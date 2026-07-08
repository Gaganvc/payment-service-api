import pg from 'pg';

const { Pool } = pg;

// Connection string from environment
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/game_economy';

// Create connection pool
export const pool = new Pool({
    connectionString,
    // Connection pool settings for production
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
    console.log('Database connected');
});

pool.on('error', (err) => {
    console.error('Database connection error:', err);
});

/**
 * Execute a function within a transaction with SERIALIZABLE isolation level.
 * This prevents:
 * - Double-spends (concurrent purchases racing the same balance)
 * - Lost updates (concurrent credits overwriting each other)
 * - Phantom reads (rewards being claimed concurrently)
 *
 * @param {Function} callback - Async function to execute within transaction
 * @returns {Promise<any>} - Result of the callback
 */
export async function withTransaction(callback) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

        const result = await callback(client);

        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Lock a specific wallet row for update.
 * This prevents concurrent modifications to the same balance.
 *
 * @param {Object} client - Database client from transaction
 * @param {string} playerId - Player ID to lock
 */
export async function lockWallet(client, playerId) {
    const result = await client.query(
        'SELECT balance, player_id FROM wallets WHERE player_id = $1 FOR UPDATE',
        [playerId]
    );

    if (result.rows.length === 0) {
        // Auto-create wallet on first access
        await client.query(
            'INSERT INTO wallets (player_id, balance) VALUES ($1, 0)',
            [playerId]
        );
        return { balance: 0, player_id: playerId };
    }

    return result.rows[0];
}

/**
 * Check if an idempotency key has been used.
 * Returns the stored response if it exists, null otherwise.
 *
 * @param {Object} client - Database client (optional, uses pool if not provided)
 * @param {string} key - Idempotency key
 * @param {string} endpoint - Endpoint identifier
 * @returns {Promise<Object|null>} - Stored response or null
 */
export async function getIdempotencyResult(client, key, endpoint) {
    const query = 'SELECT response_status, response_body FROM idempotency_keys WHERE key = $1 AND endpoint = $2';

    // Use provided client or pool
    const result = client
        ? await client.query(query, [key, endpoint])
        : await pool.query(query, [key, endpoint]);

    if (result.rows.length === 0) {
        return null;
    }

    return result.rows[0];
}

/**
 * Store an idempotency key result for future retries.
 *
 * @param {Object} client - Database client (should be in transaction)
 * @param {string} key - Idempotency key
 * @param {string} endpoint - Endpoint identifier
 * @param {number} status - HTTP status code
 * @param {Object} body - Response body
 */
export async function storeIdempotencyResult(client, key, endpoint, status, body) {
    await client.query(
        'INSERT INTO idempotency_keys (key, endpoint, response_status, response_body) VALUES ($1, $2, $3, $4)',
        [key, endpoint, status, JSON.stringify(body)]
    );
}

/**
 * Cleanup old idempotency keys.
 * Keys older than the specified age are deleted.
 *
 * @param {number} days - Days to retain keys (default: 7 days)
 */
export async function cleanupOldKeys(days = 7) {
    await pool.query(
        'DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL \'1 day\' * $1',
        [days]
    );
}
