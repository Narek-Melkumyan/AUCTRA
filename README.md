<div align="center">

# AUCTRA

**A real-time auction marketplace**

A full-stack auction platform engineered for concurrent bidding, real-time updates,
and reliable distributed systems.

<p>
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-12-E0234E?style=flat-square&logo=nestjs&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white">
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-7-2D3748?style=flat-square&logo=prisma&logoColor=white">
  <img alt="Redis" src="https://img.shields.io/badge/Redis-pub%2Fsub-DC382D?style=flat-square&logo=redis&logoColor=white">
  <img alt="Socket.IO" src="https://img.shields.io/badge/Socket.IO-4-010101?style=flat-square&logo=socketdotio&logoColor=white">
</p>

<a href="#product-showcase">Showcase</a> ·
<a href="#how-real-time-bidding-works">Bidding engine</a> ·
<a href="#performance-and-load-testing">Benchmarks</a> ·
<a href="#getting-started">Getting started</a> ·
<a href="#api-overview">API</a>

<br>

<img src="docs/screenshots/homepage.webp" alt="AUCTRA homepage with live auctions" width="100%">

</div>

---

## Overview

AUCTRA is a live auction marketplace for cars, watches, jewelry, art, real estate and
collectibles. Bidders join an auction room, watch the price move in real time, chat in the room,
message sellers privately, and compete against a countdown that the **server** controls. When an
auction closes, the winner is determined automatically and completes a (simulated) checkout.
Sellers list items with photo uploads, staff moderate everything from an operations dashboard, and
a demo catalogue of about 230 lots — illustrated with freely licensed Wikimedia Commons photos —
makes the marketplace feel alive.

I built it as a portfolio project to work through problems that simple CRUD apps never reach:

- **Many people bidding on the same lot at the same instant.** Every bid must be validated
  against the latest price, applied exactly once, and ordered deterministically.
- **Deadlines that can't be gamed.** The database clock decides when an auction ends, not a
  browser or a background job that happens to run late.
- **Real-time updates that stay correct.** Events are published only after the data is
  committed, survive process crashes, and let clients recover from missed or duplicated messages.
- **Running more than one server.** Several API instances share PostgreSQL and Redis, and their
  results stay consistent.

> **Demo platform.** AUCTRA demonstrates real engineering, but it is not a commercial
> marketplace. **No real payments are processed.** Checkout is simulated: no card data is
> collected and every payment record is flagged as simulated at the database level.

## Product showcase

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/marketplace.webp" alt="Auction marketplace with filters"><br><sub><b>Marketplace</b> — live and upcoming lots, category and price filters, server-synced countdowns</sub></td>
    <td width="50%"><img src="docs/screenshots/auction-room.webp" alt="Live auction room"><br><sub><b>Auction room</b> — current bid, minimum next bid, reserve status, pseudonymous bid history</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/category-filter.webp" alt="Marketplace filtered to live watch auctions"><br><sub><b>Category filter</b> — categories and counts from PostgreSQL, subcategories, server-side paging</sub></td>
    <td width="50%"><img src="docs/screenshots/messaging.webp" alt="Private buyer and seller messaging"><br><sub><b>Messages</b> — private buyer–seller threads about a lot, with read receipts</sub></td>
  </tr>
</table>

**Real-time bidding across sessions.** Session A places a bid; session B, a different browser,
receives it over Socket.IO after the database commit. Both screenshots were taken seconds apart.

<img src="docs/screenshots/live-bidding.webp" alt="A bid placed in one session appears in another session in real time" width="100%">

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/live-chat.webp" alt="Auction room chat"><br><sub><b>Room chat</b> — persisted, moderated, rate-limited; the seller is badged</sub></td>
    <td width="50%"><img src="docs/screenshots/ai-assistant.webp" alt="AI assistant answering from live auction data"><br><sub><b>AI assistant</b> — a real OpenAI response; listings come from read-only database tools</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/dashboard.webp" alt="Bidder dashboard"><br><sub><b>Dashboard</b> — bids, wins, watchlist and orders at a glance</sub></td>
    <td width="50%"><img src="docs/screenshots/notifications.webp" alt="Notification center"><br><sub><b>Notifications</b> — outbid, won, security alerts; pushed live and stored</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/favorites.webp" alt="Favourite lots"><br><sub><b>Favourites</b> — a starred shortlist saved to the account, separate from the watchlist</sub></td>
    <td width="50%"><img src="docs/screenshots/addresses.webp" alt="Address book"><br><sub><b>Address book</b> — shipping, billing and pickup addresses, one default each; pre-fills checkout</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/demo-checkout.webp" alt="Simulated checkout"><br><sub><b>Demo checkout</b> — winner-only, idempotent, clearly simulated</sub></td>
    <td width="50%"><img src="docs/screenshots/authentication.webp" alt="Registration and email verification"><br><sub><b>Accounts</b> — registration and email verification by code or link</sub></td>
  </tr>
