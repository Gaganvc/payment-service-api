# Backend Developer — Take-Home Assessment (Durable Game Economy Service)

_Please read this whole document carefully before you start._

## Purpose

This task lets us see how you actually build and reason about a backend that satisfy our requirement: **must never lose or duplicate a player's money or items**. It is a **screening step**: based on your submission we decide whether to move forward. It is **not a speedrun** — make good use of the time. We care, in order, about **exactly-once correctness under crashes & retries, working code, sound judgment, then extras**. A smaller service that never double-spends and survives a hard kill beats a feature-rich one that loses a coin under load.

## What to build

A **runnable wallet/economy service** that sits behind a game. Implement the slice **from a player earning currency, through spending it in a shop, through claiming a one-time reward.** The battle game itself is **out of scope** — `earn` simply simulates a battle payout. Everything else (accounts, matchmaking, the actual gameplay) is out of scope.

## Stack

**Your choice** of language and runtime. **Your choice of datastore** (SQL, key-value, embedded, or your own storage) — but **pick what you'd actually reach for, justify it, and make it genuinely survive a crash.** Use whatever tool you see fit, but don't go overboard with premade tool. What we grade is that you **understand** why your choice is correct: isolation, durability, and how a duplicate request is deduplicated. "I used Postgres" without understanding will guarantee a fail test.

## The API contract (mandated minimum — do not remove the fields)

So we can exercise every submission identically, your service **must** expose exactly this HTTP contract. You choose everything behind it; the wire shape is fixed.

Multiple **duplicated** requests must apply the effect **exactly once** and receive the **same response** as the first time.

| Method & path | Body | Effect |
|---|---|---|
| `POST /v1/wallets/{playerId}/credit` | `{ "amount": int>0, "reason": str }` | Add currency (simulates a battle payout). |
| `POST /v1/wallets/{playerId}/purchase` | `{ "itemId": str, "price": int>0 }` | **Atomically** debit `price` and grant `itemId` to the player's inventory. Insufficient funds → a well-defined rejection with **no partial effect**.|
| `POST /v1/rewards/{rewardId}/claim` | `{ "playerId": str }` | Grant a reward **once per player** (claim-once) |
| `GET /v1/wallets/{playerId}` | — | Return `{ "balance": int, "inventory": [...], "claimedRewards": [...] }`. Read-only; used to assert state. |

Choose and document: the success/error status codes, the exact response bodies, currency/price units, and any limits. Keep it minimal and consistent.

## Core requirements

1. **A runnable service** in Docker, with a clear Dockerfile (a `docker-compose.yml` is fine if your datastore needs a container) and source code.

2. **Exactly-once under retries (read this twice).** A client that sends the same mutating request twice must produce **one** effect and the **same** response. No double-credit, no double-debit, no double-grant. This is the single most important thing we evaluate, alongside durability. Make your strategy explicit in the code and in `DESIGN.md`.

3. **Durability across a hard crash (read this twice too).** Assume the process is killed with `kill -9` at **any** moment — including the middle of a purchase. After restart: every **committed** operation is intact, every **in-flight** operation is **all-or-nothing** (never a debit without its grant, never a grant without its debit), and a request **retried after the crash** still produces exactly one effect. State must outlive the process.

4. **Authoritative economy.** The **server** owns balances, prices, and inventory. A client cannot assert its own balance or set a price it didn't pay. Balances never go negative; spending more than you have is rejected cleanly.

5. **Concurrency correctness on a balance.** Many requests hit the **same wallet at the same time.** Two purchases racing a balance that affords only one must result in **exactly one** success — never a double-spend, a lost update, or a negative balance.

6. **Input safety.** Malformed, oversized, negative, or overflowing inputs (`amount: -5`, a huge number, garbage JSON, a missing key) must never crash the service or corrupt a wallet. Validate at the boundary.

## Deliverables (in the repo) - At a Minimum

- **Runnable service** with a **README** giving exact build & run instructions and how to exercise it (curl examples or a small script against the contract above).
- **Automated tests** — including at least one test that exercises **concurrent and duplicate requests on the same wallet**, and ideally one that **kills and restarts** the service and asserts no money/items were lost or duplicated. We want meaningful tests, not coverage theatre.
- **`DESIGN.md`** — architecture; your **datastore choice and why**; your **non-duplicate strategy** (how a duplicate key is deduplicated, and for how long keys are retained); your **atomicity & durability strategy** (what is atomic, what happens on `kill -9` mid-purchase, your isolation level); the API contract details you chose; and any limits.
- **`RESILIENCE.md`** — Assume the **item grant moves to a separate inventory service**, reached over an API that can **time out, fail, or process your request twice**, and which **cannot share a transaction** with your currency store. How do you keep a purchase **exactly-once** end-to-end? Name the partial-failure window and your approach (e.g. outbox, saga, compensation). As a sub-question: a bug **double-granted currency to some players last week** — without downtime, how do you **detect and correct** it, and what invariant or audit trail would have caught it sooner? One page is plenty; reasoning matters more than length.
- **`AI_DISCLOSURE.md`** — your honest declaration of any AI-tool use (see below).

## Deliberately your call (we want to see you decide)

Several things are intentionally under-specified — your datastore, your isolation level, your idempotency-key retention, how you represent the ledger, your error codes and limits. **Make a decision, implement it, and justify it in `DESIGN.md`.** "It depends" without a choice scores low; a clear decision with trade-offs scores well even if we'd have chosen differently.

## Using AI tools (disclosure required)

We ask for **honesty**: include `AI_DISCLOSURE.md` stating which tools you used, where, and roughly how much. We read the code, the git history, and your docs and compare them against your disclosure — and against each other. **A doc that claims behavior the code doesn't implement is a bigger problem than a missing feature.** For a senior role, integrity matters as much as skill.

## Process & git

- Create your **own public** git repo with a deliberately **obscure name** that doesn't reveal the task.
- **First commit must be an empty/skeleton project**, marking your start. Don't push finished code as the first commit.
- Commit **frequently** with **meaningful messages** — we read the history.

## Priorities

When you must trade off: **exactly-once + crash-durable correctness > working code & tests > judgment/justification > extra features.**

## Time limit

2 days (≈16 work-hours) from when you receive this document, **+ 8 hours**, ending when we receive your repo link by email. Create the repo with an empty README to mark your start time.

## After you submit

When you send the submission, attach a cover letter about your work, recap what you learned (if you learned nothing new, just state that), what do you think the test is about, and what responsibility do you think the role + level you're applying for will require?

If anything is unclear, ask — that's encouraged.
