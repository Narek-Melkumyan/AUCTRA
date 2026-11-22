/**
 * Auction-engine invariants under concurrency, against real PostgreSQL (and Redis
 * where noted). Each test asserts database state directly — never just API responses.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { RoleKey } from '../src/roles/permissions.js';
import { LifecycleWorker } from '../src/jobs/lifecycle.worker.js';
import { AuctionLifecycleService } from '../src/auctions/auction-lifecycle.service.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { OutboxRelayService } from '../src/realtime/outbox-relay.service.js';
import { JobProcessor } from '../src/notifications/job-processor.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  auth,
  bid,
  createLiveAuction,
  createTestApp,
  createUser,
  login,
  resetDb,
  signedIn,
  type TestApp,
} from './helpers.js';

let t: TestApp;
const extraApps: TestApp[] = [];
const sockets: Socket[] = [];

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb(t.prisma);
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const a of extraApps.splice(0)) await a.close();
});
afterAll(async () => {
  await t.close();
});

/** Creates another app instance with env overrides (config is read at boot). */
async function appWith(env: Record<string, string>): Promise<TestApp> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    const a = await createTestApp();
    extraApps.push(a);
    return a;
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

/** Invariants 1–4: valid bidder, min-bid rules in sequence order, highest = latest, sequences. */
async function assertInvariants(prisma: PrismaService, auctionId: string) {
  const a = await prisma.auction.findUniqueOrThrow({
    where: { id: auctionId },
  });
  const bids = await prisma.bid.findMany({
    where: { auctionId, status: 'ACCEPTED' },
    orderBy: { sequence: 'asc' },
    include: { bidder: { select: { id: true } } },
  });
  expect(bids.map((b) => b.sequence)).toEqual(bids.map((_, i) => i + 1));
  expect(a.bidCount).toBe(bids.length);
  bids.forEach((b, i) => {
    expect(b.bidder.id).toBe(b.bidderId);
    if (i === 0) expect(b.amountCents >= a.startingPriceCents).toBe(true);
    else {
      expect(
        b.amountCents >= bids[i - 1]!.amountCents + a.minIncrementCents,
      ).toBe(true);
      expect(b.previousPriceCents).toBe(bids[i - 1]!.amountCents);
      expect(b.bidderId).not.toBe(bids[i - 1]!.bidderId);
      expect(b.createdAt.getTime()).toBeGreaterThanOrEqual(
        bids[i - 1]!.createdAt.getTime(),
      );
    }
    expect(b.createdAt.getTime()).toBeLessThan(a.endsAt.getTime());
  });
  const last = bids.at(-1);
  expect(a.highestBidId).toBe(last?.id ?? null);
  expect(a.currentPriceCents).toBe(last?.amountCents ?? null);
  return { a, bids };
}

async function many(n: number) {
  return Promise.all(Array.from({ length: n }, () => signedIn(t)));
}

