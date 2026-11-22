# AUCTRA auction engine — concurrency, real-time & scalability report

Date: 2026-11-15 · Environment: one MacBook (10 CPU cores, 16 GB RAM), Node 24.12,
PostgreSQL 17 (Homebrew), Redis 8 (separate instance on :6390 for tests), API built with
`npm run build` and run in production mode. **All numbers below were measured on this one
machine, with load generator, database, Redis and API instances sharing its CPUs. They
are not production capacity figures.**

## 1. Original architecture (as audited)

* Bids: `POST /auctions/:id/bids` → READ COMMITTED transaction → `SELECT … FOR UPDATE` on
  the auction row → re-read auction + DB clock → validate → insert bid
  (`sequence = bidCount + 1`), update price/version, auction event, outbox event, and the
  NEW_BID/OUTBID notifications (each `notifyMany` = 5 statements) — all under the lock.
* Idempotency: unique `(bidderId, idempotencyKey)`; replay of accepted bids only.
* Lifecycle worker (activate/close/settle with `SKIP LOCKED`), unique order per auction.
* Outbox relay → Socket.IO (+ Redis adapter); clients apply events by `version` and resync
  on gaps.

Correctness core was sound: baseline scenarios A–C and D showed no invariant violations.

## 2. Bugs and bottlenecks found

| # | Finding | Evidence | Severity |
|---|---|---|---|
| 1 | **Redis outage took the API down.** Rate-limit calls waited forever on the offline queue; the Socket.IO adapter's un-handled `publish()` rejections then crashed the process. | Baseline G1: 4/5 bids failed during the outage and the instance was dead afterwards. | Critical |
| 2 | Retrying a **rejected** request re-evaluated it instead of returning the original result (e.g. `ALREADY_HIGHEST_BIDDER` could later turn into an accepted bid under the same key). | Code audit. | High |
| 3 | `auction:join` read the snapshot **before** joining the room: an event committed in between was lost for that client. | Code audit; covered by a new test. | High |
| 4 | Every authenticated request ran **~6 queries** (nested Prisma include session→user→roles→permissions). | Metrics: 422s averaged 218 ms while the bid logic itself took ~0 ms. | High (perf) |
| 5 | A hot auction could take **every pooled connection** (each waiting bid held one while blocked on the row lock), starving other auctions and reads. | Code audit + pool metrics. | High (perf) |
| 6 | Lock-wait / pool timeouts surfaced as **500**s. | Code audit. | Medium |
| 7 | Bid notifications (≈10 statements) ran **inside** the locked transaction. | Code audit. | Medium (perf) |
| 8 | Several relays could publish batches **out of order** (multi-instance). | Code audit. | Medium |
| 9 | Each viewer join cost 3–4 queries; 10,000 joins took 18 s with 5,084 handshake retries. | Baseline E. | Medium (perf) |
| 10 | Sockets kept their private user room after the session was revoked or the token expired. | Code audit. | Medium |
| 11 | Frontend: a retry generated a **new** idempotency key; a slow join snapshot could overwrite newer state; clock sync ignored RTT; no heartbeat to detect events lost in a Redis outage. | Code audit. | Medium |
| 12 | No request IDs, metrics endpoint, or graceful wait for in-flight worker/relay batches. | Code audit. | Low |

## 3. Changes implemented

**Bidding** (`src/bids/bids.service.ts`, `src/bids/bid-gate.ts`)
* Lock-free **pre-screen** (one statement = one snapshot): replays existing outcomes and
  rejects bids already doomed by *monotonic* facts (amount below the committed minimum,
  finished auction, own auction). Prices only rise and final states never revert, so the
  locked path could only agree. Repeated at the head of the queue.
* **BidGate**: per-instance FIFO per auction + global cap on bid transactions
  (`BID_MAX_CONCURRENT_TX`, default pool − 3) + bounded queue (`BID_QUEUE_MAX_PER_AUCTION`
  → retryable `503 AUCTION_BUSY`). A performance guard only; correctness is the row lock.
* Locked path: `SET LOCAL lock_timeout`; lock statement; then a fresh-snapshot statement
  reading auction + highest bidder + DB clock + recorded outcome for the key; bid
  `createdAt` = DB time under the lock; version-guarded update; outbox broadcast + a
  **notification job** in the same commit.
* **Rejected outcomes are recorded** in `idempotency_keys` (`synchronous_commit = off`;
  nothing to protect) → retries return the same answer; different parameters →
  `409 IDEMPOTENCY_KEY_REUSED`.
* Lock-wait/pool timeouts → `503 BID_SYSTEM_BUSY` + `Retry-After` (nothing committed).

**Jobs** (`src/notifications/job-processor.service.ts`): outbox rows with
`aggregateType = 'job'` are executed outside the auction lock (`FOR UPDATE SKIP LOCKED`,
marked done in the same transaction, exponential back-off, dead-letter kept visible).

