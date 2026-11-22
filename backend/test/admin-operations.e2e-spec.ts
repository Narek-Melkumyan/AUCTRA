import request from 'supertest';
import { RoleKey } from '../src/roles/permissions.js';
import { LifecycleWorker } from '../src/jobs/lifecycle.worker.js';
import { AiToolsService } from '../src/ai/ai-tools.js';
import { Permission } from '../src/roles/permissions.js';
import {
  ORIGIN,
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

const superAdmin = () =>
  signedIn(t, { roles: [RoleKey.USER, RoleKey.SUPER_ADMIN] });
const admin = () => signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });

async function soldOrder() {
  const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
  const winner = await signedIn(t);
  const auction = await createLiveAuction(t.prisma, seller.user.id);
  await bid(t, winner.session, auction.id, '120000').expect(201);
  await t.prisma
    .$executeRaw`UPDATE auctions SET "endsAt" = now() - interval '1 second', "originalEndsAt" = now() - interval '1 second' WHERE id = ${auction.id}::uuid`;
  await t.app.get(LifecycleWorker).tick();
  const order = await t.prisma.order.findFirstOrThrow({
    where: { auctionId: auction.id },
  });
  return { seller, winner, auction, order };
}

async function openDispute(token: string, orderId: string) {
  return request(t.http)
    .post(`/api/orders/${orderId}/disputes`)
    .set(auth(token))
    .send({ reason: 'not_as_described', details: 'Scratches not disclosed.' })
    .expect(201);
}

describe('admin operations: authorization', () => {
  it('ordinary users, sellers and moderators are denied; admins and super admins allowed', async () => {
    const user = await signedIn(t);
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const moderator = await signedIn(t, {
      roles: [RoleKey.USER, RoleKey.MODERATOR],
    });
    const paths = [
      '/api/admin/categories',
      '/api/admin/orders',
      '/api/admin/disputes',
    ];
    for (const p of paths) {
      await request(t.http).get(p).expect(401);
      for (const s of [user, seller, moderator])
        await request(t.http).get(p).set(auth(s.session.token)).expect(403);
    }
    await request(t.http)
      .post('/api/admin/categories')
      .set(auth(user.session.token))
      .send({ slug: 'boats', name: 'Boats' })
      .expect(403);
    for (const s of [await admin(), await superAdmin()])
      for (const p of paths)
        await request(t.http).get(p).set(auth(s.session.token)).expect(200);
  });
});

