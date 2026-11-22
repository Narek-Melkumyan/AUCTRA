import request from 'supertest';
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

async function world() {
  const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
  const mod = await signedIn(t, { roles: [RoleKey.USER, RoleKey.MODERATOR] });
  const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
  const alice = await signedIn(t);
  const bob = await signedIn(t, { verified: false });
  const auction = await createLiveAuction(t.prisma, seller.user.id);
  await bid(t, alice.session, auction.id, '100000').expect(201);
  return { admin, mod, seller, alice, bob, auction };
}

describe('admin authorization', () => {
  it('never exposes admin endpoints to regular users, and scopes moderators', async () => {
    const { mod, alice, auction } = await world();
    const endpoints = [
      '/api/admin/analytics',
      '/api/admin/users',
      '/api/admin/auctions',
      `/api/admin/auctions/${auction.id}`,
      '/api/admin/integrity/bidding',
      '/api/admin/reports',
      '/api/admin/audit-logs',
      '/api/admin/chat/messages',
      '/api/admin/notifications/deliveries',
    ];
    for (const path of endpoints) {
      await request(t.http).get(path).expect(401);
      await request(t.http)
        .get(path)
        .set(auth(alice.session.token))
        .expect(403);
    }
    // Moderators: content tools yes, analytics/notifications/audit no.
    for (const path of [
      '/api/admin/reports',
      '/api/admin/chat/messages',
      '/api/admin/users',
    ])
      await request(t.http).get(path).set(auth(mod.session.token)).expect(200);
    for (const path of [
      '/api/admin/analytics',
      '/api/admin/notifications/deliveries',
      '/api/admin/audit-logs',
    ])
      await request(t.http).get(path).set(auth(mod.session.token)).expect(403);
    await request(t.http)
      .post(`/api/admin/auctions/${auction.id}/cancel`)
      .set(auth(mod.session.token))
      .send({ reason: 'not allowed for moderators' })
      .expect(403);
  });
});

describe('analytics', () => {
  it('reports real database figures', async () => {
    const { admin, auction } = await world();
    const bob2 = await signedIn(t);
    await bid(t, bob2.session, auction.id, '110000').expect(201);
    const res = await request(t.http)
      .get('/api/admin/analytics?days=7')
      .set(auth(admin.session.token))
      .expect(200);
    expect(res.body.totals).toMatchObject({
      users: 6,
      newUsers: 6,
      liveAuctions: 1,
      bids: 2,
      bidsInPeriod: 2,
      activeBidders: 2,
    });
    expect(res.body.bidsOverTime).toHaveLength(7);
    expect(
      res.body.bidsOverTime.reduce(
        (a: number, d: { bids: number }) => a + d.bids,
        0,
      ),
    ).toBe(2);
    expect(res.body.registrationsOverTime.at(-1).users).toBe(6);
    expect(
      res.body.categories.find((c: { slug: string }) => c.slug === 'watches'),
    ).toMatchObject({
      auctions: 1,
      live: 1,
      bids: 2,
    });
    expect(res.body.mostActiveAuctions[0]).toMatchObject({
      id: auction.id,
      bidCount: 2,
      bidders: 2,
    });
    expect(res.body.checkout).toMatchObject({
      ordersTotal: 0,
      demoCompleted: 0,
    });
  });
});

describe('users', () => {
  it('searches, filters and pages users; session details only for staff who can act', async () => {
    const { admin, mod, alice } = await world();
    const list = await request(t.http)
      .get('/api/admin/users?verified=false')
      .set(auth(admin.session.token))
      .expect(200);
    expect(list.body.total).toBe(1);
    const sellers = await request(t.http)
      .get('/api/admin/users?role=SELLER&limit=1')
      .set(auth(admin.session.token))
      .expect(200);
    expect(sellers.body).toMatchObject({ total: 1, limit: 1 });
    expect(sellers.body.items[0].roles).toContain('SELLER');
    const search = await request(t.http)
      .get(
        `/api/admin/users?q=${encodeURIComponent(alice.user.email.slice(0, 10))}`,
      )
      .set(auth(admin.session.token))
      .expect(200);
    expect(search.body.items.map((u: { id: string }) => u.id)).toContain(
      alice.user.id,
    );

    const asAdmin = await request(t.http)
      .get(`/api/admin/users/${alice.user.id}`)
      .set(auth(admin.session.token))
      .expect(200);
    expect(asAdmin.body.counts.bids).toBe(1);
    expect(asAdmin.body.recentBids).toHaveLength(1);
    expect(asAdmin.body.sessions).toHaveLength(1);
    expect(asAdmin.body).not.toHaveProperty('passwordHash');
    const asMod = await request(t.http)
      .get(`/api/admin/users/${alice.user.id}`)
      .set(auth(mod.session.token))
      .expect(200);
    expect(asMod.body.sessions).toBeUndefined();
  });

  it('suspends, reactivates and signs users out everywhere with an audit trail', async () => {
    const { admin, alice } = await world();
    await request(t.http)
      .post(`/api/admin/users/${alice.user.id}/sessions/revoke`)
      .set(auth(admin.session.token))
      .expect(200);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(alice.session.token))
      .expect(401);
    await request(t.http)
      .post(`/api/admin/users/${alice.user.id}/suspend`)
      .set(auth(admin.session.token))
      .send({ reason: 'investigation' })
      .expect(200);
    await request(t.http)
      .post(`/api/admin/users/${alice.user.id}/unsuspend`)
      .set(auth(admin.session.token))
      .expect(200);
    const actions = (
      await t.prisma.auditLog.findMany({
        where: { entityId: alice.user.id, actorId: admin.user.id },
        orderBy: { id: 'asc' },
      })
    ).map((a) => a.action);
    expect(actions).toEqual([
      'user.sessions_revoked',
      'user.suspended',
      'user.unsuspend',
    ]);
  });
});