describe('bid concurrency', () => {
  it('serialises 100 concurrent bids from 100 users with no lost updates (invariants 1–4)', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id, {
      startingPriceCents: 4_500_000n,
      minIncrementCents: 25_000n,
    });
    const users = await many(100);
    const rs = await Promise.all(
      users.map((u) =>
        bid(
          t,
          u.session,
          a.id,
          String(4_500_000 + 25_000 * Math.floor(Math.random() * 80)),
        ),
      ),
    );
    const statuses = rs.map((r) => r.status);
    expect(statuses.every((s) => s === 201 || s === 422 || s === 409)).toBe(
      true,
    );
    const accepted = rs.filter((r) => r.status === 201);
    for (const r of rs.filter((x) => x.status !== 201))
      expect(['BID_TOO_LOW', 'ALREADY_HIGHEST_BIDDER']).toContain(r.body.code);
    const { bids } = await assertInvariants(t.prisma, a.id);
    expect(bids).toHaveLength(accepted.length);
    // Every 201 response corresponds to exactly one stored bid, and vice versa.
    expect(new Set(accepted.map((r) => r.body.bid.id))).toEqual(
      new Set(bids.map((b) => b.id)),
    );
    // Each accepted response saw a strictly newer state than the previous one.
    const seqs = accepted
      .map((r) => r.body.bid.sequence)
      .sort((x: number, y: number) => x - y);
    expect(seqs).toEqual(bids.map((b) => b.sequence));
  });

  it('keeps invariants when two API instances race on the same auction', async () => {
    const other = await appWith({});
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id, {
      minIncrementCents: 1_000n,
    });
    const users = await many(40);
    const rs = await Promise.all(
      users.map((u, i) =>
        request(i % 2 ? other.http : t.http)
          .post(`/api/auctions/${a.id}/bids`)
          .set(auth(u.session.token))
          .set('Idempotency-Key', randomUUID())
          .send({ amountMinor: String(100_000 + 1_000 * (i + 1)) }),
      ),
    );
    expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
    await assertInvariants(t.prisma, a.id);
  });

  it('bids the same amount at the same instant: the first committed wins, the other is told why', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id);
    const [x, y] = await many(2);
    const rs = await Promise.all([
      bid(t, x!.session, a.id, '100000'),
      bid(t, y!.session, a.id, '100000'),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 422]);
    const loser = rs.find((r) => r.status === 422)!;
    expect(loser.body).toMatchObject({
      code: 'BID_TOO_LOW',
      details: { minimum: { minor: '105000' } },
    });
    await assertInvariants(t.prisma, a.id);
  });
});

describe('idempotency (invariant 5)', () => {
  it('20 concurrent retries of one request create one bid and return the same result', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id);
    const u = await signedIn(t);
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => bid(t, u.session, a.id, '100000', key)),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(19);
    expect(new Set(rs.map((r) => r.body.bid.id)).size).toBe(1);
    expect(await t.prisma.bid.count({ where: { auctionId: a.id } })).toBe(1);
    const reused = await bid(t, u.session, a.id, '200000', key).expect(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays the original REJECTION for a retried request, even after the auction moved on', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id);
    const [alice, bob] = await many(2);
    await bid(t, alice!.session, a.id, '100000').expect(201);
    const key = randomUUID();
    const first = await bid(t, alice!.session, a.id, '110000', key).expect(409);
    expect(first.body.code).toBe('ALREADY_HIGHEST_BIDDER');
    // Bob outbids Alice; a fresh evaluation of Alice's request would now succeed…
    await bid(t, bob!.session, a.id, '105000').expect(201);
    // …but a retry of the SAME request returns the original outcome, not a new bid.
    const retry = await bid(t, alice!.session, a.id, '110000', key).expect(409);
    expect(retry.body).toMatchObject({
      code: 'ALREADY_HIGHEST_BIDDER',
      details: { replayed: true },
    });
    expect(
      await t.prisma.bid.count({
        where: { auctionId: a.id, bidderId: alice!.user.id },
      }),
    ).toBe(1);
    // Concurrent retries of a rejected request agree with each other.
    const k2 = randomUUID();
    const burst = await Promise.all(
      Array.from({ length: 8 }, () =>
        bid(t, alice!.session, a.id, '100000', k2),
      ),
    );
    expect(new Set(burst.map((r) => `${r.status}:${r.body.code}`))).toEqual(
      new Set(['422:BID_TOO_LOW']),
    );
    expect(await t.prisma.idempotencyKey.count({ where: { key: k2 } })).toBe(1);
  });
});

