import request from 'supertest';
import sharp from 'sharp';
import { RoleKey } from '../src/roles/permissions.js';
import { STORAGE_DRIVER } from '../src/storage/storage.types.js';
import { MediaCleanupWorker } from '../src/media/media-cleanup.worker.js';
import {
  auth,
  createLiveAuction,
  createTestApp,
  resetDb,
  signedIn,
  type TestApp,
} from './helpers.js';
import { FakeStorage } from './fake-storage.js';

// Small limits so the limit paths are cheap to exercise (read when the app boots).
process.env['MEDIA_MAX_UPLOAD_MB'] = '1';
process.env['MEDIA_MAX_PIXELS'] = '5000000';
process.env['MEDIA_MAX_IMAGES_PER_AUCTION'] = '4';

const storage = new FakeStorage();
let t: TestApp;

const FAIL_ALT = 'simulate-db-failure';

beforeAll(async () => {
  t = await createTestApp((b) =>
    b.overrideProvider(STORAGE_DRIVER).useValue(storage),
  );
  // Test-DB-only trigger to simulate the database failing after the objects were uploaded.
  await t.prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_fail_media_insert() RETURNS trigger AS $$
    BEGIN
      IF NEW."altText" = '${FAIL_ALT}' THEN RAISE EXCEPTION 'simulated database failure'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await t.prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS test_fail_media_insert ON listing_media`,
  );
  await t.prisma.$executeRawUnsafe(
    `CREATE TRIGGER test_fail_media_insert BEFORE INSERT ON listing_media FOR EACH ROW EXECUTE FUNCTION test_fail_media_insert()`,
  );
});
beforeEach(async () => {
  await resetDb(t.prisma);
  storage.reset();
});
afterAll(async () => {
  await t.prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS test_fail_media_insert ON listing_media`,
  );
  await t.prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS test_fail_media_insert()`,
  );
  await t.close();
});

// ───────────── fixtures ─────────────

const img = (w: number, h: number, seed = 0, alpha = false) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: alpha ? 4 : 3,
      background: {
        r: (seed * 53) % 255,
        g: (seed * 97) % 255,
        b: 120,
        ...(alpha ? { alpha: 0.5 } : {}),
      },
      noise: { type: 'gaussian', mean: 100 + seed, sigma: 6 },
    },
  });
const jpeg = (w = 1200, h = 800, seed = 1) =>
  img(w, h, seed).jpeg({ quality: 60 }).toBuffer();
const png = (w = 600, h = 400, seed = 2) =>
  img(w, h, seed, true).png({ palette: true }).toBuffer();

async function seller() {
  return signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
}

async function draftFor(
  sellerId: string,
  status: 'DRAFT' | 'LIVE' | 'SCHEDULED' = 'DRAFT',
) {
  return createLiveAuction(t.prisma, sellerId, { status });
}

function upload(
  token: string | null,
  auctionId: string,
  files: { buf: Buffer; name: string }[],
  fields: Record<string, string> = {},
) {
  let r = request(t.http).post(`/api/auctions/${auctionId}/images`);
  if (token) r = r.set(auth(token));
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  for (const f of files) r = r.attach('images', f.buf, f.name);
  return r;
}

const prefixOf = (auctionId: string, imageId: string) =>
  `auctions/${auctionId}/${imageId}/`;

// ───────────── tests ─────────────

describe('POST /auctions/:id/images', () => {
  it('stores a JPEG as three WebP variants in R2 and records the metadata', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const res = await upload(session.token, a.id, [
      { buf: await jpeg(2400, 1600), name: '../../evil name.jpg' },
    ]).expect(201);

    expect(res.body.failed).toEqual([]);
    const image = res.body.uploaded[0];
    expect(image).toMatchObject({
      position: 0,
      isPrimary: true,
      storage: 'r2',
      mimeType: 'image/webp',
      width: 1600,
      height: 1067,
    });
    expect(image.variants.thumbnail).toMatchObject({ width: 320, height: 213 });
    expect(image.variants.card).toMatchObject({ width: 800, height: 533 });
    expect(image.url).toBe(image.variants.full.url);
    expect(image).not.toHaveProperty('storageKeyPrefix');

    // Object keys are server-generated: auctions/{auctionId}/{imageId}/{variant}.webp.
    const prefix = prefixOf(a.id, image.id);
    expect(storage.keysUnder('auctions/')).toEqual(
      ['card', 'full', 'thumbnail'].map((v) => `${prefix}${v}.webp`),
    );
    for (const o of storage.objects.values()) {
      expect(o.contentType).toBe('image/webp');
      expect(o.cacheControl).toBe('public, max-age=31536000, immutable');
      expect((await sharp(o.body).metadata()).format).toBe('webp');
    }
    expect(image.variants.full.url).toBe(
      `https://media.test.auctra/${prefix}full.webp`,
    );

    const row = await t.prisma.listingMedia.findUniqueOrThrow({
      where: { id: image.id },
    });
    expect(row).toMatchObject({
      storage: 'R2',
      storageKeyPrefix: prefix,
      originalMimeType: 'image/jpeg',
      uploadedById: user.id,
      isPrimary: true,
    });
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.bytes).toBe(
      image.variants.thumbnail.bytes +
        image.variants.card.bytes +
        image.variants.full.bytes,
    );
    expect(await t.prisma.mediaCleanupTask.count()).toBe(0);
    const audit = await t.prisma.auditLog.findFirst({
      where: { action: 'auction.image.upload' },
    });
    expect(audit?.entityId).toBe(a.id);
  });

  it('accepts PNG and several files per request, in order; only the first is the cover', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    await upload(session.token, a.id, [
      { buf: await jpeg(), name: 'a.jpg' },
    ]).expect(201);
    const res = await upload(session.token, a.id, [
      { buf: await png(), name: 'b.png' },
      { buf: await jpeg(900, 900, 5), name: 'c.jpg' },
    ]).expect(201);
    expect(res.body.uploaded).toHaveLength(2);
    expect(
      res.body.images.map((i: { position: number; isPrimary: boolean }) => [
        i.position,
        i.isPrimary,
      ]),
    ).toEqual([
      [0, true],
      [1, false],
      [2, false],
    ]);
    expect(storage.objects.size).toBe(9);
  });

  it('reports partial failures per file and keeps the valid uploads', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const res = await upload(session.token, a.id, [
      { buf: await jpeg(), name: 'ok.jpg' },
      { buf: Buffer.from('definitely not an image'), name: 'fake.jpg' },
    ]).expect(201);
    expect(res.body.uploaded).toHaveLength(1);
    expect(res.body.failed).toEqual([
      expect.objectContaining({
        index: 1,
        fileName: 'fake.jpg',
        code: 'UNSUPPORTED_IMAGE_TYPE',
      }),
    ]);
    expect(storage.objects.size).toBe(3);
  });

  it('rejects unauthenticated, non-owner and non-seller callers before storing anything', async () => {
    const { user } = await seller();
    const a = await draftFor(user.id);
    const other = await seller();
    const buyer = await signedIn(t);
    const buf = await jpeg();
    expect((await upload(null, a.id, [{ buf, name: 'a.jpg' }])).status).toBe(
      401,
    );
    expect(
      (await upload(other.session.token, a.id, [{ buf, name: 'a.jpg' }]))
        .status,
    ).toBe(404);
    expect(
      (await upload(buyer.session.token, a.id, [{ buf, name: 'a.jpg' }]))
        .status,
    ).toBe(404);
    expect(storage.calls).toHaveLength(0);
    expect(await t.prisma.listingMedia.count()).toBe(0);
  });

  it('lets owners change photos only on drafts, while moderators can on any listing', async () => {
    const { user, session } = await seller();
    const live = await draftFor(user.id, 'LIVE');
    const res = await upload(session.token, live.id, [
      { buf: await jpeg(), name: 'a.jpg' },
    ]).expect(409);
    expect(res.body.code).toBe('AUCTION_NOT_EDITABLE');
    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    await upload(admin.session.token, live.id, [
      { buf: await jpeg(), name: 'a.jpg' },
    ]).expect(201);
  });

  it('enforces the upload size limit while streaming (413)', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const big = await img(1100, 1100, 9)
      .png({ compressionLevel: 0 })
      .toBuffer(); // uncompressed: >1 MB
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const res = await upload(session.token, a.id, [
      { buf: big, name: 'big.png' },
    ]).expect(413);
    expect(res.body.code).toBe('IMAGE_TOO_LARGE');
    expect(storage.calls).toHaveLength(0);
  });

  it('rejects corrupted files, spoofed types and oversized pixel dimensions', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const truncated = (await jpeg()).subarray(0, 4000);
    expect(
      (
        await upload(session.token, a.id, [
          { buf: truncated, name: 'cut.jpg' },
        ]).expect(422)
      ).body.code,
    ).toBe('INVALID_IMAGE');
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"/>',
    );
    expect(
      (
        await upload(session.token, a.id, [{ buf: svg, name: 'x.jpg' }]).expect(
          415,
        )
      ).body.code,
    ).toBe('UNSUPPORTED_IMAGE_TYPE');
    const huge = await img(3000, 2000, 3).jpeg({ quality: 40 }).toBuffer(); // 6 MP > 5 MP limit
    expect(
      (
        await upload(session.token, a.id, [
          { buf: huge, name: 'huge.jpg' },
        ]).expect(422)
      ).body.code,
    ).toBe('IMAGE_DIMENSIONS_TOO_LARGE');
    // Not multipart at all.
    const json = await request(t.http)
      .post(`/api/auctions/${a.id}/images`)
      .set(auth(session.token))
      .send({ url: 'https://example.com/a.jpg' })
      .expect(415);
    expect(json.body.code).toBe('MULTIPART_REQUIRED');
    expect(storage.calls).toHaveLength(0);
  });

  it('limits the number of photos per listing and refuses duplicates', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const first = await jpeg(800, 600, 1);
    await upload(session.token, a.id, [{ buf: first, name: '1.jpg' }]).expect(
      201,
    );
    const dup = await upload(session.token, a.id, [
      { buf: first, name: 'again.jpg' },
    ]).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_IMAGE');
    for (const seed of [2, 3, 4])
      await upload(session.token, a.id, [
        { buf: await jpeg(800, 600, seed), name: `${seed}.jpg` },
      ]).expect(201);
    const over = await upload(session.token, a.id, [
      { buf: await jpeg(800, 600, 9), name: '9.jpg' },
    ]).expect(409);
    expect(over.body.code).toBe('IMAGE_LIMIT_REACHED');
    expect(storage.objects.size).toBe(12);
  });

  it('rejects more than 6 files in one request before storing anything', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const files = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7].map(async (i) => ({
        buf: await jpeg(200, 200, i),
        name: `${i}.jpg`,
      })),
    );
    const res = await upload(session.token, a.id, files).expect(400);
    expect(res.body.code).toBe('TOO_MANY_FILES');
    expect(storage.calls).toHaveLength(0);
    expect(await t.prisma.listingMedia.count()).toBe(0);
  });

  it('concurrent uploads cannot exceed the per-listing photo limit', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    // 4 simultaneous requests × 2 distinct photos = 8 attempts against a limit of 4.
    const bodies = await Promise.all(
      [0, 1, 2, 3].map(async (r) =>
        Promise.all(
          [0, 1].map(async (i) => ({
            buf: await jpeg(300, 200, 20 + r * 2 + i),
            name: `${r}-${i}.jpg`,
          })),
        ),
      ),
    );
    const results = await Promise.all(
      bodies.map((files) => upload(session.token, a.id, files)),
    );
    const stored = results.flatMap((r) =>
      r.status === 201 ? (r.body.uploaded as unknown[]) : [],
    );
    expect(stored).toHaveLength(4);
    const rows = await t.prisma.listingMedia.findMany({
      where: { auctionId: a.id },
      orderBy: { position: 'asc' },
    });
    expect(rows.map((r) => [r.position, r.isPrimary])).toEqual([
      [0, true],
      [1, false],
      [2, false],
      [3, false],
    ]);
    // Rejected files never left objects behind.
    expect(storage.objects.size).toBe(12);
    expect(await t.prisma.mediaCleanupTask.count()).toBe(0);
  });

  it('cleans up partial uploads when R2 fails mid-upload and keeps nothing in the DB', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    storage.failPut = (key) => key.endsWith('/card.webp');
    const res = await upload(session.token, a.id, [
      { buf: await jpeg(), name: 'a.jpg' },
    ]).expect(502);
    expect(res.body.code).toBe('MEDIA_UPLOAD_FAILED');
    // thumbnail/full may have been stored before card failed — all deleted again.
    expect(storage.objects.size).toBe(0);
    expect(storage.calls.filter((c) => c.op === 'delete').length).toBe(3);
    expect(await t.prisma.listingMedia.count()).toBe(0);
    expect(await t.prisma.mediaCleanupTask.count()).toBe(0);
  });

  it('records a cleanup task when even the cleanup fails, and the worker finishes it later', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    storage.failPut = (key) => key.endsWith('/full.webp');
    storage.failDelete = () => true; // R2 completely unreachable for deletes too
    await upload(session.token, a.id, [
      { buf: await jpeg(), name: 'a.jpg' },
    ]).expect(502);
    expect(storage.objects.size).toBeGreaterThan(0); // orphans for now
    const task = await t.prisma.mediaCleanupTask.findFirstOrThrow();
    expect(task).toMatchObject({ reason: 'upload_failed', storage: 'R2' });
    expect(task.lastError).toMatch(/ECONNRESET/);

    // R2 recovers; make the task due and run the sweeper.
    storage.failDelete = () => false;
    await t.prisma.mediaCleanupTask.updateMany({
      data: { runAfter: new Date(Date.now() - 1000) },
    });
    const report = await t.app.get(MediaCleanupWorker).sweep();
    expect(report).toEqual({ deleted: 1, skippedInUse: 0, failed: 0 });
    expect(storage.objects.size).toBe(0);
    expect(await t.prisma.mediaCleanupTask.count()).toBe(0);
  });

  it('deletes uploaded objects when the database fails after the upload', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const res = await upload(
      session.token,
      a.id,
      [{ buf: await jpeg(), name: 'a.jpg' }],
      { altText: FAIL_ALT },
    );
    expect(res.status).toBe(500);
    expect(storage.calls.filter((c) => c.op === 'put')).toHaveLength(3);
    expect(storage.objects.size).toBe(0);
    expect(await t.prisma.listingMedia.count()).toBe(0);
    expect(await t.prisma.mediaCleanupTask.count()).toBe(0);
  });
});

