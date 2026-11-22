import request from 'supertest';
import { RoleKey } from '../src/roles/permissions.js';
import {
  bid,
  createLiveAuction,
  createTestApp,
  resetDb,
  signedIn,
  type TestApp,
} from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb(t.prisma);
});
afterAll(async () => {
  await t.close();
});

async function catalog() {
  const dealer = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
  const priv = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
  await t.prisma.sellerProfile.upsert({
    where: { userId: dealer.user.id },
    create: {
      userId: dealer.user.id,
      type: 'DEALER',
      verificationStatus: 'VERIFIED',
    },
    update: { type: 'DEALER', verificationStatus: 'VERIFIED' },
  });
  await t.prisma.sellerProfile.upsert({
    where: { userId: priv.user.id },
    create: {
      userId: priv.user.id,
      type: 'PRIVATE',
      verificationStatus: 'VERIFIED',
    },
    update: { type: 'PRIVATE', verificationStatus: 'VERIFIED' },
  });
  const cat = (slug: string) =>
    t.prisma.category.findUniqueOrThrow({ where: { slug } });
  const [cars, classic, watches, sport] = await Promise.all([
    cat('cars'),
    cat('cars-classic'),
    cat('watches'),
    cat('watches-sport'),
  ]);
  const make = (sellerId: string, o: Parameters<typeof createLiveAuction>[2]) =>
    createLiveAuction(t.prisma, sellerId, o);
  const a = await make(dealer.user.id, {
    title: 'Classic coupe',
    categoryId: cars.id,
    subcategoryId: classic.id,
    condition: 'GOOD',
    startingPriceCents: 5_000_000n,
    reservePriceCents: 6_000_000n,
    seedKey: 'test-classic-coupe',
  });
  const b = await make(dealer.user.id, {
    title: 'Dive watch',
    categoryId: watches.id,
    subcategoryId: sport.id,
    condition: 'EXCELLENT',
    startingPriceCents: 300_000n,
    reservePriceCents: 400_000n,
  });
  const c = await make(priv.user.id, {
    title: 'Plain watch',
    categoryId: watches.id,
    condition: 'NEW',
    startingPriceCents: 20_000n,
  });
  // A real bid sets the current price (the DB requires it to match the highest bid).
  const bidder = await signedIn(t);
  await bid(t, bidder.session, b.id, '450000').expect(201);
  await t.prisma.listingMedia.create({
    data: {
      auctionId: a.id,
      url: 'https://media.example/x.webp',
      position: 0,
      isPrimary: true,
      storage: 'EXTERNAL',
      creditAuthor: 'Jane Photographer',
      creditLicense: 'CC BY-SA 4.0',
      creditLicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      creditSourceUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
    },
  });
  return { a, b, c };
}

const ids = async (q: string) =>
  (await request(t.http).get(`/api/auctions?${q}`).expect(200)).body.items
    .map((x: { title: string }) => x.title)
    .sort();

