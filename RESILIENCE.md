# RESILIENCE.md

## Scenario 1: External Inventory Service

### Problem

The item grant operation is moved to a separate **Inventory Service**, reachable via HTTP API. This service:
- Can time out
- Can fail (5xx errors)
- Can process requests twice (at-least-once delivery)
- **Cannot share a transaction** with the wallet database (separate system)

### Challenge

A purchase must still be **exactly-once end-to-end**:
- Debit local balance
- Call Inventory Service to grant item
- Handle timeout/failure
- Ensure no orphan debits (debit without item)
- Ensure no double grants

### Partial-Failure Window

The failure window exists **between the local COMMIT and the remote API call completion**:

```
1. Begin transaction (local)
2. Lock wallet, check balance
3. Debit balance (local)
4. Record intent (outbox entry)
5. COMMIT transaction  ← Local DB committed here
6. Call Inventory Service API  ← Failure window: crash here = orphan debit
7. Process API response
```

If the process dies after step 5 but before step 7 completes, we have:
- Balance debited (committed locally)
- Item not granted (remote call not made/acknowledged)
- **Orphan debit:** Player lost money, got nothing

### Solution: Outbox Pattern with Deduplication

#### Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Economy Service│         │  Outbox Table    │         │ Inventory Svc   │
└────────┬────────┘         └────────┬─────────┘         └────────┬────────┘
         │                           │                             │
         │ 1. Begin Tx               │                             │
         ├───────────────────────────>                             │
         │ 2. Debit balance          │                             │
         │ 3. Insert outbox entry    │                             │
         │    (item_id, player_id)   │                             │
         │ 4. Commit Tx              │                             │
         ├───────────────────────────>                             │
         │                                                           │
         │ 5. Poll outbox for unprocessed                           │
         ├──────────────────────────────>                           │
         │ 6. POST /grant-item with idempotency key                 │
         ├──────────────────────────────────────────────────────────>
         │                                                           │
         │ 7. Success: mark outbox entry as processed               │
         ├──────────────────────────────>                           │
         │                                                           │
         │ 8. Retry failed entries (exponential backoff)           │
         └───────────────────────────────────────────────────────────
```

#### Implementation

**1. Outbox Table Schema**

```sql
CREATE TABLE outbox_inventory_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,  -- For Inventory Service deduplication
    status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    -- Index for polling
    INDEX idx_outbox_pending (status, created_at)
);
```

**2. Modified Purchase Flow**

```javascript
async function purchase(req, res) {
    return await withTransaction(async (client) => {
        // ... idempotency check ...
        // ... balance check ...

        // Debit balance
        const newBalance = oldBalance - price;
        await client.query('UPDATE wallets SET balance = $1 WHERE player_id = $2',
            [newBalance, playerId]);

        // Insert outbox entry (same transaction!)
        const grantId = uuid();
        const idempotencyKey = `grant-${playerId}-${itemId}-${grantId}`;
        await client.query(`
            INSERT INTO outbox_inventory_grants
            (player_id, item_id, idempotency_key, status)
            VALUES ($1, $2, $3, 'pending')
        `, [playerId, itemId, idempotencyKey]);

        // Record in ledger
        await client.query(`INSERT INTO ledger ...`);

        // Commit: balance debited, outbox entry created atomically
        return { newBalance, grantId };
    });
}

// Background worker (separate process)
async function processOutbox() {
    while (true) {
        const entries = await pool.query(`
            SELECT * FROM outbox_inventory_grants
            WHERE status = 'pending'
            AND (updated_at < NOW() - INTERVAL '1 minute' OR attempts = 0)
            ORDER BY created_at
            LIMIT 10
        `);

        for (const entry of entries.rows) {
            await processGrant(entry);
        }

        await sleep(1000); // Poll every second
    }
}

async function processGrant(entry) {
    try {
        await pool.query(`
            UPDATE outbox_inventory_grants
            SET status = 'processing', attempts = attempts + 1
            WHERE id = $1
        `, [entry.id]);

        // Call Inventory Service with idempotency key
        const response = await fetch('https://inventory.service/api/grant', {
            method: 'POST',
            headers: { 'Idempotency-Key': entry.idempotency_key },
            body: JSON.stringify({
                playerId: entry.player_id,
                itemId: entry.item_id
            })
        });

        if (response.ok) {
            await pool.query(`
                UPDATE outbox_inventory_grants
                SET status = 'completed', completed_at = NOW()
                WHERE id = $1
            `, [entry.id]);
        } else {
            throw new Error(`Inventory service error: ${response.status}`);
        }
    } catch (error) {
        await pool.query(`
            UPDATE outbox_inventory_grants
            SET status = 'pending', last_error = $1
            WHERE id = $2
        `, [error.message, entry.id]);

        // Dead letter after N attempts
        if (entry.attempts >= 10) {
            await pool.query(`
                UPDATE outbox_inventory_grants
                SET status = 'failed'
                WHERE id = $1
            `, [entry.id]);

            // Trigger alert for manual intervention
        }
    }
}
```

**3. Inventory Service Contract**

Inventory Service must support idempotency:
- Accept `Idempotency-Key` header
- Return cached response on duplicate key
- Atomic: either grant item or return error

#### Failure Scenarios

| Failure | Recovery |
|---------|----------|
| **Timeout calling Inventory Service** | Outbox entry stays `pending`; retry in next poll |
| **Inventory Service 5xx error** | Outbox entry stays `pending`; retry with exponential backoff |
| **Process crash after COMMIT** | Outbox entry persisted; worker picks it up on restart |
| **Inventory Service processes request twice** | Same idempotency key; second call returns cached result |
| **Inventory Service permanently down** | After N attempts, mark as `failed`; alert for manual intervention |

#### Why This Works

1. **Atomic intent:** Balance debit and outbox insertion are in the same transaction
2. **Durable intent:** Outbox entry survives crashes (it's in the DB)
3. **Eventually consistent:** Worker guarantees processing (with retries)
4. **Exactly-once:** Inventory Service idempotency prevents double grants
5. **No orphan debits:** Every debit has a corresponding outbox entry

---

## Scenario 2: Detecting and Correcting a Past Double-Grant Bug

### Problem

A bug last week **double-granted currency to some players**. We need to:
1. **Detect** which players were affected
2. **Correct** the balances without downtime
3. **Understand** the root cause to prevent recurrence

### Detection Strategy

#### 1. Ledger Analysis (Reconciliation)

The `ledger` table records every balance change. We can:

```sql
-- Calculate expected balance from ledger
WITH calculated_balance AS (
    SELECT
        player_id,
        SUM(amount) as expected_balance
    FROM ledger
    GROUP BY player_id
)
SELECT
    w.player_id,
    w.balance as actual_balance,
    c.expected_balance,
    w.balance - c.expected_balance as discrepancy
