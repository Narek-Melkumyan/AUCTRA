# AUCTRA API

NestJS 12 · Prisma 7 (driver adapter `@prisma/adapter-pg`) · PostgreSQL 17 · Redis · Socket.IO · Vitest.

PostgreSQL is the single source of truth. Redis is only used for cross-instance Socket.IO
fan-out and shared rate-limit counters; losing it never loses or alters a bid.

> **AUCTRA is a portfolio demo marketplace.** Accounts, bidding, chat, notifications and the
> admin tools are real; **checkout is simulated** — there is no payment provider, no card
> data is ever accepted, and every payment record is flagged `simulated` (enforced by a
> database CHECK).

## Quick start

```bash
cd backend
cp .env.example .env            # fill in DATABASE_URL, secrets (openssl rand -base64 48)
npm install                     # also runs `prisma generate`
npm run db:migrate:deploy       # apply migrations (dev: `npm run db:migrate`)
npm run db:seed                 # roles, permissions, categories, config (safe everywhere)
npm run db:seed:demo            # + demo accounts/auctions (dev only, needs SEED_DEMO_PASSWORD)
npm run db:rotate-demo-passwords # apply a changed SEED_DEMO_PASSWORD to existing *@auctra.local accounts
                                # (dry run; add -- --apply — signs them out, never touches other accounts)
npm run db:seed:catalog         # demo catalogue (~230 lots): dry run; add -- --apply to create
npm run start:dev               # http://localhost:4000/api
```

Frontend: `cd frontend && cp .env.example .env.local`, set `VITE_API_MODE=api`, then `npm run dev`
(port 8080). With `VITE_API_MODE=demo` the original in-browser simulation still runs.

No local PostgreSQL? `POSTGRES_PASSWORD=… docker compose up -d` (Postgres on 5434, Redis on 6380).

