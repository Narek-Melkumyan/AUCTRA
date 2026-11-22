/**
 * Database seed.
 *
 *   npm run db:seed                       reference data only (roles, permissions, categories, config)
 *   SEED_DEMO=true npm run db:seed        + local demo accounts and auctions (refused in production)
 *
 * Demo accounts use the password in SEED_DEMO_PASSWORD (set it in backend/.env, which
 * is git-ignored). Nothing here is a real person, business or bid.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  type ItemCondition,
} from '../generated/prisma/client.js';
import { seedReferenceData } from './reference-data.js';
import {
  DEMO_ACCOUNTS,
  DEMO_SELLER_EMAIL,
  demoPasswordFromEnv,
  hashDemoPassword,
  rotateDemoPasswords,
} from './demo-accounts.js';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: url.replace(/[?&]schema=[^&]*/, ''),
    options: '-c timezone=UTC',
  }),
});

type DemoAuction = {
  title: string;
  category: string;
  subcategory: string;
  image: string;
  condition: ItemCondition;
  city: string;
  country: string;
  startMinor: bigint;
  incrementMinor: bigint;
  reserveMinor?: bigint;
  buyNowMinor?: bigint;
  /** Minutes from now; negative = already started. */
  startOffsetMin: number;
  durationMin: number;
  description: string;
  attributes: Record<string, string | number | boolean>;
  vehicle?: {
    make: string;
    model: string;
    year: number;
    mileageKm: number;
    transmission: string;
  };
  watch?: {
    brand: string;
    model: string;
    year: number;
    caseMaterial: string;
    caseDiameterMm: number;
    movement: string;
    hasBox: boolean;
    hasPapers: boolean;
  };
  antiSniping?: boolean;
};