FROM wallets w
LEFT JOIN calculated_balance c ON w.player_id = c.player_id
WHERE w.balance != c.expected_balance;
```

**If discrepancy > 0:** Player was over-granted (bug)
**If discrepancy < 0:** Major data integrity issue

#### 2. Invariant Check

Define an invariant: `wallet.balance = SUM(ledger.amount)` for each player.

Run as a periodic job (e.g., nightly):

```javascript
async function checkInvariants() {
    const discrepancies = await pool.query(`
        SELECT w.player_id, w.balance, COALESCE(SUM(l.amount), 0) as ledger_sum
        FROM wallets w
        LEFT JOIN ledger l ON w.player_id = l.player_id
        GROUP BY w.player_id, w.balance
        HAVING w.balance != COALESCE(SUM(l.amount), 0)
    `);

    if (discrepancies.rowCount > 0) {
        // Alert!
        await alertTeam({
            message: 'Balance invariant violation detected',
            affectedPlayers: discrepancies.rows.length,
            details: discrepancies.rows
        });
    }
}
```

#### 3. Audit Trail Enhancement

**What would have caught it sooner:**

1. **Unique constraint on credit operations:**
   ```sql
   -- If credits come from a source (battle_id), make it unique
   CREATE TABLE battle_payouts (
       battle_id TEXT NOT NULL,
       player_id TEXT NOT NULL,
       amount BIGINT NOT NULL,
       PRIMARY KEY (battle_id, player_id)  -- Prevents double payout
   );
   ```

2. **Idempotency on credit operations:**
   - Credit requests should require idempotency keys
   - `battle_id` or `transaction_id` serves as natural key

3. **Periodic reconciliation:**
   - Nightly invariant check
   - Automated alert on discrepancy

### Correction Strategy

#### Step 1: Assess Impact

```sql
-- Find all affected players and amounts
WITH discrepancies AS (
    SELECT
        w.player_id,
        w.balance - COALESCE(SUM(l.amount), 0) as overage
    FROM wallets w
    LEFT JOIN ledger l ON w.player_id = l.player_id
    GROUP BY w.player_id, w.balance
    HAVING w.balance != COALESCE(SUM(l.amount), 0)
)
SELECT * FROM discrepancies WHERE overage > 0;
```

#### Step 2: Log Correction Intent

Before making changes, record what we're about to do:

```sql
CREATE TABLE balance_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id TEXT NOT NULL,
    old_balance BIGINT NOT NULL,
    correction_amount BIGINT NOT NULL,  -- negative to reduce
    new_balance BIGINT NOT NULL,
    reason TEXT NOT NULL,
    corrected_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### Step 3: Apply Correction (Transaction-Wrapped)

```javascript
async function correctBalance(playerId, correctionAmount, reason) {
    await withTransaction(async (client) => {
        // Lock wallet
        const wallet = await lockWallet(client, playerId);

        // Calculate new balance
        const newBalance = wallet.balance + correctionAmount;

        // Safety: don't make balance negative
        if (newBalance < 0) {
            throw new Error('Correction would result in negative balance');
        }

        // Update wallet
        await client.query(
            'UPDATE wallets SET balance = $1 WHERE player_id = $2',
            [newBalance, playerId]
        );

        // Record correction
        await client.query(`
            INSERT INTO balance_corrections
            (player_id, old_balance, correction_amount, new_balance, reason, corrected_by)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [playerId, wallet.balance, correctionAmount, newBalance, reason, 'system_reconciliation']);

        // Record in ledger (with negative amount to fix)
        await client.query(`
            INSERT INTO ledger (player_id, amount, new_balance, reason)
            VALUES ($1, $2, $3, $4)
        `, [playerId, correctionAmount, newBalance, reason]);
    });
}
```

#### Step 4: Verify and Communicate

After corrections, re-run invariant check to verify.

Notify affected players (optional, depending on policy):

```
"We identified an accounting error on [date] that incorrectly credited your account.
We've corrected your balance from [old] to [new]. We apologize for the error."
```

### Prevention

**To prevent future double-grants:**

1. **Idempotency keys on ALL mutating operations**
2. **Natural keys (battle_id, transaction_id) made unique in DB**
3. **Periodic invariant checks (automated, alerts on failure)**
4. **Comprehensive testing of concurrent operations**
5. **Code review focus on transaction boundaries and idempotency**