describe('category management', () => {
  it('creates categories and subcategories, renames and hides them, with an audit trail', async () => {
    const { user, session } = await superAdmin();
    await request(t.http)
      .post('/api/admin/categories')
      .set(auth(session.token))
      .send({
        slug: 'boats',
        name: 'Boats',
        description: 'Yachts and dayboats',
      })
      .expect(201);
    await request(t.http)
      .post('/api/admin/categories')
      .set(auth(session.token))
      .send({ slug: 'boats-sail', name: 'Sailing yachts', parentSlug: 'boats' })
      .expect(201);
    const dup = await request(t.http)
      .post('/api/admin/categories')
      .set(auth(session.token))
      .send({ slug: 'boats', name: 'Again' })
      .expect(409);
    expect(dup.body.code).toBe('CATEGORY_EXISTS');
    await request(t.http)
      .post('/api/admin/categories')
      .set(auth(session.token))
      .send({ slug: 'bad', name: 'Nested too deep', parentSlug: 'boats-sail' })
      .expect(422);
    await request(t.http)
      .post('/api/admin/categories')
      .set(auth(session.token))
      .send({ slug: 'Not A Slug', name: 'x' })
      .expect(400);

    // Public tree shows the new category; hiding removes it.
    let pub = await request(t.http).get('/api/categories').expect(200);
    const boats = pub.body.find((c: { slug: string }) => c.slug === 'boats');
    expect(boats.subcategories.map((s: { slug: string }) => s.slug)).toEqual([
      'boats-sail',
    ]);
    await request(t.http)
      .patch('/api/admin/categories/boats')
      .set(auth(session.token))
      .send({ name: 'Boats & yachts', isActive: false })
      .expect(200);
    pub = await request(t.http).get('/api/categories').expect(200);
    expect(pub.body.some((c: { slug: string }) => c.slug === 'boats')).toBe(
      false,
    );
    const all = await request(t.http)
      .get('/api/admin/categories')
      .set(auth(session.token))
      .expect(200);
    expect(
      all.body.find((c: { slug: string }) => c.slug === 'boats'),
    ).toMatchObject({ name: 'Boats & yachts', isActive: false });
    await request(t.http)
      .patch('/api/admin/categories/missing')
      .set(auth(session.token))
      .send({ name: 'x y' })
      .expect(404);
    const logs = await t.prisma.auditLog.findMany({
      where: { actorId: user.id, action: { startsWith: 'category.' } },
    });
    expect(logs.map((l) => l.action).sort()).toEqual([
      'category.create',
      'category.create',
      'category.update',
    ]);
  });

  it('refuses to hide a category that open listings still use', async () => {
    const { session } = await superAdmin();
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const auction = await createLiveAuction(t.prisma, seller.user.id);
    const cat = await t.prisma.category.findUniqueOrThrow({
      where: { id: auction.categoryId },
    });
    const res = await request(t.http)
      .patch(`/api/admin/categories/${cat.slug}`)
      .set(auth(session.token))
      .send({ isActive: false })
      .expect(409);
    expect(res.body.code).toBe('CATEGORY_IN_USE');
    const list = await request(t.http)
      .get('/api/admin/categories')
      .set(auth(session.token))
      .expect(200);
    expect(
      list.body.find((c: { slug: string }) => c.slug === cat.slug)
        .openAuctionCount,
    ).toBe(1);
  });
});