describe('catalogue browsing (server-side filters)', () => {
  it('filters by one or several categories and subcategories', async () => {
    await catalog();
    expect(await ids('category=cars')).toEqual(['Classic coupe']);
    expect(await ids('category=watches-sport')).toEqual(['Dive watch']);
    expect(await ids('category=cars,watches-sport')).toEqual([
      'Classic coupe',
      'Dive watch',
    ]);
    await request(t.http).get('/api/auctions?category=Bad Slug').expect(400);
  });

  it('filters by price (current bid, else starting price), condition, seller type and reserve', async () => {
    await catalog();
    expect(await ids('minPrice=4000')).toEqual(['Classic coupe', 'Dive watch']);
    expect(await ids('maxPrice=4000')).toEqual(['Plain watch']);
    expect(await ids('minPrice=1000&maxPrice=4600')).toEqual(['Dive watch']);
    expect(await ids('condition=NEW,EXCELLENT')).toEqual([
      'Dive watch',
      'Plain watch',
    ]);
    expect(await ids('sellerType=PRIVATE')).toEqual(['Plain watch']);
    expect(await ids('sellerType=DEALER')).toEqual([
      'Classic coupe',
      'Dive watch',
    ]);
    expect(await ids('reserve=none')).toEqual(['Plain watch']);
    expect(await ids('reserve=met')).toEqual(['Dive watch']);
    expect(await ids('reserve=not_met')).toEqual(['Classic coupe']);
    await request(t.http).get('/api/auctions?condition=MINT').expect(400);
  });

  it('paginates with a stable total', async () => {
    await catalog();
    const p1 = await request(t.http)
      .get('/api/auctions?limit=2&page=1')
      .expect(200);
    const p2 = await request(t.http)
      .get('/api/auctions?limit=2&page=2')
      .expect(200);
    expect(p1.body.total).toBe(3);
    expect(p1.body.items).toHaveLength(2);
    expect(p2.body.items).toHaveLength(1);
    const all = [...p1.body.items, ...p2.body.items].map(
      (x: { id: string }) => x.id,
    );
    expect(new Set(all).size).toBe(3);
  });

  it('counts open lots per category and per subcategory', async () => {
    await catalog();
    const tree = (await request(t.http).get('/api/categories').expect(200))
      .body as {
      slug: string;
      activeAuctionCount: number;
      subcategories: { slug: string; activeAuctionCount: number }[];
    }[];
    const by = (slug: string) => tree.find((c) => c.slug === slug)!;
    expect(by('cars').activeAuctionCount).toBe(1);
    expect(by('watches').activeAuctionCount).toBe(2);
    expect(
      by('cars').subcategories.find((s) => s.slug === 'cars-classic')!
        .activeAuctionCount,
    ).toBe(1);
    expect(
      by('watches').subcategories.find((s) => s.slug === 'watches-sport')!
        .activeAuctionCount,
    ).toBe(1);
    expect(
      by('watches').subcategories.find((s) => s.slug === 'watches-dress')!
        .activeAuctionCount,
    ).toBe(0);
  });

  it('marks seeded demo lots and returns photo credits', async () => {
    const { a, c } = await catalog();
    const demo = (
      await request(t.http).get(`/api/auctions/${a.id}`).expect(200)
    ).body;
    expect(demo.demo).toBe(true);
    expect(demo.media[0].credit).toEqual({
      author: 'Jane Photographer',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
      notice: null,
    });
    const real = (
      await request(t.http).get(`/api/auctions/${c.id}`).expect(200)
    ).body;
    expect(real.demo).toBe(false);
  });

  it('filters by seller handle and sorts ended lots by most recent end', async () => {
    const { a } = await catalog();
    const handle = (
      await t.prisma.userProfile.findUniqueOrThrow({
        where: { userId: a.sellerId },
      })
    ).handle;
    expect(await ids(`seller=${handle}`)).toEqual([
      'Classic coupe',
      'Dive watch',
    ]);
    expect(await ids('seller=nobody_here')).toEqual([]);
    await request(t.http).get('/api/auctions?seller=bad handle!').expect(400);
    const now = Date.now();
    for (const [title, minsAgo] of [
      ['Old result', 90],
      ['New result', 5],
    ] as const)
      await createLiveAuction(t.prisma, a.sellerId, {
        title,
        status: 'UNSOLD',
        startsAt: new Date(now - 3 * 3_600_000),
        endsAt: new Date(now - minsAgo * 60_000),
        originalEndsAt: new Date(now - minsAgo * 60_000),
      });
    const ended = await request(t.http)
      .get('/api/auctions?phase=ended&sort=recently_ended')
      .expect(200);
    expect(ended.body.items.map((x: { title: string }) => x.title)).toEqual([
      'New result',
      'Old result',
    ]);
  });
});

describe('default ordering', () => {
  it('lists open lots first (soonest end first), then closed lots (most recent first) across pages', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const now = Date.now();
    const mk = (title: string, status: 'LIVE' | 'UNSOLD', endsInMin: number) =>
      createLiveAuction(t.prisma, seller.user.id, {
        title,
        status,
        startsAt: new Date(now - 24 * 3_600_000),
        endsAt: new Date(now + endsInMin * 60_000),
        originalEndsAt: new Date(now + endsInMin * 60_000),
      });
    await mk('Closed long ago', 'UNSOLD', -600);
    await mk('Live later', 'LIVE', 120);
    await mk('Closed recently', 'UNSOLD', -5);
    await mk('Live soon', 'LIVE', 10);
    const p1 = await request(t.http)
      .get('/api/auctions?limit=3&page=1')
      .expect(200);
    const p2 = await request(t.http)
      .get('/api/auctions?limit=3&page=2')
      .expect(200);
    expect(p1.body.total).toBe(4);
    expect(
      [...p1.body.items, ...p2.body.items].map(
        (x: { title: string }) => x.title,
      ),
    ).toEqual([
      'Live soon',
      'Live later',
      'Closed recently',
      'Closed long ago',
    ]);
  });
});
