import request from 'supertest';
import { RoleKey } from '../src/roles/permissions.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  auth,
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

const inHours = (h: number) =>
  new Date(Date.now() + h * 3600_000).toISOString();

function validListing(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Steel diver chronometer',
    description:
      'A well-kept automatic diver with box and papers, recently serviced.',
    categorySlug: 'watches',
    subcategorySlug: 'watches-sport',
    condition: 'VERY_GOOD',
    currency: 'USD',
    startingPriceMinor: '900000',
    minIncrementMinor: '25000',
    reservePriceMinor: '1200000',
    startsAt: inHours(1),
    endsAt: inHours(25),
    media: [{ url: 'https://images.example.com/watch.jpg', altText: 'Watch' }],
    attributes: [{ key: 'water_resistance_m', value: 300 }],
    watch: { brand: 'Example', model: 'Diver', year: 2019, caseDiameterMm: 40 },
    ...overrides,
  };
}

describe('infrastructure', () => {
  it('health check reports the database and uses UTC database time', async () => {
    const res = await request(t.http).get('/api/health').expect(200);
    expect(res.body.database.status).toBe('up');
    const dbNow = await t.app.get(PrismaService).dbNow();
    // Regression guard: a non-UTC session time zone used to shift DB time by hours.
    expect(Math.abs(dbNow.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('never leaks internals in error responses', async () => {
    const res = await request(t.http)
      .get('/api/auctions/not-a-uuid')
      .expect(400);
    expect(res.body).toMatchObject({ statusCode: 400 });
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|stack|node_modules/i);
    await request(t.http)
      .post('/api/auctions')
      .set('Content-Type', 'application/json')
      .send('{"bad json')
      .expect(400);
  });
});

describe('listing creation and editing', () => {
  it('lets a verified seller create a draft; status and price fields are not client-controlled', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const res = await request(t.http)
      .post('/api/auctions')
      .set(auth(seller.session.token))
      .send(validListing())
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      phase: 'draft',
      bidCount: 0,
      currentPrice: null,
    });
    expect(res.body.reservePrice).toEqual({
      minor: '1200000',
      currency: 'USD',
    }); // owner sees it

    const sneaky = await request(t.http)
      .post('/api/auctions')
      .set(auth(seller.session.token))
      .send(
        validListing({
          status: 'LIVE',
          currentPriceCents: '1',
          winnerId: seller.user.id,
          sellerId: seller.user.id,
        }),
      )
      .expect(400);
    expect(JSON.stringify(sneaky.body.details.errors)).toMatch(
      /status should not exist/,
    );
  });

  it('validates prices, schedule, category and attributes', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const post = (o: Record<string, unknown>) =>
      request(t.http)
        .post('/api/auctions')
        .set(auth(seller.session.token))
        .send(validListing(o));
    expect(
      (await post({ reservePriceMinor: '100' }).expect(422)).body.code,
    ).toBe('INVALID_PRICE');
    expect(
      (await post({ startingPriceMinor: '0' }).expect(422)).body.code,
    ).toBe('INVALID_PRICE');
    expect(
      (await post({ startingPriceMinor: '12.50' }).expect(400)).body.code,
    ).toBe('VALIDATION_FAILED');
    expect((await post({ endsAt: inHours(0.5) }).expect(422)).body.code).toBe(
      'INVALID_SCHEDULE',
    );
    expect((await post({ categorySlug: 'nope' }).expect(422)).body.code).toBe(
      'INVALID_CATEGORY',
    );
    expect(
      (await post({ subcategorySlug: 'cars-classic' }).expect(422)).body.code,
    ).toBe('INVALID_SUBCATEGORY');
    expect(
      (
        await post({
          attributes: [{ key: 'water_resistance_m', value: 'deep' }],
        }).expect(422)
      ).body.code,
    ).toBe('INVALID_ATTRIBUTE');
    expect(
      (await post({ attributes: [{ key: 'artist', value: 'X' }] }).expect(422))
        .body.code,
    ).toBe('UNKNOWN_ATTRIBUTE');
    expect((await post({ currency: 'BTC' }).expect(400)).body.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      (await post({ media: [{ url: 'javascript:alert(1)' }] }).expect(400)).body
        .code,
    ).toBe('VALIDATION_FAILED');
  });

  it('forbids non-sellers from creating listings', async () => {
    const buyer = await signedIn(t);
    await request(t.http)
      .post('/api/auctions')
      .set(auth(buyer.session.token))
      .send(validListing())
      .expect(403);
    await request(t.http)
      .post('/api/auctions')
      .send(validListing())
      .expect(401);
  });

  it('blocks modification by other users and of non-draft auctions', async () => {
    const owner = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const other = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const draft = (
      await request(t.http)
        .post('/api/auctions')
        .set(auth(owner.session.token))
        .send(validListing())
        .expect(201)
    ).body;

    await request(t.http)
      .patch(`/api/auctions/${draft.id}`)
      .set(auth(other.session.token))
      .send({ title: 'Hijacked title' })
      .expect(404);
    await request(t.http)
      .post(`/api/auctions/${draft.id}/cancel`)
      .set(auth(other.session.token))
      .send({ reason: 'not mine' })
      .expect(404);
    const ok = await request(t.http)
      .patch(`/api/auctions/${draft.id}`)
      .set(auth(owner.session.token))
      .send({ title: 'Updated diver title' })
      .expect(200);
    expect(ok.body.title).toBe('Updated diver title');

    const live = await createLiveAuction(t.prisma, owner.user.id);
    const res = await request(t.http)
      .patch(`/api/auctions/${live.id}`)
      .set(auth(owner.session.token))
      .send({ startingPriceMinor: '1' })
      .expect(409);
    expect(res.body.code).toBe('AUCTION_NOT_EDITABLE');
  });

  it('runs the review flow: submit → approve → scheduled, with lifecycle history', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    const incomplete = (
      await request(t.http)
        .post('/api/auctions')
        .set(auth(seller.session.token))
        .send(validListing({ media: [], watch: undefined }))
        .expect(201)
    ).body;
    const missing = await request(t.http)
      .post(`/api/auctions/${incomplete.id}/submit`)
      .set(auth(seller.session.token))
      .expect(422);
    expect(missing.body.code).toBe('LISTING_INCOMPLETE');
    expect(missing.body.details.missing).toEqual(
      expect.arrayContaining(['at least one image', 'watch details']),
    );

    const draft = (
      await request(t.http)
        .post('/api/auctions')
        .set(auth(seller.session.token))
        .send(validListing())
        .expect(201)
    ).body;
    const submitted = await request(t.http)
      .post(`/api/auctions/${draft.id}/submit`)
      .set(auth(seller.session.token))
      .expect(200);
    expect(submitted.body.status).toBe('PENDING_REVIEW');

    // Not publicly visible while in review; sellers cannot approve; admins can.
    await request(t.http).get(`/api/auctions/${draft.id}`).expect(404);
    await request(t.http)
      .post(`/api/admin/auctions/${draft.id}/approve`)
      .set(auth(seller.session.token))
      .expect(403);
    const approved = await request(t.http)
      .post(`/api/admin/auctions/${draft.id}/approve`)
      .set(auth(admin.session.token))
      .expect(200);
    expect(approved.body.status).toBe('SCHEDULED');
    const pub = await request(t.http)
      .get(`/api/auctions/${draft.id}`)
      .expect(200);
    expect(pub.body.phase).toBe('upcoming');
    expect(pub.body).not.toHaveProperty('reservePrice');
    expect(pub.body.reserve).toBe('not_met');

    // Invalid transition: approving again.
    expect(
      (
        await request(t.http)
          .post(`/api/admin/auctions/${draft.id}/approve`)
          .set(auth(admin.session.token))
          .expect(409)
      ).body.code,
    ).toBe('NOT_IN_REVIEW');
    const history = await request(t.http)
      .get(`/api/auctions/${draft.id}/history`)
      .expect(200);
    expect(history.body.map((e: { type: string }) => e.type)).toEqual([
      'CREATED',
      'SUBMITTED_FOR_REVIEW',
      'APPROVED',
    ]);
  });

  it('applies cancellation rules', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    const live = await createLiveAuction(t.prisma, seller.user.id, {
      bidCount: 0,
    });
    const withBids = await createLiveAuction(t.prisma, seller.user.id);
    await t.prisma.auction.update({
      where: { id: withBids.id },
      data: { bidCount: 1 },
    });

    expect(
      (
        await request(t.http)
          .post(`/api/auctions/${live.id}/cancel`)
          .set(auth(seller.session.token))
          .send({ reason: 'withdrawn' })
          .expect(200)
      ).body.status,
    ).toBe('CANCELLED');
    expect(
      (
        await request(t.http)
          .post(`/api/auctions/${withBids.id}/cancel`)
          .set(auth(seller.session.token))
          .send({ reason: 'withdrawn' })
          .expect(409)
      ).body.code,
    ).toBe('CANNOT_CANCEL_WITH_BIDS');
    expect(
      (
        await request(t.http)
          .post(`/api/auctions/${withBids.id}/cancel`)
          .set(auth(admin.session.token))
          .send({ reason: 'policy violation' })
          .expect(200)
      ).body.status,
    ).toBe('CANCELLED');
    // Terminal: cannot cancel twice.
    expect(
      (
        await request(t.http)
          .post(`/api/auctions/${live.id}/cancel`)
          .set(auth(admin.session.token))
          .send({ reason: 'again' })
          .expect(409)
      ).body.code,
    ).toBe('INVALID_STATUS_TRANSITION');
  });
});

