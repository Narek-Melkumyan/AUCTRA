import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../src/config/app-config.js';
import { sha256Hex } from '../src/common/crypto.js';
import { AuthService } from '../src/auth/auth.service.js';
import {
  auth,
  createTestApp,
  createUser,
  login,
  ORIGIN,
  PASSWORD,
  refreshCookie,
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
  t.emails.length = 0;
});
afterAll(async () => {
  await t.close();
});

async function csrfAgent() {
  const agent = request.agent(t.http);
  const csrf = (await agent.get('/api/auth/csrf').expect(200)).body
    .csrfToken as string;
  return { agent, csrf };
}

function tokenFromEmail(template: string): string {
  const mail = [...t.emails].reverse().find((m) => m.template === template);
  const match = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error(`no ${template} email`);
  return decodeURIComponent(match[1]);
}

describe('registration', () => {
  it('creates an account, sets a hardened refresh cookie and never returns the hash', async () => {
    const { agent, csrf } = await csrfAgent();
    const res = await agent
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({
        email: '  New.User@Example.com ',
        password: PASSWORD,
        displayName: 'New User',
      })
      .expect(201);

    expect(res.body.user.email).toBe('new.user@example.com');
    expect(res.body.user.emailVerified).toBe(false);
    expect(res.body.user.roles).toEqual(['USER']);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
    expect(res.body.accessToken).toMatch(/^ey/);

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find(
      (c) => c.startsWith('auctra_rt='),
    )!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);

    const row = await t.prisma.user.findUniqueOrThrow({
      where: { email: 'new.user@example.com' },
    });
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    const stored = await t.prisma.refreshToken.findMany();
    expect(stored).toHaveLength(1);
    // Only the SHA-256 of the secret is persisted.
    expect(refreshCookie(res)).not.toContain(stored[0]!.tokenHash);
    expect(stored[0]!.tokenHash).toBe(
      sha256Hex(decodeURIComponent(refreshCookie(res)!).split('.')[1]!),
    );
    expect(t.emails.some((m) => m.template === 'verify-email')).toBe(true);
  });

  it('rejects duplicate emails, weak input and requests without CSRF', async () => {
    await createUser(t.prisma, { email: 'taken@example.com' });
    const { agent, csrf } = await csrfAgent();
    const dup = await agent
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({
        email: 'taken@example.com',
        password: PASSWORD,
        displayName: 'X',
      })
      .expect(409);
    expect(dup.body.code).toBe('EMAIL_TAKEN');

    const short = await agent
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ email: 'a@example.com', password: 'short', displayName: 'X' })
      .expect(400);
    expect(short.body.code).toBe('VALIDATION_FAILED');

    await request(t.http)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ email: 'b@example.com', password: PASSWORD, displayName: 'X' })
      .expect(403);
    await agent
      .post('/api/auth/register')
      .set('Origin', 'https://evil.example')
      .set('X-CSRF-Token', csrf)
      .send({ email: 'c@example.com', password: PASSWORD, displayName: 'X' })
      .expect(403);
  });
});

describe('login', () => {
  it('signs in with valid credentials', async () => {
    const user = await createUser(t.prisma);
    const s = await login(t, user.email);
    const me = await request(t.http)
      .get('/api/auth/me')
      .set(auth(s.token))
      .expect(200);
    expect(me.body.id).toBe(user.id);
    expect(me.body.permissions).toContain('bid:place');
  });

  it('answers wrong password and unknown email identically', async () => {
    const user = await createUser(t.prisma);
    const { agent, csrf } = await csrfAgent();
    const wrong = await agent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ email: user.email, password: 'not the password' })
      .expect(401);
    const unknown = await agent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ email: 'nobody@example.com', password: 'not the password' })
      .expect(401);
    // Identical apart from the per-request correlation id.
    const { requestId: _a, ...wrongBody } = wrong.body as Record<
      string,
      unknown
    >;
    const { requestId: _b, ...unknownBody } = unknown.body as Record<
      string,
      unknown
    >;
    expect(wrongBody).toEqual(unknownBody);
    expect(_a).not.toBe(_b);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after repeated failures (brute-force protection)', async () => {
    const user = await createUser(t.prisma);
    const { agent, csrf } = await csrfAgent();
    for (let i = 0; i < 5; i++) {
      await agent
        .post('/api/auth/login')
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrf)
        .send({ email: user.email, password: `wrong-${i}` })
        .expect(401);
    }
    // Even the correct password is refused while locked.
    const locked = await agent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ email: user.email, password: PASSWORD })
      .expect(429);
    expect(locked.body.code).toBe('RATE_LIMITED');
    const row = await t.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(
      await t.prisma.auditLog.count({
        where: { action: 'auth.account_locked' },
      }),
    ).toBeGreaterThan(0);
  });

  it('refuses banned accounts', async () => {
    const user = await createUser(t.prisma, { status: 'BANNED' });
    const { agent, csrf } = await csrfAgent();
    await agent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ email: user.email, password: PASSWORD })
      .expect(403);
  });
});