describe('deadlines and settlement (invariants 6–8)', () => {
  it('rejects bids after endsAt even while the auction is still LIVE in the table', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id, {
      endsAt: new Date(Date.now() + 400),
      originalEndsAt: new Date(Date.now() + 400),
    });
    const users = await many(30);
    const rs: request.Response[] = [];
    await Promise.all(
      users.map(async (u, i) => {
        for (let k = 0; k < 6; k++) {
          rs.push(
            await bid(
              t,
              u.session,
              a.id,
              String(100_000 + 5_000 * (i * 6 + k)),
            ),
          );
          await new Promise((r) => setTimeout(r, 60));
        }
      }),
    );
    expect(
      (await t.prisma.auction.findUniqueOrThrow({ where: { id: a.id } }))
        .status,
    ).toBe('LIVE');
    expect(rs.some((r) => r.body.code === 'AUCTION_ENDED')).toBe(true);
    expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
    await assertInvariants(t.prisma, a.id); // includes: every bid created before endsAt
  });

  it('settles exactly once with the highest valid bidder, even with racing workers on two instances', async () => {
    const other = await appWith({});
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id, {
      reservePriceCents: 110_000n,
    });
    const [x, y] = await many(2);
    await bid(t, x!.session, a.id, '100000').expect(201);
    await bid(t, y!.session, a.id, '120000').expect(201);
    await t.prisma
      .$executeRaw`UPDATE auctions SET "endsAt" = now() - interval '1 second', "originalEndsAt" = now() - interval '1 second' WHERE id = ${a.id}::uuid`;
    const lc1 = t.app.get(AuctionLifecycleService);
    const lc2 = other.app.get(AuctionLifecycleService);
    await Promise.all([lc1.close(a.id), lc2.close(a.id), lc1.close(a.id)]);
    const outcomes = await Promise.all([
      lc1.settle(a.id),
      lc2.settle(a.id),
      lc1.settle(a.id),
      lc2.settle(a.id),
      t.app.get(LifecycleWorker).tick(),
      other.app.get(LifecycleWorker).tick(),
    ]);
    expect(outcomes.filter((o) => o === 'SOLD')).toHaveLength(1);
    const after = await t.prisma.auction.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(after).toMatchObject({ status: 'SOLD', winnerId: y!.user.id });
    const orders = await t.prisma.order.findMany({
      where: { auctionId: a.id },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      buyerId: y!.user.id,
      hammerPriceCents: 120_000n,
    });
  });

  it('does not sell below the reserve', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id, {
      reservePriceCents: 500_000n,
    });
    const u = await signedIn(t);
    await bid(t, u.session, a.id, '100000').expect(201);
    await t.prisma
      .$executeRaw`UPDATE auctions SET "endsAt" = now() - interval '1 second', "originalEndsAt" = now() - interval '1 second' WHERE id = ${a.id}::uuid`;
    await t.app.get(LifecycleWorker).tick();
    await t.app.get(LifecycleWorker).tick();
    const after = await t.prisma.auction.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(after.status).toBe('UNSOLD');
    expect(after.winnerId).toBeNull();
    expect(await t.prisma.order.count()).toBe(0);
  });
});

