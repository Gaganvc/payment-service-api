import { withTransaction, lockWallet, getIdempotencyResult, pool } from '../db/index.js';
import { storeIdempotency as storeIdempotencyResponse } from '../middleware/idempotency.js';

/**
 * POST /v1/wallets/:playerId/credit
 * Add currency to a player's wallet (simulates battle payout)
 *
 * Idempotent: Duplicate requests with same key return same response
 * Durable: Committed changes survive process kill
 */
export async function credit(req, res) {
    const { playerId } = req.params;
    const { amount, reason } = req.body;

    try {
        const result = await withTransaction(async (client) => {
            // Check idempotency first (within transaction for consistency)
            if (req.idempotencyKey) {
                const existing = await getIdempotencyResult(client, req.idempotencyKey, req.idempotencyEndpoint);
                if (existing) {
                    return {
                        replayed: true,
                        status: existing.response_status,
                        body: existing.response_body
                    };
                }
            }

            // Lock wallet for update (prevents concurrent modifications)
            const wallet = await lockWallet(client, playerId);

            // Calculate new balance
            const oldBalance = wallet.balance;
            const newBalance = oldBalance + amount;

            // Check for overflow
            if (newBalance > Number.MAX_SAFE_INTEGER) {
                throw new Error('Balance overflow');
            }

            // Update wallet balance
            await client.query(
                'UPDATE wallets SET balance = $1 WHERE player_id = $2',
                [newBalance, playerId]
            );

            // Record in ledger for audit trail
            await client.query(
                'INSERT INTO ledger (player_id, amount, new_balance, reason) VALUES ($1, $2, $3, $4)',
                [playerId, amount, newBalance, reason]
            );

            // Store idempotency result
            const responseBody = {
                playerId,
                oldBalance,
                newBalance,
                credited: amount,
                reason
            };

            if (req.idempotencyKey) {
                await storeIdempotencyResponse(client, req, 200, responseBody);
            }

            return {
                replayed: false,
                status: 200,
                body: responseBody
            };
        });

        if (result.replayed) {
            return res
                .status(result.status)
                .set('Idempotency-Replayed', 'true')
                .json(result.body);
        }

        return res.status(200).json(result.body);

    } catch (error) {
        console.error('Credit error:', error);

        if (error.message === 'Balance overflow') {
            return res.status(400).json({
                error: 'overflow',
                message: 'Operation would cause balance overflow'
            });
        }

        return res.status(500).json({
            error: 'internal_error',
            message: 'An error occurred processing the credit'
        });
    }
}

/**
 * POST /v1/wallets/:playerId/purchase
 * Atomically debit price AND grant item
 *
 * Idempotent: Duplicate requests with same key return same response
 * Atomic: Either both debit and grant succeed, or neither does
 * Durable: Committed changes survive process kill
 */
export async function purchase(req, res) {
    const { playerId } = req.params;
    const { itemId, price } = req.body;

    try {
        const result = await withTransaction(async (client) => {
            // Check idempotency first
            if (req.idempotencyKey) {
                const existing = await getIdempotencyResult(client, req.idempotencyKey, req.idempotencyEndpoint);
                if (existing) {
                    return {
                        replayed: true,
                        status: existing.response_status,
                        body: existing.response_body
                    };
                }
            }

            // Lock wallet for update
            const wallet = await lockWallet(client, playerId);

            // Check sufficient funds
            if (wallet.balance < price) {
                const errorBody = {
                    error: 'insufficient_funds',
                    message: 'Insufficient balance for purchase',
                    playerId,
                    currentBalance: wallet.balance,
                    required: price,
                    itemId
                };

                if (req.idempotencyKey) {
                    await storeIdempotencyResponse(client, req, 402, errorBody);
                }

                return {
                    replayed: false,
                    status: 402,
                    body: errorBody
                };
            }

            // Calculate new balance
            const oldBalance = wallet.balance;
            const newBalance = oldBalance - price;

            // Update wallet balance
            await client.query(
                'UPDATE wallets SET balance = $1 WHERE player_id = $2',
                [newBalance, playerId]
            );

            // Grant item (add to inventory)
            const itemResult = await client.query(
                'INSERT INTO inventory (player_id, item_id) VALUES ($1, $2) RETURNING id, acquired_at',
                [playerId, itemId]
            );

            // Record in ledger
            await client.query(
                'INSERT INTO ledger (player_id, amount, new_balance, reason, related_item_id) VALUES ($1, $2, $3, $4, $5)',
                [playerId, -price, newBalance, `purchase: ${itemId}`, itemId]
            );

            const responseBody = {
                playerId,
                oldBalance,
                newBalance,
                spent: price,
                item: {
                    id: itemResult.rows[0].id,
                    itemId,
                    acquiredAt: itemResult.rows[0].acquired_at
                }
            };

            if (req.idempotencyKey) {
                await storeIdempotencyResponse(client, req, 200, responseBody);
            }

            return {
                replayed: false,
                status: 200,
                body: responseBody
            };
        });

        if (result.replayed) {
            return res
                .status(result.status)
                .set('Idempotency-Replayed', 'true')
                .json(result.body);
        }

        return res.status(result.status).json(result.body);

    } catch (error) {
        console.error('Purchase error:', error);

        return res.status(500).json({
            error: 'internal_error',
            message: 'An error occurred processing the purchase'
        });
    }
}

/**
 * GET /v1/wallets/:playerId
 * Get wallet balance, inventory, and claimed rewards
 *
 * Read-only endpoint (no idempotency needed)
 */
export async function getWallet(req, res) {
    const { playerId } = req.params;

    try {
        // Use simple query (no transaction needed for read)
        const walletResult = await pool.query(
            'SELECT balance, created_at, updated_at FROM wallets WHERE player_id = $1',
            [playerId]
        );

        if (walletResult.rows.length === 0) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Wallet not found',
                playerId
            });
        }

        const wallet = walletResult.rows[0];

        // Get inventory
        const inventoryResult = await pool.query(
            'SELECT id, item_id, acquired_at FROM inventory WHERE player_id = $1 ORDER BY acquired_at DESC',
            [playerId]
        );

        // Get claimed rewards
        const rewardsResult = await pool.query(
            'SELECT reward_id, claimed_at FROM claimed_rewards WHERE player_id = $1 ORDER BY claimed_at DESC',
            [playerId]
        );

        return res.status(200).json({
            playerId,
            balance: wallet.balance,
            createdAt: wallet.created_at,
            updatedAt: wallet.updated_at,
            inventory: inventoryResult.rows.map(row => ({
                id: row.id,
                itemId: row.item_id,
                acquiredAt: row.acquired_at
            })),
            claimedRewards: rewardsResult.rows.map(row => ({
                rewardId: row.reward_id,
                claimedAt: row.claimed_at
            }))
        });

    } catch (error) {
        console.error('Get wallet error:', error);

        return res.status(500).json({
            error: 'internal_error',
            message: 'An error occurred fetching the wallet'
        });
    }
}
