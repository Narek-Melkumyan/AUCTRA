import { io, type Socket } from 'socket.io-client';
import { createClient } from 'redis';
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
const sockets: Socket[] = [];

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb(t.prisma);
});
afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});
afterAll(async () => {
  await t.close();
});

function connect(url: string, token?: string): Promise<Socket> {
  const s = io(url, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: token ? { token } : {},
    reconnection: false,
  });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function nextEvent<T = Record<string, unknown>>(
  s: Socket,
  name: string,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${name}`)),
      timeoutMs,
    );
    s.once(name, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

type Snapshot = {
  ok: boolean;
  auction: { version: number; bidCount: number };
  bids: unknown[];
  error?: { code: string };
};

async function seeded() {
  const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
  const auction = await createLiveAuction(t.prisma, seller.user.id);
  return { seller, auction };
}

describe('auction rooms', () => {
  it('joins with an initial snapshot and receives bid events after commit', async () => {
    const { auction } = await seeded();
    const viewer = await connect(t.url);
    const joined = (await viewer.emitWithAck('auction:join', {
      auctionId: auction.id,
    })) as Snapshot;
    expect(joined.ok).toBe(true);
    expect(joined.auction.version).toBe(1);

    const bidder = await signedIn(t);
    const event = nextEvent<{
      eventId: string;
      version: number;
      bid: { amount: { minor: string }; bidderAlias: string };
      state: { currentPrice: { minor: string } };
    }>(viewer, 'auction:bid');
    await bid(t, bidder.session, auction.id, '100000').expect(201);
    const e = await event;
    expect(e.version).toBe(2);
    expect(e.eventId).toMatch(/^\d+$/);
    expect(e.bid.amount.minor).toBe('100000');
    expect(e.state.currentPrice.minor).toBe('100000');
    expect(JSON.stringify(e)).not.toContain(bidder.user.id);
    // Published exactly once and marked as relayed.
    // (The relay commits publishedAt right after emitting, so wait for that commit.)
    await vi.waitFor(async () => {
      const rows = await t.prisma.outboxEvent.findMany({
        where: { aggregateId: auction.id },
      });
      expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
    });
  });

  it('validates room access and payloads', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const draft = await createLiveAuction(t.prisma, seller.user.id, {
      status: 'DRAFT',
    });
    const anon = await connect(t.url);
    expect(
      (
        (await anon.emitWithAck('auction:join', {
          auctionId: draft.id,
        })) as Snapshot
      ).error?.code,
    ).toBe('AUCTION_NOT_FOUND');
    expect(
      ((await anon.emitWithAck('auction:join', { auctionId: 'x' })) as Snapshot)
        .error?.code,
    ).toBe('INVALID_AUCTION_ID');
    // The owner can follow their own draft.
    const owner = await connect(t.url, seller.session.token);
    expect(
      (
        (await owner.emitWithAck('auction:join', {
          auctionId: draft.id,
        })) as Snapshot
      ).ok,
    ).toBe(true);
  });

  it('rejects invalid tokens but keeps the viewer connected anonymously', async () => {
    const s = io(t.url, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token: 'garbage' },
      reconnection: false,
    });
    sockets.push(s);
    const err = await nextEvent<{ code: string }>(s, 'auth:error');
    expect(err.code).toBe('INVALID_TOKEN');
    expect(s.connected).toBe(true);
  });

  it('delivers private outbid notifications only to the affected user', async () => {
    const { auction } = await seeded();
    const first = await signedIn(t);
    const second = await signedIn(t);
    const firstSocket = await connect(t.url, first.session.token);
    const secondSocket = await connect(t.url, second.session.token);
    await nextEvent(firstSocket, 'auth:ok').catch(() => undefined);
    await bid(t, first.session, auction.id, '100000').expect(201);

    let leaked = false;
    secondSocket.on('notification', () => (leaked = true));
    const note = nextEvent<{ type: string; auctionId: string }>(
      firstSocket,
      'notification',
    );
    await bid(t, second.session, auction.id, '110000').expect(201);
    expect(await note).toMatchObject({ type: 'OUTBID', auctionId: auction.id });
    await new Promise((r) => setTimeout(r, 200));
    expect(leaked).toBe(false);
  });

  it('recovers missed events after a reconnect via auction:sync', async () => {
    const { auction } = await seeded();
    const bidder = await signedIn(t);
    const other = await signedIn(t);
    const s1 = await connect(t.url);
    await s1.emitWithAck('auction:join', { auctionId: auction.id });
    const got = nextEvent<{ version: number }>(s1, 'auction:bid');
    await bid(t, bidder.session, auction.id, '100000').expect(201);
    const lastSeen = (await got).version;
    s1.disconnect();

    // Bids while the client is offline.
    await bid(t, other.session, auction.id, '110000').expect(201);
    await bid(t, bidder.session, auction.id, '120000').expect(201);

    const s2 = await connect(t.url);
    const sync = (await s2.emitWithAck('auction:sync', {
      auctionId: auction.id,
    })) as Snapshot & { auction: { currentPrice: { minor: string } } };
    expect(sync.ok).toBe(true);
    expect(sync.auction.version).toBe(lastSeen + 2);
    expect(sync.auction.currentPrice.minor).toBe('120000');
    expect(sync.bids).toHaveLength(3);
  });

  it('broadcasts lifecycle state changes with versions', async () => {
    const { auction } = await seeded();
    const s = await connect(t.url);
    await s.emitWithAck('auction:join', { auctionId: auction.id });
    await t.prisma
      .$executeRaw`UPDATE auctions SET "endsAt" = now() - interval '1 second', "originalEndsAt" = now() - interval '1 second' WHERE id = ${auction.id}::uuid`;
    const ended = nextEvent<{
      type: string;
      version: number;
      state: { phase: string };
    }>(s, 'auction:state');
    const { AuctionLifecycleService } =
      await import('../src/auctions/auction-lifecycle.service.js');
    await t.app.get(AuctionLifecycleService).close(auction.id);
    expect(await ended).toMatchObject({
      type: 'auction.ended',
      version: 2,
      state: { phase: 'ended' },
    });
  });
});

describe('multi-instance fan-out (Redis adapter)', () => {
  const redisUrl =
    process.env['TEST_REDIS_URL_FANOUT'] ?? 'redis://localhost:6379';
  let redisAvailable = false;

  beforeAll(async () => {
    const c = createClient({ url: redisUrl });
    c.on('error', () => undefined);
    try {
      await c.connect();
      redisAvailable = (await c.ping()) === 'PONG';
      await c.quit();
    } catch {
      redisAvailable = false;
    }
  });

  it('delivers a bid committed on instance A to a viewer connected to instance B', async (ctx) => {
    if (!redisAvailable) ctx.skip();
    process.env['REDIS_URL'] = redisUrl;
    const a = await createTestApp();
    const b = await createTestApp();
    process.env['REDIS_URL'] = '';
    try {
      const seller = await signedIn(a, {
        roles: [RoleKey.USER, RoleKey.SELLER],
      });
      const auction = await createLiveAuction(a.prisma, seller.user.id);
      const viewerOnB = await connect(b.url);
      expect(
        (
          (await viewerOnB.emitWithAck('auction:join', {
            auctionId: auction.id,
          })) as Snapshot
        ).ok,
      ).toBe(true);
      // Give the Redis adapter a moment to propagate the room subscription.
      await new Promise((r) => setTimeout(r, 200));
      const bidder = await signedIn(a);
      const received = nextEvent<{ version: number }>(
        viewerOnB,
        'auction:bid',
        5000,
      );
      await bid(a, bidder.session, auction.id, '100000').expect(201);
      expect((await received).version).toBe(2);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