describe('managing listing photos', () => {
  async function withImages(n: number) {
    const s = await seller();
    const a = await draftFor(s.user.id);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await upload(s.session.token, a.id, [
        { buf: await jpeg(800, 600, 10 + i), name: `${i}.jpg` },
      ]).expect(201);
      ids.push(r.body.uploaded[0].id);
    }
    return { ...s, auction: a, ids };
  }
  const order = (
    body: { id: string; position: number; isPrimary: boolean }[],
  ) => body.map((i) => [i.id, i.position, i.isPrimary]);

  it('reorders the gallery; the first image becomes the cover', async () => {
    const { session, auction, ids } = await withImages(3);
    const res = await request(t.http)
      .patch(`/api/auctions/${auction.id}/images/reorder`)
      .set(auth(session.token))
      .send({ imageIds: [ids[2], ids[0], ids[1]] })
      .expect(200);
    expect(order(res.body)).toEqual([
      [ids[2], 0, true],
      [ids[0], 1, false],
      [ids[1], 2, false],
    ]);
    const bad = await request(t.http)
      .patch(`/api/auctions/${auction.id}/images/reorder`)
      .set(auth(session.token))
      .send({ imageIds: [ids[0], ids[1]] })
      .expect(400);
    expect(bad.body.code).toBe('INVALID_IMAGE_ORDER');
  });

  it('sets the primary image (exactly one per auction, always first)', async () => {
    const { session, auction, ids } = await withImages(3);
    const res = await request(t.http)
      .patch(`/api/auctions/${auction.id}/images/${ids[1]}/primary`)
      .set(auth(session.token))
      .expect(200);
    expect(order(res.body)).toEqual([
      [ids[1], 0, true],
      [ids[0], 1, false],
      [ids[2], 2, false],
    ]);
    expect(
      await t.prisma.listingMedia.count({
        where: { auctionId: auction.id, isPrimary: true },
      }),
    ).toBe(1);
    // The database itself refuses a second cover.
    await expect(
      t.prisma.listingMedia.update({
        where: { id: ids[2]! },
        data: { isPrimary: true },
      }),
    ).rejects.toThrow();
  });

  it('deletes an image, its R2 objects, and compacts the gallery', async () => {
    const { session, auction, ids } = await withImages(3);
    const res = await request(t.http)
      .delete(`/api/auctions/${auction.id}/images/${ids[0]}`)
      .set(auth(session.token))
      .expect(200);
    expect(order(res.body)).toEqual([
      [ids[1], 0, true],
      [ids[2], 1, false],
    ]);
    expect(storage.keysUnder(prefixOf(auction.id, ids[0]!))).toEqual([]);
    expect(storage.objects.size).toBe(6);
    expect(await t.prisma.mediaCleanupTask.count()).toBe(0);
  });

  it('deleting while R2 is down removes the photo now and its objects later', async () => {
    const { session, auction, ids } = await withImages(2);
    storage.failDelete = () => true;
    const res = await request(t.http)
      .delete(`/api/auctions/${auction.id}/images/${ids[0]}`)
      .set(auth(session.token))
      .expect(200);
    expect(order(res.body)).toEqual([[ids[1], 0, true]]);
    // Objects still exist, but a durable task remembers to delete them.
    expect(storage.keysUnder(prefixOf(auction.id, ids[0]!))).toHaveLength(3);
    const task = await t.prisma.mediaCleanupTask.findFirstOrThrow();
    expect(task).toMatchObject({
      keyPrefix: prefixOf(auction.id, ids[0]!),
      reason: 'image_deleted',
    });
    storage.failDelete = () => false;
    await t.prisma.mediaCleanupTask.updateMany({
      data: { runAfter: new Date(Date.now() - 1000) },
    });
    expect(await t.app.get(MediaCleanupWorker).sweep()).toEqual({
      deleted: 1,
      skippedInUse: 0,
      failed: 0,
    });
    expect(storage.keysUnder(prefixOf(auction.id, ids[0]!))).toEqual([]);
    expect(storage.keysUnder(prefixOf(auction.id, ids[1]!))).toHaveLength(3);
    expect(await t.prisma.mediaCleanupTask.count()).toBe(0);
  });

  it('cannot delete images of another listing or arbitrary keys', async () => {
    const mine = await withImages(1);
    const theirs = await withImages(1);
    // Someone else's image id under my auction → not found, nothing deleted.
    await request(t.http)
      .delete(`/api/auctions/${mine.auction.id}/images/${theirs.ids[0]}`)
      .set(auth(mine.session.token))
      .expect(404);
    await request(t.http)
      .delete(`/api/auctions/${theirs.auction.id}/images/${theirs.ids[0]}`)
      .set(auth(mine.session.token))
      .expect(404);
    // Keys are never accepted from clients: a path-looking id is rejected by validation.
    await request(t.http)
      .delete(
        `/api/auctions/${mine.auction.id}/images/${encodeURIComponent('auctions/x/y/full.webp')}`,
      )
      .set(auth(mine.session.token))
      .expect(400);
    expect(storage.objects.size).toBe(6);
  });

  it('replaces an image in place and deletes the old objects only after success', async () => {
    const { session, auction, ids } = await withImages(2);
    const res = await request(t.http)
      .post(`/api/auctions/${auction.id}/images/${ids[0]}/replace`)
      .set(auth(session.token))
      .attach('images', await png(700, 700, 40), 'new.png')
      .expect(201);
    expect(res.body.image).toMatchObject({ position: 0, isPrimary: true });
    expect(res.body.image.id).not.toBe(ids[0]);
    expect(storage.keysUnder(prefixOf(auction.id, ids[0]!))).toEqual([]);
    expect(
      storage.keysUnder(prefixOf(auction.id, res.body.image.id)),
    ).toHaveLength(3);
  });

  it('keeps the existing image when a replacement fails', async () => {
    const { session, auction, ids } = await withImages(1);
    storage.failPut = () => true;
    await request(t.http)
      .post(`/api/auctions/${auction.id}/images/${ids[0]}/replace`)
      .set(auth(session.token))
      .attach('images', await png(700, 700, 41), 'new.png')
      .expect(502);
    const rows = await t.prisma.listingMedia.findMany({
      where: { auctionId: auction.id },
    });
    expect(rows.map((r) => r.id)).toEqual([ids[0]]);
    expect(storage.keysUnder(prefixOf(auction.id, ids[0]!))).toHaveLength(3);
  });

  it('a moderator can remove a photo from a scheduled listing', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const up = await upload(session.token, a.id, [
      { buf: await jpeg(), name: 'a.jpg' },
    ]).expect(201);
    await t.prisma.auction.update({
      where: { id: a.id },
      data: { status: 'SCHEDULED' },
    });
    const ownerTry = await request(t.http)
      .delete(`/api/auctions/${a.id}/images/${up.body.uploaded[0].id}`)
      .set(auth(session.token))
      .expect(409);
    expect(ownerTry.body.code).toBe('AUCTION_NOT_EDITABLE');
    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    await request(t.http)
      .delete(`/api/auctions/${a.id}/images/${up.body.uploaded[0].id}`)
      .set(auth(admin.session.token))
      .expect(200);
    expect(storage.objects.size).toBe(0);
  });
});