</table>

**Selling with real photo storage.** A seller drafts a listing and uploads photos; Sharp turns
each one into three WebP sizes stored on Cloudflare R2, and the gallery loads the smallest size
that fits.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/seller-workspace.webp" alt="Seller workspace with listings and their status"><br><sub><b>Seller workspace</b> — drafts, review status, photo counts, withdraw and continue</sub></td>
    <td width="50%"><img src="docs/screenshots/auction-creation.webp" alt="Listing wizard: item details"><br><sub><b>Listing wizard</b> — category attributes, condition, pricing, schedule, delivery; saved as a real draft</sub></td>
  </tr>
</table>

<img src="docs/screenshots/photo-upload.webp" alt="Uploading several photos with progress, then managing them: cover, reorder, replace, remove" width="100%">

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/auction-gallery.webp" alt="Lot page gallery served from Cloudflare R2"><br><sub><b>Lot page</b> — a Wikimedia Commons photo with its credit and licence, served from R2 as 320/800/1600 px WebP</sub></td>
    <td width="50%"><img src="docs/screenshots/admin-orders-disputes.webp" alt="Admin orders and disputes"><br><sub><b>Orders &amp; disputes</b> — every order, and disputes opened by buyers, decided by staff</sub></td>
  </tr>
</table>

**Operations dashboard** — analytics, users, auctions, orders, categories and moderation, all from
live PostgreSQL data and enforced by server-side permissions.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/admin-dashboard.webp" alt="Admin analytics overview"><br><sub><b>Overview</b> — KPIs, bids over time, registrations</sub></td>
    <td width="50%"><img src="docs/screenshots/admin-auctions.webp" alt="Admin auction management"><br><sub><b>Auctions</b> — review queue, filters, bid history with real identities</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/admin-moderation.webp" alt="Chat moderation"><br><sub><b>Moderation</b> — reports, hide/delete messages, mutes and bans</sub></td>
    <td width="50%"><img src="docs/screenshots/admin-users.webp" alt="User management"><br><sub><b>Users</b> — search, roles, suspensions, sessions</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/admin-categories.webp" alt="Category management"><br><sub><b>Categories</b> — add, rename and hide categories; in-use categories are protected</sub></td>
    <td width="50%"></td>
  </tr>
</table>

<img src="docs/screenshots/mobile.webp" alt="AUCTRA on mobile: home, marketplace and auction room" width="100%">

<sub>All screenshots are real captures of the running application (Playwright + Chromium) with
local demo data: demo accounts, fictional sellers and bidders. Nothing is mocked up. Catalogue
photos come from Wikimedia Commons under free licences; see
[docs/catalog-image-credits.md](docs/catalog-image-credits.md).</sub>

## Features

Everything below is implemented and covered by tests unless marked otherwise.

**Authentication and account security**
- Registration and login with Argon2id password hashing, account lockout and per-route rate limits
- Short-lived JWT access tokens plus rotated, single-use refresh tokens in an HttpOnly cookie;
  reuse of an old token revokes the whole session
- Multi-device sessions: list them, sign out one device or all of them
- Email verification by **6-digit code or link** (hashed, single-use, 15-minute expiry,
  attempt-limited), password reset and change, security alerts for new-device sign-ins

**Auctions and real-time bidding**
- Listing lifecycle: draft → review → scheduled → live → ended → sold / unsold / cancelled
- Seller workspace: create a draft, upload photos (drag and drop, progress, cover, reorder,
  replace, remove), submit for review