| Command | Purpose |
| --- | --- |
| `npm run build` / `start:prod` | Compile (runs `prisma generate` first) / run `dist/main.js` |
| `npm run typecheck` / `lint` | `tsc --noEmit` / oxlint (type-aware) |
| `npm test` | Unit tests (no database) |
| `npm run test:e2e` | Integration tests against `DATABASE_URL_TEST` (name must end in `_test`) |
| `npm run db:migrate` | Create/apply migrations in development |
| `npm run db:migrate:deploy` | Apply committed migrations (CI/production) |
| `npm run db:migrate:status` | Show pending migrations |
| `npm run db:seed:catalog` | Idempotent demo-catalogue seed: dry run by default, `-- --apply` creates missing lots only (stable `seedKey`), photos from Wikimedia Commons via Sharp into storage under `demo-catalog/`, bids through the real engine; failures recorded in `storage/catalog-failures.json` and retried on the next run. Never touches non-demo data; refused in production |
| `npm run catalog:credits` | Regenerates `docs/catalog-image-credits.md` from the stored attribution data |
| `npm run admin:grant-role` | Audited, dry-run-first role grant for an existing account (bootstrap the first super admin; see [Roles](#roles)) |
| `npm run r2:smoke` | Live Cloudflare R2 check: upload, verify and delete labelled temporary objects ([docs](docs/media-storage.md#verifying-it)) |
| `npm run media:migrate` | Dry-run inventory / opt-in migration of existing images to R2 ([docs](docs/media-storage.md#existing-images)) |

Prepare the test database once: `DATABASE_URL=$DATABASE_URL_TEST npx prisma migrate deploy`.

## Architecture

```
src/
  config/        AppConfig — validated env, fails fast on weak/missing secrets
  prisma/        PrismaService (pg adapter, UTC sessions, dbNow())
  redis/         optional Redis connections
  auth/          register/login, refresh rotation, sessions, CSRF, email code+link verification, password reset, guards
  email/         EmailService + Resend provider, branded HTML/text templates
  roles/         permission catalogue + default role matrix (RBAC)
  users/         profile, preferences, addresses, seller application, public profiles
  categories/    category tree + custom attribute definitions
  auctions/      listings, state machine, lifecycle (activate/close/settle)
  media/         listing images: Sharp pipeline, upload API, cleanup worker
  storage/       StorageService: Cloudflare R2 (S3 API) driver, dev disk driver
  bids/          bidding engine
  outbox/        transactional outbox writer
  realtime/      Socket.IO gateway, Redis adapter, outbox relay
  jobs/          lifecycle worker (time-driven transitions, notifications, email, cleanup)
  notifications/ in-app notifications, preferences, email delivery worker, announcements
  chat/          per-auction live chat, spam limits, moderation (hide/delete/mute/ban)
  ai/            OpenAI Responses API assistants (user + admin), read-only tools, budgets
  engagement/    watchlist, favorites, reminders
  orders/        orders + simulated (demo) checkout — no payment provider by design
  admin/         analytics, users, sellers, auctions, reports, bid-integrity signals, audit log
  community/     reports, buyer↔seller messaging, disputes
  database/      reference data, seed, media migration script
```

### Money

All amounts are `BIGINT` minor units with an ISO-4217 `currency` column; there is no floating
point anywhere in the pipeline. JSON uses `{ "minor": "1250000", "currency": "USD" }` (strings, so
values above 2^53 survive). Bids reference `(auctionId, currency)` with a composite foreign key, so a
bid can never be recorded in another currency than its auction.

### Bidding (concurrency strategy)

`POST /api/auctions/:id/bids` with `Idempotency-Key` header and `{ "amountMinor": "…" }`:

1. **Pre-screen (lock-free, one statement / one snapshot)**: replays an earlier outcome for
   this key (bid → 200 with the original bid; recorded rejection → the same error), and
   rejects bids that are *already certain* to fail from monotonic facts: amount below the
   committed minimum (prices only rise), finished auction, own auction. Most of a burst
   ends here without touching the auction lock.
2. **Admission (per instance)**: `BidGate` queues bids FIFO per auction and caps total bid
   transactions (`BID_MAX_CONCURRENT_TX`, default pool − 3) so a hot auction can't drain
   the connection pool; queues are bounded (`BID_QUEUE_MAX_PER_AUCTION`) → retryable
   `503 AUCTION_BUSY`. At the head of the queue the pre-screen runs again.
3. **Locked transaction (READ COMMITTED)**: `SET LOCAL lock_timeout`; `SELECT … FOR UPDATE`
   on the auction row (its own statement); then a *new* statement — a fresh snapshot that
   sees everything committed while we waited — reads the auction, highest bidder, DB clock
   (`clock_timestamp()`) and any outcome already recorded for the key. Validation uses only
   that state: live window by DB time, seller ≠ bidder, minimum = start or current +
   increment, not already highest bidder.
4. **Write**: bid with `sequence = bidCount + 1` and `createdAt` = DB time, price/version
   update (guarded by `version`), lifecycle event(s), and two outbox rows (the broadcast and
   a notification job) — one commit. Notifications are built afterwards by `JobProcessor`,
   outside the lock. Rejections are committed as idempotency records instead
   (`synchronous_commit = off`: no side effects to protect).
5. Lock-wait/pool timeouts → `503 BID_SYSTEM_BUSY` with `Retry-After`; nothing was
   committed, so retrying with the same key is safe.

Rules: equal amounts → the first committed wins, the other gets `BID_TOO_LOW` with the new
minimum. A late worker never matters: an auction past `endsAt` rejects bids even if still
`LIVE` in the table. Bid acceptance never depends on Redis, email or AI.

### Lifecycle

```
DRAFT → PENDING_REVIEW → SCHEDULED → LIVE → ENDED → SOLD | UNSOLD
  ↑ reject ┘    (review can be disabled)        └→ CANCELLED (from any pre-ENDED state)
```
Transitions are enforced in `auction-state.ts`, guarded by an optimistic `version` check and the row
lock. The worker polls the database every second (`SKIP LOCKED`, so any number of instances is safe):
activate due auctions, close expired ones, settle ended ones (winner = highest bid if the reserve is
absent or met; one `orders` row per auction is guaranteed by a unique constraint), send ending-soon
notifications, reminders and email deliveries, and clean up expired tokens.

Default business rules (change deliberately): seller may cancel until the first bid; after that only
`auction:moderate`. Fee rates live in `system_config` (`fees.seller_commission_bps`,
`fees.buyer_premium_bps`) and ship as **0**. Anti-sniping is per auction and off unless the seller enables it.

### Realtime

Socket.IO at `/socket.io` (same origin as the API). Optional `auth: { token }` = access token.

* Client events (acknowledged, validated, token-bucket rate limited, ≤ 25 rooms/socket):
  `auction:join`, `auction:sync`, `auction:leave`, `time:sync`, `auth:refresh`.
* Server events: `auction:bid`, `auction:state` (both carry `eventId` and `version`),
  `auction:tick` (heartbeat with the authoritative version, every 10 s, emitted locally by
  each instance), `chat:message`/`chat:update`, `notification` (private `user:<id>` room),
  `auth:expired`.
* Ordering: the outbox relay publishes under a cluster-wide advisory lock in commit order.
  Clients apply only `version = held + 1`, ignore duplicates/older versions, and call
  `auction:sync` on a gap, after reconnecting, or when a heartbeat shows they are behind.
* `auction:join` joins the room *before* reading the snapshot, so no event can fall between
  them. Public snapshots are cached per instance for 1 s (invalidated by every auction
  event, in-flight requests de-duplicated) — thousands of joins cost a handful of queries.
* Auth runs as connection middleware; sessions are re-validated every 30 s (revoked
  session, ban, or access token expired for > 60 s → private room left, `auth:expired`);
  clients re-authenticate in place with `auth:refresh` after refreshing their token.
* With `REDIS_URL` set, emits reach sockets on every instance via the Redis adapter.
  Redis outages never block requests (commands fail fast, rate limiting falls back to
  per-instance counters, publishes are guarded); clients recover through heartbeats.
* Clock sync: `time:sync` answers from the DB clock offset (no query); the frontend takes
  the min-RTT of three samples. Countdowns are display only — the server decides.

### Operations

* `GET /api/health` (DB + Redis; `degraded` = 503), `GET /api/health/live`.
* `GET /api/metrics` (Prometheus; requires `Authorization: Bearer $METRICS_TOKEN`): bid
  outcomes/latency, row-lock wait, HTTP latency per route, socket connections, outbox lag,
  DB pool usage, Node CPU/memory/event-loop lag.
* Every response carries `X-Request-Id` (accepted from a proxy or generated); error bodies
  include `requestId`. Production logs are JSON; access logs with `LOG_HTTP=true`, 5xx and
  slow (> 1 s) requests always. Query strings, bodies and tokens are never logged.
* Graceful shutdown (SIGTERM): workers and relays finish their current batch, then the pool
  closes. A SIGKILL is also safe: every step is transactional and is redone by another
  instance.
* Load testing: see [`loadtest/README.md`](loadtest/README.md).

## Authentication

* **Access token**: HS256 JWT, 15 min (`JWT_ACCESS_TTL`), claims `sub`, `sid`, `typ`, `iss`, `aud`.
  Sent as `Authorization: Bearer`. Each request re-checks the session and loads roles/permissions
  from the database, so logout, bans and role changes apply immediately.
* **Refresh token**: opaque `"<id>.<secret>"` in an `HttpOnly; SameSite=Strict; Path=/api/auth`
  cookie (`Secure` in production). Only SHA-256(secret) is stored. Each refresh rotates it; the row is
  locked so concurrent refreshes serialise. Re-use of a rotated token revokes the whole session
  (family) — except within `REFRESH_RACE_GRACE_SEC`, where it returns `409 REFRESH_IN_PROGRESS` so two
  tabs refreshing together are not logged out. Sessions have an absolute (30 d) and idle (7 d) lifetime.
* **CSRF** (cookie endpoints only: register, login, refresh, logout): allowed-Origin check + signed
  double-submit token from `GET /api/auth/csrf`, echoed as `X-CSRF-Token`.
* **Passwords**: Argon2id (m=19 MiB, t=2, p=1), transparent rehash on login, 10–128 chars.
* **Brute force**: per-IP/user rate limits (Redis-backed when configured) + per-account lockout with
  exponential back-off; unknown e-mails cost the same Argon2 time as wrong passwords.
* **Email verification**: each request holds a link token (SHA-256 stored) **and** a 6-digit code
  (HMAC-SHA256 with a server-derived key, bound to the request id). Both expire after 15 min and share
  one `usedAt`, so using either retires both. 5 wrong codes void the request; resend (1/min, 5/day)
  issues new credentials and retires old ones. Signed-out code checks need the email and return a
  generic error (no account probing).
* **Password reset**: single-use, hashed, 30-minute link; `forgot-password` always answers 202 with
  the same body; a reset revokes every session; a password change revokes all other sessions.
* **Security alerts**: new-device sign-ins, password change/reset, refresh-token reuse and
  sign-out-everywhere create `ACCOUNT_SECURITY` notifications (in-app + email; cannot be disabled).

## Email (Resend)

`EmailService` sends through Resend when `RESEND_API_KEY` is set (`RESEND_FROM_EMAIL` must be on a
domain verified in Resend). Without a key the dev `log` provider prints messages to the server log
(development only) and reports **not delivered**. Auth emails are sent inline with one retry; all
other emails go through `notification_deliveries`: the worker claims due rows (`FOR UPDATE SKIP
LOCKED` + lease), sends outside any transaction, and records `SENT` (only when Resend accepted it),
`PENDING` with back-off (1 m, 5 m, 30 m, 2 h) for transient errors, `FAILED` for permanent ones, or
`SKIPPED` (no provider, unverified address, already read in-app, 12/hour cap, 10-minute coalescing).
Admins can review and requeue failed deliveries.

## Auction chat

`GET/POST /auctions/:id/chat`. Plain text ≤ 500 chars, control/zero-width characters stripped,
≤ 2 links. Limits per author: 5 messages/10 s, 20/2 min, no identical message within 60 s
(serialised with an advisory lock). Retries are idempotent via `clientMessageId`. Posting needs a
verified email, an active account and no active mute/ban; chat is open while the auction is
scheduled or live. Messages reach the room through the outbox (`chat:message` / `chat:update`; hidden
bodies are never broadcast); clients sync missed messages with `?after=<seq>`. Moderation actions are
stored in `moderation_actions` and the audit log.

## AI assistants

`POST /ai/chat?scope=user|admin` streams Server-Sent Events (`meta`, `tool`, `delta`, `done`,
`error`). The OpenAI key stays on the server; with no key every call answers `503
AI_NOT_CONFIGURED` and nothing is simulated. Each scope has its own allow-listed, read-only tools
(user: search/get auction, categories, platform rules, own bids; admin: analytics, trends, integrity
signals, moderation summary, users, auction performance, `propose_moderation_action`). Proposals are
cards a human must confirm — the assistant never executes actions. User-generated text is wrapped
as `untrusted_text`; arguments are validated server-side; emails/IPs are not sent to the provider.
Daily token budgets per user, per admin and platform-wide (`AI_*_DAILY_TOKENS`), input length limit,
12 requests/min, and usage rows in `ai_usage`. Conversations are stored in `ai_conversations`.

## Listing images (Cloudflare R2 + Sharp)

Sellers upload photos to `POST /auctions/:id/images` (multipart). The API checks ownership before
reading the body, verifies the real file type from its bytes, enforces size and pixel limits,
applies EXIF orientation and encodes three WebP variants (320 / 800 / 1600 px, never upscaled,
metadata stripped) in a bounded queue, then stores them in a Cloudflare R2 bucket via the S3 API
(AWS SDK v3) under `[MEDIA_KEY_PREFIX/]auctions/{auctionId}/{imageId}/{variant}.webp` with
immutable caching.
PostgreSQL keeps only metadata; R2 credentials never reach the browser. A cleanup-task table makes
partial uploads, failed replacements and crashes leave no orphaned objects. Setup, API, failure
handling and verification steps: [docs/media-storage.md](docs/media-storage.md);
`npm run r2:smoke` checks a real bucket end to end with labelled temporary objects. Without R2
credentials, development stores files on local disk (`MEDIA_STORAGE=local`, refused in production).

## Demo checkout

`GET /checkout/:auctionId` (winning bidder only) → `POST /orders/:id/demo-checkout` with an
`Idempotency-Key` and a delivery option (+ address when shipping). Under an order row lock the order
becomes `COMPLETED` with `demoCompletedAt` (never `paidAt`), and one `DEMO`/`simulated` payment
intent and charge are written (unique keys make duplicates impossible). Fee rates come from
`system_config` (`GET /checkout-terms`).

## API

All routes are under `/api`. Errors: `{ statusCode, code, message, details? }` with stable `code`s.

| Area | Endpoints |
| --- | --- |
| Health | `GET /health` (DB + Redis readiness), `GET /health/live` |
| Auth | `GET /auth/csrf`, `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/verify-email`, `POST /auth/verify-email/code`, `POST /auth/resend-verification`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/change-password` |
| Users | `PATCH /me/profile`, `PATCH /me/preferences`, `GET/POST /me/addresses`, `PATCH/DELETE /me/addresses/:id`, `POST /me/seller-application`, `GET /users/:handle` |
| Catalogue | `GET /categories`, `GET /categories/:slug` |
| Listing images | `GET/POST /auctions/:id/images`, `POST /auctions/:id/images/:imageId/replace`, `PATCH /auctions/:id/images/reorder`, `PATCH /auctions/:id/images/:imageId/primary`, `DELETE /auctions/:id/images/:imageId` |
| Auctions | `GET /auctions?phase=&category=&q=&sort=&page=&limit=`, `GET /auctions/:id`, `GET /auctions/:id/history`, `POST /auctions`, `PATCH /auctions/:id`, `POST /auctions/:id/submit`, `POST /auctions/:id/withdraw`, `POST /auctions/:id/cancel`, `GET /me/auctions` |
| Bids | `POST /auctions/:id/bids`, `GET /auctions/:id/bids`, `GET /me/bids` |
| Engagement | `GET /me/watchlist`, `PUT/DELETE /me/watchlist/:auctionId`, `GET /me/favorites`, `PUT/DELETE /me/favorites/:auctionId`, `GET/POST /me/reminders`, `DELETE /me/reminders/:id` |
| Notifications | `GET /me/notifications?before=&types=&unreadOnly=`, `POST /me/notifications/:id/read`, `POST /me/notifications/read-all`, `GET/PUT /me/notifications/preferences` |
| Chat | `GET/POST /auctions/:id/chat`, `POST /chat/messages/:id/report` |
| AI | `GET /ai/status`, `POST /ai/chat` (SSE), `GET /ai/conversations`, `GET/DELETE /ai/conversations/:id`, `GET /ai/usage` (admin) |
| Orders | `GET /me/orders`, `GET /orders/:id`, `GET /checkout-terms`, `GET /checkout/:auctionId`, `POST /orders/:id/demo-checkout` |
| Community | `POST /reports`, `GET/POST /conversations`, `GET /conversations/:id`, `POST /conversations/:id/messages`, `POST /orders/:id/disputes` |
| Admin | `GET /admin/analytics`, `GET /admin/integrity/bidding`, `GET /admin/auctions`, `GET /admin/auctions/:id`, `POST /admin/auctions/:id/cancel`, `GET /admin/users/:id`, `POST /admin/users/:id/sessions/revoke`, `GET /admin/chat/messages`, `POST /admin/chat/messages/:id/hide|delete|restore`, `GET/POST /admin/chat/restrictions`, `DELETE /admin/chat/restrictions/:id`, `GET /admin/chat/moderation-log`, `GET/POST /admin/notifications/announcements`, `GET /admin/notifications/deliveries`, `POST /admin/notifications/deliveries/:id/retry`, `GET /admin/auctions/review`, `POST /admin/auctions/:id/approve|reject`, `GET /admin/users`, `POST /admin/users/:id/suspend|unsuspend`, `POST /admin/users/:id/roles/grant|revoke`, `GET /admin/sellers/applications`, `POST /admin/sellers/:userId/decision`, `GET /admin/audit-logs`, `GET /admin/reports`, `POST /admin/reports/:id/decision`, `GET/POST /admin/categories`, `PATCH /admin/categories/:slug`, `GET /admin/orders`, `GET /admin/disputes`, `POST /admin/disputes/:id/decision` |

## Production checklist

* `NODE_ENV=production`, `COOKIE_SECURE=true`, HTTPS everywhere, `TRUST_PROXY_HOPS` set to your proxy depth.
* Strong, distinct `JWT_ACCESS_SECRET`, `CSRF_SECRET`, `IP_HASH_SALT` from a secret manager.
* `REDIS_URL` whenever more than one instance runs.
* Run `prisma migrate deploy` + `npm run db:seed` (reference data only) on release.
* Database least privilege: the app role needs `SELECT/INSERT/UPDATE/DELETE` on the schema only;
  run migrations with a separate owner role. No `CREATEDB`/superuser for the runtime role.
* `RESEND_API_KEY` + `RESEND_FROM_EMAIL` on a verified domain (`EMAIL_PROVIDER=log` is refused in
  production; use `disabled` to run without email).
* Optional `OPENAI_API_KEY` / `OPENAI_MODEL`; review the `AI_*_DAILY_TOKENS` budgets.
* Listing images: a dedicated R2 bucket, an API token scoped to it with Object Read & Write only,
  and `R2_PUBLIC_BASE_URL` on a custom domain (not r2.dev) — see `docs/media-storage.md`.
* Payments are intentionally simulated. Taking real money would need a real provider, webhook
  signature verification and removal of the demo checkout — out of scope for this demo.

## Roles

`USER` (bid, chat, AI assistant), `SELLER` (+ listings), `MODERATOR` (chat moderation, reports,
read users/auctions), `ADMIN` (+ analytics, suspensions, sellers, auctions, announcements, admin
AI, audit log, categories, orders, disputes), `SUPER_ADMIN` (+ role assignment, configuration).
Run `npm run db:seed` after upgrading so new permissions are synced.

The first super administrator is granted from the command line, since nobody holds
`role:assign` yet: `npm run admin:grant-role -- --email <existing account> --role SUPER_ADMIN`
(dry run; add `--apply`). It only promotes an existing, active, email-verified account, never
creates accounts or touches passwords and sessions, and writes a `role.grant` audit entry
(`metadata.via = "cli"`). Authorization stays purely data-driven — no email address appears in
code, so registering the same address elsewhere grants nothing.