**Real-time** (`src/realtime/*`)
* Relay publishes under a cluster-wide advisory lock → commit order across instances; skips
  job rows; records commit→publish lag.
* `auction:tick` heartbeat (every 10 s, local emit per instance, one query) so idle rooms
  detect missed events even if Redis dropped a publish.
* Join **then** snapshot; per-instance 1 s snapshot cache with in-flight de-duplication,
  invalidated on every auction event on **all** instances (`serverSideEmit`); signed-in
  viewers personalised in memory + one query; `time:sync` from a measured DB-clock offset.
* `auth:refresh` (re-authenticate without reconnecting) and a 30 s session sweep
  (revoked session / ban / expired token → leave private room, `auth:expired`).

**Redis** (`src/redis/redis.service.ts`, `src/common/throttling.ts`, `src/realtime/io.adapter.ts`)
* Commands fail fast (`disableOfflineQueue`, except the subscriber, whose SUBSCRIBEs must be
  replayed), capped reconnect back-off, API boots without Redis, publish/subscribe calls
  guarded, throttler: 150 ms timeout then **per-instance in-memory limits** (never
  unlimited), destroy-on-shutdown for clients stuck reconnecting.

**Auth** (`src/auth/access-token.service.ts`): one SQL statement per request (session,
user, roles, permissions) — still read every request, so revocations are immediate.

**Database pool** (`src/prisma/prisma.service.ts`): owned `pg.Pool` (exposed for metrics),
`connectionTimeoutMillis` 5 s, `statement_timeout` 15 s, UTC sessions.

**Operations**: Prometheus `/api/metrics` (token-protected), `X-Request-Id` correlation,
JSON logs in production, access log with `LOG_HTTP=true` (5xx/slow always),
`unhandledRejection` logged instead of crashing, graceful shutdown awaits the worker tick,
relay batch and job batch.

**Frontend** (`frontend/src/lib/api/live.ts`, `services/api.ts`, `routes/room.$id.tsx`):
version-guarded join snapshots, `eventAction` ordering rule, heartbeat resync,
`auth:refresh` on token rotation and on `auth:expired`, NTP-style clock offset (min-RTT of
3 samples), one idempotency key per *logical* bid reused for automatic retries
(503/network) and manual retries, bidding disabled the moment the synced countdown hits 0.
No optimistic acceptance: a bid is shown only after the server confirms it.

## 4. Files

New: `src/bids/bid-gate.ts`, `src/metrics/metrics.service.ts`,
`src/notifications/job-processor.service.ts`, `src/common/request-context.ts`,
`test/engine.e2e-spec.ts`, `loadtest/{lib,run,verify,viewer-worker}.mjs`,
`loadtest/README.md`, `frontend/src/test/realtime-consistency.test.ts`, this report.

Modified: `src/bids/bids.service.ts`, `src/realtime/{auctions.gateway,outbox-relay.service,io.adapter}.ts`,
`src/redis/redis.service.ts`, `src/common/{throttling,errors}.ts`,
`src/common/filters/all-exceptions.filter.ts`, `src/auth/access-token.service.ts`,
`src/prisma/prisma.service.ts`, `src/config/app-config.ts`, `src/outbox/outbox.service.ts`,
`src/jobs/lifecycle.worker.ts`, `src/auctions/{auctions.service,auctions.module}.ts`,
`src/notifications/notifications.module.ts`, `src/app.module.ts`, `src/bootstrap.ts`,
`src/main.ts`, `test/auth.e2e-spec.ts`, `.env.example`, `README.md`;
frontend `src/lib/api/{live,adapters}.ts`, `src/services/api.ts`, `src/routes/room.$id.tsx`.

## 5. Database migrations

**None were needed.** The work reuses the existing `idempotency_keys` table (unique
`(userId, scope, key)`), `bids (bidderId, idempotencyKey)` and `(auctionId, sequence)`
uniques, and the partial pending-outbox index. No data was changed or deleted; load tests
ran in a separate `auctra_load` database.

## 6. Concurrency protections (summary)

Row lock per auction (all instances) · fresh-snapshot read after the lock · DB clock for
deadlines and bid timestamps · sequence unique per auction · version-guarded writes ·
per-key outcome records (bids and rejections) with unique constraints · monotonic
pre-screen · bounded per-instance admission · lock/statement/pool timeouts → retryable
503 · `SKIP LOCKED` workers · unique order per auction · outbox in the same commit.

## 7. Redis and Socket.IO architecture

Rooms `auction:<id>`, `user:<id>`. Redis carries only cross-instance fan-out (adapter),
cross-instance cache invalidation, and shared rate-limit counters. PostgreSQL is the only
authority; the outbox guarantees at-least-once publication of every committed change;
versions + heartbeats + `auction:sync` make clients converge after duplicates, gaps,
reconnects or Redis outages.

