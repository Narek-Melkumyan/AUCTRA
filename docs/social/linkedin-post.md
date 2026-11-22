# LinkedIn showcase — AUCTRA

Draft for you to review and publish yourself. Nothing has been posted.

## Post

I've been building AUCTRA, a real-time auction marketplace, as a personal full-stack project.

On the surface it's a polished bidding app: live auction rooms, countdowns, chat and an admin dashboard. Underneath, it's my answer to a question I wanted to get right: what happens when many people bid on the same item at the same instant?

That's harder than it looks. Every bid has to be checked against the latest price, applied exactly once, ordered deterministically, and rejected the moment the auction ends. Then every viewer has to see the result in real time, even if a server or Redis goes down.

How AUCTRA handles it:
→ PostgreSQL is the single source of truth. Each bid runs in a transaction that locks the auction row and validates against database time.
→ Every bid carries an idempotency key, so retries can never create a duplicate bid, and a retried rejection returns the same answer.
→ Events go out through a transactional outbox only after the commit, fan out across instances with Redis and Socket.IO, and clients resync from versioned state if they miss anything.

I load-tested it on my laptop rather than guessing:
• 1,000 concurrent bids on one auction: 0 errors, 0 data-integrity violations
• 10,000 WebSocket viewers in one room on a single instance, every event delivered (p95 86 ms)
• A server killed mid-burst: no acknowledged bid lost

The tests also caught real bugs, including a Redis outage that took the API down, now fixed.

Stack: NestJS, React (TanStack Start), TypeScript, PostgreSQL + Prisma, Redis, Socket.IO, Sharp + Cloudflare R2 for listing photos, plus OpenAI-powered assistants that answer from live auction data. Checkout is simulated; no real payments are involved.

I'd love feedback from anyone who has built real-time or high-concurrency systems. What would you stress-test next?

#SoftwareEngineering #BackendDevelopment #NestJS #PostgreSQL #Redis #WebSockets #FullStack #TypeScript

---

## Carousel (upload as a document post)

Upload `linkedin-assets/auctra-linkedin-carousel.pdf`, or the seven PNGs in this order:

| # | File | Content |
|---|------|---------|
| 1 | `01-auctra-cover.png` | Cover — real homepage screenshot |
| 2 | `02-live-auction-room.png` | Live auction room (real screenshot) |
| 3 | `03-real-time-bidding.png` | Two browser sessions: bid placed in A, updated live in B (real screenshots) |
| 4 | `04-admin-dashboard.png` | Admin operations dashboard (real screenshot) |
| 5 | `05-architecture.png` | Typeset architecture + bid flow (matches the codebase) |
| 6 | `06-performance.png` | Measured load-test results (from `backend/docs/auction-engine-report.md`) |
| 7 | `07-r2-image-pipeline.png` | Lot gallery served from Cloudflare R2 (real screenshot; Wikimedia Commons photo, credited on the page) |

Suggested alt text (LinkedIn → "Alternative text"):
1. AUCTRA homepage showing live auctions for a grand tourer coupé, a watch and a painting.
2. AUCTRA live auction room with a countdown, the current highest bid and pseudonymous bid history.
3. Two browser sessions side by side: a bid of $140,000 placed in one appears instantly in the other.
4. AUCTRA admin dashboard with user, auction, bid and chat statistics from PostgreSQL.
5. Architecture diagram: React to NestJS over HTTPS and WebSocket, PostgreSQL as source of truth, Redis for fan-out.
6. Load-test results: 1,000 concurrent bids with zero errors, 10,000 WebSocket viewers, zero acknowledged bids lost.
7. AUCTRA lot page with an abstract artwork gallery whose WebP images are served from Cloudflare R2.

## Before publishing

- **Repository link:** `github.com/Narek-Melkumyan/AUCTRA` is not publicly reachable yet (it returned
  404 when checked), so the post contains no link. Once the repository is public, add a line such as
  "Code and benchmark report: <link>" before the hashtags.
- Every number above appears in `backend/docs/auction-engine-report.md` and was measured on one
  development laptop. Keep the "on my laptop" wording so no production capacity is implied.