describe('cleanup worker', () => {
  it('removes objects of an upload that never committed, but never objects still in use', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const kept = await upload(session.token, a.id, [
      { buf: await jpeg(), name: 'a.jpg' },
    ]).expect(201);
    const keptPrefix = prefixOf(a.id, kept.body.uploaded[0].id);
    // Simulate a crash between upload and insert: objects + pending task, no row.
    const orphan = prefixOf(a.id, '7f9c2a52-61a4-4a8e-9b1a-0d7d6d0c1e11');
    for (const v of ['thumbnail', 'card', 'full'])
      await storage.put(`${orphan}${v}.webp`, Buffer.from('x'), {
        contentType: 'image/webp',
        cacheControl: 'x',
      });
    const past = new Date(Date.now() - 60_000);
    await t.prisma.mediaCleanupTask.createMany({
      data: [
        {
          keyPrefix: orphan,
          storage: 'R2',
          reason: 'upload_pending',
          runAfter: past,
        },
        // A task that (wrongly) points at a committed image must not delete it.
        {
          keyPrefix: keptPrefix,
          storage: 'R2',
          reason: 'upload_pending',
          runAfter: past,
        },
      ],
    });
    const report = await t.app.get(MediaCleanupWorker).sweep();
    expect(report).toEqual({ deleted: 1, skippedInUse: 1, failed: 0 });
    expect(storage.keysUnder(orphan)).toEqual([]);
    expect(storage.keysUnder(keptPrefix)).toHaveLength(3);
    expect(await t.prisma.mediaCleanupTask.count()).toBe(0);
  });

  it('a slow upload whose pending task was already swept cannot commit', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    // Make the sweeper claim the pending task while the upload is in flight.
    storage.failPut = () => false;
    const worker = t.app.get(MediaCleanupWorker);
    const realPut = storage.put.bind(storage);
    storage.put = async (key, body, o) => {
      if (key.endsWith('/full.webp')) {
        await t.prisma.mediaCleanupTask.updateMany({
          data: { runAfter: new Date(Date.now() - 1000) },
        });
        await worker.sweep();
      }
      return realPut(key, body, o);
    };
    try {
      const res = await upload(session.token, a.id, [
        { buf: await jpeg(), name: 'a.jpg' },
      ]);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('MEDIA_UPLOAD_EXPIRED');
    } finally {
      storage.put = realPut;
    }
    expect(await t.prisma.listingMedia.count()).toBe(0);
    expect(storage.objects.size).toBe(0);
  });
});

