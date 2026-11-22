/**
 * Seeds the AUCTRA demonstration catalogue (src/database/catalog/catalog.ts).
 *
 *   npm run db:seed:catalog                      # dry run: what would be created / skipped
 *   npm run db:seed:catalog -- --apply           # create the missing lots
 *   npm run db:seed:catalog -- --apply --only car-ferrari-458-italia,watch-rolex-datejust-16013
 *   npm run db:seed:catalog -- --apply --limit 10
 *
 * Guarantees:
 *  - Idempotent: every lot has a stable `seedKey`; lots that already exist are skipped, never
 *    updated or deleted. Re-running only adds what is missing.
 *  - Touches nothing else: existing users, auctions, bids, orders and images are untouched.
 *    Demo sellers and buyers are separate fictional accounts on *.demo.auctra.local with
 *    random passwords (nobody can sign in as them); no real account bids or sells.
 *  - Real code paths: bids are placed through BidsService (the live bid engine) and
 *    completed lots are closed by the lifecycle worker, so prices, histories, results and
 *    orders are consistent. Orders stay in PENDING_PAYMENT; no transactions are simulated.
 *  - Images: freely licensed Wikimedia Commons photos (CC0 / public domain / CC BY / CC BY-SA)
 *    are downloaded once (cached under storage/catalog-cache), processed by the same Sharp
 *    pipeline as uploads and stored in object storage under `demo-catalog/…`, with author,
 *    license and source saved on each image for attribution.
 *  - Refused when NODE_ENV=production.
 */
import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Background work must not run inside the seeding process; the API relays outbox events.
// Seeded activity must never email anyone.
Object.assign(process.env, {
  LIFECYCLE_WORKER_ENABLED: 'false',
  OUTBOX_RELAY_ENABLED: 'false',
  EMAIL_PROVIDER: 'log',
  RESEND_API_KEY: '',
});

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('@nestjs/common');
const argon2 = await import('argon2');
const { AppModule } = await import('../app.module.js');
const { AppConfig } = await import('../config/app-config.js');
const { PrismaService } = await import('../prisma/prisma.service.js');
const { StorageService } = await import('../storage/storage.service.js');
const { BidsService } = await import('../bids/bids.service.js');
const { LifecycleWorker } = await import('../jobs/lifecycle.worker.js');
const { processImage } = await import('../media/image-processor.js');
const { keyPrefixFor } = await import('../media/auction-images.service.js');
const { IMMUTABLE_CACHE_CONTROL } = await import('../storage/storage.types.js');
const { DEFAULT_ROLES, RoleKey } = await import('../roles/permissions.js');
const {
  FULL_CATALOG: CATALOG,
  DEMO_BUYERS,
  SELLERS,
} = await import('./catalog/index.js');
const { licenseAllowed, plainAuthor, politeFetch, scaledUrl } =
  await import('./catalog/commons.js');
type CatalogLot = import('./catalog/catalog.js').CatalogLot;
type AuthContext = import('../common/auth-context.js').AuthContext;

const NAMESPACE = 'demo-catalog';
const CACHE_DIR = path.resolve('storage/catalog-cache');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY = arg('--only')?.split(',');
const LIMIT = Number(arg('--limit') ?? Infinity);
const DEMO_FOOTER =
  '\n\nDemo listing: part of the AUCTRA demonstration catalogue, not a real item for sale. ' +
  'The photo is a freely licensed image from Wikimedia Commons (credited on the photo).';

const ILLUSTRATIVE_FOOTER =
  '\n\nDemo listing: part of the AUCTRA demonstration catalogue, not a real property for sale. ' +
  'The photo is an illustrative, freely licensed image from Wikimedia Commons and does not show the property described.';
const FAILURES_FILE = path.resolve('storage/catalog-failures.json');

/** Modification details (and ShareAlike / illustrative notes) stored with each credit. */
function noticeFor(lot: { category: string }, license: string): string {
  const parts = [
    'Resized to 320/800/1600 px and converted to WebP by AUCTRA; embedded metadata removed.',
  ];
  if (/BY-SA/i.test(license))
    parts.push('These adapted images are shared under the same license.');
  if (lot.category === 'real-estate')
    parts.push('Illustrative photo: it does not show the property described.');
  return parts.join(' ');
}

const log = (...m: unknown[]) => console.log(...m);