describe('orders and disputes', () => {
  it('a demo-completed order can be disputed, and only one active dispute is allowed', async () => {
    const { session } = await admin();
    const { order, winner } = await soldOrder();
    await request(t.http)
      .post(`/api/orders/${order.id}/demo-checkout`)
      .set(auth(winner.session.token))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ delivery: 'PICKUP' })
      .expect((r) => expect([200, 201]).toContain(r.status));
    expect(
      (await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe('COMPLETED');
    // Two buyers' tabs racing: exactly one dispute is created.
    const results = await Promise.all(
      [1, 2].map(() =>
        request(t.http)
          .post(`/api/orders/${order.id}/disputes`)
          .set(auth(winner.session.token))
          .send({ reason: 'not_as_described' }),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(await t.prisma.dispute.count({ where: { orderId: order.id } })).toBe(
      1,
    );
    const o = await t.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(o.status).toBe('DISPUTED');
    expect(o.paidAt).toBeNull();
    const d = await t.prisma.dispute.findFirstOrThrow({
      where: { orderId: order.id },
    });
    await request(t.http)
      .post(`/api/admin/disputes/${d.id}/decision`)
      .set(auth(session.token))
      .send({
        status: 'RESOLVED_SELLER',
        resolution: 'Matches the listing photos.',
      })
      .expect(200)
      .expect((r) => expect(r.body.orderStatus).toBe('COMPLETED'));
  });

  it('lists every order with parties, totals and status counts', async () => {
    const { session } = await admin();
    const { order, winner, seller } = await soldOrder();
    const res = await request(t.http)
      .get('/api/admin/orders')
      .set(auth(session.token))
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.counts).toEqual({ PENDING_PAYMENT: 1 });
    expect(res.body.items[0]).toMatchObject({
      orderNumber: order.orderNumber,
      status: 'PENDING_PAYMENT',
      buyer: { id: winner.user.id },
      seller: { id: seller.user.id },
      hammerPrice: { minor: '120000', currency: 'USD' },
      openDisputes: 0,
    });
    await request(t.http)
      .get('/api/admin/orders?status=COMPLETED')
      .set(auth(session.token))
      .expect(200)
      .expect((r) => expect(r.body.items).toHaveLength(0));
    await request(t.http)
      .get('/api/admin/orders?status=BOGUS')
      .set(auth(session.token))
      .expect(400);
  });

  it('reviews and resolves a dispute; both parties are notified and the order leaves DISPUTED', async () => {
    const { session, user } = await superAdmin();
    const { order, winner, seller } = await soldOrder();
    await openDispute(winner.session.token, order.id);
    expect(
      (await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe('DISPUTED');

    const list = await request(t.http)
      .get('/api/admin/disputes?status=OPEN')
      .set(auth(session.token))
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    const d = list.body.items[0];
    expect(d).toMatchObject({
      status: 'OPEN',
      openedByRole: 'buyer',
      order: { orderNumber: order.orderNumber, status: 'DISPUTED' },
    });

    await request(t.http)
      .post(`/api/admin/disputes/${d.id}/decision`)
      .set(auth(session.token))
      .send({ status: 'UNDER_REVIEW' })
      .expect(200);
    const noReason = await request(t.http)
      .post(`/api/admin/disputes/${d.id}/decision`)
      .set(auth(session.token))
      .send({ status: 'RESOLVED_BUYER' })
      .expect(400);
    expect(noReason.body.code).toBe('RESOLUTION_REQUIRED');
    const done = await request(t.http)
      .post(`/api/admin/disputes/${d.id}/decision`)
      .set(auth(session.token))
      .send({
        status: 'RESOLVED_BUYER',
        resolution: 'Seller did not disclose the damage; order cancelled.',
      })
      .expect(200);
    expect(done.body).toMatchObject({
      status: 'RESOLVED_BUYER',
      orderStatus: 'CANCELLED',
    });
    const again = await request(t.http)
      .post(`/api/admin/disputes/${d.id}/decision`)
      .set(auth(session.token))
      .send({ status: 'CLOSED', resolution: 'again' })
      .expect(409);
    expect(again.body.code).toBe('DISPUTE_CLOSED');

    const row = await t.prisma.dispute.findUniqueOrThrow({
      where: { id: d.id },
    });
    expect(row).toMatchObject({
      handledById: user.id,
      status: 'RESOLVED_BUYER',
    });
    expect(row.resolvedAt).not.toBeNull();
    const notes = await t.prisma.notification.findMany({
      where: { type: 'ORDER_UPDATE', title: { startsWith: 'Dispute' } },
    });
    expect(notes.map((n) => n.userId).sort()).toEqual(
      [winner.user.id, seller.user.id].sort(),
    );
    expect(
      await t.prisma.auditLog.count({ where: { action: 'dispute.decide' } }),
    ).toBe(2);
  });

  it('a dispute closed in the seller’s favour returns the order to its prior state', async () => {
    const { session } = await admin();
    const { order, winner } = await soldOrder();
    await openDispute(winner.session.token, order.id);
    const d = await t.prisma.dispute.findFirstOrThrow();
    await request(t.http)
      .post(`/api/admin/disputes/${d.id}/decision`)
      .set(auth(session.token))
      .set('Origin', ORIGIN)
      .send({
        status: 'RESOLVED_SELLER',
        resolution: 'Condition matched the listing photos.',
      })
      .expect(200)
      .expect((r) => expect(r.body.orderStatus).toBe('PENDING_PAYMENT'));
  });
});

describe('admin assistant moderation summary', () => {
  it('includes open disputes and the review queue size', async () => {
    const { order, winner } = await soldOrder();
    await openDispute(winner.session.token, order.id);
    const auth = {
      userId: winner.user.id,
      sessionId: 'x',
      email: 'staff@example.com',
      emailVerified: true,
      status: 'ACTIVE' as const,
      suspendedUntil: null,
      roles: ['ADMIN'],
      permissions: new Set<string>([Permission.AI_ADMIN]),
    };
    const res = await t.app
      .get(AiToolsService)
      .execute('ADMIN', 'summarize_moderation', '{}', auth);
    const out = res.output as {
      open_disputes: { order_number: string; status: string }[];
      listings_awaiting_review: number;
    };
    expect(out.open_disputes).toEqual([
      expect.objectContaining({
        order_number: order.orderNumber,
        status: 'OPEN',
      }),
    ]);
    expect(out.listings_awaiting_review).toBe(0);
  });
});
