# DESIGN.md

## Architecture Overview

The Durable Game Economy Service is a RESTful API built with Express.js and PostgreSQL, designed to handle virtual currency and items with exactly-once semantics and crash durability.

**Core Design Philosophy:** Every mutating operation is idempotent, atomic, and durable. The database is the source of truth; the HTTP layer is a thin wrapper around database transactions.

## Datastore Choice

### PostgreSQL

**Choice:** PostgreSQL 16 (via docker-compose) with `SERIALIZABLE` isolation level.

**Justification:**

| Requirement | PostgreSQL Feature |
|-------------|-------------------|
| Exactly-once | Unique constraints on idempotency keys, transaction atomicity |
| Crash durability | Write-Ahead Log (WAL) ensures committed data survives `kill -9` |
| Concurrency control | Row-level locks (`SELECT FOR UPDATE`), serializable isolation |
| Atomic operations | ACID transactions with explicit BEGIN/COMMIT/ROLLBACK |

**Why not others:**
- **Redis:** Would need additional persistence config for durability; lacks SERIALIZABLE isolation
- **SQLite:** Single-writer bottleneck for concurrent wallet operations
- **MySQL:** Slightly weaker isolation defaults; requires more explicit configuration

## Idempotency Strategy

### Key Generation

- **Client-generated:** Clients provide `Idempotency-Key` header (recommended: UUID v4)
- **Format:** 8-256 character string; validated at HTTP layer
- **Scope:** Unique per `(key, endpoint)` tuple

### Storage & Lookup

```sql
CREATE TABLE idempotency_keys (
    key TEXT NOT NULL,
    endpoint TEXT NOT NULL,      -- e.g., "POST /v1/wallets/:playerId/credit"
    response_status INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key, endpoint)
);
```

**Flow:**
1. Middleware extracts key from `Idempotency-Key` header (or `X-Idempotency-Key`, or query param)
2. Within transaction: check if `(key, endpoint)` exists
3. If exists: return cached response (status + body) with `Idempotency-Replayed: true` header
4. If not exists: execute operation, store response in same transaction

**Key Retention:** 7 days (configurable). Old keys can be cleaned via `DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '7 days'`.

**Why this approach:**
- **Atomic with operation:** Stored in same transaction; either both succeed or neither does
- **Database-backed:** Survives crashes; no in-memory cache that could be lost
- **Endpoint-scoped:** Same key can be safely reused for different operations

## Atomicity & Durability Strategy

### Transaction Isolation: SERIALIZABLE

```javascript
await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
```

**Why SERIALIZABLE:**
- Highest isolation level; prevents all phenomena: dirty reads, non-repeatable reads, phantom reads
- Database either serializes transactions or aborts one (we retry on abort)
- Guarantees: concurrent operations see a consistent snapshot

### Row Locking: SELECT FOR UPDATE

```javascript
const wallet = await client.query(
    'SELECT balance FROM wallets WHERE player_id = $1 FOR UPDATE',
    [playerId]
);
```

**Why row locks:**
- Prevents concurrent modifications to the same balance
- Two purchases racing: one gets the lock, other waits; first completes, second sees updated balance
- No lost updates, no double-spends

### Atomic Purchase: Debit + Grant

```javascript
try {
    // 1. Lock wallet
    // 2. Check balance
    // 3. Update balance
    // 4. Insert inventory item
    // 5. Insert ledger entry
    // 6. Store idempotency result
    COMMIT
} catch {
    ROLLBACK  // All-or-nothing: no debit without grant, no grant without debit
}
```

**Partial-failure window:** None. If step 4 fails after step 3, the entire transaction rolls back.

### Crash Behavior: `kill -9` at Any Moment

| Crash point | State after restart |
|-------------|---------------------|
| Before BEGIN | No effect; operation never started |
| After BEGIN, before COMMIT | Transaction rolled back by Postgres; no partial effects |
| After COMMIT | Durably stored; WAL ensures data survives |
| During idempotency check | No state change; safe to retry |

**Postgres guarantees:**
- Committed transactions are written to WAL before COMMIT returns
- On crash, uncommitted transactions are rolled back
- On restart, WAL replay restores committed state

### Concurrency Correctness

**Scenario:** Two purchases race for a wallet with balance 100, each costing 60.

1. Transaction A: `SELECT FOR UPDATE` → gets lock, sees balance 100
2. Transaction B: `SELECT FOR UPDATE` → **waits** for lock
3. Transaction A: Checks 100 ≥ 60, updates balance to 40, inserts item, COMMITs
4. Transaction B: Gets lock, sees balance 40, checks 40 ≥ 60 → **fails with insufficient funds**

**Result:** Exactly one success, one clean rejection. No double-spend, no negative balance.

## API Contract Details

### Common Response Format

**Success:**
```json
{
    "playerId": "string",
    // ...operation-specific fields
}
```

