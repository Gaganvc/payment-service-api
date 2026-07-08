import express from 'express';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { validateBody, schemas } from './middleware/validation.js';
import { credit, purchase, getWallet } from './controllers/wallet.js';
import { claimReward } from './controllers/rewards.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API Routes
// Apply idempotency middleware to all mutating operations
app.use(idempotencyMiddleware);

// Wallet routes
app.post(
    '/v1/wallets/:playerId/credit',
    validateBody(schemas.credit),
    credit
);

app.post(
    '/v1/wallets/:playerId/purchase',
    validateBody(schemas.purchase),
    purchase
);

app.get('/v1/wallets/:playerId', getWallet);

// Reward routes
app.post(
    '/v1/rewards/:rewardId/claim',
    validateBody(schemas.claimReward),
    claimReward
);

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'internal_error',
        message: 'An unexpected error occurred'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'not_found',
        message: 'Endpoint not found',
        path: req.path
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Game Economy Service listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});

export default app;
