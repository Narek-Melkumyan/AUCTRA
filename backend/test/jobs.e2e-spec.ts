import request from 'supertest';
import { LifecycleWorker } from '../src/jobs/lifecycle.worker.js';
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

describe('lifecycle worker', () => {
  it('activates, closes and settles auctions by database time in one pass each', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const due = await createLiveAuction(t.prisma, seller.user.id, {
      status: 'SCHEDULED',
      startsAt: new Date(Date.now() - 1000),
    });
    const ended = await createLiveAuction(t.prisma, seller.user.id);
    const buyer = await signedIn(t);
    await bid(t, buyer.session, ended.id, '100000').expect(201);
    await t.prisma
      .$executeRaw`UPDATE auctions SET "endsAt" = now() - interval '1 second', "originalEndsAt" = now() - interval '1 second' WHERE id = ${ended.id}::uuid`;

    const worker = t.app.get(LifecycleWorker);
    const report = await worker.tick();
    expect(report).toMatchObject({ activated: 1, closed: 1, settled: 1 });
    expect(
      (await t.prisma.auction.findUniqueOrThrow({ where: { id: due.id } }))
        .status,
    ).toBe('LIVE');
    expect(
      (await t.prisma.auction.findUniqueOrThrow({ where: { id: ended.id } }))
        .status,
    ).toBe('SOLD');

    // Idempotent: a second pass changes nothing.
    expect(await worker.tick()).toMatchObject({
      activated: 0,
      closed: 0,
      settled: 0,
    });
    expect(await t.prisma.order.count()).toBe(1);
  });

  it('sends one ending-soon notification to watchers and never marks dev emails as delivered', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const auction = await createLiveAuction(t.prisma, seller.user.id, {
      endsAt: new Date(Date.now() + 5 * 60_000),
      originalEndsAt: new Date(Date.now() + 5 * 60_000),
    });
    const watcher = await signedIn(t);
    await request(t.http)
      .put(`/api/me/watchlist/${auction.id}`)
      .set(auth(watcher.session.token))
      .send({})
      .expect(200);
    // Opt in to ending-soon emails to exercise the email channel.
    await request(t.http)
      .put('/api/me/notifications/preferences')
      .set(auth(watcher.session.token))
      .send({
        preferences: [
          { type: 'AUCTION_ENDING_SOON', channel: 'EMAIL', enabled: true },
        ],
      })
      .expect(200);

    const worker = t.app.get(LifecycleWorker);
    await worker.tick();
    await worker.tick();
    const notes = await t.prisma.notification.findMany({
      where: { userId: watcher.user.id, type: 'AUCTION_ENDING_SOON' },
    });
    expect(notes).toHaveLength(1);
    const deliveries = await t.prisma.notificationDelivery.findMany({
      where: { notificationId: notes[0]!.id },
    });
    expect(deliveries.find((d) => d.channel === 'IN_APP')?.status).toBe('SENT');
    expect(deliveries.find((d) => d.channel === 'EMAIL')?.status).toBe(
      'SKIPPED',
    );

    const inbox = await request(t.http)
      .get('/api/me/notifications')
      .set(auth(watcher.session.token))
      .expect(200);
    expect(inbox.body.unread).toBe(1);
    await request(t.http)
      .post('/api/me/notifications/read-all')
      .set(auth(watcher.session.token))
      .expect(200);
    expect(
      (
        await request(t.http)
          .get('/api/me/notifications')
          .set(auth(watcher.session.token))
          .expect(200)
      ).body.unread,
    ).toBe(0);
  });
});

describe('seller onboarding and RBAC', () => {
  it('requires an approved application before a user can list', async () => {
    const applicant = await signedIn(t);
    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    await request(t.http)
      .post('/api/me/seller-application')
      .set(auth(applicant.session.token))
      .send({ type: 'PRIVATE' })
      .expect(201);
    await request(t.http)
      .post(`/api/admin/sellers/${applicant.user.id}/decision`)
      .set(auth(applicant.session.token))
      .send({ decision: 'approve' })
      .expect(403);
    await request(t.http)
      .post(`/api/admin/sellers/${applicant.user.id}/decision`)
      .set(auth(admin.session.token))
      .send({ decision: 'approve' })
      .expect(200);
    const me = await request(t.http)
      .get('/api/auth/me')
      .set(auth(applicant.session.token))
      .expect(200);
    expect(me.body.roles).toContain('SELLER');
    expect(me.body.permissions).toContain('auction:create');
  });

  it('only super-admins can assign roles, and admins cannot suspend admins', async () => {
    const target = await signedIn(t);
    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    const otherAdmin = await signedIn(t, {
      roles: [RoleKey.USER, RoleKey.ADMIN],
    });
    const root = await signedIn(t, {
      roles: [RoleKey.USER, RoleKey.SUPER_ADMIN],
    });
    await request(t.http)
      .post(`/api/admin/users/${target.user.id}/roles/grant`)
      .set(auth(admin.session.token))
      .send({ role: 'ADMIN' })
      .expect(403);
    await request(t.http)
      .post(`/api/admin/users/${target.user.id}/roles/grant`)
      .set(auth(root.session.token))
      .send({ role: 'SELLER' })
      .expect(200);
    await request(t.http)
      .post(`/api/admin/users/${otherAdmin.user.id}/suspend`)
      .set(auth(admin.session.token))
      .send({ reason: 'test' })
      .expect(403);

    await request(t.http)
      .post(`/api/admin/users/${target.user.id}/suspend`)
      .set(auth(admin.session.token))
      .send({ reason: 'chargeback abuse' })
      .expect(200);
    const me = await request(t.http)
      .get('/api/auth/me')
      .set(auth(target.session.token))
      .expect(200);
    expect(me.body.status).toBe('SUSPENDED');
    await request(t.http)
      .post(`/api/admin/users/${target.user.id}/suspend`)
      .set(auth(admin.session.token))
      .send({ reason: 'fraud', level: 'BANNED' })
      .expect(200);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(target.session.token))
      .expect(401);
    const audit = await request(t.http)
      .get('/api/admin/audit-logs?action=user.banned')
      .set(auth(admin.session.token))
      .expect(200);
    expect(audit.body).toHaveLength(1);
  });

  it('enforces ownership on orders, and leaves them awaiting the demo checkout', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const buyer = await signedIn(t);
    const stranger = await signedIn(t);
    const auction = await createLiveAuction(t.prisma, seller.user.id);
    await bid(t, buyer.session, auction.id, '100000').expect(201);
    await t.prisma
      .$executeRaw`UPDATE auctions SET "endsAt" = now() - interval '1 second', "originalEndsAt" = now() - interval '1 second' WHERE id = ${auction.id}::uuid`;
    await t.app.get(LifecycleWorker).tick();
    const order = await t.prisma.order.findFirstOrThrow();

    await request(t.http)
      .get(`/api/orders/${order.id}`)
      .set(auth(stranger.session.token))
      .expect(404);
    const asSeller = await request(t.http)
      .get(`/api/orders/${order.id}`)
      .set(auth(seller.session.token))
      .expect(200);
    expect(asSeller.body).toMatchObject({
      simulated: true,
      demoCompletedAt: null,
    });
    // The old real-payment endpoint no longer exists: AUCTRA has no payment provider.
    await request(t.http)
      .post(`/api/orders/${order.id}/payment-intents`)
      .set(auth(buyer.session.token))
      .expect(404);
    expect(await t.prisma.paymentIntent.count()).toBe(0);
    expect(
      (await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe('PENDING_PAYMENT');
  });
});