## 8. Test results (all executed)

| Suite | Result |
|---|---|
| Backend typecheck / lint | clean / 0 errors (warnings only) |
| Backend unit (Vitest) | 20 / 20 |
| Backend integration (real PostgreSQL; Redis where noted) | **128 / 128** in 13 files, incl. new `engine.e2e-spec.ts` (16) |
| Backend production build | OK |
| Frontend typecheck / lint / tests / build | clean / 0 errors / **37 / 37** / OK |

`engine.e2e-spec.ts` covers: 100 concurrent bidders (invariants 1–4, every 201 stored
exactly once); two API instances racing; equal amounts; 20 concurrent retries of one key;
rejected-request replay after the auction moved on; bids across the deadline; settlement
racing on two instances (one SOLD, one order); reserve not met; injected failure → no
partial writes then retry succeeds; held row lock → `503 BID_SYSTEM_BUSY` with
`Retry-After`; bounded queue → `503 AUCTION_BUSY`; Redis unreachable → bids correct,
health degraded, local rate limiting; restart → latest state; missed events → resync;
heartbeat; join/snapshot ordering under concurrent bids; notification jobs exactly once.

## 9. Load-test measurements (observed)

Raw JSON: `loadtest/results/` — `baseline-ABC.json`, `baseline-DEFG.json` (before the changes); `final-pool10.json` (A, B, D, E), `final-CFG.json` (C), `final-FG.json` (F, G), `after-C1000.json` / `after-C1000-pool25.json` (1,000-bursts), `diag-C1000.json` (server-metrics diagnosis).
Pool = 10 connections per instance unless stated.

**A — 2 simultaneous bidders, same amount, 25 rounds:** 25/25 rounds exactly one accepted,
loser `BID_TOO_LOW` with the new minimum. p50 5.9 ms, p95 25.9 ms. 0 violations.

**B — 10 bidders around $45,000, each request sent 3× concurrently:** accepted in DB order
`$45,000 → $45,500 → $46,000 → $47,000 → $48,000`; 8 replays (200), 18 `BID_TOO_LOW`;
every key had one consistent outcome; key reuse with another amount → `409`. p95 56.5 ms.

**C — bursts against one auction (incl. 10 % duplicate retries):**

| Burst | Pool | Server errors | Shed (503, retryable) | Throughput | p50 | p95 | p99 | Invariants |
|---|---|---|---|---|---|---|---|---|
| 100 (+10) | 10 | 0 | 0 | 544 req/s | 158 ms | 195 ms | 198 ms | OK |
| 1,000 (+100), gate only (intermediate run; its JSON was overwritten) | 10 | 0 | 0 | 263 req/s | 789 ms | 4,134 ms | 4,165 ms | OK |
| 1,000 (+100), final | 10 | 0 | 0 | **513 req/s** | 483 ms | **2,101 ms** | 2,133 ms | OK |
| 1,000 (+100), final | 25 | 0 | 87 `AUCTION_BUSY` | **931 req/s** | 512 ms | 1,121 ms | 1,170 ms | OK |

In the 1,000-burst, server metrics showed 999 of 1,001 decisions made by the lock-free
pre-screen and a total row-lock wait of 2.2 ms; the remaining time is request handling on a
single Node process (≈ 1.4 ms CPU per request) and pool queueing — i.e. horizontal scaling
territory, not lock contention.

**D — 50 auctions × 10 bidders (500 users, 2 instances, 20 s per phase):**

| Phase | Requests | Server errors | p50 | p95 | p99 |
|---|---|---|---|---|---|
| Steady | 3,648 | 0 | 4.3 ms | 8.7 ms | 18.6 ms |
| + hot auction bursting 100 bids / 3 s | 3,649 | 0 | 4.1 ms | 8.5 ms | 18.1 ms |
| (the hot auction itself) | 700 | 0 | 66.6 ms | 90.7 ms | 94.5 ms |

