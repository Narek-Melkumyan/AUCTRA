import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AuctionLifecycleService } from '../src/auctions/auction-lifecycle.service.js';
import { RoleKey } from '../src/roles/permissions.js';
import {
  auth,
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

async function setup(overrides: Parameters<typeof createLiveAuction>[2] = {}) {
  const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
  const auction = await createLiveAuction(t.prisma, seller.user.id, overrides);
  return { seller, auction };
}

describe('bid validation', () => {
  it('accepts a valid opening bid and updates the auction atomically', async () => {
    const { auction } = await setup();
    const { session } = await signedIn(t);
    const res = await bid(t, session, auction.id, '100000').expect(201);
    expect(res.body.bid).toMatchObject({
      sequence: 1,
      amount: { minor: '100000', currency: 'USD' },
      mine: true,
    });
    expect(res.body.auction).toMatchObject({
      version: 2,
      bidCount: 1,
      currentPrice: { minor: '100000' },
      minimumNextBid: { minor: '105000' },
    });

    const a = await t.prisma.auction.findUniqueOrThrow({
      where: { id: auction.id },
    });
    expect(a.currentPriceCents).toBe(100000n);
    expect(a.highestBidId).toBe(res.body.bid.id);
    expect(
      await t.prisma.outboxEvent.count({
        where: { aggregateId: auction.id, type: 'auction.bid_placed' },
      }),
    ).toBe(1);
    expect(
      await t.prisma.auctionEvent.count({
        where: { auctionId: auction.id, type: 'BID_PLACED' },
      }),
    ).toBe(1);
  });

  it('rejects a bid below the minimum with the exact minimum', async () => {
    const { auction } = await setup();
    const a = await signedIn(t);
    const b = await signedIn(t);
    await bid(t, a.session, auction.id, '100000').expect(201);
    const res = await bid(t, b.session, auction.id, '104999').expect(422);
    expect(res.body.code).toBe('BID_TOO_LOW');
    expect(res.body.details.minimum).toEqual({
      minor: '105000',
      currency: 'USD',
    });
    // Below the starting price on an auction without bids.
    const { auction: fresh } = await setup();
    expect(
      (await bid(t, b.session, fresh.id, '99999').expect(422)).body.code,
    ).toBe('BID_TOO_LOW');
  });

  it('rejects bids on an auction whose end time has passed, even before the closing job runs', async () => {
    const { auction } = await setup({
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() - 1000),
    });
    const { session } = await signedIn(t);
    const res = await bid(t, session, auction.id, '100000').expect(409);
    expect(res.body.code).toBe('AUCTION_ENDED');
    const a = await t.prisma.auction.findUniqueOrThrow({
      where: { id: auction.id },
    });
    expect(a.status).toBe('LIVE'); // worker has not run — DB time alone decided
    expect(a.bidCount).toBe(0);
  });

  it('rejects bids before the start, on cancelled auctions and on drafts', async () => {
    const { session } = await signedIn(t);
    const { auction: upcoming } = await setup({
      status: 'SCHEDULED',
      startsAt: new Date(Date.now() + 3600_000),
      endsAt: new Date(Date.now() + 7200_000),
    });
    expect(
      (await bid(t, session, upcoming.id, '100000').expect(409)).body.code,
    ).toBe('AUCTION_NOT_STARTED');
    const { auction: cancelled } = await setup({ status: 'CANCELLED' });
    expect(
      (await bid(t, session, cancelled.id, '100000').expect(409)).body.code,
    ).toBe('AUCTION_CANCELLED');
    const { auction: draft } = await setup({ status: 'DRAFT' });
    await bid(t, session, draft.id, '100000').expect(404);
  });

  it('activates a due SCHEDULED auction inline when the scheduler is late', async () => {
    const { auction } = await setup({
      status: 'SCHEDULED',
      startsAt: new Date(Date.now() - 1000),
    });
    const { session } = await signedIn(t);
    await bid(t, session, auction.id, '100000').expect(201);
    const a = await t.prisma.auction.findUniqueOrThrow({
      where: { id: auction.id },
    });
    expect(a.status).toBe('LIVE');
    expect(a.version).toBe(3); // STARTED + BID_PLACED
  });

  it('prevents sellers bidding on their own auction', async () => {
    const { seller, auction } = await setup();
    const res = await bid(t, seller.session, auction.id, '100000').expect(403);
    expect(res.body.code).toBe('SELF_BIDDING_NOT_ALLOWED');
  });

  it('blocks suspended and unverified users', async () => {
    const { auction } = await setup();
    const suspended = await signedIn(t, { status: 'SUSPENDED' });
    expect(
      (await bid(t, suspended.session, auction.id, '100000').expect(403)).body
        .code,
    ).toBe('ACCOUNT_RESTRICTED');
    const unverified = await signedIn(t, { verified: false });
    expect(
      (await bid(t, unverified.session, auction.id, '100000').expect(403)).body
        .code,
    ).toBe('EMAIL_NOT_VERIFIED');
    await request(t.http)
      .post(`/api/auctions/${auction.id}/bids`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: '100000' })
      .expect(401);
  });

  it('requires an idempotency key and exact integer amounts', async () => {
    const { auction } = await setup();
    const { session } = await signedIn(t);
    const noKey = await request(t.http)
      .post(`/api/auctions/${auction.id}/bids`)
      .set(auth(session.token))
      .send({ amountMinor: '100000' })
      .expect(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    for (const amountMinor of ['1000.50', '1e6', '-5', 100000]) {
      await request(t.http)
        .post(`/api/auctions/${auction.id}/bids`)
        .set(auth(session.token))
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor })
        .expect(400);
    }
  });

  it('does not let the current leader outbid themselves', async () => {
    const { auction } = await setup();
    const { session } = await signedIn(t);
    await bid(t, session, auction.id, '100000').expect(201);
    expect(
      (await bid(t, session, auction.id, '200000').expect(409)).body.code,
    ).toBe('ALREADY_HIGHEST_BIDDER');
  });

  it('serialises very large amounts exactly', async () => {
    const { auction } = await setup({
      startingPriceCents: 900_000_000_000_000_001n,
      minIncrementCents: 1n,
    });
    const { session } = await signedIn(t);
    const res = await bid(t, session, auction.id, '900000000000000001').expect(
      201,
    );
    expect(res.body.auction.currentPrice.minor).toBe('900000000000000001');
    expect(res.body.auction.minimumNextBid.minor).toBe('900000000000000002');
  });

  it('extends the end time inside the anti-sniping window', async () => {
    const endsAt = new Date(Date.now() + 30_000);
    const { auction } = await setup({
      endsAt,
      originalEndsAt: endsAt,
      antiSnipingEnabled: true,
      antiSnipingWindowSec: 60,
      antiSnipingExtensionSec: 120,
    });
    const { session } = await signedIn(t);
    const res = await bid(t, session, auction.id, '100000').expect(201);
    const newEnd = new Date(res.body.auction.endsAt).getTime();
    expect(newEnd).toBeGreaterThan(endsAt.getTime() + 60_000);
    expect(
      await t.prisma.auctionEvent.count({
        where: { auctionId: auction.id, type: 'EXTENDED' },
      }),
    ).toBe(1);
  });

  it('hides bidder identity in public history', async () => {
    const { auction } = await setup();
    const a = await signedIn(t);
    await bid(t, a.session, auction.id, '100000').expect(201);
    const pub = await request(t.http)
      .get(`/api/auctions/${auction.id}/bids`)
      .expect(200);
    expect(pub.body[0].bidderAlias).toMatch(/^bidder_[0-9a-f]{6}$/);
    expect(pub.body[0].mine).toBe(false);
    expect(JSON.stringify(pub.body)).not.toContain(a.user.id);
    expect(JSON.stringify(pub.body)).not.toContain(a.user.email);
    const detail = await request(t.http)
      .get(`/api/auctions/${auction.id}`)
      .expect(200);
    expect(detail.body).not.toHaveProperty('reservePrice');
    expect(JSON.stringify(detail.body)).not.toContain(a.user.id);
    const mine = await request(t.http)
      .get(`/api/auctions/${auction.id}/bids`)
      .set(auth(a.session.token))
      .expect(200);
    expect(mine.body[0].mine).toBe(true);
  });
});