const DEMO_AUCTIONS: DemoAuction[] = [
  {
    title: '2021 Grand Tourer V12 Coupé',
    category: 'cars',
    subcategory: 'cars-supercars',
    image: 'asset://car',
    condition: 'EXCELLENT',
    city: 'Monaco',
    country: 'MC',
    startMinor: 12_000_000n,
    incrementMinor: 250_000n,
    reserveMinor: 18_500_000n,
    buyNowMinor: 24_500_000n,
    startOffsetMin: -60,
    durationMin: 60 * 26,
    description:
      'Demo listing. A single-owner grand tourer in metallic silver with dealer service history and both keys.',
    attributes: {
      title_status: 'Clean',
      service_history: true,
      engine: '5.2L twin-turbo V12',
    },
    vehicle: {
      make: 'Demo Motors',
      model: 'GT V12',
      year: 2021,
      mileageKm: 8420,
      transmission: '8-speed automatic',
    },
    antiSniping: true,
  },
  {
    title: 'Steel Diver Chronometer, Green Bezel',
    category: 'watches',
    subcategory: 'watches-sport',
    image: 'asset://watch',
    condition: 'VERY_GOOD',
    city: 'Geneva',
    country: 'CH',
    startMinor: 900_000n,
    incrementMinor: 25_000n,
    buyNowMinor: 2_100_000n,
    startOffsetMin: -30,
    durationMin: 90,
    description:
      'Demo listing. A green-bezel steel diver with original box and papers; minimal bracelet stretch.',
    attributes: { water_resistance_m: 300 },
    watch: {
      brand: 'Demo Horlogerie',
      model: 'Diver 40',
      year: 2019,
      caseMaterial: 'Stainless steel',
      caseDiameterMm: 40,
      movement: 'Automatic',
      hasBox: true,
      hasPapers: true,
    },
    antiSniping: true,
  },
  {
    title: 'Clifftop Villa with Infinity Pool',
    category: 'real-estate',
    subcategory: 'real-estate-residential',
    image: 'asset://house',
    condition: 'EXCELLENT',
    city: 'Amalfi',
    country: 'IT',
    startMinor: 240_000_000n,
    incrementMinor: 2_500_000n,
    reserveMinor: 340_000_000n,
    startOffsetMin: -120,
    durationMin: 60 * 72,
    description:
      'Demo listing. A five-bedroom clifftop villa with terraced gardens and an infinity pool overlooking the sea.',
    attributes: {
      property_type: 'Villa',
      bedrooms: 5,
      floor_area_m2: 420,
      tenure: 'Freehold',
    },
  },
  {
    title: 'Pear-Cut Diamond Rivière Necklace',
    category: 'jewelry',
    subcategory: 'jewelry-necklaces',
    image: 'asset://jewelry',
    condition: 'EXCELLENT',
    city: 'London',
    country: 'GB',
    startMinor: 4_200_000n,
    incrementMinor: 75_000n,
    buyNowMinor: 8_900_000n,
    startOffsetMin: -45,
    durationMin: 60 * 8,
    description:
      'Demo listing. A graduated rivière of pear-cut diamonds set in platinum, with a grading report.',
    attributes: {
      metal: 'Platinum',
      total_carat: 18.4,
      certificate: 'Independent lab report',
    },
  },
  {
    title: 'Abstract Composition No. 12',
    category: 'art',
    subcategory: 'art-paintings',
    image: 'asset://art',
    condition: 'VERY_GOOD',
    city: 'New York',
    country: 'US',
    startMinor: 1_800_000n,
    incrementMinor: 40_000n,
    startOffsetMin: -15,
    durationMin: 60 * 12,
    description:
      'Demo listing. Oil on canvas, signed verso, from a private collection; framed.',
    attributes: {
      artist: 'Demo Artist',
      medium: 'Oil on canvas',
      year_created: 1998,
      dimensions: '120 × 90 cm',
    },
  },
  {
    title: 'Louis XV Carved Walnut Cabinet',
    category: 'collectibles',
    subcategory: 'collectibles-antiques',
    image: 'asset://antique',
    condition: 'GOOD',
    city: 'Lyon',
    country: 'FR',
    startMinor: 320_000n,
    incrementMinor: 10_000n,
    reserveMinor: 400_000n,
    startOffsetMin: -10,
    durationMin: 60 * 30,
    description:
      'Demo listing. A carved walnut cabinet in the Louis XV manner with original hardware.',
    attributes: {
      era: '19th century',
      provenance: 'Private French collection',
    },
  },
  {
    title: 'Vintage Gold Dress Watch',
    category: 'watches',
    subcategory: 'watches-vintage',
    image: 'asset://watch',
    condition: 'GOOD',
    city: 'Milan',
    country: 'IT',
    startMinor: 320_000n,
    incrementMinor: 10_000n,
    startOffsetMin: 60,
    durationMin: 60 * 24,
    description:
      'Demo listing. An 18k yellow gold manual-wind dress watch with a restored dial.',
    attributes: {},
    watch: {
      brand: 'Demo Orologi',
      model: 'Classico',
      year: 1962,
      caseMaterial: '18k yellow gold',
      caseDiameterMm: 34,
      movement: 'Manual wind',
      hasBox: false,
      hasPapers: false,
    },
  },
  {
    title: 'Coastal Penthouse',
    category: 'real-estate',
    subcategory: 'real-estate-residential',
    image: 'asset://house',
    condition: 'VERY_GOOD',
    city: 'Marbella',
    country: 'ES',
    startMinor: 110_000_000n,
    incrementMinor: 1_000_000n,
    reserveMinor: 135_000_000n,
    startOffsetMin: 120,
    durationMin: 60 * 48,
    description:
      'Demo listing. A three-bedroom penthouse with wraparound terrace and sea views.',
    attributes: {
      property_type: 'Penthouse',
      bedrooms: 3,
      floor_area_m2: 210,
      tenure: 'Freehold',
    },
  },
];

async function ensureUser(
  email: string,
  displayName: string,
  handle: string,
  roles: string[],
  passwordHash: string,
) {
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      emailVerifiedAt: new Date(),
      profile: { create: { displayName, handle } },
      preferences: { create: {} },
      identityVerification: { create: {} },
    },
    update: {},
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