- Listing photos validated and re-encoded with Sharp into 320 / 800 / 1600 px WebP variants
  (EXIF orientation applied, location metadata removed) and stored in **Cloudflare R2** (S3 API,
  verified against a live bucket with `npm run r2:smoke`); pages load the smallest variant that
  fits
- Concurrency-safe bidding with row locks, idempotency keys, per-auction sequence numbers and
  database-time deadlines; optional anti-sniping extensions
- Automatic close and settlement with reserve-price handling and exactly-one order per auction
- Socket.IO room per auction, versioned events, and resync after gaps or reconnects
- Marketplace browsing on the server: category and subcategory tree from PostgreSQL (admin-created
  categories appear automatically), full-text search, price / condition / seller-type / reserve
  filters, sorting and pagination; Live Now and seller pages are paged too

**Engagement**
- Room chat per auction: persisted, paginated, rate-limited and moderated
- Notification center: in-app (live) and email, per-type preferences, delivery tracking
- Watchlist, reminders, bid history and order history
- Favourites (a starred shortlist, separate from the watchlist) and an address book with one
  default per address type; checkout pre-fills the default shipping address
- Buyers can open a dispute on an order and report a listing; both land in the staff queues
- Private buyer–seller messaging per lot: inbox with unread counts, paginated history, live
  delivery over Socket.IO to the two participants only, and notifications
- Public seller profiles with their listings, and "remind me" for upcoming lots

**Administration**
- Analytics from PostgreSQL, user / seller / auction management, report queue, chat
  moderation, announcements, email-delivery review and audit log, all behind role-based permissions
- Category management, the order book and dispute decisions (audited, both parties notified)
- One-time, audited CLI to grant a role to an existing account (`npm run admin:grant-role`), used
  to bootstrap the first super administrator — no email addresses in authorization code
- Bid-integrity signals (shared networks, seller affinity, bursts) for human review

**AI assistants (OpenAI Responses API)**
- Member assistant that searches real listings and explains rules through read-only tools
- Admin assistant with analytics and moderation tools that can only *suggest* actions; an admin
  must confirm them
- Token budgets, input limits, prompt-injection guarding, and a clear "not configured" state
  when no API key is set

**Demo catalogue**
- About 230 fictional lots across six categories, created by an idempotent, dry-run-first seed
  (`npm run db:seed:catalog`) that bids through the real engine and closes lots through the real
  lifecycle worker, so prices, results and orders are consistent
- Photos are freely licensed Wikimedia Commons images (CC0 / public domain / CC BY / CC BY-SA),
  processed by the same Sharp pipeline and stored in R2 under `demo-catalog/`; every lot page
  credits author, license and source ([full list](docs/catalog-image-credits.md)); museum
  originals are offered only as reproductions, and property photos are marked illustrative

**Demo checkout**
- Winner-only simulated checkout with delivery options, idempotent completion and an order history

## Tech stack

| Layer | Technologies |
| --- | --- |
| **Frontend** | React 19, TypeScript, TanStack Start (SSR) and TanStack Router, TanStack Query, Tailwind CSS 4, Radix UI primitives, Recharts, Socket.IO client, Vite, Vitest |
| **Backend** | NestJS 12, Node.js, TypeScript, class-validator, Helmet, @nestjs/throttler, prom-client |
| **Data** | PostgreSQL 17, Prisma 7 (driver adapter `@prisma/adapter-pg`) |
| **Real-time and infra** | Socket.IO 4 with the Redis adapter, Redis, transactional outbox, background workers |
| **Media** | Sharp (libvips) image processing, Cloudflare R2 object storage via AWS SDK v3 (S3 API), multer |
| **Auth** | JWT (HS256) access tokens, rotated refresh tokens, HttpOnly + CSRF-protected cookies, Argon2id, RBAC |
| **Integrations** | OpenAI (Responses API) for the assistants, Resend for email — both optional, configured by environment |
| **Testing** | Vitest + Supertest against real PostgreSQL and Redis; a custom Node load-test harness |

## System architecture

