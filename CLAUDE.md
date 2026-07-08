# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

This is a take-home assessment for a backend developer position: building a **Durable Game Economy Service** — a wallet/economy API that must never lose or duplicate a player's money or items.

See `BRIEF_backend_developer.md` for the complete assignment specification.

## Core Requirements (Priority Order)

1. **Exactly-once semantics under retries** — Duplicate requests must produce exactly one effect and the same response. No double-credit, no double-debit, no double-grant. This is the single most important requirement.

2. **Durability across hard crashes** — The service must survive `kill -9` at any moment (including mid-purchase). After restart: committed operations are intact, in-flight operations are all-or-nothing, and retried requests still produce exactly one effect.

3. **Authoritative economy** — Server owns balances, prices, inventory. Balances never go negative. A client cannot assert its own balance or set a price it didn't pay.

4. **Concurrency correctness** — Many requests may hit the same wallet simultaneously. Two purchases racing a balance that affords only one must result in exactly one success — never a double-spend.

5. **Input safety** — Malformed, negative, or overflowing inputs must never crash the service or corrupt state.

## Mandated API Contract

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/v1/wallets/{playerId}/credit` | `{ "amount": int>0, "reason": str }` | Add currency (battle payout simulation) |
| POST | `/v1/wallets/{playerId}/purchase` | `{ "itemId": str, "price": int>0 }` | Atomically debit price AND grant itemId |
| POST | `/v1/rewards/{rewardId}/claim` | `{ "playerId": str }` | Grant reward once per player (claim-once) |
| GET | `/v1/wallets/{playerId}` | — | Return balance, inventory, claimedRewards |

All mutating endpoints must be idempotent. Purchase must be atomic: insufficient funds = clean rejection with no partial effect.

## Deliverables

- `README.md` — Build & run instructions, curl examples
- Automated tests — Including concurrent/duplicate request tests and crash-recovery tests
- `DESIGN.md` — Datastore choice, idempotency strategy, atomicity/durability strategy, API contract details
- `RESILIENCE.md` — How to maintain exactly-once when item grant is a separate inventory service (outbox/saga/compensation), plus how to detect/correct a past double-grant bug
- `AI_DISCLOSURE.md` — Honest declaration of AI tool usage
- Runnable service in Docker

## Architecture Decisions to Make & Document

- Datastore choice (SQL, key-value, embedded) and justification
- Idempotency-key strategy (generation, retention, deduplication mechanism)
- Atomicity boundaries (what is atomic, what happens on crash mid-purchase)
- Isolation level for concurrent balance operations
- Error codes, status codes, and limits

## Trade-off Priority

When forced to choose: **exactly-once + crash-durable correctness > working code & tests > judgment/justification > extra features**
