import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { RoleKey } from '../src/roles/permissions.js';
import {
  EMAIL_PROVIDER,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
} from '../src/email/email.service.js';
import {
  EMAIL_MAX_ATTEMPTS,
  EmailDeliveryService,
} from '../src/notifications/email-delivery.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import {
  auth,
  bid,
  createLiveAuction,
  createTestApp,
  ORIGIN,
  PASSWORD,
  resetDb,
  signedIn,
  type TestApp,
} from './helpers.js';

/** Stand-in for Resend: returns queued results (default: accepted). */
class FakeProvider implements EmailProvider {
  readonly name = 'resend' as const;
  sent: EmailMessage[] = [];
  queue: EmailSendResult[] = [];
  async send(m: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(m);
    return (
      this.queue.shift() ?? {
        delivered: true,
        providerMessageId: `em_${this.sent.length}`,
      }
    );
  }
}

const fake = new FakeProvider();
let t: TestApp;
const sockets: Socket[] = [];

beforeAll(async () => {
  t = await createTestApp((b) =>
    b.overrideProvider(EMAIL_PROVIDER).useValue(fake),
  );
});
beforeEach(async () => {
  await resetDb(t.prisma);
  fake.sent = [];
  fake.queue = [];
});
afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});
afterAll(async () => {
  await t.close();
});

const inbox = async (token: string, q = '') =>
  (
    await request(t.http)
      .get(`/api/me/notifications${q}`)
      .set(auth(token))
      .expect(200)
  ).body as {
    items: {
      id: string;
      type: string;
      title: string;
      link: string | null;
      read: boolean;
    }[];
    unread: number;
    hasMore: boolean;
  };

async function emailRows(userId: string) {
  return t.prisma.notificationDelivery.findMany({
    where: { channel: 'EMAIL', notification: { userId } },
    include: { notification: true },
    orderBy: { createdAt: 'asc' },
  });
}

describe('in-app notifications', () => {
  it('notifies the seller of new bids and the previous leader of being outbid, pushed in real time', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id);
    const alice = await signedIn(t);
    const bob = await signedIn(t);

    const s = io(t.url, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token: alice.session.token },
      reconnection: false,
    });
    sockets.push(s);
    await new Promise((r) => s.once('auth:ok', r));
    const pushed = new Promise<{ type: string; link: string }>((resolve) =>
      s.on('notification', (n: { type: string; link: string }) => {
        if (n.type === 'OUTBID') resolve(n);
      }),
    );

    await bid(t, alice.session, a.id, '100000').expect(201);
    await bid(t, bob.session, a.id, '110000').expect(201);

    expect(await pushed).toMatchObject({
      type: 'OUTBID',
      link: `/room/${a.id}`,
    });
    const sellerBox = await inbox(seller.session.token);
    expect(sellerBox.items.filter((n) => n.type === 'NEW_BID')).toHaveLength(2);
    expect(sellerBox.unread).toBe(2);
    const aliceBox = await inbox(alice.session.token);
    expect(aliceBox.items.map((n) => n.type)).toEqual(['OUTBID']);

    // History paging and type filter.
    const page1 = await inbox(seller.session.token, '?limit=1');
    expect(page1.hasMore).toBe(true);
    const page2 = await inbox(
      seller.session.token,
      `?limit=1&before=${encodeURIComponent(
        (
          await t.prisma.notification.findUniqueOrThrow({
            where: { id: page1.items[0]!.id },
          })
        ).createdAt.toISOString(),
      )}`,
    );
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    expect(
      (await inbox(seller.session.token, '?types=OUTBID')).items,
    ).toHaveLength(0);

    await request(t.http)
      .post(`/api/me/notifications/${sellerBox.items[0]!.id}/read`)
      .set(auth(seller.session.token))
      .expect(204);
    expect((await inbox(seller.session.token)).unread).toBe(1);
    // Other users cannot touch my notifications.
    await request(t.http)
      .post(`/api/me/notifications/${sellerBox.items[1]!.id}/read`)
      .set(auth(bob.session.token))
      .expect(404);
  });

  it('notifies the seller of chat activity at most once per 15 minutes per room', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const a = await createLiveAuction(t.prisma, seller.user.id);
    const u = await signedIn(t);
    for (const body of ['Is it original?', 'And the box?'])
      await request(t.http)
        .post(`/api/auctions/${a.id}/chat`)
        .set(auth(u.session.token))
        .send({ body })
        .expect(201);
    const box = await inbox(seller.session.token);
    expect(box.items.filter((n) => n.type === 'CHAT_MESSAGE')).toHaveLength(1);
  });

  it('alerts on sign-ins from new devices only, and never lets security alerts be disabled', async () => {
    const u = await signedIn(t); // first session (helper login)
    const login = async (ua: string) => {
      const agent = request.agent(t.http);
      const csrf = (await agent.get('/api/auth/csrf')).body.csrfToken as string;
      return agent
        .post('/api/auth/login')
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrf)
        .set('User-Agent', ua)
        .send({ email: u.user.email, password: PASSWORD })
        .expect(200);
    };
    const firefox =
      'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';
    await login(firefox);
    await login(firefox);
    const alerts = (await inbox(u.session.token)).items.filter(
      (n) => n.type === 'ACCOUNT_SECURITY',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toBe('New sign-in to your account');
    expect(alerts[0]!.link).toBe('/settings');
    // The security alert gets an email delivery even though it can't be switched off.
    expect((await emailRows(u.user.id)).length).toBe(1);

    const prefs = await request(t.http)
      .put('/api/me/notifications/preferences')
      .set(auth(u.session.token))
      .send({
        preferences: [
          { type: 'ACCOUNT_SECURITY', channel: 'EMAIL', enabled: false },
        ],
      })
      .expect(200);
    expect(
      prefs.body.find(
        (p: { type: string; channel: string }) =>
          p.type === 'ACCOUNT_SECURITY' && p.channel === 'EMAIL',
      ),
    ).toMatchObject({ enabled: true, locked: true });
  });

  it('records verification in-app without sending an email about it', async () => {
    const u = await signedIn(t, { verified: false });
    await t.app.get(NotificationsService).notifyNow([
      {
        userId: u.user.id,
        type: 'ACCOUNT_SECURITY',
        title: 'Email address verified',
        body: 'ok',
        email: false,
        dedupeKey: 'email-verified',
      },
    ]);
    expect((await inbox(u.session.token)).items).toHaveLength(1);
    expect(await emailRows(u.user.id)).toHaveLength(0);
  });
});

