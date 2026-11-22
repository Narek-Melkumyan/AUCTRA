import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { RoleKey } from '../src/roles/permissions.js';
import { LifecycleWorker } from '../src/jobs/lifecycle.worker.js';
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

async function soldAuction(opts: { reserve?: bigint } = {}) {
  const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
  const winner = await signedIn(t);
  const loser = await signedIn(t);
  const auction = await createLiveAuction(t.prisma, seller.user.id, {
    ...(opts.reserve ? { reservePriceCents: opts.reserve } : {}),
  });
  await bid(t, loser.session, auction.id, '100000').expect(201);
  await bid(t, winner.session, auction.id, '120000').expect(201);
  await t.prisma
    .$executeRaw`UPDATE auctions SET "endsAt" = now() - interval '1 second', "originalEndsAt" = now() - interval '1 second' WHERE id = ${auction.id}::uuid`;
  await t.app.get(LifecycleWorker).tick();
  return { seller, winner, loser, auction };
}

const complete = (
  token: string,
  orderId: string,
  body: object,
  key: string | null = randomUUID(),
) => {
  const r = request(t.http)
    .post(`/api/orders/${orderId}/demo-checkout`)
    .set(auth(token));
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};

describe('demo checkout', () => {
  it('lets only the winning bidder open checkout', async () => {
    const { seller, winner, loser, auction } = await soldAuction();
    const ok = await request(t.http)
      .get(`/api/checkout/${auction.id}`)
      .set(auth(winner.session.token))
      .expect(200);
    expect(ok.body).toMatchObject({
      simulated: true,
      completed: false,
      status: 'PENDING_PAYMENT',
      hammerPrice: { minor: '120000', currency: 'USD' },
      total: { minor: '120000' },
    });
    expect(ok.body.deliveryOptions.map((o: { key: string }) => o.key)).toEqual([
      'PICKUP',
      'INSURED_SHIPPING',
      'WHITE_GLOVE',
    ]);
    for (const u of [loser, seller]) {
      const r = await request(t.http)
        .get(`/api/checkout/${auction.id}`)
        .set(auth(u.session.token))
        .expect(403);
      expect(r.body.code).toBe('NOT_THE_WINNER');
    }
  });

  it('refuses checkout for unsold lots', async () => {
    const { winner, auction } = await soldAuction({ reserve: 500000n });
    const r = await request(t.http)
      .get(`/api/checkout/${auction.id}`)
      .set(auth(winner.session.token))
      .expect(409);
    expect(r.body.code).toBe('CHECKOUT_NOT_AVAILABLE');
    expect(await t.prisma.order.count()).toBe(0);
  });

  it('records a simulated order — never a real payment', async () => {
    const { winner, seller, auction } = await soldAuction();
    const order = await t.prisma.order.findUniqueOrThrow({
      where: { auctionId: auction.id },
    });
    await complete(
      winner.session.token,
      order.id,
      { delivery: 'PICKUP' },
      null,
    ).expect(400);
    const noAddress = await complete(winner.session.token, order.id, {
      delivery: 'INSURED_SHIPPING',
    }).expect(422);
    expect(noAddress.body.code).toBe('ADDRESS_REQUIRED');
    await complete(winner.session.token, order.id, {
      delivery: 'INSURED_SHIPPING',
      address: {
        fullName: 'A B',
        line1: '1 Main St',
        city: 'Yerevan',
        postalCode: '0010',
        country: 'xx1',
      },
    }).expect(400);

    const res = await complete(winner.session.token, order.id, {
      delivery: 'INSURED_SHIPPING',
      address: {
        fullName: 'Ada Lovelace',
        line1: '1 Main St',
        city: 'London',
        postalCode: 'N1 9GU',
        country: 'gb',
      },
    }).expect(201);
    expect(res.body.replayed).toBe(false);
    expect(res.body.order).toMatchObject({
      status: 'COMPLETED',
      simulated: true,
      paidAt: null,
      shipping: { minor: '24000' },
      total: { minor: '144000' },
      fulfillmentMethod: 'SHIPPING',
    });
    expect(res.body.order.demoCompletedAt).not.toBeNull();

    const intents = await t.prisma.paymentIntent.findMany();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      provider: 'DEMO',
      simulated: true,
      status: 'SUCCEEDED',
      amountCents: 144000n,
    });
    const txs = await t.prisma.transaction.findMany();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      provider: 'DEMO',
      simulated: true,
      type: 'CHARGE',
    });
    const stored = await t.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.shippingAddress).toMatchObject({
      country: 'GB',
      city: 'London',
    });
    expect(JSON.stringify(stored.shippingAddress)).not.toMatch(
      /card|cvv|iban/i,
    );

    expect(
      await t.prisma.notification.count({
        where: { userId: winner.user.id, type: 'ORDER_UPDATE' },
      }),
    ).toBe(1);
    expect(
      await t.prisma.notification.count({
        where: { userId: seller.user.id, type: 'ORDER_UPDATE' },
      }),
    ).toBe(1);
    expect(
      await t.prisma.auditLog.count({
        where: { action: 'order.demo_checkout_completed' },
      }),
    ).toBe(1);

    const history = await request(t.http)
      .get('/api/me/orders')
      .set(auth(winner.session.token))
      .expect(200);
    expect(history.body[0]).toMatchObject({
      status: 'COMPLETED',
      role: 'buyer',
      simulated: true,
    });
  });

  it('prevents duplicate orders and payments, even under concurrent retries', async () => {
    const { winner, loser, seller, auction } = await soldAuction();
    const order = await t.prisma.order.findUniqueOrThrow({
      where: { auctionId: auction.id },
    });
    for (const u of [loser, seller]) {
      const r = await complete(u.session.token, order.id, {
        delivery: 'PICKUP',
      }).expect(403);
      expect(r.body.code).toBe('NOT_THE_WINNER');
    }
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        complete(winner.session.token, order.id, { delivery: 'PICKUP' }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.every((r) => r.body.order.status === 'COMPLETED')).toBe(
      true,
    );
    expect(await t.prisma.paymentIntent.count()).toBe(1);
    expect(await t.prisma.transaction.count()).toBe(1);
    expect(await t.prisma.order.count()).toBe(1);
    // A later retry with a different delivery choice does not change the completed order.
    const again = await complete(winner.session.token, order.id, {
      delivery: 'WHITE_GLOVE',
      address: {
        fullName: 'X Y',
        line1: '2 High St',
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
      },
    }).expect(200);
    expect(again.body.order.shipping.minor).toBe('0');
  });

  it('enforces at the database level that DEMO rows are flagged simulated', async () => {
    const { auction } = await soldAuction();
    const order = await t.prisma.order.findUniqueOrThrow({
      where: { auctionId: auction.id },
    });
    await expect(
      t.prisma.paymentIntent.create({
        data: {
          orderId: order.id,
          provider: 'DEMO',
          simulated: false,
          amountCents: 1n,
          currency: 'USD',
          idempotencyKey: 'x',
        },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.order.update({
        where: { id: order.id },
        data: { demoCompletedAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});
