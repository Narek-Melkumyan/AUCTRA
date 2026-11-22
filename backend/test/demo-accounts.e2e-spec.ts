import request from 'supertest';
import * as argon2 from 'argon2';
import {
  DEMO_ACCOUNTS,
  demoPasswordFromEnv,
  rotateDemoPasswords,
} from '../src/database/demo-accounts.js';
import {
  auth,
  createUser,
  createTestApp,
  login,
  ORIGIN,
  PASSWORD,
  resetDb,
  type TestApp,
} from './helpers.js';

// Demo-password rotation (npm run db:rotate-demo-passwords): only the seeded
// *@auctra.local accounts change, and they are signed out everywhere.

let t: TestApp;
const NEW_PASSWORD = 'rotated demo password 2026';

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb(t.prisma);
});
afterAll(async () => {
  await t.close();
});

async function loginStatus(email: string, password: string) {
  const agent = request.agent(t.http);
  const csrf = (await agent.get('/api/auth/csrf').expect(200)).body
    .csrfToken as string;
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', csrf)
    .send({ email, password });
  return res.status;
}

/** Three of the four demo accounts plus an ordinary (real) account, all on PASSWORD. */
async function setup() {
  const [admin, , bidder1] = await Promise.all(
    DEMO_ACCOUNTS.slice(0, 3).map((a) =>
      createUser(t.prisma, { email: a.email, roles: [...a.roles] }),
    ),
  );
  const real = await createUser(t.prisma, {
    email: 'owner@example.com',
    roles: ['USER', 'ADMIN', 'SUPER_ADMIN'],
  });
  const demoSession = await login(t, bidder1!.email);
  const realSession = await login(t, real.email);
  return { admin: admin!, bidder1: bidder1!, real, demoSession, realSession };
}

describe('rotateDemoPasswords', () => {
  it('dry run reports what would change and writes nothing', async () => {
    const { bidder1, demoSession } = await setup();
    const before = await t.prisma.user.findUniqueOrThrow({
      where: { id: bidder1.id },
    });

    const results = await rotateDemoPasswords(t.prisma, NEW_PASSWORD, {
      apply: false,
    });
    expect(results).toEqual([
      { email: 'admin@auctra.local', outcome: 'would-rotate', sessions: 0 },
      { email: 'seller@auctra.local', outcome: 'would-rotate', sessions: 0 },
      { email: 'bidder1@auctra.local', outcome: 'would-rotate', sessions: 1 },
      { email: 'bidder2@auctra.local', outcome: 'missing', sessions: 0 },
    ]);
    const after = await t.prisma.user.findUniqueOrThrow({
      where: { id: bidder1.id },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(demoSession.token))
      .expect(200);
    expect(
      await t.prisma.auditLog.count({
        where: { action: 'auth.password_changed' },
      }),
    ).toBe(0);
  });

  it('rotates only demo accounts, signs them out, audits without password material', async () => {
    const { admin, bidder1, real, demoSession, realSession } = await setup();
    const realBefore = await t.prisma.user.findUniqueOrThrow({
      where: { id: real.id },
    });

    const results = await rotateDemoPasswords(t.prisma, NEW_PASSWORD, {
      apply: true,
    });
    expect(results.map((r) => [r.email, r.outcome, r.sessions])).toEqual([
      ['admin@auctra.local', 'rotated', 0],
      ['seller@auctra.local', 'rotated', 0],
      ['bidder1@auctra.local', 'rotated', 1],
      ['bidder2@auctra.local', 'missing', 0],
    ]);

    // Demo accounts: new password only, existing session revoked.
    const demo = await t.prisma.user.findUniqueOrThrow({
      where: { id: bidder1.id },
    });
    expect(await argon2.verify(demo.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await argon2.verify(demo.passwordHash, PASSWORD)).toBe(false);
    expect(await loginStatus(admin.email, PASSWORD)).toBe(401);
    expect(await loginStatus(admin.email, NEW_PASSWORD)).toBe(200);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(demoSession.token))
      .expect(401);
    const revoked = await t.prisma.session.findFirstOrThrow({
      where: { userId: bidder1.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(revoked.revokeReason).toBe('PASSWORD_CHANGED');
    expect(
      await t.prisma.refreshToken.count({
        where: { sessionId: revoked.id, revokedAt: null },
      }),
    ).toBe(0);

    // The real account is untouched: same hash, same timestamps, still signed in.
    const realAfter = await t.prisma.user.findUniqueOrThrow({
      where: { id: real.id },
    });
    expect(realAfter.passwordHash).toBe(realBefore.passwordHash);
    expect(realAfter.passwordChangedAt).toEqual(realBefore.passwordChangedAt);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(realSession.token))
      .expect(200);
    expect(await loginStatus(real.email, PASSWORD)).toBe(200);

    const logs = await t.prisma.auditLog.findMany({
      where: { action: 'auth.password_changed' },
    });
    expect(logs).toHaveLength(3);
    expect(logs.map((l) => l.entityId)).not.toContain(real.id);
    const dump = JSON.stringify(logs.map((l) => l.metadata));
    expect(dump).not.toContain(NEW_PASSWORD);
    expect(dump).not.toContain(demo.passwordHash);
    expect(logs[0]!.metadata).toMatchObject({
      via: 'cli',
      reason: 'demo-password-rotation',
    });
  });

  it('is idempotent: a second run changes and logs nothing', async () => {
    await setup();
    await rotateDemoPasswords(t.prisma, NEW_PASSWORD, { apply: true });
    const hashes = await t.prisma.user.findMany({
      select: { id: true, passwordHash: true },
      orderBy: { id: 'asc' },
    });
    const logs = await t.prisma.auditLog.count();

    const again = await rotateDemoPasswords(t.prisma, NEW_PASSWORD, {
      apply: true,
    });
    expect(again.map((r) => r.outcome)).toEqual([
      'current',
      'current',
      'current',
      'missing',
    ]);
    expect(
      await t.prisma.user.findMany({
        select: { id: true, passwordHash: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(hashes);
    expect(await t.prisma.auditLog.count()).toBe(logs);
  });

  it('requires a SEED_DEMO_PASSWORD of at least 12 characters', () => {
    expect(() => demoPasswordFromEnv({})).toThrow(/SEED_DEMO_PASSWORD/);
    expect(() => demoPasswordFromEnv({ SEED_DEMO_PASSWORD: 'short' })).toThrow(
      /≥ 12/,
    );
    expect(demoPasswordFromEnv({ SEED_DEMO_PASSWORD: NEW_PASSWORD })).toBe(
      NEW_PASSWORD,
    );
  });
});