describe('idempotency and concurrency', () => {
  it('replays a duplicate request instead of bidding twice', async () => {
    const { auction } = await setup();
    const { session } = await signedIn(t);
    const key = randomUUID();
    const first = await bid(t, session, auction.id, '100000', key).expect(201);
    const second = await bid(t, session, auction.id, '100000', key).expect(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.bid.id).toBe(first.body.bid.id);
    expect(await t.prisma.bid.count()).toBe(1);
    const conflict = await bid(t, session, auction.id, '150000', key).expect(
      409,
    );
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('accepts exactly one of many concurrent duplicates', async () => {
    const { auction } = await setup();
    const { session } = await signedIn(t);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        bid(t, session, auction.id, '100000', key),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(
      true,
    );
    expect(new Set(results.map((r) => r.body.bid.id)).size).toBe(1);
    expect(await t.prisma.bid.count()).toBe(1);
  });

  it('two users bidding the same amount at the same moment: exactly one wins', async () => {
    const { auction } = await setup();
    const a = await signedIn(t);
    const b = await signedIn(t);
    const [ra, rb] = await Promise.all([
      bid(t, a.session, auction.id, '100000'),
      bid(t, b.session, auction.id, '100000'),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([201, 422]);
    const loser = ra.status === 422 ? ra : rb;
    expect(loser.body.code).toBe('BID_TOO_LOW');
    const row = await t.prisma.auction.findUniqueOrThrow({
      where: { id: auction.id },
    });
    expect(row.bidCount).toBe(1);
    expect(row.version).toBe(2);
  });

  it('keeps a consistent, gap-free bid sequence under a burst of competing bids', async () => {
    const { auction } = await setup();
    const bidders = await Promise.all(
      Array.from({ length: 12 }, () => signedIn(t)),
    );
    // Every bidder offers a different amount, all above the opening price, at once.
    const results = await Promise.all(
      bidders.map((b, i) =>
        bid(t, b.session, auction.id, String(100_000 + i * 10_000)),
      ),
    );
    const accepted = results.filter((r) => r.status === 201);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    for (const r of results)
      if (r.status !== 201)
        expect(['BID_TOO_LOW', 'ALREADY_HIGHEST_BIDDER']).toContain(
          r.body.code,
        );

    const bids = await t.prisma.bid.findMany({
      where: { auctionId: auction.id },
      orderBy: { sequence: 'asc' },
    });
    expect(bids.map((x) => x.sequence)).toEqual(bids.map((_, i) => i + 1));
    for (let i = 1; i < bids.length; i++) {
      expect(bids[i]!.amountCents).toBeGreaterThanOrEqual(
        bids[i - 1]!.amountCents + 5_000n,
      );
    }
    const row = await t.prisma.auction.findUniqueOrThrow({
      where: { id: auction.id },
    });
    expect(row.bidCount).toBe(bids.length);
    expect(row.currentPriceCents).toBe(bids.at(-1)!.amountCents);
    expect(row.highestBidId).toBe(bids.at(-1)!.id);
    expect(row.version).toBe(1 + bids.length);
  });
});

describe('closing and settlement', () => {
  async function endNow(id: string) {
    await t.prisma
      .$executeRaw`UPDATE auctions SET "endsAt" = now() - interval '1 second', "originalEndsAt" = now() - interval '1 second' WHERE id = ${id}::uuid`;
  }

  it('closes, picks the highest bidder and creates exactly one order', async () => {
    const { seller, auction } = await setup();
    const a = await signedIn(t);
    const b = await signedIn(t);
    await bid(t, a.session, auction.id, '100000').expect(201);
    await bid(t, b.session, auction.id, '120000').expect(201);
    await endNow(auction.id);
    const lifecycle = t.app.get(AuctionLifecycleService);

    expect(await lifecycle.close(auction.id)).toBe(true);
    expect(await lifecycle.close(auction.id)).toBe(false);
    expect(
      (await bid(t, a.session, auction.id, '200000').expect(409)).body.code,
    ).toBe('AUCTION_ENDED');

    expect(await lifecycle.settle(auction.id)).toBe('SOLD');
    expect(await lifecycle.settle(auction.id)).toBeNull(); // double settlement is a no-op

    const row = await t.prisma.auction.findUniqueOrThrow({
      where: { id: auction.id },
    });
    expect(row.status).toBe('SOLD');
    expect(row.winnerId).toBe(b.user.id);
    const orders = await t.prisma.order.findMany({
      where: { auctionId: auction.id },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      buyerId: b.user.id,
      sellerId: seller.user.id,
      hammerPriceCents: 120000n,
      totalCents: 120000n,
      status: 'PENDING_PAYMENT',
    });

    const types = (await t.prisma.notification.findMany()).map(
      (n) =>
        `${n.type}:${n.userId === b.user.id ? 'winner' : n.userId === a.user.id ? 'loser' : 'seller'}`,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'AUCTION_WON:winner',
        'AUCTION_LOST:loser',
        'AUCTION_SOLD:seller',
        'OUTBID:loser',
      ]),
    );
    const events = (
      await t.prisma.auctionEvent.findMany({
        where: { auctionId: auction.id },
        orderBy: { id: 'asc' },
      })
    ).map((e) => e.type);
    expect(events.slice(-2)).toEqual(['ENDED', 'SOLD']);

    const winnerView = await request(t.http)
      .get(`/api/auctions/${auction.id}`)
      .set(auth(b.session.token))
      .expect(200);
    expect(winnerView.body.result).toMatchObject({
      outcome: 'sold',
      wonByMe: true,
      hammerPrice: { minor: '120000' },
    });
    const myOrders = await request(t.http)
      .get('/api/me/orders')
      .set(auth(b.session.token))
      .expect(200);
    expect(myOrders.body[0].total.minor).toBe('120000');
  });

  it('is UNSOLD when the reserve is not met, and SOLD when it is', async () => {
    const lifecycle = t.app.get(AuctionLifecycleService);
    const { auction: below } = await setup({ reservePriceCents: 150_000n });
    const { auction: met } = await setup({ reservePriceCents: 150_000n });
    const x = await signedIn(t);
    await bid(t, x.session, below.id, '140000').expect(201);
    const res = await bid(t, x.session, met.id, '150000').expect(201);
    expect(res.body.auction.reserve).toBe('met');
    await endNow(below.id);
    await endNow(met.id);
    await lifecycle.close(below.id);
    await lifecycle.close(met.id);
    expect(await lifecycle.settle(below.id)).toBe('UNSOLD');
    expect(await lifecycle.settle(met.id)).toBe('SOLD');
    expect(await t.prisma.order.count({ where: { auctionId: below.id } })).toBe(
      0,
    );
    const unsold = await t.prisma.auction.findUniqueOrThrow({
      where: { id: below.id },
    });
    expect(unsold.winnerId).toBeNull();
  });

  it('is UNSOLD without bids', async () => {
    const lifecycle = t.app.get(AuctionLifecycleService);
    const { auction } = await setup();
    await endNow(auction.id);
    await lifecycle.close(auction.id);
    expect(await lifecycle.settle(auction.id)).toBe('UNSOLD');
  });

  it('a bid racing the close is either accepted before the deadline or rejected — never both', async () => {
    const lifecycle = t.app.get(AuctionLifecycleService);
    const { auction } = await setup({
      endsAt: new Date(Date.now() + 300),
      originalEndsAt: new Date(Date.now() + 300),
    });
    const { session } = await signedIn(t);
    await new Promise((r) => setTimeout(r, 250));
    const [bidRes] = await Promise.all([
      bid(t, session, auction.id, '100000'),
      new Promise((r) => setTimeout(r, 60)).then(() =>
        lifecycle.close(auction.id),
      ),
    ]);
    await new Promise((r) => setTimeout(r, 100));
    await lifecycle.close(auction.id);
    await lifecycle.settle(auction.id);
    const row = await t.prisma.auction.findUniqueOrThrow({
      where: { id: auction.id },
    });
    if (bidRes.status === 201) {
      expect(row.status).toBe('SOLD');
      const b = await t.prisma.bid.findFirstOrThrow({
        where: { auctionId: auction.id },
      });
      expect(b.createdAt.getTime()).toBeLessThanOrEqual(row.endsAt.getTime());
    } else {
      expect(bidRes.body.code).toBe('AUCTION_ENDED');
      expect(row.status).toBe('UNSOLD');
      expect(row.bidCount).toBe(0);
    }
  });
});
