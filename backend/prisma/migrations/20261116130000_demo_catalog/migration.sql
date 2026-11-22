-- Demo catalog support. Additive only: nullable columns and a unique index on a new column.
ALTER TABLE "auctions" ADD COLUMN "seedKey" VARCHAR(80);
CREATE UNIQUE INDEX "auctions_seedKey_key" ON "auctions"("seedKey");

ALTER TABLE "listing_media"
  ADD COLUMN "creditAuthor" VARCHAR(300),
  ADD COLUMN "creditLicense" VARCHAR(60),
  ADD COLUMN "creditLicenseUrl" VARCHAR(500),
  ADD COLUMN "creditSourceUrl" VARCHAR(1000);
