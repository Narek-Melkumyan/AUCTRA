-- CreateEnum
CREATE TYPE "ChatMessageStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'DELETED');

-- CreateEnum
CREATE TYPE "ChatRestrictionType" AS ENUM ('MUTE', 'BAN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ModerationActionType" ADD VALUE 'DELETE_MESSAGE';
ALTER TYPE "ModerationActionType" ADD VALUE 'RESTORE_MESSAGE';
ALTER TYPE "ModerationActionType" ADD VALUE 'MUTE_USER';
ALTER TYPE "ModerationActionType" ADD VALUE 'BAN_FROM_CHAT';
ALTER TYPE "ModerationActionType" ADD VALUE 'LIFT_CHAT_RESTRICTION';
ALTER TYPE "ModerationActionType" ADD VALUE 'DISMISS_REPORT';

-- AlterEnum
ALTER TYPE "ReportTargetType" ADD VALUE 'CHAT_MESSAGE';

-- CreateTable
CREATE TABLE "auction_chat_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" BIGSERIAL NOT NULL,
    "auctionId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "status" "ChatMessageStatus" NOT NULL DEFAULT 'VISIBLE',
    "clientMessageId" VARCHAR(64),
    "moderatedById" UUID,
    "moderatedAt" TIMESTAMPTZ(3),
    "moderationReason" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auction_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_restrictions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "type" "ChatRestrictionType" NOT NULL,
    "reason" VARCHAR(500),
    "expiresAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auction_chat_messages_seq_key" ON "auction_chat_messages"("seq");

-- CreateIndex
CREATE INDEX "auction_chat_messages_auctionId_seq_idx" ON "auction_chat_messages"("auctionId", "seq");

-- CreateIndex
CREATE INDEX "auction_chat_messages_authorId_createdAt_idx" ON "auction_chat_messages"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "auction_chat_messages_status_createdAt_idx" ON "auction_chat_messages"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "auction_chat_messages_authorId_clientMessageId_key" ON "auction_chat_messages"("authorId", "clientMessageId");

-- CreateIndex
CREATE INDEX "chat_restrictions_userId_revokedAt_idx" ON "chat_restrictions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "chat_restrictions_createdAt_idx" ON "chat_restrictions"("createdAt");

-- AddForeignKey
ALTER TABLE "auction_chat_messages" ADD CONSTRAINT "auction_chat_messages_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "auctions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auction_chat_messages" ADD CONSTRAINT "auction_chat_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auction_chat_messages" ADD CONSTRAINT "auction_chat_messages_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_restrictions" ADD CONSTRAINT "chat_restrictions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_restrictions" ADD CONSTRAINT "chat_restrictions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_restrictions" ADD CONSTRAINT "chat_restrictions_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Chat integrity rules Prisma cannot express.
ALTER TABLE "auction_chat_messages"
  ADD CONSTRAINT "chat_body_not_blank" CHECK (length(btrim("body")) > 0),
  ADD CONSTRAINT "chat_moderation_consistent" CHECK (
    ("status" = 'VISIBLE') OR ("moderatedAt" IS NOT NULL)
  );
ALTER TABLE "chat_restrictions"
  ADD CONSTRAINT "chat_mute_has_expiry" CHECK ("type" <> 'MUTE' OR "expiresAt" IS NOT NULL),
  ADD CONSTRAINT "chat_restriction_expiry_after_start" CHECK ("expiresAt" IS NULL OR "expiresAt" > "createdAt");
