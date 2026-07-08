/**
 * Validate request body against a schema.
 * Returns 400 if validation fails.
 *
 * @param {Object} schema - Validation schema with required fields and validators
 * @returns {Function} - Express middleware
 */
export function validateBody(schema) {
    return (req, res, next) => {
        const errors = [];

        // Check required fields
        for (const field of schema.required || []) {
            if (!(field in req.body)) {
                errors.push(`Missing required field: ${field}`);
            }
        }

        // Validate each field
        for (const [field, validator] of Object.entries(schema.fields || {})) {
            if (field in req.body) {
                const value = req.body[field];
                const error = validator(value);
                if (error) {
                    errors.push(`${field}: ${error}`);
                }
            }
        }

        if (errors.length > 0) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'Request validation failed',
                details: errors
            });
        }

        next();
    };
}

/**
 * Common validators
 */
export const validators = {
    /** Positive integer (> 0) with safe range */
    positiveInt: (value) => {
        if (!Number.isInteger(value)) {
            return 'Must be an integer';
        }
        if (value <= 0) {
            return 'Must be greater than 0';
        }
        if (value > Number.MAX_SAFE_INTEGER) {
            return 'Value too large';
        }
        return null;
    },

    /** Non-negative integer (>= 0) with safe range */
    nonNegativeInt: (value) => {
        if (!Number.isInteger(value)) {
            return 'Must be an integer';
        }
        if (value < 0) {
            return 'Must be non-negative';
        }
        if (value > Number.MAX_SAFE_INTEGER) {
            return 'Value too large';
        }
        return null;
    },

    /** String with length constraints */
    string: (min = 1, max = 255) => (value) => {
        if (typeof value !== 'string') {
            return 'Must be a string';
        }
        if (value.length < min) {
            return `Must be at least ${min} character${min > 1 ? 's' : ''}`;
        }
        if (value.length > max) {
            return `Must be at most ${max} characters`;
        }
        return null;
    },

    /** Player ID format */
    playerId: (value) => {
        if (typeof value !== 'string') {
            return 'Must be a string';
        }
        if (value.length < 1) {
            return 'Must not be empty';
        }
        if (value.length > 100) {
            return 'Must be at most 100 characters';
        }
        // Allow alphanumeric, hyphen, underscore
        if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
            return 'Must contain only letters, numbers, hyphens, and underscores';
        }
        return null;
    }
};

// Request schemas for each endpoint
export const schemas = {
    credit: {
        required: ['amount', 'reason'],
        fields: {
            amount: validators.positiveInt,
            reason: validators.string(1, 500)
        }
    },

    purchase: {
        required: ['itemId', 'price'],
        fields: {
            itemId: validators.string(1, 100),
            price: validators.positiveInt
        }
    },

    claimReward: {
        required: ['playerId'],
        fields: {
            playerId: validators.playerId
        }
    }
};