Independent auctions were unaffected by the hot one. (Throughput is bounded by the
harness's think time, chosen to stay under the 30 bids/min/user rate limit.)

**E — viewers in ONE auction room, one API instance, 10 events each:**

| Viewers | Joined | Join wall time | Delivered | Delivery p50 | p95 | p99 | Server peak RSS / CPU |
|---|---|---|---|---|---|---|---|
| 100 | 100 | 0.18 s | 1,000/1,000 | 19.7 ms | 27.5 ms | 28.7 ms | 430 MB / 9 % |
| 1,000 | 1,000 | 0.37 s | 10,000/10,000 | 26.7 ms | 40.2 ms | 43.4 ms | 438 MB / 49 % |
| 5,000 | 5,000 | 2.2 s | 50,000/50,000 | 39.3 ms | 58.4 ms | 64.4 ms | 511 MB / 114 % |
| 10,000 | 10,000 | 8.8 s | 100,000/100,000 | 59.0 ms | 85.7 ms | 96.4 ms | 700 MB / 145 % |
| 10,000 (baseline, before) | 10,000 | 18.0 s | 100,000/100,000 | 62.2 ms | 113.3 ms | 157.3 ms | 966 MB / 140 % |

Delivery latency = HTTP bid sent → event received by each viewer. 20,000 viewers could
not be measured: the single load-generating machine ran out of ephemeral ports
(`EADDRNOTAVAIL`, ~16k per source address) — a client-side limit, not a server failure.

**F — two instances:** 500 viewers on instance 2, bids on instance 1: 5,000/5,000 events
delivered via Redis, p50 32 ms, p95 66 ms; every viewer at the DB version.

**G — failure recovery:**
* Redis stopped during bidding: 5/5 bids accepted (201), no violations; after restart
  viewers on the other instance converged ≈ 3.2 s later (of which 3 s was the harness's
  wait for the adapter to reconnect).
* SIGKILL of an instance mid-burst (killed after the first responses): 1 accepted + 14
  rejected before the kill, 85 network failures; all 85 retried with their original keys
  on instance 2 got consistent answers; **0 acknowledged bids missing**, 0 violations.
* 200 viewers disconnected, 5 bids, reconnect: 200/200 at the DB version in 51 ms.
* Deadline during 913 concurrent bids on both instances: 0 server errors, 60
  `AUCTION_ENDED`, no bid at/after the deadline, settled SOLD once with one order.
* Instance killed while 30 auctions settled: after restart 30/30 SOLD, 30 orders, 0 violations.
* Outbox commit→publish lag (G run): 120 events, mean 1.9 ms.

## 10. Known limitations

* Measurements come from one laptop; the generator competes with the server for CPU.
  **No claim of 50,000 concurrent viewers is made** — 10,000 in one room on one instance
  was the largest measured; 20,000 was blocked by the client's port range.
* One Node process saturates around 500–900 bid requests/s (CPU), so bigger bursts queue;
  the queue is bounded and sheds with retryable 503s.
* Viewer counts per room are per instance (lower bound with several instances).
* During a Redis outage cross-instance events are lost (Redis pub/sub is not durable);
  clients converge within the 10 s heartbeat or on the next event. Bids are unaffected.
* Rejection records use asynchronous commit: after a database crash a just-recorded
  rejection may be lost (a retry is then re-evaluated; it can never create a duplicate bid).
* A retried *rejected* request is replayed for 24 h (idempotency record expiry).
* Rate limiting falls back to per-instance counters while Redis is down (limits are then
  per instance, not global).

## 11. Recommended deployment topology

```
            Load balancer (sticky not required; WebSocket upgrade enabled)
                  │
   ┌──────────────┼──────────────┐
 API 1          API 2          API N      (stateless NestJS; each: HTTP + Socket.IO +
   │              │              │         worker + relay + job processor)
   └──────┬───────┴───────┬──────┘
          │               │
   PgBouncer (transaction pooling)     Redis (adapter, rate limits, invalidation)
          │
   PostgreSQL primary (+ replica for analytics/admin reads)
```

* Size `DATABASE_POOL_MAX` per instance × instances ≤ PgBouncer pool; keep
  `BID_MAX_CONCURRENT_TX` below the pool to protect reads.
* Scale API instances on CPU; each comfortably held 10,000 sockets here (≈ 700 MB RSS).
  For 50,000 viewers plan ≥ 5–8 instances and **load-test that topology with distributed
  load generators** before relying on it.
* Raise OS limits (file descriptors, `somaxconn`) and the load balancer's idle timeouts
  (> 25 s ping interval).
* Scrape `/api/metrics`; alert on `auctra_bid_requests_total{outcome=~"BID_SYSTEM_BUSY|AUCTION_BUSY"}`,
  `auctra_db_pool_connections{state="waiting"}`, outbox lag, event-loop lag and 5xx.

## 12. Reproduce

```bash
cd backend
npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run build
npx vitest run --config ./vitest.config.e2e.ts test/engine.e2e-spec.ts   # engine invariants only

# load tests (see loadtest/README.md for one-time setup of auctra_load + Redis :6390)
export LOAD_DATABASE_URL=postgresql://auctra:…@localhost:5432/auctra_load
export LOAD_REDIS_URL=redis://localhost:6390
node loadtest/run.mjs A B C D E F G --viewers 100,1000,5000,10000 --out loadtest/results/run.json
node loadtest/run.mjs C --cburst 1000 --pool 25 --out loadtest/results/c1000.json

cd ../frontend && npm run typecheck && npm run lint && npm test && npm run build
```