describe('email delivery (Resend semantics)', () => {
  async function pendingEmail(opts: { verified?: boolean } = {}) {
    const u = await signedIn(t, { verified: opts.verified ?? true });
    await t.app.get(NotificationsService).notifyNow([
      {
        userId: u.user.id,
        type: 'AUCTION_WON',
        title: 'You won!',
        body: 'Congratulations.',
        dedupeKey: `won:${u.user.id}`,
      },
    ]);
    return u;
  }
  const worker = () => t.app.get(EmailDeliveryService);

  it('marks SENT only when the provider accepts, with the provider id', async () => {
    const u = await pendingEmail();
    const r = await worker().deliverDue();
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    const [row] = await emailRows(u.user.id);
    expect(row).toMatchObject({
      status: 'SENT',
      attempts: 1,
      providerMessageId: 'em_1',
    });
    expect(fake.sent[0]!.html).toContain('You won!');
    expect(fake.sent[0]!.idempotencyKey).toBe(`notification/${row!.id}`);
  });

  it('retries transient failures with back-off, then gives up as FAILED — never SENT', async () => {
    const u = await pendingEmail();
    for (let i = 1; i <= EMAIL_MAX_ATTEMPTS; i++) {
      fake.queue.push({
        delivered: false,
        reason: 'resend:rate_limit_exceeded',
        retryable: true,
      });
      await t.prisma.notificationDelivery.updateMany({
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await worker().deliverDue();
      const [row] = await emailRows(u.user.id);
      if (i < EMAIL_MAX_ATTEMPTS) {
        expect(row).toMatchObject({ status: 'PENDING', attempts: i });
        expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        // Not due yet: a second pass does not resend.
        expect((await worker().deliverDue()).claimed).toBe(0);
      } else {
        expect(row).toMatchObject({ status: 'FAILED', attempts: i });
        expect(row!.lastError).toBe('resend:rate_limit_exceeded');
        expect(row!.sentAt).toBeNull();
      }
    }
  });

  it('fails permanently on a validation error and lets an admin requeue it', async () => {
    const u = await pendingEmail();
    fake.queue.push({
      delivered: false,
      reason: 'resend:validation_error',
      retryable: false,
    });
    await worker().deliverDue();
    const [row] = await emailRows(u.user.id);
    expect(row!.status).toBe('FAILED');

    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    const failed = await request(t.http)
      .get('/api/admin/notifications/deliveries?status=FAILED')
      .set(auth(admin.session.token))
      .expect(200);
    expect(failed.body.items).toHaveLength(1);
    expect(failed.body.items[0]).toMatchObject({
      lastError: 'resend:validation_error',
    });
    await request(t.http)
      .post(`/api/admin/notifications/deliveries/${row!.id}/retry`)
      .set(auth(admin.session.token))
      .expect(200);
    await worker().deliverDue();
    expect((await emailRows(u.user.id))[0]!.status).toBe('SENT');
    expect(
      await t.prisma.auditLog.count({
        where: { action: 'notification.delivery_retry' },
      }),
    ).toBe(1);
  });

  it('skips unverified addresses and notifications already read in the app', async () => {
    const unverified = await pendingEmail({ verified: false });
    const reader = await pendingEmail();
    await t.prisma.notification.updateMany({
      where: { userId: reader.user.id },
      data: { readAt: new Date() },
    });
    await worker().deliverDue();
    expect((await emailRows(unverified.user.id))[0]).toMatchObject({
      status: 'SKIPPED',
      lastError: 'email not verified',
    });
    expect((await emailRows(reader.user.id))[0]).toMatchObject({
      status: 'SKIPPED',
      lastError: 'already read in app',
    });
    expect(fake.sent).toHaveLength(0);
  });

  it('uses the security template for account alerts', async () => {
    const u = await signedIn(t);
    await t.app.get(NotificationsService).notifyNow([
      {
        userId: u.user.id,
        type: 'ACCOUNT_SECURITY',
        title: 'Your password was changed',
        body: 'Details',
        dedupeKey: 'pw',
      },
    ]);
    await worker().deliverDue();
    expect(fake.sent[0]!.subject).toBe(
      'AUCTRA security alert: Your password was changed',
    );
    expect(fake.sent[0]!.template).toBe('security-alert');
  });
});

describe('announcements', () => {
  it('broadcasts to the chosen audience with per-recipient tracking; admins only', async () => {
    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const buyer = await signedIn(t);
    await request(t.http)
      .post('/api/admin/notifications/announcements')
      .set(auth(buyer.session.token))
      .send({ title: 'Hello', body: 'World' })
      .expect(403);

    const all = await request(t.http)
      .post('/api/admin/notifications/announcements')
      .set(auth(admin.session.token))
      .send({
        title: 'Maintenance tonight',
        body: 'Bidding pauses 02:00–02:15 UTC.',
        link: '/live',
      })
      .expect(201);
    expect(all.body.recipientCount).toBe(3);
    expect(all.body.deliveries).toEqual([
      { channel: 'IN_APP', status: 'SENT', count: 3 },
    ]);
    const note = (await inbox(buyer.session.token)).items[0]!;
    expect(note).toMatchObject({ type: 'ANNOUNCEMENT', link: '/live' });

    const sellersOnly = await request(t.http)
      .post('/api/admin/notifications/announcements')
      .set(auth(admin.session.token))
      .send({
        title: 'Seller fees',
        body: 'Fees stay at 0% in the demo.',
        audience: 'SELLERS',
        sendEmail: true,
      })
      .expect(201);
    expect(sellersOnly.body.recipientCount).toBe(1);
    expect((await emailRows(seller.user.id)).length).toBe(1);
    expect((await inbox(buyer.session.token)).items).toHaveLength(1);

    const history = await request(t.http)
      .get('/api/admin/notifications/announcements')
      .set(auth(admin.session.token))
      .expect(200);
    expect(history.body.map((a: { title: string }) => a.title)).toEqual([
      'Seller fees',
      'Maintenance tonight',
    ]);
    expect(
      await t.prisma.auditLog.count({
        where: { action: 'notification.announcement_sent' },
      }),
    ).toBe(2);
  });
});