describe('access tokens', () => {
  it('rejects missing, tampered and expired tokens', async () => {
    const { session } = await signedIn(t);
    await request(t.http).get('/api/auth/me').expect(401);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(`${session.token}x`))
      .expect(401);

    const config = t.app.get(AppConfig);
    const claims = JSON.parse(
      Buffer.from(session.token.split('.')[1]!, 'base64url').toString(),
    ) as { sub: string; sid: string };
    const expired = await new JwtService().signAsync(
      {
        sub: claims.sub,
        sid: claims.sid,
        typ: 'access',
        exp: Math.floor(Date.now() / 1000) - 10,
      },
      {
        secret: config.jwtAccessSecret,
        algorithm: 'HS256',
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      },
    );
    const res = await request(t.http)
      .get('/api/auth/me')
      .set(auth(expired))
      .expect(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');

    const otherSecret = await new JwtService().signAsync(
      { sub: claims.sub, sid: claims.sid, typ: 'access' },
      {
        secret: 'x'.repeat(64),
        algorithm: 'HS256',
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
        expiresIn: 60,
      },
    );
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(otherSecret))
      .expect(401);
  });

  it('stops working immediately once its session is revoked', async () => {
    const { session } = await signedIn(t);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(session.token))
      .expect(200);
    await request(t.http)
      .post('/api/auth/logout-all')
      .set(auth(session.token))
      .expect(200);
    const res = await request(t.http)
      .get('/api/auth/me')
      .set(auth(session.token))
      .expect(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
  });
});

describe('refresh token rotation', () => {
  it('rotates the refresh token on every refresh', async () => {
    const { session } = await signedIn(t);
    const r1 = await session.agent
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', session.csrf)
      .expect(200);
    const r2 = await session.agent
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', session.csrf)
      .expect(200);
    expect(refreshCookie(r1)).toBeTruthy();
    expect(refreshCookie(r1)).not.toBe(refreshCookie(r2));
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(r2.body.accessToken))
      .expect(200);
    const tokens = await t.prisma.refreshToken.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(tokens).toHaveLength(3);
    expect(tokens.filter((x) => x.usedAt === null)).toHaveLength(1);
    expect(tokens[0]!.replacedById).toBe(tokens[1]!.id);
  });

  it('requires CSRF on refresh', async () => {
    const { session } = await signedIn(t);
    await session.agent
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .expect(403);
    await session.agent
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', 'forged.value')
      .expect(403);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const { session } = await signedIn(t);
    const firstCookie = (await t.prisma.refreshToken.findFirstOrThrow()).id;
    const stolen = await stolenCookieFor(session);
    const rotated = await session.agent
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', session.csrf)
      .expect(200);
    // Move the rotation outside the concurrency grace window.
    await t.prisma.refreshToken.update({
      where: { id: firstCookie },
      data: { usedAt: new Date(Date.now() - 60_000) },
    });

    const reuse = await request(t.http)
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', [`auctra_rt=${stolen}`, `auctra_csrf=${session.csrf}`])
      .set('X-CSRF-Token', session.csrf)
      .expect(401);
    expect(reuse.body.code).toBe('TOKEN_REUSE_DETECTED');

    // The legitimate holder's newer token is dead too, and so is the access token.
    await session.agent
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', session.csrf)
      .expect(401);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(rotated.body.accessToken))
      .expect(401);
    const s = await t.prisma.session.findFirstOrThrow();
    expect(s.revokeReason).toBe('TOKEN_REUSE');
    expect(
      await t.prisma.auditLog.count({
        where: { action: 'auth.refresh_token_reuse' },
      }),
    ).toBe(1);
  });

  it('serialises concurrent refreshes: one wins, the other gets 409 without logging the user out', async () => {
    const { session } = await signedIn(t);
    const cookie = await stolenCookieFor(session);
    const send = () =>
      request(t.http)
        .post('/api/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', [`auctra_rt=${cookie}`, `auctra_csrf=${session.csrf}`])
        .set('X-CSRF-Token', session.csrf);
    const results = await Promise.all([send(), send(), send()]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409]);
    const winner = results.find((r) => r.status === 200)!;
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(winner.body.accessToken))
      .expect(200);
    const s = await t.prisma.session.findFirstOrThrow();
    expect(s.revokedAt).toBeNull();
  });

  it('rejects an expired refresh token', async () => {
    const { session } = await signedIn(t);
    await t.prisma
      .$executeRaw`UPDATE refresh_tokens SET "expiresAt" = now() - interval '1 second', "createdAt" = now() - interval '1 day'`;
    const res = await session.agent
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', session.csrf)
      .expect(401);
    expect(res.body.code).toBe('REFRESH_TOKEN_EXPIRED');
  });
});