describe('atomicity and failure handling (invariants 9–11)', () => {
  it('a failed transaction leaves no partial changes, and the retry succeeds', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id);
    const u = await signedIn(t);
    const outbox = t.app.get(OutboxService);
    const original = outbox.enqueueMany.bind(outbox);
    let fail = true;
    outbox.enqueueMany = async (tx, msgs) => {
      if (fail) {
        fail = false;
        throw new Error('simulated failure after the bid insert');
      }
      return original(tx, msgs);
    };
    try {
      const key = randomUUID();
      await bid(t, u.session, a.id, '100000', key).expect(500);
      const mid = await t.prisma.auction.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(mid).toMatchObject({
        version: a.version,
        bidCount: 0,
        currentPriceCents: null,
        highestBidId: null,
      });
      expect(await t.prisma.bid.count({ where: { auctionId: a.id } })).toBe(0);
      expect(
        await t.prisma.auctionEvent.count({ where: { auctionId: a.id } }),
      ).toBe(0);
      expect(
        await t.prisma.outboxEvent.count({ where: { aggregateId: a.id } }),
      ).toBe(0);
      expect(await t.prisma.idempotencyKey.count({ where: { key } })).toBe(0);
      await bid(t, u.session, a.id, '100000', key).expect(201);
    } finally {
      outbox.enqueueMany = original;
    }
    await assertInvariants(t.prisma, a.id);
  });

  it('answers a retryable 503 (not a 500) when the auction row lock cannot be obtained in time', async () => {
    const fast = await appWith({ BID_LOCK_TIMEOUT_MS: '300' });
    const seller = await signedIn(fast, {
      roles: [RoleKey.USER, RoleKey.SELLER],
    });
    const a = await createLiveAuction(fast.prisma, seller.user.id);
    const u = await signedIn(fast);
    const blocker = new pg.Client({
      connectionString: process.env['DATABASE_URL']!.replace(/\?.*$/, ''),
    });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [
        a.id,
      ]);
      const key = randomUUID();
      const busy = await bid(fast, u.session, a.id, '100000', key).expect(503);
      expect(busy.body.code).toBe('BID_SYSTEM_BUSY');
      expect(busy.headers['retry-after']).toBe('1');
      await blocker.query('ROLLBACK');
      // Nothing was committed, so the same request now succeeds.
      await bid(fast, u.session, a.id, '100000', key).expect(201);
    } finally {
      await blocker.end();
    }
  });

  it('bounds the per-auction queue with a retryable 503 instead of piling up', async () => {
    const tight = await appWith({ BID_QUEUE_MAX_PER_AUCTION: '3' });
    const seller = await signedIn(tight, {
      roles: [RoleKey.USER, RoleKey.SELLER],
    });
    const a = await createLiveAuction(tight.prisma, seller.user.id, {
      minIncrementCents: 1_000n,
    });
    const users = await Promise.all(
      Array.from({ length: 40 }, () => signedIn(tight)),
    );
    const rs = await Promise.all(
      users.map((u, i) =>
        bid(tight, u.session, a.id, String(100_000 + 1_000 * i)),
      ),
    );
    const busy = rs.filter((r) => r.status === 503);
    expect(busy.length).toBeGreaterThan(0);
    expect(
      busy.every(
        (r) => r.body.code === 'AUCTION_BUSY' && r.headers['retry-after'],
      ),
    ).toBe(true);
    expect(rs.filter((r) => r.status >= 500 && r.status !== 503)).toHaveLength(
      0,
    );
    await assertInvariants(tight.prisma, a.id);
  });

  it('keeps accepting correct bids while Redis is unreachable, with local rate limiting (invariant 10)', async () => {
    const started = Date.now();
    const noRedis = await appWith({
      REDIS_URL: 'redis://127.0.0.1:6399',
      RATE_LIMIT_ENABLED: 'true',
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    const seller = await signedIn(noRedis, {
      roles: [RoleKey.USER, RoleKey.SELLER],
    });
    const a = await createLiveAuction(noRedis.prisma, seller.user.id);
    const [x, y] = await Promise.all([signedIn(noRedis), signedIn(noRedis)]);
    await bid(noRedis, x.session, a.id, '100000').expect(201);
    await bid(noRedis, y.session, a.id, '105000').expect(201);
    const health = await request(noRedis.http).get('/api/health').expect(503);
    expect(health.body).toMatchObject({
      status: 'degraded',
      redis: { status: 'down' },
    });
    // Rate limits still apply per instance: the bid endpoint allows 30/min per user.
    const burst = await Promise.all(
      Array.from({ length: 35 }, () =>
        request(noRedis.http)
          .post(`/api/auctions/${a.id}/bids`)
          .set(auth(x.session.token))
          .set('Idempotency-Key', randomUUID())
          .send({ amountMinor: '1' }),
      ),
    );
    expect(burst.some((r) => r.status === 429)).toBe(true);
    await assertInvariants(noRedis.prisma, a.id);
  });

  it('a restarted instance serves the latest committed state (invariant 11)', async () => {
    const first = await appWith({});
    const seller = await createUser(first.prisma, {
      roles: [RoleKey.USER, RoleKey.SELLER],
    });
    const a = await createLiveAuction(first.prisma, seller.id);
    const u = await createUser(first.prisma);
    const s = await login(first, u.email);
    await bid(first, s, a.id, '100000').expect(201);
    await first.close();
    extraApps.splice(extraApps.indexOf(first), 1);
    const second = await appWith({});
    const res = await request(second.http)
      .get(`/api/auctions/${a.id}`)
      .expect(200);
    expect(res.body).toMatchObject({
      bidCount: 1,
      version: 2,
      currentPrice: { minor: '100000' },
    });
    await assertInvariants(second.prisma, a.id);
  });
});

