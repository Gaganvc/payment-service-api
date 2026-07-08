import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { pool } from '../src/db/index.js';
import supertest from 'supertest';
const request = supertest(app);
import app from '../src/server.js';

// Test utilities
const TEST_PLAYER = 'test_player_' + Math.random().toString(36).substring(7);
const TEST_PLAYER_2 = 'test_player_' + Math.random().toString(36).substring(7);
const TEST_ITEM = 'sword_01';
const TEST_REWARD = 'welcome_bonus';

// Helper to make authenticated-like requests with idempotency key
function withIdempotencyKey(req, key) {
    return req.set('Idempotency-Key', key);
}

// Generate random idempotency key
function generateKey() {
    return 'test-key-' + Math.random().toString(36).substring(7);
}

describe('Game Economy Service API', () => {
    // Setup: Run migrations before tests
    before(async () => {
        // Create test tables if not exists
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
    });

    // Cleanup: Remove test data after tests
    after(async () => {
        await pool.query('DELETE FROM idempotency_keys WHERE key LIKE \'test-key-%\'');
        await pool.query('DELETE FROM inventory WHERE player_id LIKE \'test_player_%\'');
        await pool.query('DELETE FROM claimed_rewards WHERE player_id LIKE \'test_player_%\'');
        await pool.query('DELETE FROM wallets WHERE player_id LIKE \'test_player_%\'');
        await pool.end();
    });

    describe('POST /v1/wallets/:playerId/credit', () => {
        it('should credit currency to a wallet', async () => {
            const response = await request
                .post(`/v1/wallets/${TEST_PLAYER}/credit`)
                .send({ amount: 100, reason: 'battle_win' });

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.body.playerId, TEST_PLAYER);
            assert.strictEqual(response.body.oldBalance, 0);
            assert.strictEqual(response.body.newBalance, 100);
            assert.strictEqual(response.body.credited, 100);
            assert.strictEqual(response.body.reason, 'battle_win');
        });

        it('should reject negative amounts', async () => {
            const response = await request
                .post(`/v1/wallets/${TEST_PLAYER}/credit`)
                .send({ amount: -50, reason: 'test' });

            assert.strictEqual(response.status, 400);
            assert.strictEqual(response.body.error, 'invalid_request');
        });

        it('should reject missing amount', async () => {
            const response = await request
                .post(`/v1/wallets/${TEST_PLAYER}/credit`)
                .send({ reason: 'test' });

            assert.strictEqual(response.status, 400);
            assert.strictEqual(response.body.error, 'invalid_request');
        });
    });

    describe('POST /v1/wallets/:playerId/purchase', () => {
        it('should successfully purchase an item with sufficient funds', async () => {
            // First credit the wallet
            await request
                .post(`/v1/wallets/${TEST_PLAYER}/credit`)
                .send({ amount: 500, reason: 'setup' });

            // Then purchase
            const response = await request
                .post(`/v1/wallets/${TEST_PLAYER}/purchase`)
                .send({ itemId: TEST_ITEM, price: 100 });

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.body.playerId, TEST_PLAYER);
            assert.strictEqual(response.body.oldBalance, 500);
            assert.strictEqual(response.body.newBalance, 400);
            assert.strictEqual(response.body.spent, 100);
            assert.strictEqual(response.body.item.itemId, TEST_ITEM);
            assert.ok(response.body.item.id);
        });

        it('should reject purchase with insufficient funds', async () => {
            const response = await request
                .post(`/v1/wallets/${TEST_PLAYER}/purchase`)
                .send({ itemId: 'expensive_item', price: 10000 });

            assert.strictEqual(response.status, 402);
            assert.strictEqual(response.body.error, 'insufficient_funds');
            assert.strictEqual(response.body.currentBalance, 400);
            assert.strictEqual(response.body.required, 10000);
        });

        it('should reject negative price', async () => {
            const response = await request
                .post(`/v1/wallets/${TEST_PLAYER}/purchase`)
                .send({ itemId: 'test', price: -10 });

            assert.strictEqual(response.status, 400);
            assert.strictEqual(response.body.error, 'invalid_request');
        });
    });

    describe('POST /v1/rewards/:rewardId/claim', () => {
        it('should successfully claim a reward', async () => {
            const response = await request
                .post(`/v1/rewards/${TEST_REWARD}/claim`)
                .send({ playerId: TEST_PLAYER });

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.body.playerId, TEST_PLAYER);
            assert.strictEqual(response.body.rewardId, TEST_REWARD);
            assert.ok(response.body.claimedAt);
        });

        it('should reject duplicate claim', async () => {
            // First claim
            await request
                .post(`/v1/rewards/${TEST_REWARD}/claim`)
                .send({ playerId: TEST_PLAYER_2 });

            // Duplicate claim
            const response = await request
                .post(`/v1/rewards/${TEST_REWARD}/claim`)
                .send({ playerId: TEST_PLAYER_2 });

            assert.strictEqual(response.status, 409);
            assert.strictEqual(response.body.error, 'already_claimed');
        });
    });

    describe('GET /v1/wallets/:playerId', () => {
        it('should return wallet state', async () => {
            const response = await request
                .get(`/v1/wallets/${TEST_PLAYER}`);

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.body.playerId, TEST_PLAYER);
            assert.strictEqual(typeof response.body.balance, 'number');
            assert.ok(Array.isArray(response.body.inventory));
            assert.ok(Array.isArray(response.body.claimedRewards));
        });

        it('should return 404 for non-existent wallet', async () => {
            const response = await request
                .get('/v1/wallets/nonexistent_player');

            assert.strictEqual(response.status, 404);
            assert.strictEqual(response.body.error, 'not_found');
        });
    });
});