```mermaid
flowchart LR
    subgraph Client["Browser"]
        UI["React app<br/>TanStack Start"]
    end

    subgraph API["NestJS API · identical instances"]
        REST["REST controllers<br/>auth · bids · auctions · chat · admin · AI"]
        GW["Socket.IO gateway<br/>auction:{id} rooms"]
        BID["Bid engine<br/>row-locked transaction"]
        LC["Lifecycle worker<br/>activate · close · settle"]
        RELAY["Outbox relay<br/>publish after commit"]
        JOBS["Job processor<br/>notifications · email"]
        MEDIA["Image pipeline<br/>Sharp → WebP variants"]
    end

    PG[("PostgreSQL<br/>source of truth")]
    RD[("Redis<br/>pub/sub · rate limits")]
    R2[("Cloudflare R2<br/>listing photos")]

    UI -- "HTTPS (commands)" --> REST
    UI <-- "WebSocket (live state)" --> GW
    REST --> BID
    BID -- "bid + price + outbox row<br/>in one commit" --> PG
    LC -- "SKIP LOCKED" --> PG
    RELAY -- "read committed events" --> PG
    JOBS -- "read job rows" --> PG
    RELAY --> GW
    GW <-- "cross-instance fan-out" --> RD
    REST -- "photo uploads" --> MEDIA
    MEDIA -- "S3 API (server-side keys)" --> R2
    MEDIA -- "metadata only" --> PG
    UI -. "public image URLs" .-> R2
```

PostgreSQL is the only authority: Redis carries fan-out and rate-limit counters, never bid
state. Every API instance runs the same modules; workers and relays coordinate through
`FOR UPDATE SKIP LOCKED` and advisory locks, so no instance is special.

## How real-time bidding works

A bid is a `POST /api/auctions/:id/bids` with an `Idempotency-Key` header. It goes through four steps:

1. **Lock-free pre-screen.** One SQL statement (one snapshot) replays an earlier outcome for the
   same key, and rejects bids that are *already certain* to fail. Prices only rise and finished
   auctions never reopen, so a bid below the committed minimum is rejected without waiting for
   the lock.
2. **Admission.** Per-instance FIFO per auction with a cap on concurrent bid transactions, so a
   hot auction can't drain the connection pool. Queues are bounded and overflow returns a
   retryable `503`.
3. **Locked transaction.** `SELECT … FOR UPDATE` on the auction row, then a fresh read of the
   price, highest bidder and **database clock**. The transaction validates the deadline, seller ≠
   bidder and the minimum bid (start price, or current price + increment). It then writes the bid
   with `sequence = bidCount + 1`, updates the price under a version guard, and inserts an
   **outbox** row, all in one commit.
4. **Publish.** After commit, the outbox relay emits the event to the auction room, and the Redis
   adapter carries it to every instance. Clients apply only `version = held + 1`, ignore
   duplicates, and call `auction:sync` on a gap, on reconnect, or when a heartbeat shows they are behind.

```mermaid
sequenceDiagram
    autonumber
    participant A as Bidder A
    participant B as Bidder B
    participant API as NestJS API
    participant DB as PostgreSQL
    participant WS as Socket.IO (+ Redis)

    par same instant
        A->>API: POST /bids $142,500 (Idempotency-Key ka)
    and
        B->>API: POST /bids $142,500 (Idempotency-Key kb)
    end
    API->>DB: BEGIN · SELECT … FOR UPDATE (A gets the lock)
    Note over DB: B's transaction waits on the row lock
    API->>DB: read price + clock_timestamp() → valid
    API->>DB: INSERT bid (seq 10) · UPDATE price/version · INSERT outbox
    API->>DB: COMMIT
    API-->>A: 201 Created
    Note over API,DB: B is re-checked against the committed price<br/>(queue head on the same instance, or row lock on another)
    API->>DB: minimum is now $145,000 · record rejection for key kb
    API-->>B: 422 BID_TOO_LOW (minimum $145,000)
    DB-->>API: outbox relay reads committed event v11
    API->>WS: emit auction:bid (version 11)
    WS-->>A: version 11
    WS-->>B: version 11
```

Key rules:
- **Equal amounts.** The first committed bid wins; the other bidder is told the new minimum.
- **Retries.** A retry with the same key returns the original result, whether accepted or rejected.
  The same key with different parameters returns `409 IDEMPOTENCY_KEY_REUSED`.
- **Deadlines.** A bid is rejected after `endsAt` by database time, even if the close worker
  hasn't run yet.
