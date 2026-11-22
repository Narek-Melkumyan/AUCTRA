-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL', 'SELLERS', 'BIDDERS', 'STAFF');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'NEW_BID';
ALTER TYPE "NotificationType" ADD VALUE 'CHAT_MESSAGE';
ALTER TYPE "NotificationType" ADD VALUE 'AUCTION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'AUCTION_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'ANNOUNCEMENT';

-- AlterTable
ALTER TABLE "notification_deliveries" ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "audience" "AnnouncementAudience" NOT NULL DEFAULT 'ALL',
    "sendEmail" BOOLEAN NOT NULL DEFAULT false,
    "link" VARCHAR(300),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_createdAt_idx" ON "announcements"("createdAt");

-- CreateIndex
CREATE INDEX "notification_deliveries_channel_status_nextAttemptAt_idx" ON "notification_deliveries"("channel", "status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Pending deliveries are claimed by (channel, nextAttemptAt); keep the partial index lean.
DROP INDEX IF EXISTS "notification_deliveries_pending_idx";
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" ("channel", "nextAttemptAt") WHERE "status" = 'PENDING';
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_recipients_nonneg" CHECK ("recipientCount" >= 0);
