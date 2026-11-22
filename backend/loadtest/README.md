# AUCTRA load & concurrency harness

Reproducible scenarios for the bidding engine, real-time fan-out and failure recovery.
Everything goes through the real HTTP API and Socket.IO server; correctness is then
checked **directly in PostgreSQL** (`verify.mjs`), never from API responses alone.

Why a Node harness instead of k6/Artillery: the scenarios need to mint tokens for real
sessions, mirror the frontend's versioned-event logic in every viewer, start/kill API
instances and Redis mid-test, and query the database for invariants. A small Node
harness built on the project's own dependencies (`pg`, `socket.io-client`,
`jsonwebtoken`, built-in `fetch`) does all of that without extra binaries.

## Setup (once)

```bash
cd backend
# A dedicated database — the harness refuses names that don't end in _load/_test.
psql "$ADMIN_URL" -c 'CREATE DATABASE auctra_load'
DATABASE_URL=postgresql://auctra:…@localhost:5432/auctra_load npx prisma migrate deploy
DATABASE_URL=postgresql://auctra:…@localhost:5432/auctra_load npm run db:seed
# A dedicated Redis (scenario G stops and restarts it).
redis-server --port 6390 --save '' --appendonly no &
npm run build
```

## Run

```bash
export LOAD_DATABASE_URL=postgresql://auctra:…@localhost:5432/auctra_load
export LOAD_REDIS_URL=redis://localhost:6390
node loadtest/run.mjs A B C D E F G --out loadtest/results/run.json
```

Options: `--cburst 1000` (size of scenario C's burst), `--pool 25` (DATABASE_POOL_MAX
for the API instances), `--viewers 100,1000,5000,10000` (scenario E milestones),
`--dsecs 20` (scenario D duration per phase).

The harness starts its own API instances from `dist/main.js` in production mode on
ports 4101/4102 (both run the lifecycle worker and outbox relay), with
`METRICS_TOKEN` set so it can scrape `/api/metrics` after each scenario.

| | Scenario | Checks |
|---|---|---|
| A | 2 users bid the same amount at once, 25 rounds | exactly one accepted, the other `BID_TOO_LOW` |
| B | 10 bidders around $45k, every request sent 3× concurrently with one key | same outcome per key, key reuse → 409, invariants |
| C | burst of N bids from N users (+10% duplicate retries) | no 5xx, every 201 is in the DB once, invariants |
| D | 50 auctions × 10 bidders, then + a hot auction bursting 100 bids every 3 s | throughput/latency of independent auctions with and without the hot one |
| E | 100 → 1,000 → 5,000 → 10,000 (→ 20,000) viewers in one room | join time, delivery completeness and latency per event, server CPU/RSS |
| F | viewers on instance 2, bids on instance 1 | cross-instance delivery via Redis, versions match the DB |
| G | Redis outage; SIGKILL during a burst; disconnect/reconnect; deadline during bidding; kill during settlement | committed state stays correct; clients converge |

Database invariants checked after every scenario (`verify.mjs`): valid bidder; amounts
follow the minimum-bid rule in sequence order; contiguous unique sequences;
highest bid = last accepted bid; no bid at/after the deadline; unique idempotency keys;
SOLD only to the highest bidder at/above the reserve with exactly one order; no
outbox events stuck unpublished.

Results are written as JSON (latency p50/p95/p99, outcome counts, throughput, CPU/RSS
samples, scraped server metrics). The numbers in the project report come from these
files on a single development machine — they are **not** production capacity figures.
