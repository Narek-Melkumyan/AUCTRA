# AUCTRA web client — notes for coding agents

## Origin and current workflow

This client was first built with [Lovable](https://lovable.dev). On **22 November 2026**
the Lovable project's GitHub sync was disconnected: Lovable no longer reads from or writes
to this repository, and nothing here is managed in the Lovable editor. AUCTRA is now
developed independently with Claude Code and GitHub; the client lives in `frontend/` and
the NestJS API in `../backend`.

- Make all changes in this repository and land them through pull requests into `main`.
  Do not rewrite published history (no force pushes to `main`).
- Do not edit a file whose header says it is automatically generated (for example
  `src/routeTree.gen.ts`, produced by TanStack Router).
- Lovable-specific services do not apply: there is no Supabase or drizzle schema (the
  database is PostgreSQL, owned by the API through Prisma migrations), AI calls go through
  the API rather than Lovable's gateway (no `LOVABLE_API_KEY`), and secrets live in the
  git-ignored `backend/.env`, never in this repository.
- `@lovable.dev/vite-tanstack-config` (in `vite.config.ts`) is still the build setup, and
  `src/lib/lovable-error-reporting.ts` only reports errors when Lovable's preview tooling
  is present; neither is a sync mechanism.

## Project rules

- Auction state lives in a client-side demo store (src/lib/auction-store.ts); UI reads it via hooks so a server-authoritative WebSocket feed can replace the simulation later without touching pages.
- AI assistant responses come from a local mock (src/lib/ai-mock.ts) that must never place bids; swap in a real AI call behind the same function.
- Demo sign-in, profile and orders live in src/lib/demo-session.ts (local only, not auth); account pages read it via useSession so a real backend session can replace it.
- UI performs auth, auction, bidding, order and AI calls through `services` (src/services); `types.ts` holds the contracts and `demo.ts` wraps the local simulation, so a REST/Socket.IO backend is added as another implementation without editing pages. Live state is still read via store hooks until a socket-fed store replaces the simulation.

- Keep demo settlement logic consistent: a highest bid only counts as won when the auction has ended **and** the reserve is met or absent. Use `isWonByMe()` in checkout, room, account dashboards and notifications.
- This project is an illustrative frontend, not an authenticated production auction service. Never let frontend/mock bid acceptance or simulated payments be mistaken for an authoritative backend.