describe('auctions', () => {
  it('lists with filters, shows full bid history to staff, and cancels with notifications', async () => {
    const { admin, seller, alice, auction } = await world();
    const filtered = await request(t.http)
      .get(
        `/api/admin/auctions?status=LIVE&category=watches&sellerId=${seller.user.id}`,
      )
      .set(auth(admin.session.token))
      .expect(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0]).toMatchObject({
      id: auction.id,
      bidCount: 1,
    });
    const none = await request(t.http)
      .get('/api/admin/auctions?category=cars')
      .set(auth(admin.session.token))
      .expect(200);
    expect(none.body.total).toBe(0);

    const detail = await request(t.http)
      .get(`/api/admin/auctions/${auction.id}`)
      .set(auth(admin.session.token))
      .expect(200);
    expect(detail.body.bids[0].bidder).toMatchObject({
      id: alice.user.id,
      email: alice.user.email,
    });

    await request(t.http)
      .post(`/api/admin/auctions/${auction.id}/cancel`)
      .set(auth(admin.session.token))
      .send({ reason: 'Counterfeit concern' })
      .expect(200);
    expect(
      (await t.prisma.auction.findUniqueOrThrow({ where: { id: auction.id } }))
        .status,
    ).toBe('CANCELLED');
    expect(
      await t.prisma.notification.count({
        where: { userId: alice.user.id, auctionId: auction.id },
      }),
    ).toBeGreaterThan(0);
  });
});

describe('bid integrity signals', () => {
  it('flags several accounts bidding from one network for human review', async () => {
    const { admin, auction } = await world();
    const other = await signedIn(t);
    await bid(t, other.session, auction.id, '110000').expect(201);
    const flags = await request(t.http)
      .get('/api/admin/integrity/bidding')
      .set(auth(admin.session.token))
      .expect(200);
    const shared = flags.body.find(
      (f: { kind: string }) => f.kind === 'SHARED_NETWORK',
    );
    expect(shared).toMatchObject({ auctionId: auction.id });
    expect(shared.users).toHaveLength(2);
    // Read-only: nothing was changed.
    expect(await t.prisma.moderationAction.count()).toBe(0);
  });
});

describe('reports', () => {
  it('shows what was reported and records dismissals', async () => {
    const { mod, alice, auction } = await world();
    const reporter = await signedIn(t);
    const msg = (
      await request(t.http)
        .post(`/api/auctions/${auction.id}/chat`)
        .set(auth(alice.session.token))
        .send({ body: 'check my other listing' })
        .expect(201)
    ).body;
    await request(t.http)
      .post(`/api/chat/messages/${msg.id}/report`)
      .set(auth(reporter.session.token))
      .send({ reason: 'spam' })
      .expect(201);
    const queue = await request(t.http)
      .get('/api/admin/reports')
      .set(auth(mod.session.token))
      .expect(200);
    expect(queue.body[0].target).toMatchObject({
      kind: 'chat',
      body: 'check my other listing',
    });
    await request(t.http)
      .post(`/api/admin/reports/${queue.body[0].id}/decision`)
      .set(auth(mod.session.token))
      .send({ status: 'DISMISSED', resolution: 'Not spam' })
      .expect(200);
    expect(
      await t.prisma.moderationAction.count({
        where: { action: 'DISMISS_REPORT' },
      }),
    ).toBe(1);
    expect(
      await t.prisma.auditLog.count({ where: { action: 'report.decide' } }),
    ).toBe(1);
  });
});
