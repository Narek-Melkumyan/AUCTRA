# Listing images: Cloudflare R2 + Sharp

Sellers upload listing photos to the AUCTRA API. The API validates each file, re-encodes it with
[Sharp](https://sharp.pixelplumbing.com/) into three WebP variants and stores them in a Cloudflare
R2 bucket through the S3-compatible API (AWS SDK v3). PostgreSQL stores only metadata and object
keys — never image bytes. Browsers load images straight from R2's public URL; R2 credentials never
leave the server.

> Scope: this is for user-uploaded application media (auction photos). The README screenshots in
> `docs/screenshots/` are documentation assets and stay in Git.

## How an upload works

```
browser ──multipart──▶ NestJS API
                         1. JWT + permission guards; ownership checked BEFORE the body is read
                         2. multer streams the body into memory with hard limits (10 MB/file, 6 files)
                         3. Sharp: sniff magic bytes → read header → pixel limit → decode once
                            → auto-orient (EXIF) → 3 WebP variants, metadata stripped
                            (bounded queue: MEDIA_PROCESSING_CONCURRENCY, else 503 MEDIA_BUSY)
                         4. cleanup task row for the new key prefix  (crash-safety net)
                         5. PUT thumbnail/card/full to R2 (parallel; all settle before any cleanup)
                         6. short transaction: re-check access/limits, insert listing_media row,
                            delete the cleanup task
                       ◀── 201 { images, uploaded, failed }
```

No database transaction is open during image processing or network I/O.

| Failure | What happens |
| --- | --- |
| Invalid / corrupt / oversized file | 413 / 415 / 422 with a stable `code`; nothing is stored |
| R2 error during upload | Uploaded variants are deleted; 502 `MEDIA_UPLOAD_FAILED`; no row |
| R2 also fails the cleanup | The cleanup task stays; `MediaCleanupWorker` retries with back-off |
| Database error after upload | Uploaded objects are deleted; no row |
| Process crash between upload and insert | The pending task (15 min lease) is swept and the objects deleted |
| Very slow upload whose task was already swept | The insert refuses to commit (503 `MEDIA_UPLOAD_EXPIRED`) |
| Replacement fails | The original image row and objects are untouched |
| Image deleted / replaced | Row change and cleanup task commit together; objects deleted right after, or later by the worker |

The worker never deletes a prefix that a committed `listing_media` row still references.

## Variants

| Variant | Max width | WebP quality | Used for |
| --- | --- | --- | --- |
| `thumbnail` | 320 px | 75 | search results, dashboard rows, gallery strips, photo manager |
| `card` | 800 px | 80 | auction cards, checkout, AI listing cards, order thumbnails |
| `full` | 1600 px | 85 | item and auction-room gallery, zoom |

Widths are upper bounds: images are never enlarged. Height is capped at 3× the width (extreme
panoramas, WebP's 16383 px limit). Every variant is sized from the original's dimensions, so the
aspect ratio is preserved exactly. Transparency is kept. EXIF orientation is applied and then all
EXIF/XMP/IPTC metadata (including GPS location) is removed; colours are converted to sRGB.
Originals are **not** retained (nothing needs them, and they may contain location metadata).

Accepted input: JPEG, PNG, WebP, AVIF — identified by the file's bytes, not its name or
`Content-Type`. GIF, SVG, HEIC and anything else are refused. Minimum 100×100 px.

Measured results (Sharp 0.35.5 / libvips 8.18.7, Apple-silicon laptop; inputs derived from the
project's bundled images):

| Input | Source | thumbnail | card | full | Stored total | Time |
| --- | --- | --- | --- | --- | --- | --- |
| painting-2400.jpg | JPEG 2400×1600, 506.4 KB | 320×213, 8.5 KB | 800×533, 49.0 KB | 1600×1067, 148.8 KB | 206.3 KB | 179 ms |
| phone-rotated-exif6.jpg | JPEG 1200×2000 (EXIF 6), 278.5 KB | 320×533, 12.6 KB | 800×1333, 63.3 KB | 1200×2000, 130.1 KB | 206.0 KB | 258 ms |
| detail-alpha.png | PNG 900×900 + alpha, 599.7 KB | 320×320, 6.7 KB | 800×800, 39.1 KB | 900×900, 60.0 KB | 105.8 KB | 119 ms |
| small-600.webp | WebP 600×450, 29.4 KB | 320×240, 7.1 KB | 600×450, 24.6 KB | 600×450, 28.2 KB | 59.9 KB | 49 ms |

(Sizes depend on image content; noisy photos compress less.)

## Object keys and caching

```
<bucket>/
└── [MEDIA_KEY_PREFIX/]auctions/{auctionId}/{imageId}/thumbnail.webp
                                                    /card.webp
                                                    /full.webp
```

`MEDIA_KEY_PREFIX` is optional and empty in production. Set it (e.g. `dev`) when several
environments share one bucket, so development uploads never mix with production objects; the
integration tests use `integration-tests/<uuid>`. The database enforces the same key shape.

`imageId` is a server-generated UUID; client file names are never used. Every key is validated
against a strict pattern before any storage call, and clients can only address images by their
UUID within an auction they may manage — arbitrary keys cannot be deleted. Objects are written
once and never overwritten, so they are served with
`Cache-Control: public, max-age=31536000, immutable` and `Content-Type: image/webp`.

## Database

`listing_media` (existing table, extended — migration `20261115130000_listing_media_storage`,
additive only):

| Column | Meaning |
| --- | --- |
| `storage` | `R2`, `LOCAL` (dev), `EXTERNAL` (https URL), `BUNDLED` (`asset://` demo image) |
| `url` | full-size URL (stored images: the `full` variant's public URL) — unchanged for old readers |
| `storageKeyPrefix` | `auctions/{auctionId}/{imageId}/` (unique) |
| `variants` | `{ thumbnail|card|full: { key, url, width, height, bytes } }` |
| `width`, `height`, `bytes`, `mimeType` | full-variant dimensions, total stored bytes, `image/webp` |
| `originalMimeType`, `originalBytes`, `contentHash` | detected input type, size, SHA-256 |
| `position`, `isPrimary` | gallery order (0…n-1); the cover is always position 0 |
| `uploadedById`, `createdAt`, `updatedAt` | ownership and timestamps |

Database-enforced invariants: one cover per auction (partial unique index), the cover is first
(CHECK), stored images always have a key prefix and variants (CHECK), key-prefix format (CHECK),
the same photo cannot be added twice to one auction (partial unique index on `contentHash`).
`media_cleanup_tasks` holds prefixes awaiting deletion.

## API

All under `/api`. Writes require a signed-in owner of a **draft** listing (`auction:manage:own`) or a
moderator (`auction:moderate`, any status). Other callers get 404.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `GET` | `/auctions/:id/images` | — | Same visibility as `GET /auctions/:id` |
| `POST` | `/auctions/:id/images` | multipart: `images` (1–6 files), optional `altText` | 201 `{ images, uploaded, failed }`; 30/min |
| `POST` | `/auctions/:id/images/:imageId/replace` | multipart: `images` (1 file) | Keeps position and cover flag |
| `PATCH` | `/auctions/:id/images/reorder` | `{ "imageIds": [...] }` (all ids, new order) | First becomes the cover |
| `PATCH` | `/auctions/:id/images/:imageId/primary` | — | Moves the image to the front |
| `DELETE` | `/auctions/:id/images/:imageId` | — | Returns the remaining images |

Image object returned everywhere (also in `media` of `GET /auctions/:id`):

```json
{
  "id": "…", "url": "https://media.example.com/auctions/…/full.webp", "type": "IMAGE",
  "altText": null, "position": 0, "isPrimary": true, "storage": "r2",
  "width": 1600, "height": 1067, "mimeType": "image/webp", "bytes": 210000,
  "variants": {
    "thumbnail": { "url": "…/thumbnail.webp", "width": 320, "height": 213, "bytes": 8700 },
    "card":      { "url": "…/card.webp",      "width": 800, "height": 533, "bytes": 50200 },
    "full":      { "url": "…/full.webp",      "width": 1600, "height": 1067, "bytes": 152400 }
  },
  "createdAt": "…", "updatedAt": "…"
}
```

`variants` is `null` for legacy (`external` / `bundled`) images, which keep working unchanged.
The listing `media` field (URL list on create/update) is still accepted, but is refused with
409 `MEDIA_MANAGED_BY_UPLOADS` once a listing has uploaded photos, so it can never orphan them.

Error codes: `NO_FILES`, `MULTIPART_REQUIRED`, `TOO_MANY_FILES`, `UNEXPECTED_FILE_FIELD`,
`IMAGE_TOO_LARGE` (413), `UNSUPPORTED_IMAGE_TYPE` (415), `INVALID_IMAGE`, `IMAGE_TOO_SMALL`,
`IMAGE_DIMENSIONS_TOO_LARGE`, `EMPTY_FILE` (422), `DUPLICATE_IMAGE`, `IMAGE_LIMIT_REACHED`,
`AUCTION_NOT_EDITABLE` (409), `INVALID_IMAGE_ORDER` (400), `MEDIA_UPLOAD_FAILED` (502),
`MEDIA_BUSY`, `MEDIA_UPLOAD_EXPIRED`, `MEDIA_STORAGE_NOT_CONFIGURED` (503).

## Setting up Cloudflare R2

1. **Create the bucket.** Cloudflare dashboard → R2 Object Storage → Create bucket → name it
   e.g. `auctra` and set `R2_BUCKET_NAME` to it. Use a dedicated bucket for AUCTRA.
2. **Create a restricted API token.** R2 → Manage R2 API Tokens → Create API token →
   permission **Object Read & Write**, scoped to **this bucket only**, with an expiry if you like.
   Copy the *Access Key ID* and *Secret Access Key* (shown once) and your *Account ID*
   (R2 overview page). Never commit them; store them in `backend/.env` or your secret manager.
3. **Enable public delivery.** A bucket is private by default and does **not** serve public URLs.
   Either enable the bucket's **r2.dev** public development URL (bucket → Settings → Public
   Development URL → Allow; Cloudflare rate-limits it and does not cache it, so use it for
   development only) or, for production, connect a **custom domain** (bucket → Settings → Custom
   Domains, e.g. `media.example.com`), which adds Cloudflare caching. Only listing photos go in this
   bucket — never identity documents or private files, because every object in it is public.
4. **Configure the API** (`backend/.env`):

   ```bash
   R2_ACCOUNT_ID=<32-character account id>
   R2_ACCESS_KEY_ID=<access key id>
   R2_SECRET_ACCESS_KEY=<secret access key>
   R2_BUCKET_NAME=auctra
   R2_PUBLIC_BASE_URL=https://pub-<id>.r2.dev        # or https://media.example.com
   # MEDIA_STORAGE=r2                                 # implied once R2_* values are set
   # MEDIA_KEY_PREFIX=dev                             # optional: keep dev objects separate
   ```

   The endpoint defaults to `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` with region `auto`
   (override with `R2_ENDPOINT`, e.g. for the EU jurisdiction). Incomplete R2 settings stop the
   API at startup with a message naming the missing variables.
5. Restart the API. Its startup log names the active driver, without credentials:
   `Media storage: Cloudflare R2 (bucket "auctra", public https://pub-….r2.dev)`. The frontend
   needs no configuration: it only receives public image URLs.
6. Run the live smoke test (below) to prove credentials, permissions and public delivery.

Without R2 settings, development uses `MEDIA_STORAGE=local` (files under `backend/storage/media`,
git-ignored, served by the API at `/media/...`). Production refuses `local`; with neither, uploads
answer 503 `MEDIA_STORAGE_NOT_CONFIGURED`.

## Verifying it

**Live smoke test against the real bucket** (opt-in; uses the R2 settings in `backend/.env`):

```bash
cd backend && npm run r2:smoke
```

It generates a synthetic sideways phone photo (EXIF orientation 6 with a red marker), runs it
through the real Sharp pipeline, uploads the three variants through `StorageService` under a
unique `integration-tests/<uuid>/` prefix with `purpose=integration-test` object metadata, and
checks each object with HeadObject (type, length, cache headers), GetObject (decodes as WebP with
the expected size, no EXIF/ICC, upright) and its public URL (HTTP 200, identical bytes), plus that
only the three variants exist under the prefix. It then deletes exactly the keys it uploaded —
also when a check fails — and verifies the prefix is empty. Nothing outside its prefix is listed,
read or deleted, and credentials are never printed. Exit code 0 means every check passed.

To exercise the whole app against R2 without touching development data, run a second API on a
separate database with `MEDIA_KEY_PREFIX=integration-tests/<uuid>`; every object it writes is
then under that prefix.

**In the app:** sign in as a seller in the app → **Sell an item** → create a listing → the *Photos* step uploads
to the API. Or with curl (a seller access token from `POST /api/auth/login`):

```bash
# Upload one or more photos to a draft you own
curl -sS -X POST "http://localhost:4000/api/auctions/$AUCTION_ID/images" \
  -H "Authorization: Bearer $TOKEN" \
  -F "images=@photo1.jpg" -F "images=@photo2.png" | jq '.uploaded[] | {id, variants}'

# Check the stored WebP variants (type, size, immutable caching)
curl -sI "$FULL_URL" | grep -iE 'content-type|content-length|cache-control'
curl -s "$CARD_URL" -o card.webp && file card.webp        # → RIFF … Web/P image, 800 x …
```

Stored metadata:

```sql
SELECT id, position, "isPrimary", storage, width, height, bytes,
       "originalMimeType", "originalBytes", "storageKeyPrefix",
       variants -> 'thumbnail' ->> 'url' AS thumbnail_url
FROM listing_media WHERE "auctionId" = '<auction id>' ORDER BY position;
SELECT * FROM media_cleanup_tasks;   -- normally empty
```

Deletion:

```bash
curl -sS -X DELETE "http://localhost:4000/api/auctions/$AUCTION_ID/images/$IMAGE_ID" \
  -H "Authorization: Bearer $TOKEN" | jq length
curl -s -o /dev/null -w "%{http_code}\n" "$FULL_URL"   # 404 once deleted (cached copies may
                                                       # live until the CDN cache expires)
```

## Existing images

Seeded demo listings reference images bundled with the frontend (`asset://car` …); older API
clients may have stored external https URLs. Both keep working (`storage = BUNDLED` / `EXTERNAL`,
`variants = null`) and the UI falls back to the single URL for every size.

`npm run media:migrate` converts them into stored variants — explicitly and reversibly:

```bash
npm run media:migrate                                     # dry run: inventory + plan (default)
npm run media:migrate -- --include-bundled --apply        # bundled demo images
npm run media:migrate -- --allow-host cdn.example.com --apply   # one external host
npm run media:migrate -- --rollback storage/media-migrations/<journal>.json --apply
```

Only pass `--include-bundled` / `--allow-host` for images you own or are licensed to re-host —
the script never downloads anything that was not explicitly selected. Rows keep their id,
position, cover flag and alt text; a row's URL is replaced only after all three variants are
uploaded; already-migrated rows are skipped on re-runs; each run writes a rollback journal.
The bundled demo images came with the original UI scaffold; their licence has not been verified,
so they have **not** been migrated.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEDIA_STORAGE` | `r2` if any `R2_*` is set, else `local` in development, else `disabled` | storage backend |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | — | R2 credentials (server only) |
| `R2_BUCKET_NAME` | `auctra` | bucket |
| `R2_PUBLIC_BASE_URL` | — (required for R2) | r2.dev URL or custom domain |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | S3 endpoint override |
| `MEDIA_KEY_PREFIX` | empty | optional key namespace, e.g. `dev` (see *Object keys*) |
| `MEDIA_LOCAL_DIR`, `MEDIA_LOCAL_PUBLIC_URL` | `storage/media`, `http://localhost:<PORT>/media` | dev disk storage |
| `MEDIA_MAX_UPLOAD_MB` | 10 | per-file limit (enforced while streaming) |
| `MEDIA_MAX_PIXELS` | 40000000 | decompression-bomb guard (checked from the header) |
| `MEDIA_MAX_IMAGES_PER_AUCTION` | 12 | photos per listing |
| `MEDIA_PROCESSING_CONCURRENCY` | 2 | images decoded at once per instance |
| `MEDIA_PROCESSING_QUEUE_MAX` | 16 | waiting uploads before 503 `MEDIA_BUSY` |

Metrics (`/api/metrics`): `auctra_media_uploads_total{result}`,
`auctra_media_processing_seconds`, `auctra_storage_operations_total{op,result}`.

## Tests

- `src/media/image-processor.spec.ts` — JPEG/PNG/WebP/AVIF input, WebP output, metadata stripping,
  EXIF orientation, aspect ratio, no upscaling, height cap, size/pixel/min-size limits, corrupt,
  truncated and spoofed files, bounded processing queue.
- `src/storage/storage.spec.ts` — R2 driver commands and headers (fake S3 client), 404 handling,
  client configuration (region `auto`, endpoint, checksums), key validation, configuration rules.
- `test/media.e2e-spec.ts` — real PostgreSQL with an in-memory R2 stand-in: uploads, multi-file and
  partial failures, auth/ownership/status rules, limits, duplicates, reorder, cover, delete,
  replace, R2 failure mid-upload, failed cleanup + worker retry, R2 down during delete (worker
  finishes later), database failure after upload, crash recovery, more than 6 files per request,
  concurrent requests racing the per-listing limit, key-namespace constraints, compatibility with
  URL-based and bundled images, storage not configured.
- `npm run r2:smoke` — the only test that talks to Cloudflare (see *Verifying it*).

`npm test` / `npm run test:e2e` never contact a real bucket: the test environment forces
`MEDIA_STORAGE=disabled` and clears `R2_*` even if `.env` contains credentials.