- **Settlement.** The highest bid wins if the reserve is met. A unique constraint guarantees at
  most one order per auction, even with workers racing on several instances.

## Performance and load testing

Measured with a reproducible harness against production builds of the API (two instances,
shared PostgreSQL and Redis). Correctness is checked **directly in PostgreSQL** after every
scenario: contiguous sequences, minimum-bid rules, highest bid equal to the last accepted bid,
no bid after the deadline, and one valid order per sold auction.

> All figures come from **one development laptop** (10 CPU cores, 16 GB RAM) with the load
> generator, database, Redis and API sharing the same CPUs. They are not production capacity
> figures, and larger viewer counts have not been tested.

| Scenario | Result |
| --- | --- |
| 2 bidders, same amount, same instant (25 rounds) | exactly one accepted every round; the other `422 BID_TOO_LOW` |
| 10 bidders, each request sent 3× with one key | one outcome per key, 8 replays, key reuse → `409` |
| 100-bid burst on one auction (+10 duplicate retries) | **0 server errors**, p95 **195 ms**, all invariants hold |
| 1,000-bid burst on one auction, DB pool 10 | **0 server errors**, **513 req/s**, p95 2.1 s |
| 1,000-bid burst on one auction, DB pool 25 | **931 req/s**, p95 1.1 s, 87 retryable `503 AUCTION_BUSY` (load shedding), 0 other errors |
| 50 auctions × 10 bidders, + a hot auction bursting 100 bids / 3 s | other auctions' p95 **8.5 ms** (8.7 ms without the hot one), 0 errors |
| 10,000 WebSocket viewers in one room, one instance | **100,000 / 100,000** events delivered, p95 **86 ms**, ~700 MB RSS |
| Cross-instance delivery (viewers on instance 2) | 5,000 / 5,000 events via Redis, p95 66 ms |
| Redis stopped mid-auction | 5 / 5 bids accepted; viewers on the other instance resynced after restart |
| Instance `SIGKILL`ed mid-burst, retries on instance 2 | **0 acknowledged bids lost**, consistent answers for every retried key |
| Instance killed while 30 auctions settled | 30 / 30 settled exactly once after restart |

How to read the outcomes: a **201** is an accepted bid. A **4xx** is a business rejection, such
as a bid below the minimum or after the deadline. A **503** with `Retry-After` is deliberate,
retryable back-pressure where nothing was written. A **transport error** means no response at
all, which only happened in the deliberate kill test.

Full methodology, raw numbers and the bugs these tests found:
[backend/docs/auction-engine-report.md](backend/docs/auction-engine-report.md) ·
how to run the harness: [backend/loadtest/README.md](backend/loadtest/README.md)

## Authentication and security

- **Passwords:** Argon2id (OWASP baseline parameters), transparent rehash, 10–128 characters, lockout with exponential back-off
- **Tokens:** 15-minute HS256 access tokens. Each request re-checks the session, roles and
  permissions in one query, so bans and revocations apply immediately.
- **Refresh:** opaque token stored only as a SHA-256 hash, in an `HttpOnly; SameSite=Strict` cookie scoped to `/api/auth`; rotated on every use, reuse revokes the session family
- **CSRF:** origin check plus a signed double-submit token on cookie endpoints
- **Authorization:** role-based permissions (USER, SELLER, MODERATOR, ADMIN, SUPER_ADMIN)
  checked by guards; the socket connection is authenticated before any event, and sessions are
  re-validated periodically.
- **Abuse limits:** per-route and per-user rate limits (Redis-backed, with a per-instance fallback), WebSocket token buckets, chat spam limits, bounded bid queues
- **Input and output:** DTO validation on every endpoint, uniform error bodies with request
  IDs, Helmet headers, and no secrets or tokens in logs.
- **Bids:** the server never trusts client prices, user IDs or timestamps

## Project structure

