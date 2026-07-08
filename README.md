# Durable Game Economy Service

A wallet/economy API for games with **exactly-once semantics**, **crash durability**, and **concurrency correctness**.

Built with Express.js and PostgreSQL.

## Features

- ✅ **Exactly-once semantics** — Duplicate requests produce one effect, same response
- ✅ **Crash durable** — Survives `kill -9` at any moment; committed state intact
- ✅ **Concurrent-safe** — No double-spends under concurrent load
- ✅ **Atomic operations** — Purchase debits balance and grants item atomically
- ✅ **Input-safe** — Validates all inputs; no crashes from malformed data

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Start PostgreSQL and the service
docker-compose up --build

# Service will be available at http://localhost:3000
# Health check: http://localhost:3000/health
```

### Manual Setup

1. **Start PostgreSQL**

```bash
docker run -d \
  --name game_economy_db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=game_economy \
  -p 5432:5432 \
  postgres:16-alpine
```

2. **Install dependencies**

```bash
npm install
```

3. **Run migrations**

```bash
npm run migrate
```

4. **Start the service**

```bash
npm start
```

## API Usage

### Credit Currency (Battle Payout)

```bash
curl -X POST http://localhost:3000/v1/wallets/player123/credit \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-uuid-here" \
  -d '{
    "amount": 100,
    "reason": "battle_win"
  }'
```

**Response:**
```json
{
  "playerId": "player123",
  "oldBalance": 0,
  "newBalance": 100,
  "credited": 100,
  "reason": "battle_win"
}
```

### Purchase Item

```bash
curl -X POST http://localhost:3000/v1/wallets/player123/purchase \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-uuid-here" \
  -d '{
    "itemId": "sword_01",
    "price": 50
  }'
```

**Response:**
```json
{
  "playerId": "player123",
  "oldBalance": 100,
  "newBalance": 50,
  "spent": 50,
  "item": {
    "id": "uuid",
    "itemId": "sword_01",
    "acquiredAt": "2024-01-15T10:30:00Z"
  }
}
```

**Insufficient Funds:**
```bash
# Returns 402 with error details
```

### Claim Reward

```bash
curl -X POST http://localhost:3000/v1/rewards/welcome_bonus/claim \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-uuid-here" \
  -d '{
    "playerId": "player123"
  }'
```

**Response:**
```json
{
  "playerId": "player123",
  "rewardId": "welcome_bonus",
  "claimedAt": "2024-01-15T10:30:00Z"
}
```

**Already Claimed:**
```bash
# Returns 409 with error details
```

### Get Wallet State

```bash
curl http://localhost:3000/v1/wallets/player123
```

**Response:**
```json
{
  "playerId": "player123",
  "balance": 50,
  "createdAt": "2024-01-15T10:00:00Z",
  "updatedAt": "2024-01-15T10:30:00Z",
  "inventory": [
    {
      "id": "uuid",
      "itemId": "sword_01",
      "acquiredAt": "2024-01-15T10:30:00Z"
    }
  ],
  "claimedRewards": [
    {
      "rewardId": "welcome_bonus",
      "claimedAt": "2024-01-15T10:15:00Z"
    }
  ]
}
```

## Testing

### Run All Tests

```bash
npm test
```

### Test Coverage

- **API tests** (`test/api.test.js`): Normal flow, validation, error cases
- **Critical tests** (`test/critical.test.js`):
  - Idempotency: Duplicate requests return same response
  - Concurrency: No double-spends under concurrent load
  - Crash recovery: State survives process restart
  - Input safety: Malformed inputs rejected

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the service |
| `npm run dev` | Start with hot-reload (node --watch) |
| `npm test` | Run all tests |
| `npm run migrate` | Run database migrations |
| `npm run docker:build` | Build Docker image |
| `npm run docker:run` | Run with docker-compose |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/game_economy` | Postgres connection string |
| `PORT` | `3000` | Service port |

## Architecture

- **HTTP Framework:** Express.js
- **Database:** PostgreSQL 16 with SERIALIZABLE isolation
- **Idempotency:** Client-provided keys, stored in database
- **Transactions:** SERIALIZABLE isolation with row locking

See [DESIGN.md](DESIGN.md) for detailed architecture documentation.

## Frontend Interface

A web-based UI is available for testing the API interactively.

### Using the Frontend

1. **Start the backend service** (using Docker or manual setup above)

2. **Open the frontend**
   - Simply open `frontend/index.html` in your browser
   - Or use a local server: `npx serve frontend`

3. **Features**
   - 💰 Credit wallet with custom amount and reason
   - 🛒 Purchase items (deducts balance, adds to inventory)
   - 🎁 Claim one-time rewards
   - 👛 View wallet state (balance, inventory, claimed rewards)

### Frontend Screenshot

The frontend provides:
- Interactive forms for each API endpoint
- Real-time response display
- Visual wallet display with balance, inventory items, and claimed rewards
- Configurable API URL (defaults to `http://localhost:3000`)

## License

MIT