async function main() {
  if (process.env['NODE_ENV'] === 'production')
    throw new Error('Refusing to seed the demo catalogue in production.');
  Logger.overrideLogger(['warn', 'error']);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  const config = app.get(AppConfig);
  const prisma = app.get(PrismaService);
  const storage = app.get(StorageService);
  const bids = app.get(BidsService);
  const lifecycle = app.get(LifecycleWorker);
  const db = new URL(process.env['DATABASE_URL']!);
  log(
    `Database ${db.hostname}${db.pathname} · storage ${storage.enabled ? storage.provider : 'disabled'} · ${APPLY ? 'APPLY' : 'dry run'}`,
  );
  if (APPLY && !storage.enabled)
    throw new Error(
      'Image storage is not configured (set R2_* or MEDIA_STORAGE=local).',
    );

  try {
    const failures: { key: string; file: string; error: string }[] = [];
    const lots = CATALOG.filter((l) => !ONLY || ONLY.includes(l.key));
    const existing = new Set(
      (
        await prisma.auction.findMany({
          where: { seedKey: { in: lots.map((l) => l.key) } },
          select: { seedKey: true },
        })
      ).map((a) => a.seedKey!),
    );
    const todo = lots.filter((l) => !existing.has(l.key)).slice(0, LIMIT);
    log(
      `${lots.length} catalogue lots · ${existing.size} already present (skipped) · ${todo.length} to create`,
    );
    // Attribution backfill for lots seeded before notices existed (metadata only).
    if (APPLY) {
      const missing = await prisma.listingMedia.findMany({
        where: {
          creditLicense: { not: null },
          creditNotice: null,
          auction: { seedKey: { not: null } },
        },
        select: {
          id: true,
          creditLicense: true,
          auction: { select: { category: { select: { slug: true } } } },
        },
      });
      for (const m of missing)
        await prisma.listingMedia.update({
          where: { id: m.id },
          data: {
            creditNotice: noticeFor(
              { category: m.auction.category.slug },
              m.creditLicense!,
            ),
          },
        });
      if (missing.length)
        log(
          `Added attribution notices to ${missing.length} existing demo photos.`,
        );
    }
    const images = await resolveImages(todo, failures);
    if (!APPLY) {
      for (const l of todo)
        log(
          `  would create ${l.key.padEnd(44)} ${l.plan.padEnd(8)} ${images.get(l.file)?.license ?? 'IMAGE UNAVAILABLE — will be skipped'}`,
        );
      writeFailures(failures);
      log('Dry run only. Re-run with --apply to create these lots.');
      return;
    }

    const sellers = await ensureSellers(prisma);
    const buyers = await ensureBuyers(prisma);
    const report = {
      created: 0,
      images: 0,
      bids: 0,
      sold: 0,
      unsold: 0,
      failed: 0,
    };
    for (const lot of todo) {
      if (!images.has(lot.file)) {
        report.failed++;
        continue; // recorded by resolveImages; the lot is retried on the next run
      }
      try {
        const r = await createLot(lot, {
          prisma,
          storage,
          bids,
          lifecycle,
          config,
          sellerId: sellers[lot.seller],
          buyers,
          image: images.get(lot.file)!,
        });
        report.created++;
        report.images++;
        report.bids += r.bids;
        if (r.status === 'SOLD') report.sold++;
        if (r.status === 'UNSOLD') report.unsold++;
        log(
          `  created ${lot.key.padEnd(44)} ${r.status.padEnd(9)} bids ${r.bids}`,
        );
      } catch (err) {
        report.failed++;
        failures.push({
          key: lot.key,
          file: lot.file,
          error: (err as Error).message.slice(0, 300),
        });
        log(`  FAILED  ${lot.key}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    writeFailures(failures);
    log(JSON.stringify(report));
  } finally {
    await app.close();
  }
}

type ImageMeta = {
  url: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
};

/** Looks up download URL and attribution for every file; refuses non-free licenses. */
async function resolveImages(
  lots: CatalogLot[],
  failures: { key: string; file: string; error: string }[],
): Promise<Map<string, ImageMeta>> {
  const out = new Map<string, ImageMeta>();
  const files = [...new Set(lots.map((l) => l.file))];
  for (let i = 0; i < files.length; i += 40) {
    const u = new URL('https://commons.wikimedia.org/w/api.php');
    u.search = new URLSearchParams({
      action: 'query',
      format: 'json',
      titles: files.slice(i, i + 40).join('|'),
      prop: 'imageinfo',
      iiprop: 'url|size|extmetadata',
      iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist',
      iiurlwidth: '1600',
    }).toString();
    const body = (await (await politeFetch(u)).json()) as {
      query: {
        normalized?: { from: string; to: string }[];
        pages: Record<
          string,
          {
            title: string;
            missing?: string;
            imageinfo?: {
              width: number;
              thumburl?: string;
              descriptionurl: string;
              extmetadata?: Record<string, { value: string }>;
            }[];
          }
        >;
      };
    };
    const alias = new Map(
      (body.query.normalized ?? []).map((n) => [n.to, n.from] as const),
    );
    for (const p of Object.values(body.query.pages)) {
      const ii = p.imageinfo?.[0];
      const meta = ii?.extmetadata ?? {};
      const license = meta['LicenseShortName']?.value ?? '';
      const file = alias.get(p.title) ?? p.title;
      const problem =
        p.missing !== undefined || !ii?.thumburl
          ? 'Commons file not found'
          : !licenseAllowed(license)
            ? `Not freely licensed (${license})`
            : null;
      if (problem || !ii?.thumburl) {
        for (const l of lots.filter((x) => x.file === file))
          failures.push({ key: l.key, file, error: problem ?? 'no rendition' });
        continue;
      }
      out.set(file, {
        url: scaledUrl(ii.thumburl, ii.width),
        author: plainAuthor(meta['Artist']?.value),
        license,
        licenseUrl: meta['LicenseUrl']?.value ?? null,
        sourceUrl: ii.descriptionurl,
      });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const l of lots)
    if (!out.has(l.file) && !failures.some((f) => f.key === l.key))
      failures.push({
        key: l.key,
        file: l.file,
        error: 'Commons file not resolved',
      });
  return out;
}

/** Failed images are kept for review; a later run retries those lots automatically. */
function writeFailures(
  failures: { key: string; file: string; error: string }[],
) {
  mkdirSync(path.dirname(FAILURES_FILE), { recursive: true });
  writeFileSync(FAILURES_FILE, JSON.stringify(failures, null, 2));
  log(
    failures.length
      ? `${failures.length} lot(s) skipped — details in ${path.relative(process.cwd(), FAILURES_FILE)}`
      : 'No image failures.',
  );
}

async function download(url: string): Promise<Buffer> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(
    CACHE_DIR,
    createHash('sha1').update(url).digest('hex'),
  );
  if (existsSync(file)) return readFileSync(file);
  const res = await politeFetch(url);
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  // Be gentle with upload.wikimedia.org; CATALOG_DOWNLOAD_DELAY_MS slows retries further.
  await new Promise((r) =>
    setTimeout(r, Number(process.env.CATALOG_DOWNLOAD_DELAY_MS) || 400),
  );
  return buf;
}

type Prisma = InstanceType<typeof PrismaService>;

/** Unusable password: a hash of 32 random bytes nobody knows. */
const lockedPassword = () =>
  argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id });

async function ensureAccount(
  prisma: Prisma,
  email: string,
  displayName: string,
  handle: string,
  roles: string[],
) {
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user)
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: await lockedPassword(),
        emailVerifiedAt: new Date(),
        profile: { create: { displayName, handle } },
        preferences: { create: {} },
        identityVerification: { create: {} },
      },
    });
  for (const key of roles) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      create: { userId: user.id, roleId: role.id },
      update: {},
    });
  }
  return user;
}

async function ensureSellers(prisma: Prisma) {
  const ids = {} as Record<keyof typeof SELLERS, string>;
  for (const [key, s] of Object.entries(SELLERS) as [
    keyof typeof SELLERS,
    (typeof SELLERS)[keyof typeof SELLERS],
  ][]) {
    const u = await ensureAccount(prisma, s.email, s.displayName, s.handle, [
      RoleKey.USER,
      RoleKey.SELLER,
    ]);
    await prisma.sellerProfile.upsert({
      where: { userId: u.id },
      create: {
        userId: u.id,
        type: s.type,
        businessName: s.business ?? null,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
      update: {},
    });
    ids[key] = u.id;
  }
  return ids;
}

async function ensureBuyers(prisma: Prisma): Promise<AuthContext[]> {
  const out: AuthContext[] = [];
  const perms = new Set<string>(DEFAULT_ROLES.USER.permissions);
  for (const [email, name, handle] of DEMO_BUYERS) {
    const u = await ensureAccount(prisma, email, name, handle, [RoleKey.USER]);
    out.push({
      userId: u.id,
      sessionId: randomUUID(),
      email,
      emailVerified: true,
      status: 'ACTIVE',
      suspendedUntil: null,
      roles: ['USER'],
      permissions: perms,
    });
  }
  return out;
}

const cents = (usd: number) => BigInt(Math.round(usd * 100));
const hash = (s: string) => {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

async function createLot(
  lot: CatalogLot,
  ctx: {
    prisma: Prisma;
    storage: InstanceType<typeof StorageService>;
    bids: InstanceType<typeof BidsService>;
    lifecycle: InstanceType<typeof LifecycleWorker>;
    config: InstanceType<typeof AppConfig>;
    sellerId: string;
    buyers: AuthContext[];
    image: ImageMeta;
  },
): Promise<{ status: string; bids: number }> {
  const { prisma, storage } = ctx;
  const cat = await prisma.category.findUniqueOrThrow({
    where: { slug: lot.category },
    include: { attributes: true },
  });
  const sub = lot.subcategory
    ? await prisma.category.findUniqueOrThrow({
        where: { slug: lot.subcategory },
        include: { attributes: true },
      })
    : null;
  if (sub && sub.parentId !== cat.id)
    throw new Error(
      `${lot.subcategory} is not a subcategory of ${lot.category}`,
    );
  const defs = [...cat.attributes, ...(sub?.attributes ?? [])];
  for (const key of Object.keys(lot.attributes))
    if (!defs.some((d) => d.key === key))
      throw new Error(`Unknown attribute ${key} for ${lot.category}`);

  // 1. Image: download (cached), Sharp variants, upload to storage under demo-catalog/.
  const original = await download(ctx.image.url);
  const processed = await processImage(original, {
    maxBytes: Math.max(ctx.config.mediaMaxUploadBytes, 25 * 1024 * 1024),
    maxPixels: ctx.config.mediaMaxPixels,
  });
  const auctionId = randomUUID();
  const imageId = randomUUID();
  const prefix = keyPrefixFor(auctionId, imageId, NAMESPACE);
  const variants: Record<
    string,
    { key: string; url: string; width: number; height: number; bytes: number }
  > = {};
  const uploaded: string[] = [];
  try {
    for (const v of processed.variants) {
      const key = `${prefix}${v.name}.webp`;
      await storage.put(key, v.data, {
        contentType: 'image/webp',
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        metadata: {
          'auction-id': auctionId,
          'image-id': imageId,
          variant: v.name,
          purpose: 'demo-catalog',
        },
      });
      uploaded.push(key);
      variants[v.name] = {
        key,
        url: storage.publicUrl(key),
        width: v.width,
        height: v.height,
        bytes: v.bytes,
      };
    }

    // 2. Lot row (+ image, attributes, specs) in one transaction.
    const now = await prisma.dbNow();
    const t = now.getTime();
    const h = hash(lot.key);
    let startsAt: Date;
    let endsAt: Date;
    if (lot.plan === 'upcoming') {
      startsAt = new Date(t + lot.hours * 3_600_000);
      endsAt = new Date(startsAt.getTime() + (lot.days ?? 5) * 86_400_000);
    } else if (lot.plan === 'live') {
      startsAt = new Date(t - (6 + (h % 72)) * 3_600_000);
      endsAt = new Date(t + lot.hours * 3_600_000 + (h % 50) * 60_000);
    } else {
      // Completed lots are bid on now and then closed by the lifecycle worker.
      startsAt = new Date(t - (48 + (h % 72)) * 3_600_000);
      endsAt = new Date(t + 30 * 60_000);
    }
    const full = variants['full']!;
    await prisma.auction.create({
      data: {
        id: auctionId,
        seedKey: lot.key,
        sellerId: ctx.sellerId,
        categoryId: cat.id,
        subcategoryId: sub?.id ?? null,
        title: lot.title,
        description:
          lot.description +
          (lot.category === 'real-estate' ? ILLUSTRATIVE_FOOTER : DEMO_FOOTER),
        condition: lot.condition,
        locationCity: lot.city,
        locationCountry: lot.country,
        currency: 'USD',
        startingPriceCents: cents(lot.start),
        minIncrementCents: cents(lot.increment),
        reservePriceCents: lot.reserve ? cents(lot.reserve) : null,
        buyNowPriceCents: lot.buyNow ? cents(lot.buyNow) : null,
        startsAt,
        endsAt,
        originalEndsAt: endsAt,
        status: lot.plan === 'upcoming' ? 'SCHEDULED' : 'LIVE',
        submittedAt: new Date(t - 7 * 86_400_000),
        approvedAt: new Date(t - 6 * 86_400_000),
        ...(lot.antiSniping
          ? {
              antiSnipingEnabled: true,
              antiSnipingWindowSec: 120,
              antiSnipingExtensionSec: 120,
            }
          : {}),
        media: {
          create: [
            {
              id: imageId,
              type: 'IMAGE',
              url: full.url,
              altText: lot.title,
              width: full.width,
              height: full.height,
              position: 0,
              isPrimary: true,
              storage: storage.provider,
              storageKeyPrefix: prefix,
              variants,
              mimeType: 'image/webp',
              bytes: processed.variants.reduce((n, v) => n + v.bytes, 0),
              originalMimeType: processed.inputMime,
              originalBytes: processed.inputBytes,
              contentHash: processed.contentHash,
              uploadedById: ctx.sellerId,
              creditAuthor: ctx.image.author,
              creditLicense: ctx.image.license,
              creditLicenseUrl: ctx.image.licenseUrl,
              creditSourceUrl: ctx.image.sourceUrl,
              creditNotice: noticeFor(lot, ctx.image.license),
            },
          ],
        },
        attributeValues: {
          create: Object.entries(lot.attributes).map(([key, value]) => ({
            attributeId: defs.find((d) => d.key === key)!.id,
            ...(typeof value === 'number'
              ? { valueNumber: value }
              : typeof value === 'boolean'
                ? { valueBoolean: value }
                : { valueText: value }),
          })),
        },
        ...(lot.vehicle ? { vehicle: { create: lot.vehicle } } : {}),
        ...(lot.watch ? { watch: { create: lot.watch } } : {}),
        events: {
          create: [
            {
              type: 'CREATED',
              toStatus: 'DRAFT',
              version: 1,
              metadata: { seed: 'demo-catalog' },
            },
          ],
        },
      },
    });
  } catch (err) {
    await storage.deleteMany(uploaded).catch(() => undefined);
    throw err;
  }

  // 3. Bids through the real engine (never from real accounts).
  let placed = 0;
  if (lot.plan !== 'upcoming' && (lot.bids ?? 0) > 0) {
    const reserve = lot.reserve ? cents(lot.reserve) : null;
    let last = -1;
    for (let i = 0; i < (lot.bids ?? 0) + (lot.plan === 'sold' ? 6 : 0); i++) {
      const a = await prisma.auction.findUniqueOrThrow({
        where: { id: auctionId },
        select: {
          currentPriceCents: true,
          startingPriceCents: true,
          minIncrementCents: true,
        },
      });
      const next =
        a.currentPriceCents === null
          ? a.startingPriceCents
          : a.currentPriceCents +
            a.minIncrementCents *
              BigInt(1 + ((hash(lot.key) + i) % 3 === 0 ? 1 : 0));
      const metReserve = !reserve || (a.currentPriceCents ?? 0n) >= reserve;
      if (i >= (lot.bids ?? 0) && (lot.plan !== 'sold' || metReserve)) break; // extra bids only to meet a sold lot's reserve
      if (lot.plan === 'unsold' && reserve && next >= reserve) break; // unsold: stay below reserve
      let b = (hash(lot.key) + i * 7) % ctx.buyers.length;
      if (b === last) b = (b + 1) % ctx.buyers.length;
      last = b;
      try {
        await ctx.bids.placeBid(ctx.buyers[b]!, {
          auctionId,
          amount: next,
          idempotencyKey: randomUUID(),
        });
        placed++;
      } catch (err) {
        log(
          `    bid not placed on ${lot.key}: ${(err as Error).message.slice(0, 120)}`,
        );
        break;
      }
    }
  }

  // 4. Completed lots: end now and let the lifecycle worker close and settle them.
  if (lot.plan === 'sold' || lot.plan === 'unsold') {
    await prisma.auction.update({
      where: { id: auctionId },
      data: {
        endsAt: new Date(Date.now() - 1000),
        originalEndsAt: new Date(Date.now() - 1000),
      },
    });
    for (let i = 0; i < 5; i++) {
      await ctx.lifecycle.tick();
      const s = await prisma.auction.findUniqueOrThrow({
        where: { id: auctionId },
        select: { status: true },
      });
      if (s.status === 'SOLD' || s.status === 'UNSOLD') break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const final = await prisma.auction.findUniqueOrThrow({
    where: { id: auctionId },
    select: { status: true },
  });
  const expected =
    lot.plan === 'sold' ? 'SOLD' : lot.plan === 'unsold' ? 'UNSOLD' : null;
  if (expected && final.status !== expected)
    throw new Error(
      `expected ${expected}, got ${final.status} (lot kept; check it manually)`,
    );
  return { status: final.status, bids: placed };
}

main().catch((err: unknown) => {
  console.error(`seed-catalog failed: ${(err as Error).message}`);
  process.exit(1);
});