```text
AUCTRA/
├── frontend/                  React app (TanStack Start)
│   └── src/
│       ├── routes/            pages: home, explore, live, room, admin, checkout, settings …
│       ├── components/        UI, auction room, chat, admin panels, AI assistant
│       ├── lib/api/           API client, live sync (Socket.IO), adapters
│       └── services/          service layer (API mode / offline demo mode)
├── backend/                   NestJS API
│   ├── src/                   auth · bids · auctions · media · storage · realtime · outbox ·
│   │                          jobs · chat · messaging · notifications · email · orders ·
│   │                          admin · ai · database/catalog (demo catalogue + seed) …
│   ├── prisma/                schema + migrations (incl. hand-written CHECK constraints)
│   ├── test/                  integration tests (real PostgreSQL / Redis)
│   ├── loadtest/              load and concurrency harness (scenarios A–G)
│   └── docs/                  engineering report, media storage guide
├── docs/
│   ├── screenshots/           README images (real captures)
│   ├── catalog-image-credits.md  author / license / source of every demo-catalogue photo
│   └── social/                showcase assets
└── README.md
```

## Getting started

### Prerequisites

- Node.js 24 (the version used for development and all tests)
- PostgreSQL 17 (tested version)
- Redis (tested with 8.x; optional for a single instance, required with several API instances)

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env: DATABASE_URL, DATABASE_URL_TEST, and two different secrets
# (JWT_ACCESS_SECRET, CSRF_SECRET), e.g. generated with: openssl rand -base64 48
npm install                 # also generates the Prisma client
npm run db:migrate:deploy   # apply migrations
npm run db:seed             # roles, permissions, categories
npm run db:seed:demo        # optional demo auctions/accounts (set SEED_DEMO_PASSWORD first)
npm run db:rotate-demo-passwords  # after changing SEED_DEMO_PASSWORD: dry run, add -- --apply
                            # (re-seeding never changes existing demo passwords)
npm run db:seed:catalog     # optional: dry run of the ~230-lot demo catalogue (add -- --apply;
                            # needs image storage — R2 or local — and downloads Commons photos)