describe('public listing', () => {
  it('filters by phase and category and reports ended auctions as ended before the job runs', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const live = await createLiveAuction(t.prisma, seller.user.id);
    const expired = await createLiveAuction(t.prisma, seller.user.id, {
      startsAt: new Date(Date.now() - 7200_000),
      endsAt: new Date(Date.now() - 1000),
    });
    await createLiveAuction(t.prisma, seller.user.id, { status: 'DRAFT' });

    const liveRes = await request(t.http)
      .get('/api/auctions?phase=live')
      .expect(200);
    expect(liveRes.body.items.map((a: { id: string }) => a.id)).toEqual([
      live.id,
    ]);
    const endedRes = await request(t.http)
      .get('/api/auctions?phase=ended')
      .expect(200);
    expect(
      endedRes.body.items.map((a: { id: string; phase: string }) => [
        a.id,
        a.phase,
      ]),
    ).toEqual([[expired.id, 'ended']]);
    expect(
      (await request(t.http).get('/api/auctions?category=watches').expect(200))
        .body.total,
    ).toBe(2);
    expect(
      (await request(t.http).get('/api/auctions?category=cars').expect(200))
        .body.total,
    ).toBe(0);
    const cats = await request(t.http).get('/api/categories').expect(200);
    expect(cats.body.map((c: { slug: string }) => c.slug)).toEqual([
      'cars',
      'watches',
      'jewelry',
      'art',
      'real-estate',
      'collectibles',
    ]);
  });
});
