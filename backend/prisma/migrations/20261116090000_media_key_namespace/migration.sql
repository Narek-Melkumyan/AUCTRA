-- Allow an optional key namespace (MEDIA_KEY_PREFIX) in front of "auctions/…" so several
-- environments can share one bucket. Only widens two CHECK constraints; existing rows
-- already satisfy the new pattern and no data is touched.
ALTER TABLE "listing_media" DROP CONSTRAINT "listing_media_key_prefix_chk";
ALTER TABLE "listing_media" ADD CONSTRAINT "listing_media_key_prefix_chk" CHECK (
  "storageKeyPrefix" IS NULL OR
  "storageKeyPrefix" ~ '^([a-z0-9][a-z0-9-]{0,62}/){0,4}auctions/[0-9a-f-]{36}/[0-9a-f-]{36}/$'
);

ALTER TABLE "media_cleanup_tasks" DROP CONSTRAINT "media_cleanup_tasks_prefix_chk";
ALTER TABLE "media_cleanup_tasks" ADD CONSTRAINT "media_cleanup_tasks_prefix_chk" CHECK (
  "keyPrefix" ~ '^([a-z0-9][a-z0-9-]{0,62}/){0,4}auctions/[0-9a-f-]{36}/[0-9a-f-]{36}/$'
);