describe('reads and compatibility with existing listings', () => {
  it('serves images with the auction and hides drafts from the public', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    await upload(session.token, a.id, [
      { buf: await jpeg(), name: 'a.jpg' },
    ]).expect(201);
    await request(t.http).get(`/api/auctions/${a.id}/images`).expect(404);
    const own = await request(t.http)
      .get(`/api/auctions/${a.id}/images`)
      .set(auth(session.token))
      .expect(200);
    expect(own.body).toHaveLength(1);
    await t.prisma.auction.update({
      where: { id: a.id },
      data: { status: 'LIVE' },
    });
    const pub = await request(t.http).get(`/api/auctions/${a.id}`).expect(200);
    expect(pub.body.media[0].variants.card.url).toMatch(/card\.webp$/);
  });

  it('keeps URL-based and bundled images working, and protects uploaded ones', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    await t.prisma.listingMedia.createMany({
      data: [
        {
          auctionId: a.id,
          url: 'asset://watch',
          position: 0,
          isPrimary: true,
          storage: 'BUNDLED',
        },
        {
          auctionId: a.id,
          url: 'https://images.example.com/w.jpg',
          position: 1,
          storage: 'EXTERNAL',
        },
      ],
    });
    const list = await request(t.http)
      .get(`/api/auctions/${a.id}/images`)
      .set(auth(session.token))
      .expect(200);
    expect(
      list.body.map(
        (i: { storage: string; variants: unknown; url: string }) => [
          i.storage,
          i.variants,
          i.url,
        ],
      ),
    ).toEqual([
      ['bundled', null, 'asset://watch'],
      ['external', null, 'https://images.example.com/w.jpg'],
    ]);
    // Uploads append after legacy images; reordering mixes both kinds.
    const up = await upload(session.token, a.id, [
      { buf: await jpeg(), name: 'a.jpg' },
    ]).expect(201);
    expect(up.body.uploaded[0]).toMatchObject({
      position: 2,
      isPrimary: false,
    });
    // The legacy URL list can no longer overwrite (and orphan) uploaded photos.
    const patch = await request(t.http)
      .patch(`/api/auctions/${a.id}`)
      .set(auth(session.token))
      .send({ media: [{ url: 'https://images.example.com/other.jpg' }] })
      .expect(409);
    expect(patch.body.code).toBe('MEDIA_MANAGED_BY_UPLOADS');
    // Deleting a legacy image touches no storage objects.
    const legacyId = list.body[1].id;
    const deletesBefore = storage.calls.filter((c) => c.op === 'delete').length;
    await request(t.http)
      .delete(`/api/auctions/${a.id}/images/${legacyId}`)
      .set(auth(session.token))
      .expect(200);
    expect(storage.calls.filter((c) => c.op === 'delete').length).toBe(
      deletesBefore,
    );
  });

  it('URL media on create still works and marks the first image as cover', async () => {
    const { session } = await seller();
    const res = await request(t.http)
      .post('/api/auctions')
      .set(auth(session.token))
      .send({
        title: 'Steel diver chronometer',
        description:
          'A well-kept automatic diver with box and papers, recently serviced.',
        categorySlug: 'watches',
        subcategorySlug: 'watches-sport',
        condition: 'VERY_GOOD',
        currency: 'USD',
        startingPriceMinor: '900000',
        minIncrementMinor: '25000',
        startsAt: new Date(Date.now() + 3600_000).toISOString(),
        endsAt: new Date(Date.now() + 7200_000).toISOString(),
        media: [
          { url: 'https://images.example.com/watch.jpg' },
          { url: 'asset://watch' },
        ],
      })
      .expect(201);
    expect(
      res.body.media.map((m: { storage: string; isPrimary: boolean }) => [
        m.storage,
        m.isPrimary,
      ]),
    ).toEqual([
      ['external', true],
      ['bundled', false],
    ]);
  });
});

