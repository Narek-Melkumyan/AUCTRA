import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { RoleKey } from '../src/roles/permissions.js';
import { CHAT_LIMITS } from '../src/chat/chat.service.js';
import {
  auth,
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

function connect(token?: string): Promise<Socket> {
  const s = io(t.url, {
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

async function room() {
  const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
  const auction = await createLiveAuction(t.prisma, seller.user.id);
  return { seller, auction };
}

const say = (token: string, auctionId: string, body: string, extra = {}) =>
  request(t.http)
    .post(`/api/auctions/${auctionId}/chat`)
    .set(auth(token))
    .send({ body, ...extra });

describe('auction chat', () => {
  it('persists messages, broadcasts them to the room after commit and pages history', async () => {
    const { auction, seller } = await room();
    const alice = await signedIn(t);
    const viewer = await connect();
    await viewer.emitWithAck('auction:join', { auctionId: auction.id });
    const delivered = nextEvent<{
      body: string;
      seq: string;
      author: { handle: string };
    }>(viewer, 'chat:message');

    const sent = await say(
      alice.session.token,
      auction.id,
      '  Hello room!  ',
    ).expect(201);
    expect(sent.body).toMatchObject({
      body: 'Hello room!',
      status: 'VISIBLE',
      mine: true,
      author: { isSeller: false, isStaff: false },
    });
    const evt = await delivered;
    expect(evt.body).toBe('Hello room!');
    expect(evt.seq).toBe(sent.body.seq);
    expect(evt).not.toHaveProperty('authorId');

    await say(
      seller.session.token,
      auction.id,
      'Welcome, ask me anything',
    ).expect(201);
    for (let i = 0; i < 3; i++)
      await t.prisma.auctionChatMessage.create({
        data: {
          auctionId: auction.id,
          authorId: alice.user.id,
          body: `old ${i}`,
        },
      });

    const anon = await request(t.http)
      .get(`/api/auctions/${auction.id}/chat?limit=2`)
      .expect(200);
    expect(anon.body.messages).toHaveLength(2);
    expect(anon.body.hasMore).toBe(true);
    expect(anon.body.viewer).toMatchObject({
      canPost: false,
      reason: 'SIGN_IN_REQUIRED',
    });
    const older = await request(t.http)
      .get(
        `/api/auctions/${auction.id}/chat?before=${anon.body.messages[0].seq}`,
      )
      .expect(200);
    expect(older.body.messages.map((m: { body: string }) => m.body)).toEqual([
      'Hello room!',
      'Welcome, ask me anything',
      'old 0',
    ]);
    expect(older.body.messages[1].author.isSeller).toBe(true);
    // Missed-message sync after a reconnect.
    const missed = await request(t.http)
      .get(`/api/auctions/${auction.id}/chat?after=${sent.body.seq}`)
      .expect(200);
    expect(missed.body.messages).toHaveLength(4);
  });

  it('stores text verbatim (no HTML interpretation) and strips control characters', async () => {
    const { auction } = await room();
    const u = await signedIn(t);
    const res = await say(
      u.session.token,
      auction.id,
      '<img src=x onerror=alert(1)>\u0000​ ok\n\n\n\nbye',
    ).expect(201);
    expect(res.body.body).toBe('<img src=x onerror=alert(1)> ok\n\nbye');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    await say(u.session.token, auction.id, '   ​ ').expect(400);
    await say(u.session.token, auction.id, 'x'.repeat(501)).expect(400);
    await say(
      u.session.token,
      auction.id,
      'https://a.test https://b.test https://c.test',
    ).expect(422);
  });

  it('enforces who may post', async () => {
    const { auction } = await room();
    await request(t.http)
      .post(`/api/auctions/${auction.id}/chat`)
      .send({ body: 'hi' })
      .expect(401);
    const unverified = await signedIn(t, { verified: false });
    const r1 = await say(unverified.session.token, auction.id, 'hi').expect(
      403,
    );
    expect(r1.body.code).toBe('EMAIL_NOT_VERIFIED');
    const suspended = await signedIn(t, { status: 'SUSPENDED' });
    const r2 = await say(suspended.session.token, auction.id, 'hi').expect(403);
    expect(r2.body.code).toBe('ACCOUNT_RESTRICTED');

    const ok = await signedIn(t);
    const seller2 = await signedIn(t, {
      roles: [RoleKey.USER, RoleKey.SELLER],
    });
    const ended = await createLiveAuction(t.prisma, seller2.user.id, {
      status: 'ENDED',
    });
    const r3 = await say(ok.session.token, ended.id, 'gg').expect(422);
    expect(r3.body.code).toBe('CHAT_CLOSED');
    const draft = await createLiveAuction(t.prisma, seller2.user.id, {
      status: 'DRAFT',
    });
    await say(ok.session.token, draft.id, 'peek').expect(404);
    await request(t.http).get(`/api/auctions/${draft.id}/chat`).expect(404);
  });

  it('limits bursts and duplicates, and stores a retried send once', async () => {
    const { auction } = await room();
    const u = await signedIn(t);
    const first = await say(u.session.token, auction.id, 'hello', {
      clientMessageId: 'client-msg-0001',
    }).expect(201);
    const replay = await say(u.session.token, auction.id, 'hello', {
      clientMessageId: 'client-msg-0001',
    }).expect(200);
    expect(replay.body.id).toBe(first.body.id);
    const dup = await say(u.session.token, auction.id, 'HELLO').expect(409);
    expect(dup.body.code).toBe('DUPLICATE_MESSAGE');

    const results = await Promise.all(
      Array.from({ length: CHAT_LIMITS.burst.count + 2 }, (_, i) =>
        say(u.session.token, auction.id, `burst ${i}`),
      ),
    );
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(CHAT_LIMITS.burst.count - 1);
    expect(results.some((r) => r.status === 429)).toBe(true);
    expect(
      await t.prisma.auctionChatMessage.count({
        where: { authorId: u.user.id },
      }),
    ).toBe(CHAT_LIMITS.burst.count);
  });
});

describe('chat moderation', () => {
  it('hides, deletes and restores messages; only moderators see hidden content', async () => {
    const { auction } = await room();
    const author = await signedIn(t);
    const other = await signedIn(t);
    const mod = await signedIn(t, { roles: [RoleKey.USER, RoleKey.MODERATOR] });
    const msg = (
      await say(author.session.token, auction.id, 'buy my scam').expect(201)
    ).body;

    await request(t.http)
      .post(`/api/admin/chat/messages/${msg.id}/hide`)
      .set(auth(other.session.token))
      .send({})
      .expect(403);

    const viewer = await connect();
    await viewer.emitWithAck('auction:join', { auctionId: auction.id });
    const update = nextEvent<{
      id: string;
      status: string;
      body: string | null;
    }>(viewer, 'chat:update');
    const hidden = await request(t.http)
      .post(`/api/admin/chat/messages/${msg.id}/hide`)
      .set(auth(mod.session.token))
      .send({ reason: 'spam' })
      .expect(200);
    expect(hidden.body).toMatchObject({
      status: 'HIDDEN',
      body: 'buy my scam',
    });
    expect(await update).toMatchObject({
      id: msg.id,
      status: 'HIDDEN',
      body: null,
    });

    const asUser = await request(t.http)
      .get(`/api/auctions/${auction.id}/chat`)
      .set(auth(other.session.token))
      .expect(200);
    expect(asUser.body.messages).toHaveLength(0);
    const asMod = await request(t.http)
      .get(`/api/auctions/${auction.id}/chat`)
      .set(auth(mod.session.token))
      .expect(200);
    expect(asMod.body.messages[0]).toMatchObject({
      status: 'HIDDEN',
      moderation: { reason: 'spam' },
    });
    expect(asMod.body.viewer.isModerator).toBe(true);

    await request(t.http)
      .post(`/api/admin/chat/messages/${msg.id}/restore`)
      .set(auth(mod.session.token))
      .send({})
      .expect(200);
    await request(t.http)
      .post(`/api/admin/chat/messages/${msg.id}/delete`)
      .set(auth(mod.session.token))
      .send({ reason: 'policy' })
      .expect(200);

    const log = await request(t.http)
      .get('/api/admin/chat/moderation-log')
      .set(auth(mod.session.token))
      .expect(200);
    expect(log.body.map((l: { action: string }) => l.action)).toEqual([
      'DELETE_MESSAGE',
      'RESTORE_MESSAGE',
      'HIDE_MESSAGE',
    ]);
    expect(
      await t.prisma.auditLog.count({
        where: { action: { startsWith: 'chat.message_' } },
      }),
    ).toBe(3);
  });

  it('mutes temporarily, bans permanently, and lifts restrictions', async () => {
    const { auction } = await room();
    const u = await signedIn(t);
    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    await say(u.session.token, auction.id, 'first').expect(201);

    const mute = await request(t.http)
      .post('/api/admin/chat/restrictions')
      .set(auth(admin.session.token))
      .send({
        userId: u.user.id,
        type: 'MUTE',
        minutes: 10,
        reason: 'cool off',
      })
      .expect(201);
    const muted = await say(u.session.token, auction.id, 'still here?').expect(
      403,
    );
    expect(muted.body.code).toBe('CHAT_MUTED');
    expect(muted.body.details.mutedUntil).toBeDefined();
    const view = await request(t.http)
      .get(`/api/auctions/${auction.id}/chat`)
      .set(auth(u.session.token))
      .expect(200);
    expect(view.body.viewer).toMatchObject({ canPost: false, reason: 'MUTED' });

    await request(t.http)
      .delete(`/api/admin/chat/restrictions/${mute.body.id}`)
      .set(auth(admin.session.token))
      .expect(200);
    await say(u.session.token, auction.id, 'back').expect(201);

    const ban = await request(t.http)
      .post('/api/admin/chat/restrictions')
      .set(auth(admin.session.token))
      .send({
        userId: u.user.id,
        type: 'BAN',
        reason: 'abuse',
        hideRecentMessages: true,
      })
      .expect(201);
    expect(ban.body.hiddenMessages).toBe(2);
    expect(
      (await say(u.session.token, auction.id, 'x').expect(403)).body.code,
    ).toBe('CHAT_BANNED');
    const active = await request(t.http)
      .get('/api/admin/chat/restrictions')
      .set(auth(admin.session.token))
      .expect(200);
    expect(active.body).toHaveLength(1);
    expect(active.body[0]).toMatchObject({ type: 'BAN', active: true });
  });

  it('protects staff from non-super-admin restrictions and rejects bad input', async () => {
    const admin = await signedIn(t, { roles: [RoleKey.USER, RoleKey.ADMIN] });
    const mod = await signedIn(t, { roles: [RoleKey.USER, RoleKey.MODERATOR] });
    await request(t.http)
      .post('/api/admin/chat/restrictions')
      .set(auth(admin.session.token))
      .send({ userId: mod.user.id, type: 'BAN' })
      .expect(403);
    const u = await signedIn(t);
    await request(t.http)
      .post('/api/admin/chat/restrictions')
      .set(auth(admin.session.token))
      .send({ userId: u.user.id, type: 'MUTE' })
      .expect(400);
  });

  it('lets users report a message once and surfaces it to moderators', async () => {
    const { auction } = await room();
    const author = await signedIn(t);
    const reporter = await signedIn(t);
    const mod = await signedIn(t, { roles: [RoleKey.USER, RoleKey.MODERATOR] });
    const msg = (
      await say(author.session.token, auction.id, 'rude words').expect(201)
    ).body;
    await request(t.http)
      .post(`/api/chat/messages/${msg.id}/report`)
      .set(auth(author.session.token))
      .send({ reason: 'abuse' })
      .expect(422);
    const r = await request(t.http)
      .post(`/api/chat/messages/${msg.id}/report`)
      .set(auth(reporter.session.token))
      .send({ reason: 'harassment', details: 'see above' })
      .expect(201);
    expect(r.body.duplicate).toBe(false);
    const again = await request(t.http)
      .post(`/api/chat/messages/${msg.id}/report`)
      .set(auth(reporter.session.token))
      .send({ reason: 'harassment' })
      .expect(201);
    expect(again.body.duplicate).toBe(true);

    const queue = await request(t.http)
      .get('/api/admin/chat/messages?reported=true')
      .set(auth(mod.session.token))
      .expect(200);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({ id: msg.id, openReports: 1 });
  });
});