describe('realtime recovery (invariant 12)', () => {
  function connect(url: string): Promise<Socket> {
    const s = io(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
    });
  }

  it('a client that missed events resynchronises to the DB version; heartbeats expose staleness', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id);
    const users = await many(3);
    let viewer = await connect(t.url);
    const first = (await viewer.emitWithAck('auction:join', {
      auctionId: a.id,
    })) as { auction: { version: number } };
    expect(first.auction.version).toBe(1);
    viewer.disconnect();
    let amount = 100_000;
    for (const u of users) {
      await bid(t, u.session, a.id, String(amount)).expect(201);
      amount += 5_000;
    }
    viewer = await connect(t.url);
    const tick = new Promise<{ version: number }>((r) =>
      viewer.once('auction:tick', r),
    );
    const again = (await viewer.emitWithAck('auction:join', {
      auctionId: a.id,
    })) as {
      auction: { version: number; bidCount: number };
      bids: unknown[];
    };
    expect(again.auction).toMatchObject({ version: 4, bidCount: 3 });
    expect(again.bids).toHaveLength(3);
    await t.app.get(OutboxRelayService).tickRooms();
    expect((await tick).version).toBe(4);
  });

  it('joins after the snapshot cannot miss an event (join-then-snapshot ordering)', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id, {
      minIncrementCents: 1_000n,
    });
    const users = await many(15);
    const viewers = await Promise.all(
      Array.from({ length: 10 }, () => connect(t.url)),
    );
    const seen = viewers.map(() => new Set<number>());
    let snapVersion: number[] = [];
    viewers.forEach((v, i) =>
      v.on('auction:bid', (e: { version: number }) => seen[i]!.add(e.version)),
    );
    // Bids stream in while the viewers join.
    const bidding = (async () => {
      for (let k = 0; k < users.length; k++) {
        await bid(
          t,
          users[k]!.session,
          a.id,
          String(100_000 + 1_000 * k),
        ).expect(201);
      }
    })();
    snapVersion = await Promise.all(
      viewers.map(
        async (v) =>
          (
            (await v.emitWithAck('auction:join', { auctionId: a.id })) as {
              auction: { version: number };
            }
          ).auction.version,
      ),
    );
    await bidding;
    await new Promise((r) => setTimeout(r, 500));
    // Every version after the snapshot must have been delivered to that viewer.
    viewers.forEach((_, i) => {
      for (let v = snapVersion[i]! + 1; v <= 16; v++)
        expect(seen[i]!.has(v)).toBe(true);
    });
  });

  it('runs notification fan-out outside the bid transaction, exactly once', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id);
    const [x, y] = await many(2);
    await bid(t, x!.session, a.id, '100000').expect(201);
    await bid(t, y!.session, a.id, '105000').expect(201);
    const jobs = t.app.get(JobProcessor);
    await jobs.drain();
    await Promise.all([jobs.batch(), jobs.batch()]); // re-runs are harmless
    expect(
      await t.prisma.notification.count({
        where: { userId: seller.user.id, type: 'NEW_BID' },
      }),
    ).toBe(2);
    expect(
      await t.prisma.notification.count({
        where: { userId: x!.user.id, type: 'OUTBID' },
      }),
    ).toBe(1);
    expect(
      await t.prisma.outboxEvent.count({
        where: { aggregateType: 'job', publishedAt: null },
      }),
    ).toBe(0);
  });
});
