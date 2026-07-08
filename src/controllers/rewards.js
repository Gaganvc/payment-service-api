import { withTransaction, lockWallet, getIdempotencyResult } from '../db/index.js';
import { storeIdempotency as storeIdempotencyResponse } from '../middleware/idempotency.js';

/**
 * POST /v1/rewards/:rewardId/claim
 * Claim a one-time reward per player
 *
 * Idempotent: Duplicate requests return same response
 * Atomic: Either claim succeeds or doesn't (unique constraint enforces once-per-player)
 * Durable: Committed changes survive process kill
 */
export async function claimReward(req, res) {
    const { rewardId } = req.params;
    const { playerId } = req.body;

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

            // Ensure wallet exists (creates if not)
            await lockWallet(client, playerId);

            // Try to insert the claim - unique constraint prevents duplicates
            try {
                await client.query(
                    'INSERT INTO claimed_rewards (player_id, reward_id) VALUES ($1, $2)',
                    [playerId, rewardId]
                );
            } catch (dbError) {
                // Unique violation = already claimed
                if (dbError.code === '23505') {
                    // Get existing claim details
                    const existing = await client.query(
                        'SELECT claimed_at FROM claimed_rewards WHERE player_id = $1 AND reward_id = $2',
                        [playerId, rewardId]
                    );

                    const errorBody = {
                        error: 'already_claimed',
                        message: 'Reward has already been claimed by this player',
                        playerId,
                        rewardId,
                        claimedAt: existing.rows[0].claimed_at
                    };

                    if (req.idempotencyKey) {
                        await storeIdempotencyResponse(client, req, 409, errorBody);
                    }

                    return {
                        replayed: false,
                        status: 409,
                        body: errorBody
                    };
                }
                throw dbError;
            }

            const responseBody = {
                playerId,
                rewardId,
                claimedAt: new Date().toISOString()
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
        console.error('Claim reward error:', error);

        return res.status(500).json({
            error: 'internal_error',
            message: 'An error occurred claiming the reward'
        });
    }
}