npm run start:dev           # http://localhost:4000/api
```

To make your own (already registered and verified) account a super administrator:

```bash
npm run admin:grant-role -- --email you@example.com --role SUPER_ADMIN           # dry run
npm run admin:grant-role -- --email you@example.com --role SUPER_ADMIN --apply   # audited grant
```

Optional integrations (all variables are documented in `backend/.env.example`):
`RESEND_API_KEY` and `RESEND_FROM_EMAIL` for email (without them, emails are printed to the dev
log); `OPENAI_API_KEY` and `OPENAI_MODEL` for the assistants; `R2_*` for listing photos in
Cloudflare R2 (without them, development stores photos on local disk — see
[backend/docs/media-storage.md](backend/docs/media-storage.md)).

No local PostgreSQL? `cd backend && POSTGRES_PASSWORD=… docker compose up -d` starts PostgreSQL and Redis.

### 2. Frontend

```bash
cd frontend
cp .env.example .env.local   # set VITE_API_MODE=api and VITE_API_URL=http://localhost:4000/api
npm install
npm run dev                  # http://localhost:8080
```

With `VITE_API_MODE=demo` the frontend runs entirely in the browser with simulated data, with no backend needed.

### 3. Tests

```bash
cd backend
npm run typecheck && npm run lint
npm test                     # unit tests
npm run test:e2e             # integration tests (needs DATABASE_URL_TEST ending in _test)
```

```bash
cd frontend && npm run typecheck && npm run lint && npm test
```

Current status: backend 56 unit and 181 integration tests passing; frontend 73 tests passing; live Cloudflare R2 smoke test 23/23.

## API overview

All routes live under `/api` and return errors as `{ statusCode, code, message, details?, requestId }`.

| Area | Highlights |
| --- | --- |
| Auth | `POST /auth/register` · `/login` · `/refresh` · `/logout` · `/logout-all` · `/verify-email` · `/verify-email/code` · `/forgot-password` · `/reset-password` · `GET /auth/sessions` |
| Auctions | `GET /auctions` (filters, sorting) · `GET /auctions/:id` · seller create/submit/withdraw/cancel |
| Listing images | `GET/POST /auctions/:id/images` (multipart upload) · replace · reorder · set cover · delete |
| Bids | `POST /auctions/:id/bids` (Idempotency-Key) · `GET /auctions/:id/bids` · `GET /me/bids` |
| Chat | `GET/POST /auctions/:id/chat` · `POST /chat/messages/:id/report` |
| Messaging | `GET/POST /conversations` · `GET /conversations/unread` · `GET /conversations/:id` (paged) · `POST /conversations/:id/messages` · `POST /conversations/:id/read` |
| Profiles | `GET /users/:handle` (public seller profile) · `GET /auctions?seller=:handle` |
| Engagement | watchlist · favorites (`PUT/DELETE /me/favorites/:auctionId`) · reminders (`/me/reminders`) · notifications and preferences |
| Addresses | `GET/POST /me/addresses` · `PATCH/DELETE /me/addresses/:id` (one default per type) |
| Orders | `GET /checkout/:auctionId` · `POST /orders/:id/demo-checkout` · `GET /me/orders` · `POST /orders/:id/disputes` |
| Admin | analytics, users, sellers, auctions, orders, disputes, categories, reports, chat moderation, announcements, audit log, bid-integrity signals |
| AI | `GET /ai/status` · `POST /ai/chat` (Server-Sent Events) · conversations · usage |
| Ops | `GET /health` · `GET /metrics` (Prometheus, token-protected) |
| Realtime | Socket.IO: `auction:join` · `auction:sync` · `auction:leave` · `time:sync` · `auth:refresh` |

The full endpoint reference and configuration guide are in [backend/README.md](backend/README.md).

## Engineering challenges

**Concurrent bid correctness.** Bids for one auction serialize on a PostgreSQL row lock, and
the lock is taken in its own statement. Under READ COMMITTED, a statement's snapshot is fixed
when it starts, so a combined lock-and-read query could see a stale highest bid after waiting.
A separate read statement always sees the latest commit.

**Idempotency for rejections too.** The first version replayed accepted bids only, so a retried
"already highest bidder" request could later succeed. Rejections are now recorded per key,
concurrent retries agree, and a reused key with different parameters is refused.

**A Redis outage that took the API down.** Load testing showed that with Redis stopped, requests
hung and the process crashed: the rate limiter waited on an unbounded offline queue, and the
Socket.IO adapter had unhandled publish rejections. Now Redis commands fail fast, rate limits
fall back to per-instance counters, and publishes are guarded. Bids keep working, and clients
catch up through version heartbeats.

**Missed WebSocket events.** Joining a room used to read the snapshot first and subscribe second,
so an event could fall in between and be lost. Now the server joins first, every event carries a
version, clients resync on gaps, and a lightweight per-instance heartbeat exposes staleness even
in quiet rooms.

**Multi-instance consistency.** Several relays could publish out of order, and per-instance caches
could serve stale snapshots. A cluster-wide advisory lock now orders publication, cache
invalidations are broadcast to every instance, and settlement is safe with workers racing on
every instance.

**Throughput under bursts.** Metrics showed 1,000-bid bursts were slowed by about six
authentication queries per request and by bids holding pooled connections while queued. One
aggregated auth query, a lock-free pre-screen and bounded per-auction admission took a single
instance from 263 to 513 requests/s with the same pool.

## Project status

**Complete**
- Authentication, sessions, email verification (code + link), password flows
- Concurrency-safe bidding, auction lifecycle, settlement and demo checkout
- Real-time rooms with versioned events, Redis fan-out and reconnect sync
- Room chat with moderation, notification center, admin dashboard, AI assistants
- Seller workspace with real drafts and photo uploads; Sharp image pipeline on Cloudflare R2
- Admin categories, orders and disputes; buyer disputes and listing reports
- Buyer–seller messaging with live delivery; seller profiles; reminders for upcoming lots
- Server-side marketplace search, filters and pagination over database-driven categories
- A ~230-lot demo catalogue with attributed, freely licensed photos
- Favourites and address book screens on the server APIs, used by checkout
- Integration tests, engine-invariant tests and a load-test harness

**In progress / roadmap**
- Serve listing photos from a custom domain on the R2 bucket (development uses its rate-limited
  r2.dev URL).
- Email delivery to arbitrary recipients needs a verified sending domain in Resend.
- Editable user profiles with avatars (display name only today).
- A support inbox: the help page points to the assistant, disputes and reports instead of a contact form.
- Global viewer counts across instances; load testing beyond 10,000 viewers with distributed generators.
- Public deployment.

## Author

**Narek Melkumyan** — [github.com/Narek-Melkumyan](https://github.com/Narek-Melkumyan)

Feedback and questions are welcome through GitHub issues.