async function seedDemo() {
  if (process.env['NODE_ENV'] === 'production')
    throw new Error('Refusing to seed demo data in production');
  const password = demoPasswordFromEnv();
  const hash = await hashDemoPassword(password);
  for (const a of DEMO_ACCOUNTS)
    await ensureUser(a.email, a.displayName, a.handle, [...a.roles], hash);
  // Existing accounts keep their hash on re-seed; say so instead of failing silently.
  const stale = (
    await rotateDemoPasswords(prisma, password, { apply: false })
  ).filter((r) => r.outcome === 'would-rotate');
  if (stale.length)
    console.warn(
      `${stale.length} existing demo account(s) still use an older password. Run npm run db:rotate-demo-passwords to apply SEED_DEMO_PASSWORD to them.`,
    );
  const seller = await prisma.user.findUniqueOrThrow({
    where: { email: DEMO_SELLER_EMAIL },
  });
  await prisma.sellerProfile.upsert({
    where: { userId: seller.id },
    create: {
      userId: seller.id,
      type: 'DEALER',
      businessName: 'Demo Dealer Ltd (fictional)',
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
    },
    update: {},
  });

  const existing = await prisma.auction.count({
    where: { sellerId: seller.id },
  });
  if (existing > 0) {
    console.log(`Demo auctions already present (${existing}); skipping.`);
    return;
  }
  const now = Date.now();
  for (const d of DEMO_AUCTIONS) {
    const cat = await prisma.category.findUniqueOrThrow({
      where: { slug: d.category },
      include: { attributes: true },
    });
    const sub = await prisma.category.findUniqueOrThrow({
      where: { slug: d.subcategory },
      include: { attributes: true },
    });
    const startsAt = new Date(now + d.startOffsetMin * 60_000);
    const endsAt = new Date(startsAt.getTime() + d.durationMin * 60_000);
    const status = startsAt.getTime() <= now ? 'LIVE' : 'SCHEDULED';
    const defs = [...cat.attributes, ...sub.attributes];
    await prisma.auction.create({
      data: {
        sellerId: seller.id,
        categoryId: cat.id,
        subcategoryId: sub.id,
        title: d.title,
        description: d.description,
        condition: d.condition,
        locationCity: d.city,
        locationCountry: d.country,
        currency: 'USD',
        startingPriceCents: d.startMinor,
        minIncrementCents: d.incrementMinor,
        reservePriceCents: d.reserveMinor ?? null,
        buyNowPriceCents: d.buyNowMinor ?? null,
        startsAt,
        endsAt,
        originalEndsAt: endsAt,
        status,
        submittedAt: new Date(now),
        approvedAt: new Date(now),
        ...(d.antiSniping
          ? {
              antiSnipingEnabled: true,
              antiSnipingWindowSec: 120,
              antiSnipingExtensionSec: 120,
            }
          : {}),
        media: {
          create: [
            {
              url: d.image,
              altText: d.title,
              position: 0,
              isPrimary: true,
              storage: 'BUNDLED',
            },
          ],
        },
        attributeValues: {
          create: Object.entries(d.attributes).map(([key, value]) => {
            const def = defs.find((x) => x.key === key);
            if (!def) throw new Error(`Unknown attribute ${key}`);
            return {
              attributeId: def.id,
              ...(typeof value === 'number'
                ? { valueNumber: value }
                : typeof value === 'boolean'
                  ? { valueBoolean: value }
                  : { valueText: value }),
            };
          }),
        },
        ...(d.vehicle ? { vehicle: { create: d.vehicle } } : {}),
        ...(d.watch ? { watch: { create: d.watch } } : {}),
        events: {
          create: [
            {
              type: 'CREATED',
              toStatus: 'DRAFT',
              version: 1,
              metadata: { seed: true },
            },
          ],
        },
      },
    });
  }
  console.log(
    `Seeded ${DEMO_AUCTIONS.length} demo auctions and 4 demo accounts (*@auctra.local).`,
  );
}

async function main() {
  await seedReferenceData(prisma);
  console.log('Reference data synced.');
  if (process.env['SEED_DEMO'] === 'true') await seedDemo();
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