describe('logout and sessions', () => {
  it('logout revokes the current device only', async () => {
    const user = await createUser(t.prisma);
    const phone = await login(t, user.email);
    const laptop = await login(t, user.email);
    const phoneCookie = await stolenCookieFor(phone);
    await phone.agent
      .post('/api/auth/logout')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', phone.csrf)
      .set(auth(phone.token))
      .expect(204);
    // The cookie was cleared: the device now has no session at all…
    const none = await phone.agent
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', phone.csrf)
      .expect(204);
    expect(none.body).toEqual({});
    // …and replaying the logged-out refresh token is rejected.
    await request(t.http)
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', phone.csrf)
      .set('Cookie', [`auctra_rt=${phoneCookie}`, `auctra_csrf=${phone.csrf}`])
      .expect(401);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(phone.token))
      .expect(401);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(laptop.token))
      .expect(200);
  });

  it('lists sessions and revokes another device', async () => {
    const user = await createUser(t.prisma);
    const a = await login(t, user.email);
    const b = await login(t, user.email);
    const list = await request(t.http)
      .get('/api/auth/sessions')
      .set(auth(a.token))
      .expect(200);
    expect(list.body).toHaveLength(2);
    expect(
      list.body.filter((s: { current: boolean }) => s.current),
    ).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/127\.0\.0\.1/);
    const other = list.body.find((s: { current: boolean }) => !s.current);
    await request(t.http)
      .delete(`/api/auth/sessions/${other.id}`)
      .set(auth(a.token))
      .expect(204);
    await request(t.http).get('/api/auth/me').set(auth(b.token)).expect(401);
  });

  it('logout-all revokes every session', async () => {
    const user = await createUser(t.prisma);
    const a = await login(t, user.email);
    const b = await login(t, user.email);
    const res = await request(t.http)
      .post('/api/auth/logout-all')
      .set(auth(a.token))
      .expect(200);
    expect(res.body.revokedSessions).toBe(2);
    await request(t.http).get('/api/auth/me').set(auth(b.token)).expect(401);
  });
});

