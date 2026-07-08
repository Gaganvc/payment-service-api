-- Durable Game Economy Service Database Schema
-- PostgreSQL with emphasis on exactly-once semantics and crash durability

-- Wallets: Store player currency balances
-- One row per player, balance never negative (enforced by CHECK constraint)
CREATE TABLE IF NOT EXISTS wallets (
    player_id TEXT PRIMARY KEY,
    balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Inventory: Items owned by players
-- One-to-many: one player can have many items, same item can appear multiple times
CREATE TABLE IF NOT EXISTS inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id TEXT NOT NULL REFERENCES wallets(player_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Index for querying player's inventory quickly
    -- Index for supporting idempotent purchase lookups
    INDEX idx_inventory_player (player_id)
);

-- Claimed Rewards: One-time reward claims per player
-- Unique constraint ensures a player can only claim a specific reward once
CREATE TABLE IF NOT EXISTS claimed_rewards (
    player_id TEXT NOT NULL,
    reward_id TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (player_id, reward_id)
);

-- Idempotency Keys: Track processed requests for exactly-once semantics
-- When a request with an idempotency key is processed, we store:
-- - The key itself
-- - The endpoint it was for (to prevent cross-endpoint collisions)
-- - The result (so we can return the same response on retry)
-- - Created timestamp for cleanup/TTL purposes
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key, endpoint)
);

-- Index for time-based cleanup of old idempotency keys
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);

-- Ledger (optional but recommended): Audit trail of all balance changes
-- Helps detect anomalies and provides transaction history
CREATE TABLE IF NOT EXISTS ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id TEXT NOT NULL,
    amount BIGINT NOT NULL,
    new_balance BIGINT NOT NULL,
    reason TEXT NOT NULL,
    related_item_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    INDEX idx_ledger_player (player_id)
);

-- Function to update wallet updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallets_update_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
