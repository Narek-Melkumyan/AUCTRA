# Screenshots

Real captures of the running application, used by the root README.

- Captured with Playwright (Chromium 143, headless) at 1440 × 900 (2× DPR, dark theme) and
  390 × 844 (3× DPR) for mobile, then encoded as WebP (quality 82).
- Source: a local AUCTRA stack (NestJS API built from this repo + Vite dev frontend) running
  against a separate, freshly seeded database (`npm run db:seed:demo`). Activity was created
  through the real API: demo bidders registered and verified their email, placed bids and
  chatted. The bid in `live-bidding.webp` was placed through the UI while a second browser
  session watched the update arrive over Socket.IO.
- One lot's end time was moved forward in that demo database so its normal close/settle
  flow produced a sold auction for `demo-checkout.webp`.
- `ai-assistant.webp` shows a real OpenAI response (configured API key); its listing card
  comes from the database tool result.
- `live-bidding.webp`, `authentication.webp` and `mobile.webp` combine several real captures
  side by side; captions were added outside the UI. No UI content was edited.
- All names, emails and sellers are fictional demo data.
- Added in a later session: `seller-workspace.webp`, `auction-creation.webp`, `photo-upload.webp`,
  `auction-gallery.webp`, `admin-orders-disputes.webp`, `admin-categories.webp` and a fresh
  `admin-dashboard.webp`. The listing photos are abstract images generated for this purpose (no
  third-party content); they were uploaded through the UI, processed by Sharp and served from a
  real Cloudflare R2 bucket under a temporary test prefix that was deleted afterwards. The
  `photo-upload.webp` pair includes a text file renamed to `.jpg`, which the server rejected.
  The order in `admin-orders-disputes.webp` came from a real automatic close (the lot's end time
  was moved forward in the separate demo database), a UI demo checkout and a dispute opened from
  the buyer's orders page.

- Refreshed on 22 Nov 2026 against the expanded demo catalogue: `homepage`, `marketplace`,
  `category-filter`, `auction-room`, `live-chat`, `auction-gallery`, `messaging`,
  `admin-dashboard`, `seller-workspace`, `ai-assistant` and `mobile`. Listing photos in these
  captures come from Wikimedia Commons under CC0, public-domain, CC BY or CC BY-SA licences and are
  credited on each lot page; the full list is in `../catalog-image-credits.md`.
- Refreshed again later on 22 Nov 2026 (223-lot demo database): `homepage`, `marketplace`,
  `category-filter`, `auction-room`, `live-bidding`, `auction-gallery`, `dashboard`,
  `notifications`, `admin-dashboard`, `admin-auctions`, `admin-orders-disputes`,
  `admin-categories`, `seller-workspace` and `mobile`, plus the new `favorites` and `addresses`.
  For `live-bidding`, session A placed the bid through the UI and session B, a guest that was
  never reloaded, received it over Socket.IO (its minimum next bid changed). The dashboard's
  bids were placed through the real bidding API by the demo bidder; the addresses are fictional.
  `ai-assistant`, `live-chat` and `messaging` are from the earlier 22 Nov refresh; `authentication`,
  `auction-creation`, `photo-upload`, `demo-checkout`, `admin-users` and `admin-moderation` show
  flows that do not depend on the catalogue.
