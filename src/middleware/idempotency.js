import { getIdempotencyResult, storeIdempotencyResult } from '../db/index.js';

/**
 * Extract idempotency key from request.
 * Looks for the key in:
 * 1. Header: Idempotency-Key
 * 2. Header: X-Idempotency-Key
 * 3. Query param: idempotency_key
 *
 * @param {Object} req - Express request
 * @returns {string|null} - Idempotency key or null
 */
function extractIdempotencyKey(req) {
    return (
        req.get('Idempotency-Key') ||
        req.get('X-Idempotency-Key') ||
        req.query.idempotency_key ||
        null
    );
}

/**
 * Middleware to handle idempotency for POST/PUT/PATCH requests.
 * Checks if the request has been processed before and returns the cached result.
 * If not processed, stores the result after the handler completes.
 *
 * For use with transaction-wrapped handlers to ensure atomicity.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
export async function idempotencyMiddleware(req, res, next) {
    // Only apply to mutating operations
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
        return next();
    }

    const key = extractIdempotencyKey(req);

    // If no key provided, proceed without idempotency
    // (Could optionally require keys for all mutating requests)
    if (!key) {
        req.idempotencyKey = null;
        return next();
    }

    // Validate key format (should be a reasonable UUID or similar)
    if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
        return res.status(400).json({
            error: 'invalid_idempotency_key',
            message: 'Idempotency key must be between 8 and 256 characters'
        });
    }

    const endpoint = `${req.method} ${req.route?.path || req.path}`;

    try {
        // Check if this request was already processed
        const cached = await getIdempotencyResult(null, key, endpoint);

        if (cached) {
            // Return the cached response
            return res
                .status(cached.response_status)
                .set('Idempotency-Replayed', 'true')
                .json(cached.response_body);
        }

        // Store key and endpoint on request for later storage
        req.idempotencyKey = key;
        req.idempotencyEndpoint = endpoint;

        next();
    } catch (error) {
        console.error('Idempotency check error:', error);
        // On error, proceed without idempotency (fail open)
        // Alternative: fail closed with 500
        next();
    }
}

/**
 * Helper to store idempotency result after successful operation.
 * Should be called within the transaction for atomicity.
 *
 * @param {Object} client - Database client from transaction
 * @param {Object} req - Express request
 * @param {number} status - HTTP status code
 * @param {Object} body - Response body
 */
export function storeIdempotency(client, req, status, body) {
    if (req.idempotencyKey && req.idempotencyEndpoint) {
        return storeIdempotencyResult(client, req.idempotencyKey, req.idempotencyEndpoint, status, body);
    }
}

/**
 * Helper to generate a UUID v4 idempotency key.
 * Clients should generate their own, but this can be used for testing.
 *
 * @returns {string} - UUID v4
 */
export function generateIdempotencyKey() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
