/**
 * Moves existing listing images (bundled demo assets or external https URLs) into the
 * configured image storage (Cloudflare R2), producing the same WebP variants as uploads.
 *
 *   npm run media:migrate                                   # dry run: inventory + plan
 *   npm run media:migrate -- --include-bundled --apply      # migrate asset://… images
 *   npm run media:migrate -- --allow-host cdn.example.com --apply
 *   npm run media:migrate -- --rollback storage/media-migrations/<file>.json --apply
 *
 * Safety rules:
 *  - Dry run unless --apply. Nothing is migrated implicitly: bundled assets need
 *    --include-bundled and external images need --allow-host <host> for each host —
 *    pass them only for images you own or are licensed to re-host.
 *  - Rows are updated in place (same id, position, cover flag, alt text) and only after
 *    all three variants were uploaded; the old URL is kept until then.
 *  - Re-running skips rows that are already stored, so nothing is uploaded twice.
 *  - Every change is journaled; --rollback restores the old URLs and deletes the objects.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  StorageService,
  createStorageDriver,
} from '../storage/storage.service.js';
import { IMMUTABLE_CACHE_CONTROL } from '../storage/storage.types.js';
import type { MetricsService } from '../metrics/metrics.service.js';
import { processImage } from '../media/image-processor.js';
import { keyPrefixFor, variantKeys } from '../media/auction-images.service.js';
import type { StoredVariants } from '../media/media.mapper.js';

type JournalEntry = {
  id: string;
  auctionId: string;
  oldUrl: string;
  oldStorage: 'EXTERNAL' | 'BUNDLED';
  newPrefix: string;
  storage: 'R2' | 'LOCAL';
};

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const values = (name: string) =>
  args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
const APPLY = flag('--apply');
const INCLUDE_BUNDLED = flag('--include-bundled');
const ALLOWED_HOSTS = new Set(
  values('--allow-host').map((h) => h.toLowerCase()),
);
const LIMIT = Number(values('--limit')[0] ?? Infinity);
const ROLLBACK = values('--rollback')[0];
const ASSETS_DIR = path.resolve(
  values('--assets-dir')[0] ??
    path.join(process.cwd(), '../frontend/src/assets'),
);

// Script output is the plan/progress lines below; keep framework debug logs out of it.
Logger.overrideLogger(['warn', 'error']);

const config = new AppConfig(process.env);
const prisma = new PrismaService(config);
const metrics = {
  storageOps: { inc: () => undefined },
} as unknown as MetricsService;
const storage = new StorageService(createStorageDriver(config), metrics);

const log = (...m: unknown[]) => console.log(...m);

async function readBundled(url: string): Promise<Buffer> {
  const name = /^asset:\/\/([a-z0-9-]+)$/.exec(url)?.[1];
  if (!name) throw new Error('not an asset:// reference');
  for (const ext of ['jpg', 'jpeg', 'png', 'webp'])
    if (existsSync(path.join(ASSETS_DIR, `${name}.${ext}`)))
      return readFileSync(path.join(ASSETS_DIR, `${name}.${ext}`));
  throw new Error(`asset "${name}" not found in ${ASSETS_DIR}`);
}

async function fetchExternal(url: string): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('only https URLs are fetched');
  const res = await fetch(u, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'manual',
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > config.mediaMaxUploadBytes)
    throw new Error('larger than the upload limit');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > config.mediaMaxUploadBytes)
    throw new Error('larger than the upload limit');
  return body;
}

async function migrate() {
  const rows = await prisma.listingMedia.findMany({
    orderBy: [{ auctionId: 'asc' }, { position: 'asc' }],
    select: { id: true, auctionId: true, url: true, storage: true, type: true },
  });
  const byStorage = rows.reduce<Record<string, number>>(
    (m, r) => ({ ...m, [r.storage]: (m[r.storage] ?? 0) + 1 }),
    {},
  );
  log('Inventory:', byStorage);
  const hosts = new Map<string, number>();
  for (const r of rows.filter((r) => r.storage === 'EXTERNAL')) {
    const h = new URL(r.url).host;
    hosts.set(h, (hosts.get(h) ?? 0) + 1);
  }
  if (hosts.size) log('External hosts:', Object.fromEntries(hosts));
  const assets = new Set(
    rows.filter((r) => r.storage === 'BUNDLED').map((r) => r.url),
  );
  if (assets.size) log('Bundled assets:', [...assets].join(', '));

  const plan = rows.filter((r) => {
    if (r.type !== 'IMAGE') return false;
    if (r.storage === 'BUNDLED') return INCLUDE_BUNDLED;
    if (r.storage === 'EXTERNAL')
      return ALLOWED_HOSTS.has(new URL(r.url).host.toLowerCase());
    return false; // already stored
  });
  const skipped = rows.length - plan.length;
  log(
    `Plan: migrate ${Math.min(plan.length, LIMIT)} image(s); ${skipped} left as they are` +
      (INCLUDE_BUNDLED || ALLOWED_HOSTS.size
        ? ''
        : ' (pass --include-bundled and/or --allow-host <host> to select images you own or may re-host)'),
  );
  if (!APPLY) {
    for (const r of plan.slice(0, LIMIT))
      log(`  would migrate ${r.id}  ${r.url}`);
    log('Dry run — nothing was changed. Re-run with --apply to migrate.');
    return;
  }
  if (!storage.enabled)
    throw new Error('Image storage is not configured (MEDIA_STORAGE).');
  const provider = storage.provider;
  if (provider === 'LOCAL')
    log(
      'Note: MEDIA_STORAGE=local — images go to development disk storage, not R2.',
    );

  const dir = path.join(process.cwd(), 'storage/media-migrations');
  mkdirSync(dir, { recursive: true });
  const journalPath = path.join(
    dir,
    `media-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const journal: JournalEntry[] = [];
  const save = () =>
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  let ok = 0;
  let failed = 0;

  for (const r of plan.slice(0, LIMIT)) {
    const oldStorage = r.storage as 'EXTERNAL' | 'BUNDLED';
    const prefix = keyPrefixFor(r.auctionId, r.id, config.mediaKeyPrefix);
    try {
      const input =
        oldStorage === 'BUNDLED'
          ? await readBundled(r.url)
          : await fetchExternal(r.url);
      const p = await processImage(input, {
        maxBytes: config.mediaMaxUploadBytes,
        maxPixels: config.mediaMaxPixels,
      });
      const dup = await prisma.listingMedia.findFirst({
        where: {
          auctionId: r.auctionId,
          contentHash: p.contentHash,
          id: { not: r.id },
        },
        select: { id: true },
      });
      if (dup) {
        log(`  skip ${r.id}: same photo already stored as ${dup.id}`);
        continue;
      }
      const now = await prisma.dbNow();
      await prisma.mediaCleanupTask.upsert({
        where: { keyPrefix: prefix },
        create: {
          keyPrefix: prefix,
          storage: provider,
          reason: 'upload_pending',
          runAfter: new Date(now.getTime() + 15 * 60_000),
        },
        update: {
          reason: 'upload_pending',
          attempts: 0,
          runAfter: new Date(now.getTime() + 15 * 60_000),
        },
      });
      const variants = {} as StoredVariants;
      const results = await Promise.allSettled(
        p.variants.map(async (v) => {
          const key = `${prefix}${v.name}.webp`;
          await storage.put(key, v.data, {
            contentType: 'image/webp',
            cacheControl: IMMUTABLE_CACHE_CONTROL,
            metadata: {
              'auction-id': r.auctionId,
              'image-id': r.id,
              variant: v.name,
              source: 'migration',
            },
          });
          variants[v.name] = {
            key,
            url: storage.publicUrl(key),
            width: v.width,
            height: v.height,
            bytes: v.bytes,
          };
        }),
      );
      const rejected = results.find(
        (x): x is PromiseRejectedResult => x.status === 'rejected',
      );
      if (rejected) {
        await storage.deleteMany(variantKeys(prefix)).then(
          () =>
            prisma.mediaCleanupTask.deleteMany({
              where: { keyPrefix: prefix },
            }),
          () => undefined, // task stays; the API's cleanup worker retries
        );
        throw rejected.reason;
      }
      // Only now point the row at the new objects — and only if nobody changed it meanwhile.
      await prisma.$transaction(async (tx) => {
        const updated = await tx.listingMedia.updateMany({
          where: { id: r.id, url: r.url, storage: oldStorage },
          data: {
            url: variants.full.url,
            storage: provider,
            storageKeyPrefix: prefix,
            variants: variants as unknown as Prisma.InputJsonValue,
            width: variants.full.width,
            height: variants.full.height,
            mimeType: 'image/webp',
            bytes: p.variants.reduce((n, v) => n + v.bytes, 0),
            originalMimeType: p.inputMime,
            originalBytes: p.inputBytes,
            contentHash: p.contentHash,
          },
        });
        if (updated.count !== 1)
          throw new Error('row changed during migration; left untouched');
        await tx.mediaCleanupTask.deleteMany({
          where: { keyPrefix: prefix, attempts: 0 },
        });
      });
      journal.push({
        id: r.id,
        auctionId: r.auctionId,
        oldUrl: r.url,
        oldStorage,
        newPrefix: prefix,
        storage: provider,
      });
      save();
      ok++;
      log(`  migrated ${r.id}  ${r.url} → ${variants.full.url}`);
    } catch (err) {
      failed++;
      // A failed row keeps its original URL; schedule removal of anything uploaded.
      await prisma.mediaCleanupTask
        .updateMany({
          where: { keyPrefix: prefix },
          data: { runAfter: new Date() },
        })
        .catch(() => undefined);
      log(`  FAILED ${r.id}  ${r.url}: ${(err as Error).message}`);
    }
  }
  log(
    `Done: ${ok} migrated, ${failed} failed.${journal.length ? ` Rollback journal: ${journalPath}` : ''}`,
  );
}

async function rollback(file: string) {
  const entries = JSON.parse(readFileSync(file, 'utf8')) as JournalEntry[];
  log(`Rollback of ${entries.length} image(s) from ${file}`);
  if (!APPLY) {
    for (const e of entries) log(`  would restore ${e.id} → ${e.oldUrl}`);
    log('Dry run — nothing was changed. Re-run with --apply to roll back.');
    return;
  }
  for (const e of entries) {
    const now = await prisma.dbNow();
    const restored = await prisma.$transaction(async (tx) => {
      const r = await tx.listingMedia.updateMany({
        where: { id: e.id, storageKeyPrefix: e.newPrefix },
        data: {
          url: e.oldUrl,
          storage: e.oldStorage,
          storageKeyPrefix: null,
          variants: Prisma.DbNull,
          width: null,
          height: null,
          mimeType: null,
          bytes: null,
          originalMimeType: null,
          originalBytes: null,
          contentHash: null,
        },
      });
      if (r.count === 1)
        await tx.mediaCleanupTask.upsert({
          where: { keyPrefix: e.newPrefix },
          create: {
            keyPrefix: e.newPrefix,
            storage: e.storage,
            reason: 'image_deleted',
            runAfter: now,
          },
          update: { reason: 'image_deleted', runAfter: now },
        });
      return r.count === 1;
    });
    if (!restored) {
      log(`  skip ${e.id}: changed since the migration`);
      continue;
    }
    if (storage.enabled && storage.provider === e.storage)
      await storage.deleteMany(variantKeys(e.newPrefix)).then(
        () =>
          prisma.mediaCleanupTask.deleteMany({
            where: { keyPrefix: e.newPrefix },
          }),
        () => log(`  objects of ${e.id} will be removed by the cleanup worker`),
      );
    log(`  restored ${e.id} → ${e.oldUrl}`);
  }
}

(ROLLBACK ? rollback(ROLLBACK) : migrate())
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().then(() => prisma.pool.end()));
