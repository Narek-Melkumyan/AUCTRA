import request from 'supertest';
import { RoleKey } from '../src/roles/permissions.js';
import {
  auth,
  createLiveAuction,
  createTestApp,
  resetDb,
  signedIn,
  type TestApp,
} from './helpers.js';

// Address book (/me/addresses) and favourites (/me/favorites): the APIs behind the
// frontend's Address book and Favourites screens.

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

const home = {
  type: 'SHIPPING',
  label: 'Home',
  fullName: 'Ada Buyer',
  line1: '1 Main Street',
  city: 'Springfield',
  postalCode: '12345',
  country: 'US',
};

describe('address book', () => {
  it('creates, lists (defaults first), edits, clears optional fields and deletes', async () => {
    const { session } = await signedIn(t);
    const h = auth(session.token);
    const a = await request(t.http)
      .post('/api/me/addresses')
      .set(h)
      .send({ ...home, line2: 'Apt 4', phone: '+1 555 0100' })
      .expect(201);
    expect(a.body).toMatchObject({ ...home, line2: 'Apt 4', isDefault: false });
    const b = await request(t.http)
      .post('/api/me/addresses')
      .set(h)
      .send({ ...home, label: 'Office', line1: '9 Work Road', isDefault: true })
      .expect(201);

    const list = await request(t.http)
      .get('/api/me/addresses')
      .set(h)
      .expect(200);
    expect(list.body.map((x: { id: string }) => x.id)).toEqual([
      b.body.id,
      a.body.id,
    ]);

    const edited = await request(t.http)
      .patch(`/api/me/addresses/${a.body.id}`)
      .set(h)
      .send({ city: 'Shelbyville', line2: null, phone: null })
      .expect(200);
    expect(edited.body).toMatchObject({
      city: 'Shelbyville',
      line2: null,
      phone: null,
      line1: '1 Main Street',
    });

    await request(t.http)
      .delete(`/api/me/addresses/${a.body.id}`)
      .set(h)
      .expect(204);
    const after = await request(t.http)
      .get('/api/me/addresses')
      .set(h)
      .expect(200);
    expect(after.body).toHaveLength(1);
  });

  it('keeps exactly one default per type, including when a default changes type', async () => {
    const { user, session } = await signedIn(t);
    const h = auth(session.token);
    const ship = await request(t.http)
      .post('/api/me/addresses')
      .set(h)
      .send({ ...home, isDefault: true })
      .expect(201);
    const bill = await request(t.http)
      .post('/api/me/addresses')
      .set(h)
      .send({ ...home, type: 'BILLING', isDefault: true })
      .expect(201);
    const ship2 = await request(t.http)
      .post('/api/me/addresses')
      .set(h)
      .send({ ...home, label: 'Cabin' })
      .expect(201);
    const defaults = (type: 'SHIPPING' | 'BILLING') =>
      t.prisma.userAddress.findMany({
        where: { userId: user.id, type, isDefault: true },
        select: { id: true },
      });

    // Make the second shipping address the default: the first one gives way.
    await request(t.http)
      .patch(`/api/me/addresses/${ship2.body.id}`)
      .set(h)
      .send({ isDefault: true })
      .expect(200);
    expect(await defaults('SHIPPING')).toEqual([{ id: ship2.body.id }]);

    // Moving the default billing address to shipping keeps it the default there
    // instead of failing on the one-default-per-type index.
    await request(t.http)
      .patch(`/api/me/addresses/${bill.body.id}`)
      .set(h)
      .send({ type: 'SHIPPING' })
      .expect(200);
    expect(await defaults('SHIPPING')).toEqual([{ id: bill.body.id }]);
    expect(await defaults('BILLING')).toEqual([]);
    expect(ship.body.id).toBeDefined();
  });

  it('validates input and never exposes or edits another user’s addresses', async () => {
    const owner = await signedIn(t);
    const other = await signedIn(t);
    await request(t.http)
      .post('/api/me/addresses')
      .set(auth(owner.session.token))
      .send({ ...home, country: 'usa' })
      .expect(400);
    await request(t.http)
      .post('/api/me/addresses')
      .set(auth(owner.session.token))
      .send({ ...home, fullName: '   ' })
      .expect(400);
    const mine = await request(t.http)
      .post('/api/me/addresses')
      .set(auth(owner.session.token))
      .send(home)
      .expect(201);

    const theirs = await request(t.http)
      .get('/api/me/addresses')
      .set(auth(other.session.token))
      .expect(200);
    expect(theirs.body).toEqual([]);
    await request(t.http)
      .patch(`/api/me/addresses/${mine.body.id}`)
      .set(auth(other.session.token))
      .send({ city: 'Elsewhere' })
      .expect(404);
    await request(t.http)
      .delete(`/api/me/addresses/${mine.body.id}`)
      .set(auth(other.session.token))
      .expect(404);
    await request(t.http).get('/api/me/addresses').expect(401);
  });
});

describe('favourites', () => {
  it('adds idempotently, lists newest first, removes, and is separate from the watchlist', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const buyer = await signedIn(t);
    const h = auth(buyer.session.token);
    const one = await createLiveAuction(t.prisma, seller.user.id);
    const two = await createLiveAuction(t.prisma, seller.user.id, {
      title: 'Second lot',
    });

    await request(t.http)
      .put(`/api/me/favorites/${one.id}`)
      .set(h)
      .send({})
      .expect(200);
    await request(t.http)
      .put(`/api/me/favorites/${two.id}`)
      .set(h)
      .send({})
      .expect(200);
    // Favouriting again is a no-op, not an error or a duplicate.
    await request(t.http)
      .put(`/api/me/favorites/${one.id}`)
      .set(h)
      .send({})
      .expect(200);

    const list = await request(t.http)
      .get('/api/me/favorites')
      .set(h)
      .expect(200);
    expect(list.body.map((f: { auctionId: string }) => f.auctionId)).toEqual([
      two.id,
      one.id,
    ]);
    const watch = await request(t.http)
      .get('/api/me/watchlist')
      .set(h)
      .expect(200);
    expect(watch.body).toEqual([]);

    await request(t.http)
      .delete(`/api/me/favorites/${two.id}`)
      .set(h)
      .expect(204);
    const after = await request(t.http)
      .get('/api/me/favorites')
      .set(h)
      .expect(200);
    expect(after.body).toEqual([
      { auctionId: one.id, createdAt: expect.any(String) },
    ]);
  });

  it('refuses lots the user cannot see and requires sign-in', async () => {
    const seller = await signedIn(t, { roles: [RoleKey.USER, RoleKey.SELLER] });
    const buyer = await signedIn(t);
    const draft = await createLiveAuction(t.prisma, seller.user.id, {
      status: 'DRAFT',
    });
    await request(t.http)
      .put(`/api/me/favorites/${draft.id}`)
      .set(auth(buyer.session.token))
      .send({})
      .expect(404);
    await request(t.http)
      .put('/api/me/favorites/00000000-0000-4000-8000-000000000000')
      .set(auth(buyer.session.token))
      .send({})
      .expect(404);
    await request(t.http).get('/api/me/favorites').expect(401);
  });
});