describe('email verification', () => {
  async function register(email: string) {
    const { agent, csrf } = await csrfAgent();
    const res = await agent
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ email, password: PASSWORD, displayName: 'Verifier' })
      .expect(201);
    return res.body.accessToken as string;
  }

  it('verifies with a single-use token', async () => {
    await register('verify@example.com');
    const token = tokenFromEmail('verify-email');
    await request(t.http)
      .post('/api/auth/verify-email')
      .send({ token })
      .expect(200);
    const u = await t.prisma.user.findUniqueOrThrow({
      where: { email: 'verify@example.com' },
    });
    expect(u.emailVerifiedAt).not.toBeNull();
    const again = await request(t.http)
      .post('/api/auth/verify-email')
      .send({ token })
      .expect(400);
    expect(again.body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('rejects an expired token', async () => {
    await register('expired@example.com');
    const token = tokenFromEmail('verify-email');
    await t.prisma.verificationToken.updateMany({
      data: {
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await request(t.http)
      .post('/api/auth/verify-email')
      .send({ token })
      .expect(400);
    const u = await t.prisma.user.findUniqueOrThrow({
      where: { email: 'expired@example.com' },
    });
    expect(u.emailVerifiedAt).toBeNull();
  });

  it('throttles resend requests', async () => {
    const access = await register('resend@example.com');
    // Registration just sent one; an immediate resend is refused.
    await request(t.http)
      .post('/api/auth/resend-verification')
      .set(auth(access))
      .expect(429);
    await t.prisma.verificationToken.updateMany({
      data: { createdAt: new Date(Date.now() - 120_000) },
    });
    const ok = await request(t.http)
      .post('/api/auth/resend-verification')
      .set(auth(access))
      .expect(200);
    expect(ok.body.sent).toBe(true);
    expect(
      await t.prisma.verificationToken.count({ where: { usedAt: null } }),
    ).toBe(1);
  });
});

describe('password reset', () => {
  it('does not reveal whether an email exists', async () => {
    await createUser(t.prisma, { email: 'exists@example.com' });
    const a = await request(t.http)
      .post('/api/auth/forgot-password')
      .send({ email: 'exists@example.com' })
      .expect(202);
    const b = await request(t.http)
      .post('/api/auth/forgot-password')
      .send({ email: 'missing@example.com' })
      .expect(202);
    expect(a.body).toEqual(b.body);
  });

  it('resets with a single-use token and signs out every device', async () => {
    const user = await createUser(t.prisma, { email: 'reset@example.com' });
    const s = await login(t, user.email);
    await t.app.get(AuthService).processPasswordReset('reset@example.com', {});
    const token = tokenFromEmail('password-reset');

    await request(t.http)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'a brand new passphrase' })
      .expect(200);
    await request(t.http).get('/api/auth/me').set(auth(s.token)).expect(401);
    await login(t, user.email, 'a brand new passphrase');

    const reuse = await request(t.http)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'yet another passphrase' })
      .expect(400);
    expect(reuse.body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('rejects an expired reset token', async () => {
    await createUser(t.prisma, { email: 'late@example.com' });
    await t.app.get(AuthService).processPasswordReset('late@example.com', {});
    const token = tokenFromEmail('password-reset');
    await t.prisma.verificationToken.updateMany({
      data: {
        createdAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await request(t.http)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'a brand new passphrase' })
      .expect(400);
  });

  it('change-password keeps the current session and revokes the others', async () => {
    const user = await createUser(t.prisma);
    const current = await login(t, user.email);
    const other = await login(t, user.email);
    await request(t.http)
      .post('/api/auth/change-password')
      .set(auth(current.token))
      .send({
        currentPassword: 'wrong',
        newPassword: 'another long passphrase',
      })
      .expect(400);
    const res = await request(t.http)
      .post('/api/auth/change-password')
      .set(auth(current.token))
      .send({
        currentPassword: PASSWORD,
        newPassword: 'another long passphrase',
      })
      .expect(200);
    expect(res.body.revokedSessions).toBe(1);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(current.token))
      .expect(200);
    await request(t.http)
      .get('/api/auth/me')
      .set(auth(other.token))
      .expect(401);
  });
});

/** Reads the session's current refresh cookie value from its agent jar. */
async function stolenCookieFor(session: {
  agent: ReturnType<typeof request.agent>;
}): Promise<string> {
  const jar = (
    session.agent as unknown as {
      jar: {
        getCookie: (n: string, o: unknown) => { value: string } | undefined;
      };
    }
  ).jar;
  const c = jar.getCookie('auctra_rt', {
    domain: '127.0.0.1',
    path: '/api/auth',
    secure: false,
    script: false,
  });
  if (!c) throw new Error('no refresh cookie in jar');
  return c.value;
}
