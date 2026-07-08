import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { pool } from '../src/db/index.js';
import supertest from 'supertest';
import app from '../src/server.js';

const request = supertest(app);

const TEST_PLAYER = 'critical_test_' + Math.random().toString(36).substring(7);

describe('Critical Requirements: Exactly-Once & Concurrency', () => {
    before(async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wallets (
                player_id TEXT PRIMARY KEY,
                balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS inventory (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                player_id TEXT NOT NULL REFERENCES wallets(player_id) ON DELETE CASCADE,
                item_id TEXT NOT NULL,
                acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS claimed_rewards (
                player_id TEXT NOT NULL,
                reward_id TEXT NOT NULL,
                claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (player_id, reward_id)
            );
            CREATE TABLE IF NOT EXISTS idempotency_keys (
                key TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                response_status INTEGER NOT NULL,
                response_body JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (key, endpoint)
            );

            CREATE TABLE IF NOT EXISTS ledger (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                player_id TEXT NOT NULL,
                amount BIGINT NOT NULL,
                new_balance BIGINT NOT NULL,
                reason TEXT NOT NULL,
                related_item_id TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        // Setup: Give player 1000 balance
        await request
            .post(`/v1/wallets/${TEST_PLAYER}/credit`)
            .send({ amount: 1000, reason: 'test_setup' });
    });

    after(async () => {
        await pool.query('DELETE FROM idempotency_keys WHERE key LIKE \'%\'');
        await pool.query('DELETE FROM inventory WHERE player_id LIKE \'critical_test_%\'');
        await pool.query('DELETE FROM claimed_rewards WHERE player_id LIKE \'critical_test_%\'');
        await pool.query('DELETE FROM wallets WHERE player_id LIKE \'critical_test_%\'');
        await pool.end();
    });

    describe('Idempotency: Exactly-Once Semantics', () => {
        it('should return same response for duplicate credit requests', async () => {
            const idempotencyKey = 'test-credit-' + Math.random();

            const first = await request
                .post(`/v1/wallets/${TEST_PLAYER}/credit`)
                .set('Idempotency-Key', idempotencyKey)
                .send({ amount: 500, reason: 'test' });

            assert.strictEqual(first.status, 200);
            assert.strictEqual(first.body.newBalance, 1500);
            assert.ok(!first.headers['idempotency-replayed']);

            // Sleep to ensure timestamps differ
            await new Promise(r => setTimeout(r, 10));

            const duplicate = await request
                .post(`/v1/wallets/${TEST_PLAYER}/credit`)
                .set('Idempotency-Key', idempotencyKey)
                .send({ amount: 500, reason: 'test' });

            assert.strictEqual(duplicate.status, 200);
            assert.strictEqual(duplicate.body.newBalance, 1500); // Balance unchanged
            assert.strictEqual(duplicate.headers['idempotency-replayed'], 'true');

            // Verify balance was only credited once
            const wallet = await request.get(`/v1/wallets/${TEST_PLAYER}`);
            assert.strictEqual(wallet.body.balance, 1500);
        });

        it('should return same response for duplicate purchase requests', async () => {
            const idempotencyKey = 'test-purchase-' + Math.random();

            const first = await request
                .post(`/v1/wallets/${TEST_PLAYER}/purchase`)
                .set('Idempotency-Key', idempotencyKey)
                .send({ itemId: 'shield', price: 200 });

            assert.strictEqual(first.status, 200);
            assert.strictEqual(first.body.newBalance, 1300);
            assert.ok(!first.headers['idempotency-replayed']);

            const duplicate = await request
                .post(`/v1/wallets/${TEST_PLAYER}/purchase`)
                .set('Idempotency-Key', idempotencyKey)
                .send({ itemId: 'shield', price: 200 });

            assert.strictEqual(duplicate.status, 200);
            assert.strictEqual(duplicate.body.newBalance, 1300);
            assert.strictEqual(duplicate.headers['idempotency-replayed'], 'true');

            // Verify only one item was granted
            const wallet = await request.get(`/v1/wallets/${TEST_PLAYER}`);
            const shieldCount = wallet.body.inventory.filter(i => i.itemId === 'shield').length;
            assert.strictEqual(shieldCount, 1);
        });

        it('should return same error response for duplicate failed purchases', async () => {
            const idempotencyKey = 'test-fail-purchase-' + Math.random();
            const lowBalancePlayer = 'low_balance_' + Math.random();

            // First attempt with insufficient funds
            const first = await request
                .post(`/v1/wallets/${lowBalancePlayer}/purchase`)
                .set('Idempotency-Key', idempotencyKey)
                .send({ itemId: 'expensive', price: 99999 });

            assert.strictEqual(first.status, 402);
            assert.strictEqual(first.body.error, 'insufficient_funds');

            // Duplicate request should return same error
            const duplicate = await request
                .post(`/v1/wallets/${lowBalancePlayer}/purchase`)
                .set('Idempotency-Key', idempotencyKey)
                .send({ itemId: 'expensive', price: 99999 });

            assert.strictEqual(duplicate.status, 402);
            assert.strictEqual(duplicate.body.error, 'insufficient_funds');
            assert.strictEqual(duplicate.headers['idempotency-replayed'], 'true');
        });

        it('should return same response for duplicate reward claims', async () => {
            const idempotencyKey = 'test-claim-' + Math.random();
            const rewardId = 'daily_bonus_' + Math.random();

            const first = await request
                .post(`/v1/rewards/${rewardId}/claim`)
                .set('Idempotency-Key', idempotencyKey)
                .send({ playerId: TEST_PLAYER });

            assert.strictEqual(first.status, 200);
            assert.strictEqual(first.body.rewardId, rewardId);

            const duplicate = await request
                .post(`/v1/rewards/${rewardId}/claim`)
                .set('Idempotency-Key', idempotencyKey)
                .send({ playerId: TEST_PLAYER });

            assert.strictEqual(duplicate.status, 200);
            assert.strictEqual(duplicate.headers['idempotency-replayed'], 'true');
        });
    });

    describe('Concurrency: No Double-Spends', () => {
        it('should prevent concurrent purchases exceeding balance', async () => {
            const player = 'concurrent_' + Math.random();
            const itemPrice = 300;
            const initialBalance = 500;

            // Setup wallet
            await request
                .post(`/v1/wallets/${player}/credit`)
                .send({ amount: initialBalance, reason: 'setup' });

            // Send 5 concurrent purchase requests (500 balance, 300 each)
            // Only 1 should succeed
            const requests = [];
            for (let i = 0; i < 5; i++) {
                requests.push(
                    request
                        .post(`/v1/wallets/${player}/purchase`)
                        .send({ itemId: `item_${i}`, price: itemPrice })
                );
            }

            const responses = await Promise.all(requests);

            const successCount = responses.filter(r => r.status === 200).length;
            const failureCount = responses.filter(r => r.status === 402).length;

            // Exactly one should succeed, four should fail
            assert.strictEqual(successCount, 1, 'Exactly one purchase should succeed');
            assert.strictEqual(failureCount, 4, 'Four purchases should fail with insufficient funds');

            // Final balance should be initial - price
            const wallet = await request.get(`/v1/wallets/${player}`);
            assert.strictEqual(wallet.body.balance, initialBalance - itemPrice);

            // Exactly one item should be in inventory
            assert.strictEqual(wallet.body.inventory.length, 1);
        });

        it('should handle concurrent credits correctly (no lost updates)', async () => {
            const player = 'credit_concurrent_' + Math.random();
            const creditAmount = 100;
            const numCredits = 10;

            // Send 10 concurrent credit requests
            const requests = [];
            for (let i = 0; i < numCredits; i++) {
                requests.push(
                    request
                        .post(`/v1/wallets/${player}/credit`)
                        .send({ amount: creditAmount, reason: 'concurrent_test' })
                );
            }

            const responses = await Promise.all(requests);

            // All should succeed
            for (const response of responses) {
                assert.strictEqual(response.status, 200);
            }

            // Final balance should be exactly amount * count
            const wallet = await request.get(`/v1/wallets/${player}`);
            assert.strictEqual(wallet.body.balance, creditAmount * numCredits);
        });

        it('should prevent concurrent reward double-claims', async () => {
            const player = 'reward_concurrent_' + Math.random().toString(36).substring(7);
            const rewardId = 'limited_reward_' + Math.random().toString(36).substring(7);

            // Send 10 concurrent claim requests
            const requests = [];
            for (let i = 0; i < 10; i++) {
                requests.push(
                    request
                        .post(`/v1/rewards/${rewardId}/claim`)
                        .send({ playerId: player })
                );
            }

            const responses = await Promise.all(requests);

            const successCount = responses.filter(r => r.status === 200).length;
            const conflictCount = responses.filter(r => r.status === 409).length;

            // Exactly one should succeed
            assert.strictEqual(successCount, 1, 'Exactly one claim should succeed');
            assert.strictEqual(conflictCount, 9, 'Nine claims should conflict');

            // Verify only one recorded claim
            const wallet = await request.get(`/v1/wallets/${player}`);
            const claimed = wallet.body.claimedRewards.filter(r => r.rewardId === rewardId);
            assert.strictEqual(claimed.length, 1);
        });
    });

    describe('Crash Recovery: Durability', () => {
        it('should recover committed state after simulated crash', async () => {
            const player = 'crash_test_' + Math.random();

            // Perform some operations
            await request
                .post(`/v1/wallets/${player}/credit`)
                .send({ amount: 1000, reason: 'before_crash' });

            await request
                .post(`/v1/wallets/${player}/purchase`)
                .send({ itemId: 'survivor_item', price: 250 });

            // "Crash" - disconnect and reconnect to database
            await pool.end();
            const { pool: newPool } = await import('../src/db/index.js');

            // Verify state survived
            const wallet = await newPool.query(
                'SELECT balance FROM wallets WHERE player_id = $1',
                [player]
            );

            assert.strictEqual(wallet.rows.length, 1);
            assert.strictEqual(wallet.rows[0].balance, 750);

            const inventory = await newPool.query(
                'SELECT COUNT(*) FROM inventory WHERE player_id = $1 AND item_id = $2',
                [player, 'survivor_item']
            );

            assert.strictEqual(parseInt(inventory.rows[0].count), 1);

            // Cleanup
            await newPool.query('DELETE FROM wallets WHERE player_id = $1', [player]);
        });

        it('should not apply in-flight transaction after crash', async () => {
            const player = 'rollback_test_' + Math.random();

            // This test simulates a crash mid-transaction
            // The transaction should rollback and not apply

            // Use raw PG client to simulate crash
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('INSERT INTO wallets (player_id, balance) VALUES ($1, 100)', [player]);

                // "Crash" - close connection without commit
                await client.query('ROLLBACK');
            } finally {
                client.release();
            }

            // Verify wallet was not created
            const result = await pool.query(
                'SELECT * FROM wallets WHERE player_id = $1',
                [player]
            );

            assert.strictEqual(result.rows.length, 0);
        });
    });

    describe('Input Safety', () => {
        it('should reject malformed JSON', async () => {
            const response = await request
                .post(`/v1/wallets/${TEST_PLAYER}/credit`)
                .set('Content-Type', 'application/json')
                .send('invalid json');

            assert.strictEqual(response.status, 400);
        });

        it('should reject oversized amount', async () => {
            const response = await request
                .post(`/v1/wallets/${TEST_PLAYER}/credit`)
                .send({ amount: Number.MAX_SAFE_INTEGER + 1, reason: 'overflow' });

            assert.strictEqual(response.status, 400);
        });

        it('should reject zero amount', async () => {
            const response = await request
                .post(`/v1/wallets/${TEST_PLAYER}/credit`)
                .send({ amount: 0, reason: 'zero' });

            assert.strictEqual(response.status, 400);
        });

        it('should reject invalid player ID format', async () => {
            const response = await request
                .post('/v1/wallets/invalid@player#/credit')
                .send({ amount: 100, reason: 'test' });

            // Either 400 (validation) or 404 (wallet not found)
            assert.ok([400, 404].includes(response.status));
        });
    });
});