**Error:**
```json
{
    "error": "error_code",
    "message": "Human-readable description",
    // ...error-specific fields
}
```

### Endpoints

#### POST /v1/wallets/{playerId}/credit

Add currency to a wallet (simulates battle payout).

**Request:**
```json
{
    "amount": 100,      // Required: integer > 0
    "reason": "string"  // Required: 1-500 characters
}
```

**Success (200):**
```json
{
    "playerId": "player123",
    "oldBalance": 0,
    "newBalance": 100,
    "credited": 100,
    "reason": "battle_win"
}
```

**Errors:**
| Status | Code | Condition |
|--------|------|-----------|
| 400 | `invalid_request` | Missing/invalid fields |
| 400 | `overflow` | Balance would exceed MAX_SAFE_INTEGER |
| 500 | `internal_error` | Unexpected error |

**Idempotency:** Duplicate request with same key returns same response; balance credited exactly once.

#### POST /v1/wallets/{playerId}/purchase

Atomically debit price and grant item.

**Request:**
```json
{
    "itemId": "sword_01",  // Required: 1-100 characters
    "price": 50           // Required: integer > 0
}
```

**Success (200):**
```json
{
    "playerId": "player123",
    "oldBalance": 100,
    "newBalance": 50,
    "spent": 50,
    "item": {
        "id": "uuid",
        "itemId": "sword_01",
        "acquiredAt": "2024-01-01T00:00:00Z"
    }
}
```

**Errors:**
| Status | Code | Condition |
|--------|------|-----------|
| 400 | `invalid_request` | Missing/invalid fields |
| 402 | `insufficient_funds` | Balance < price |
| 500 | `internal_error` | Unexpected error |

**Idempotency:** Duplicate request returns same response; exactly one debit, exactly one grant.

#### POST /v1/rewards/{rewardId}/claim

Claim a one-time reward per player.

**Request:**
```json
{
    "playerId": "player123"  // Required: valid player ID format
}
```

**Success (200):**
```json
{
    "playerId": "player123",
    "rewardId": "welcome_bonus",
    "claimedAt": "2024-01-01T00:00:00Z"
}
```

**Errors:**
| Status | Code | Condition |
|--------|------|-----------|
| 400 | `invalid_request` | Missing/invalid fields |
| 409 | `already_claimed` | Reward already claimed by this player |
| 500 | `internal_error` | Unexpected error |

**Idempotency:** Duplicate request returns same response; reward claimed exactly once per player.

#### GET /v1/wallets/{playerId}

Get wallet state (read-only; no idempotency needed).

**Success (200):**
```json
{
    "playerId": "player123",
    "balance": 50,
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T01:00:00Z",
    "inventory": [
        {
            "id": "uuid",
            "itemId": "sword_01",
            "acquiredAt": "2024-01-01T00:30:00Z"
        }
    ],
    "claimedRewards": [
        {
            "rewardId": "welcome_bonus",
            "claimedAt": "2024-01-01T00:15:00Z"
        }
    ]
}
```

**Errors:**
| Status | Code | Condition |
|--------|------|-----------|
| 404 | `not_found` | Wallet doesn't exist |
| 500 | `internal_error` | Unexpected error |

## Limits & Constraints

| Field | Limit | Enforcement |
|-------|-------|-------------|
| `amount` | 1 to 9,007,199,254,740,991 | Validation + CHECK constraint |
| `price` | 1 to 9,007,199,254,740,991 | Validation + CHECK constraint |
| `balance` | 0 to 9,007,199,254,740,991 | CHECK constraint |
| `reason` | 1-500 characters | Validation |
| `itemId` | 1-100 characters | Validation |
| `playerId` | 1-100 characters, alphanumeric + `_` `-` | Validation |
| `idempotencyKey` | 8-256 characters | Validation |

## Schema Summary

```sql
wallets (player_id, balance, created_at, updated_at)
  -- Balance never negative (CHECK constraint)
  -- One row per player

inventory (id, player_id, item_id, acquired_at)
  -- FK to wallets (cascade delete)
  -- One-to-many: one player, many items

claimed_rewards (player_id, reward_id, claimed_at)
  -- PK (player_id, reward_id) ensures once-per-player

idempotency_keys (key, endpoint, response_status, response_body, created_at)
  -- PK (key, endpoint) prevents cross-endpoint collisions
  -- Stores full response for replay

ledger (id, player_id, amount, new_balance, reason, related_item_id, created_at)
  -- Audit trail for all balance changes
  -- Helps detect anomalies
```

## Security Considerations

1. **Input validation at HTTP boundary** — Never trust client input
2. **SQL injection prevention** — Parameterized queries only
3. **Balance authority** — Server owns all balances; client cannot assert their own
4. **Rate limiting** — Not implemented (out of scope), but recommended for production
5. **Authentication** — Not implemented (out of scope), but required for production
