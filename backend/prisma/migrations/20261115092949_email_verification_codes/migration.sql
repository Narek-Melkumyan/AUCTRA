-- AlterTable
ALTER TABLE "verification_tokens" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeHash" CHAR(64);

ALTER TABLE "verification_tokens"
  ADD CONSTRAINT "verification_tokens_attempts_nonneg" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "verification_tokens_code_only_for_email" CHECK ("codeHash" IS NULL OR "purpose" = 'EMAIL_VERIFICATION');
