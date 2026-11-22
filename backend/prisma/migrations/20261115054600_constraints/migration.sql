-- Invariants that Prisma's schema language cannot express.
-- Prisma Migrate ignores CHECK constraints and partial indexes when diffing, so
-- future `prisma migrate dev` runs will not try to drop them.

-- ── Users ───────────────────────────────────────────────────────────
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase_chk" CHECK ("email" = lower("email")),
  ADD CONSTRAINT "users_email_format_chk" CHECK ("email" ~ '^[^@\s]+@[^@\s]+$'),
  ADD CONSTRAINT "users_failed_login_count_chk" CHECK ("failedLoginCount" >= 0);

ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_handle_format_chk" CHECK ("handle" ~ '^[a-z0-9_.]{3,32}$'),
  ADD CONSTRAINT "user_profiles_country_chk" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');

ALTER TABLE "user_preferences"
  ADD CONSTRAINT "user_preferences_currency_chk" CHECK ("preferredCurrency" ~ '^[A-Z]{3}$');

ALTER TABLE "user_addresses"
  ADD CONSTRAINT "user_addresses_country_chk" CHECK ("country" ~ '^[A-Z]{2}$');

-- At most one default address per user and address type.
CREATE UNIQUE INDEX "user_addresses_one_default_per_type"
  ON "user_addresses" ("userId", "type") WHERE "isDefault";

-- ── Sessions & tokens ───────────────────────────────────────────────
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_expiry_chk" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_expiry_chk" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "verification_tokens"
  ADD CONSTRAINT "verification_tokens_expiry_chk" CHECK ("expiresAt" > "createdAt");

-- ── Auctions ────────────────────────────────────────────────────────
ALTER TABLE "auctions"
  ADD CONSTRAINT "auctions_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "auctions_starting_price_chk" CHECK ("startingPriceCents" > 0),
  ADD CONSTRAINT "auctions_increment_chk" CHECK ("minIncrementCents" > 0),
  ADD CONSTRAINT "auctions_reserve_chk" CHECK ("reservePriceCents" IS NULL OR "reservePriceCents" >= "startingPriceCents"),
  ADD CONSTRAINT "auctions_buy_now_chk" CHECK ("buyNowPriceCents" IS NULL OR "buyNowPriceCents" > "startingPriceCents"),
  ADD CONSTRAINT "auctions_current_price_chk" CHECK ("currentPriceCents" IS NULL OR "currentPriceCents" >= "startingPriceCents"),
  ADD CONSTRAINT "auctions_bid_count_chk" CHECK ("bidCount" >= 0),
  ADD CONSTRAINT "auctions_highest_bid_consistency_chk" CHECK (("highestBidId" IS NULL) = ("currentPriceCents" IS NULL)),
  ADD CONSTRAINT "auctions_window_chk" CHECK ("endsAt" > "startsAt" AND "originalEndsAt" > "startsAt" AND "endsAt" >= "originalEndsAt"),
  ADD CONSTRAINT "auctions_anti_sniping_chk" CHECK (
    "antiSnipingWindowSec" >= 0 AND "antiSnipingExtensionSec" >= 0 AND
    (NOT "antiSnipingEnabled" OR ("antiSnipingWindowSec" > 0 AND "antiSnipingExtensionSec" > 0))
  ),
  ADD CONSTRAINT "auctions_version_chk" CHECK ("version" >= 1),
  -- A winner exists only on SOLD auctions, and SOLD auctions always have one.
  ADD CONSTRAINT "auctions_winner_chk" CHECK (
    ("status" = 'SOLD') = ("winnerId" IS NOT NULL AND "winningBidId" IS NOT NULL)
  );

ALTER TABLE "listing_media"
  ADD CONSTRAINT "listing_media_position_chk" CHECK ("position" >= 0);

ALTER TABLE "vehicle_details"
  ADD CONSTRAINT "vehicle_details_year_chk" CHECK ("year" BETWEEN 1885 AND 2100),
  ADD CONSTRAINT "vehicle_details_mileage_chk" CHECK ("mileageKm" IS NULL OR "mileageKm" >= 0),
  ADD CONSTRAINT "vehicle_details_vin_chk" CHECK ("vin" IS NULL OR "vin" ~ '^[A-HJ-NPR-Z0-9]{17}$');

ALTER TABLE "watch_details"
  ADD CONSTRAINT "watch_details_year_chk" CHECK ("year" IS NULL OR "year" BETWEEN 1700 AND 2100);

-- ── Bids ────────────────────────────────────────────────────────────
ALTER TABLE "bids"
  ADD CONSTRAINT "bids_amount_chk" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "bids_sequence_chk" CHECK ("sequence" >= 1),
  ADD CONSTRAINT "bids_increases_chk" CHECK ("previousPriceCents" IS NULL OR "amountCents" > "previousPriceCents"),
  ADD CONSTRAINT "bids_idempotency_key_chk" CHECK (length("idempotencyKey") BETWEEN 8 AND 100);

-- ── Orders & payments ───────────────────────────────────────────────
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_chk" CHECK (
    "hammerPriceCents" > 0 AND "buyerPremiumCents" >= 0 AND "shippingCents" >= 0 AND "taxCents" >= 0
  ),
  ADD CONSTRAINT "orders_total_chk" CHECK (
    "totalCents" = "hammerPriceCents" + "buyerPremiumCents" + "shippingCents" + "taxCents"
  ),
  ADD CONSTRAINT "orders_parties_chk" CHECK ("buyerId" <> "sellerId");

ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_amount_chk" CHECK ("amountCents" > 0);
ALTER TABLE "transactions"    ADD CONSTRAINT "transactions_amount_chk" CHECK ("amountCents" > 0);
ALTER TABLE "refunds"         ADD CONSTRAINT "refunds_amount_chk" CHECK ("amountCents" > 0);
ALTER TABLE "payouts"         ADD CONSTRAINT "payouts_amount_chk" CHECK ("amountCents" > 0);
ALTER TABLE "invoices"        ADD CONSTRAINT "invoices_total_chk" CHECK ("totalCents" >= 0);
ALTER TABLE "platform_fees"
  ADD CONSTRAINT "platform_fees_amount_chk" CHECK ("amountCents" >= 0),
  ADD CONSTRAINT "platform_fees_rate_chk" CHECK ("rateBps" BETWEEN 0 AND 10000);

-- ── Infrastructure ──────────────────────────────────────────────────
-- Fast scan of events still waiting to be relayed.
CREATE INDEX "outbox_events_pending_idx"
  ON "outbox_events" ("availableAt", "id") WHERE "publishedAt" IS NULL;

-- Fast lookup of deliveries still waiting to be sent.
CREATE INDEX "notification_deliveries_pending_idx"
  ON "notification_deliveries" ("createdAt") WHERE "status" = 'PENDING';
