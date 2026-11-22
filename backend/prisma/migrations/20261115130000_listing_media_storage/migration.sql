-- Image storage for listing media (Cloudflare R2 / local dev disk). Additive only:
-- new nullable columns with defaults, a cleanup-task table, and a backfill that
-- classifies existing rows. No existing row or column is removed.

-- CreateEnum
CREATE TYPE "MediaStorage" AS ENUM ('EXTERNAL', 'BUNDLED', 'R2', 'LOCAL');

-- AlterTable
ALTER TABLE "listing_media" ADD COLUMN     "bytes" INTEGER,
ADD COLUMN     "contentHash" CHAR(64),
ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mimeType" VARCHAR(100),
ADD COLUMN     "originalBytes" INTEGER,
ADD COLUMN     "originalMimeType" VARCHAR(100),
ADD COLUMN     "storage" "MediaStorage" NOT NULL DEFAULT 'EXTERNAL',
ADD COLUMN     "storageKeyPrefix" VARCHAR(200),
ADD COLUMN     "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "uploadedById" UUID,
ADD COLUMN     "variants" JSONB;

-- CreateTable
CREATE TABLE "media_cleanup_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "storage" "MediaStorage" NOT NULL,
    "keyPrefix" VARCHAR(200) NOT NULL,
    "reason" VARCHAR(40) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "runAfter" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_cleanup_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_cleanup_tasks_keyPrefix_key" ON "media_cleanup_tasks"("keyPrefix");

-- CreateIndex
CREATE INDEX "media_cleanup_tasks_runAfter_idx" ON "media_cleanup_tasks"("runAfter");

-- CreateIndex
CREATE UNIQUE INDEX "listing_media_storageKeyPrefix_key" ON "listing_media"("storageKeyPrefix");

-- CreateIndex
CREATE INDEX "listing_media_uploadedById_idx" ON "listing_media"("uploadedById");

-- AddForeignKey
ALTER TABLE "listing_media" ADD CONSTRAINT "listing_media_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Backfill existing rows ─────────────────────────────────────────
-- Seeded demo images reference assets bundled with the frontend.
UPDATE "listing_media" SET "storage" = 'BUNDLED' WHERE "url" LIKE 'asset://%';
-- The first image of each auction becomes its cover.
UPDATE "listing_media" m SET "isPrimary" = true
WHERE m."position" = (SELECT min(x."position") FROM "listing_media" x WHERE x."auctionId" = m."auctionId");

-- ── Invariants Prisma cannot express ───────────────────────────────
-- At most one cover image per auction, and it is always first in the gallery.
CREATE UNIQUE INDEX "listing_media_one_primary" ON "listing_media" ("auctionId") WHERE "isPrimary";
ALTER TABLE "listing_media"
  ADD CONSTRAINT "listing_media_primary_first_chk" CHECK (NOT "isPrimary" OR "position" = 0),
  -- Stored images always carry their server-generated key prefix and variant map; others never do.
  ADD CONSTRAINT "listing_media_stored_chk" CHECK (
    ("storage" IN ('R2', 'LOCAL')) = ("storageKeyPrefix" IS NOT NULL AND "variants" IS NOT NULL)
  ),
  ADD CONSTRAINT "listing_media_key_prefix_chk" CHECK (
    "storageKeyPrefix" IS NULL OR "storageKeyPrefix" ~ '^auctions/[0-9a-f-]{36}/[0-9a-f-]{36}/$'
  ),
  ADD CONSTRAINT "listing_media_sizes_chk" CHECK (
    ("bytes" IS NULL OR "bytes" >= 0) AND ("originalBytes" IS NULL OR "originalBytes" >= 0)
    AND ("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)
  ),
  ADD CONSTRAINT "listing_media_hash_chk" CHECK ("contentHash" IS NULL OR "contentHash" ~ '^[0-9a-f]{64}$');
-- The same photo cannot be uploaded twice to one auction.
CREATE UNIQUE INDEX "listing_media_auction_hash" ON "listing_media" ("auctionId", "contentHash") WHERE "contentHash" IS NOT NULL;

ALTER TABLE "media_cleanup_tasks"
  ADD CONSTRAINT "media_cleanup_tasks_prefix_chk" CHECK ("keyPrefix" ~ '^auctions/[0-9a-f-]{36}/[0-9a-f-]{36}/$'),
  ADD CONSTRAINT "media_cleanup_tasks_storage_chk" CHECK ("storage" IN ('R2', 'LOCAL')),
  ADD CONSTRAINT "media_cleanup_tasks_attempts_chk" CHECK ("attempts" >= 0);