describe('object key namespace (MEDIA_KEY_PREFIX)', () => {
  it('the database accepts namespaced prefixes and still rejects malformed ones', async () => {
    const id = '0b9c1d2e-0000-4000-8000-000000000001';
    const ok = [
      `auctions/${id}/${id}/`,
      `dev/auctions/${id}/${id}/`,
      `integration-tests/${id}/auctions/${id}/${id}/`,
    ];
    for (const keyPrefix of ok)
      await t.prisma.mediaCleanupTask.create({
        data: {
          keyPrefix,
          storage: 'R2',
          reason: 'test',
          runAfter: new Date(),
        },
      });
    for (const keyPrefix of [
      `../auctions/${id}/${id}/`,
      `Dev/auctions/${id}/${id}/`,
      `auctions/${id}/${id}/full.webp`,
      `x/auctions/../${id}/${id}/`,
    ])
      await expect(
        t.prisma.mediaCleanupTask.create({
          data: {
            keyPrefix,
            storage: 'R2',
            reason: 'test',
            runAfter: new Date(),
          },
        }),
      ).rejects.toThrow();
    expect(await t.prisma.mediaCleanupTask.count()).toBe(ok.length);
  });
});

describe('without storage configured', () => {
  let plain: TestApp;
  beforeAll(async () => {
    plain = await createTestApp(); // MEDIA_STORAGE=disabled in the test environment
  });
  afterAll(async () => {
    await plain.close();
  });

  it('refuses uploads with 503 and a clear code', async () => {
    const { user, session } = await seller();
    const a = await draftFor(user.id);
    const res = await request(plain.http)
      .post(`/api/auctions/${a.id}/images`)
      .set(auth(session.token))
      .attach('images', await jpeg(), 'a.jpg')
      .expect(503);
    expect(res.body.code).toBe('MEDIA_STORAGE_NOT_CONFIGURED');
  });
});
