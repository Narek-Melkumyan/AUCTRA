import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { RoleKey } from '../src/roles/permissions.js';
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

async function setup() {
  const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
  const buyer = await signedIn(t);
  const stranger = await signedIn(t);
  const auction = await createLiveAuction(t.prisma, seller.user.id);
  return { seller, buyer, stranger, auction };
}

const start = (token: string, auctionId: string, message: string) =>
  request(t.http)
    .post('/api/conversations')
    .set(auth(token))
    .send({ auctionId, message });
const send = (token: string, id: string, body: string) =>
  request(t.http)
    .post(`/api/conversations/${id}/messages`)
    .set(auth(token))
    .send({ body });
const unread = async (token: string) =>
  (
    await request(t.http)
      .get('/api/conversations/unread')
      .set(auth(token))
      .expect(200)
  ).body as { messages: number; conversations: number };
const dmNotifications = (userId: string) =>
  t.prisma.notification.count({ where: { userId, type: 'DIRECT_MESSAGE' } });

describe('buyer–seller messaging', () => {
  it('starts one thread per listing and buyer, with unread counts and one notification per batch', async () => {
    const { seller, buyer, auction } = await setup();
    const first = await start(
      buyer.session.token,
      auction.id,
      'Is the service history complete?',
    ).expect(201);
    const id = first.body.id as string;
    expect(first.body).toMatchObject({
      myRole: 'buyer',
      counterpart: { id: seller.user.id },
      auction: { id: auction.id },
      messages: [{ mine: true, body: 'Is the service history complete?' }],
    });
    // A second "start" reuses the same thread.
    const again = await start(buyer.session.token, auction.id, 'And the keys?');
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(id);
    await send(buyer.session.token, id, 'One more question.').expect(201);

    const list = await request(t.http)
      .get('/api/conversations')
      .set(auth(seller.session.token))
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      id,
      myRole: 'seller',
      unread: 3,
      counterpart: { id: buyer.user.id },
      lastMessage: { body: 'One more question.', mine: false },
    });
    expect(await unread(seller.session.token)).toEqual({
      messages: 3,
      conversations: 1,
    });
    // Three messages, but only the first unread one produced a notification.
    expect(await dmNotifications(seller.user.id)).toBe(1);

    await request(t.http)
      .post(`/api/conversations/${id}/read`)
      .set(auth(seller.session.token))
      .expect(200);
    expect((await unread(seller.session.token)).messages).toBe(0);

    await send(seller.session.token, id, 'Yes, full history.').expect(201);
    expect(await unread(buyer.session.token)).toEqual({
      messages: 1,
      conversations: 1,
    });
    expect(await dmNotifications(buyer.user.id)).toBe(1);
    // The sender's own messages never count as unread for them.
    expect((await unread(seller.session.token)).messages).toBe(0);
    // Next unread batch for the seller notifies again.
    await send(buyer.session.token, id, 'Great, thanks!').expect(201);
    expect(await dmNotifications(seller.user.id)).toBe(2);
  });

  it('keeps conversations private to their two participants', async () => {
    const { seller, buyer, stranger, auction } = await setup();
    const id = (
      await start(buyer.session.token, auction.id, 'Hello').expect(201)
    ).body.id as string;
    await request(t.http)
      .get(`/api/conversations/${id}`)
      .set(auth(stranger.session.token))
      .expect(404);
    await send(stranger.session.token, id, 'let me in').expect(404);
    await request(t.http)
      .post(`/api/conversations/${id}/read`)
      .set(auth(stranger.session.token))
      .expect(404);
    const list = await request(t.http)
      .get('/api/conversations')
      .set(auth(stranger.session.token))
      .expect(200);
    expect(list.body.items).toEqual([]);
    await request(t.http).get('/api/conversations').expect(401);
    const own = await start(seller.session.token, auction.id, 'me').expect(422);
    expect(own.body.code).toBe('OWN_LISTING');
    expect(await t.prisma.message.count()).toBe(1);
  });

  it('pages message history backwards in time', async () => {
    const { buyer, auction } = await setup();
    const id = (await start(buyer.session.token, auction.id, 'm0').expect(201))
      .body.id as string;
    const base = Date.now() - 3_600_000;
    await t.prisma.message.createMany({
      data: Array.from({ length: 59 }, (_, i) => ({
        conversationId: id,
        senderId: buyer.user.id,
        body: `m${i + 1}`,
        createdAt: new Date(base + (i + 1) * 1000),
      })),
    });
    // m0 was created "now", so it is the newest; move it before the batch.
    await t.prisma.message.updateMany({
      where: { conversationId: id, body: 'm0' },
      data: { createdAt: new Date(base) },
    });
    const p1 = await request(t.http)
      .get(`/api/conversations/${id}`)
      .set(auth(buyer.session.token))
      .expect(200);
    expect(p1.body.hasMore).toBe(true);
    expect(p1.body.messages).toHaveLength(50);
    expect(p1.body.messages[0].body).toBe('m10');
    expect(p1.body.messages.at(-1).body).toBe('m59');
    const p2 = await request(t.http)
      .get(`/api/conversations/${id}?before=${p1.body.messages[0].id}`)
      .set(auth(buyer.session.token))
      .expect(200);
    expect(p2.body.hasMore).toBe(false);
    expect(p2.body.messages.map((m: { body: string }) => m.body)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i}`),
    );
  });

  it('pushes new messages to both participants over Socket.IO, and to nobody else', async () => {
    const { seller, buyer, stranger, auction } = await setup();
    const connect = (token: string) => {
      const s = io(t.url, {
        path: '/socket.io',
        transports: ['websocket'],
        auth: { token },
        reconnection: false,
      });
      sockets.push(s);
      return new Promise<Socket>((resolve, reject) => {
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });
    };
    const [sellerSock, strangerSock] = await Promise.all([
      connect(seller.session.token),
      connect(stranger.session.token),
    ]);
    let leaked = false;
    strangerSock.on('message', () => (leaked = true));
    const got = new Promise<{
      conversationId: string;
      message: { body: string; senderId: string };
    }>((resolve) => sellerSock.once('message', resolve));
    const res = await start(
      buyer.session.token,
      auction.id,
      'Live hello',
    ).expect(201);
    const evt = await got;
    expect(evt).toMatchObject({
      conversationId: res.body.id,
      message: { body: 'Live hello', senderId: buyer.user.id },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(leaked).toBe(false);
  });
});
