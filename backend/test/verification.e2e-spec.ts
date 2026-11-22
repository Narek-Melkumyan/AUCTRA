import request from 'supertest';
import { MAX_CODE_ATTEMPTS } from '../src/auth/auth.service.js';
import {
  auth,
  createTestApp,
  ORIGIN,
  PASSWORD,
  resetDb,
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

async function register(email: string) {
  const agent = request.agent(t.http);
  const csrf = (await agent.get('/api/auth/csrf').expect(200)).body
    .csrfToken as string;
  const res = await agent
    .post('/api/auth/register')
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', csrf)
    .send({
      email,
      password: PASSWORD,
      displayName: 'Vera <Fier>'.replace(/[<>]/g, ''),
    })
    .expect(201);
  return res.body as {
    accessToken: string;
    verificationEmail: { delivered: boolean; providerConfigured: boolean };
  };
}

function lastVerification() {
  const mail = [...t.emails]
    .reverse()
    .find((m) => m.template === 'verify-email');
  if (!mail) throw new Error('no verification email');
  const token = decodeURIComponent(
    /token=([A-Za-z0-9_%-]+)/.exec(mail.text)![1]!,
  );
  const code = /Verification code: (\d{6})/.exec(mail.text)![1]!;
  return { mail, token, code };
}

const verified = async (email: string) =>
  (await t.prisma.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt;

const wrong = (code: string) =>
  String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('verification email', () => {
  it('contains both a link and a 6-digit code, stores only hashes, and reports non-delivery honestly', async () => {
    const reg = await register('both@example.com');
    // The dev log provider never claims delivery.
    expect(reg.verificationEmail).toEqual({
      delivered: false,
      providerConfigured: false,
      reason: 'no-provider-configured',
    });
    const { mail, token, code } = lastVerification();
    expect(mail.subject).toContain(code);
    expect(mail.html).toContain('AUCTRA');
    expect(mail.html).toContain(`${code.slice(0, 3)} ${code.slice(3)}`);
    expect(mail.html).toContain('/verify-email?token=');
    expect(mail.html).toContain('15 minutes');
    const row = await t.prisma.verificationToken.findFirstOrThrow();
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(code);
    expect(row.tokenHash).not.toBe(token);
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1000);
  });
});

describe('verify by code', () => {
  it('verifies the signed-in user and retires the link from the same request', async () => {
    const { accessToken } = await register('code@example.com');
    const { token, code } = lastVerification();
    await request(t.http)
      .post('/api/auth/verify-email/code')
      .set(auth(accessToken))
      .send({ code })
      .expect(200);
    expect(await verified('code@example.com')).not.toBeNull();
    // Single use: neither the code nor the link works again.
    const again = await request(t.http)
      .post('/api/auth/verify-email/code')
      .set(auth(accessToken))
      .send({ code })
      .expect(400);
    expect(again.body.code).toBe('NO_ACTIVE_CODE');
    const link = await request(t.http)
      .post('/api/auth/verify-email')
      .send({ token })
      .expect(400);
    expect(link.body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    const me = await request(t.http)
      .get('/api/auth/me')
      .set(auth(accessToken))
      .expect(200);
    expect(me.body.emailVerified).toBe(true);
  });

  it('works signed out with the email address, with a generic error for unknown accounts', async () => {
    await register('signedout@example.com');
    const { code } = lastVerification();
    const unknown = await request(t.http)
      .post('/api/auth/verify-email/code')
      .send({ code, email: 'nobody@example.com' })
      .expect(400);
    expect(unknown.body.code).toBe('INVALID_OR_EXPIRED_CODE');
    const bad = await request(t.http)
      .post('/api/auth/verify-email/code')
      .send({ code: wrong(code), email: 'signedout@example.com' })
      .expect(400);
    // Same response shape as the unknown account: no enumeration.
    expect(bad.body.code).toBe('INVALID_OR_EXPIRED_CODE');
    expect(bad.body.details).toBeUndefined();
    await request(t.http)
      .post('/api/auth/verify-email/code')
      .send({ code, email: 'SignedOut@Example.com' })
      .expect(200);
    expect(await verified('signedout@example.com')).not.toBeNull();
  });

  it('rejects malformed codes and missing identity', async () => {
    await request(t.http)
      .post('/api/auth/verify-email/code')
      .send({ code: '12345', email: 'a@example.com' })
      .expect(400);
    const noEmail = await request(t.http)
      .post('/api/auth/verify-email/code')
      .send({ code: '123456' })
      .expect(400);
    expect(noEmail.body.code).toBe('EMAIL_REQUIRED');
  });

  it(`voids the request after ${MAX_CODE_ATTEMPTS} wrong codes — the right code and the link stop working`, async () => {
    const { accessToken } = await register('brute@example.com');
    const { token, code } = lastVerification();
    for (let i = MAX_CODE_ATTEMPTS - 1; i >= 0; i--) {
      const res = await request(t.http)
        .post('/api/auth/verify-email/code')
        .set(auth(accessToken))
        .send({ code: wrong(code) })
        .expect(400);
      expect(res.body.code).toBe('INVALID_CODE');
      expect(res.body.details.attemptsRemaining).toBe(i);
    }
    const locked = await request(t.http)
      .post('/api/auth/verify-email/code')
      .set(auth(accessToken))
      .send({ code })
      .expect(400);
    expect(locked.body.code).toBe('TOO_MANY_ATTEMPTS');
    await request(t.http)
      .post('/api/auth/verify-email')
      .send({ token })
      .expect(400);
    expect(await verified('brute@example.com')).toBeNull();
  });

  it('counts concurrent guesses exactly (row lock)', async () => {
    const { accessToken } = await register('race@example.com');
    const { code } = lastVerification();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        request(t.http)
          .post('/api/auth/verify-email/code')
          .set(auth(accessToken))
          .send({ code: wrong(code) }),
      ),
    );
    const row = await t.prisma.verificationToken.findFirstOrThrow();
    expect(row.attempts).toBe(MAX_CODE_ATTEMPTS);
  });

  it('rejects an expired code', async () => {
    const { accessToken } = await register('late@example.com');
    const { code } = lastVerification();
    await t.prisma.verificationToken.updateMany({
      data: {
        createdAt: new Date(Date.now() - 20 * 60_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const res = await request(t.http)
      .post('/api/auth/verify-email/code')
      .set(auth(accessToken))
      .send({ code })
      .expect(400);
    expect(res.body.code).toBe('CODE_EXPIRED');
    expect(await verified('late@example.com')).toBeNull();
  });
});

describe('verify by link', () => {
  it('retires the code from the same request', async () => {
    const { accessToken } = await register('link@example.com');
    const { token, code } = lastVerification();
    await request(t.http)
      .post('/api/auth/verify-email')
      .send({ token })
      .expect(200);
    expect(await verified('link@example.com')).not.toBeNull();
    await request(t.http)
      .post('/api/auth/verify-email/code')
      .set(auth(accessToken))
      .send({ code })
      .expect(400);
  });
});

describe('resend', () => {
  it('issues new credentials and invalidates the old link and code', async () => {
    const { accessToken } = await register('again@example.com');
    const first = lastVerification();
    await t.prisma.verificationToken.updateMany({
      data: { createdAt: new Date(Date.now() - 120_000) },
    });
    const res = await request(t.http)
      .post('/api/auth/resend-verification')
      .set(auth(accessToken))
      .expect(200);
    expect(res.body).toMatchObject({
      sent: true,
      alreadyVerified: false,
      expiresInMinutes: 15,
      email: { delivered: false },
    });
    const second = lastVerification();
    expect(second.token).not.toBe(first.token);

    await request(t.http)
      .post('/api/auth/verify-email')
      .send({ token: first.token })
      .expect(400);
    if (first.code !== second.code) {
      await request(t.http)
        .post('/api/auth/verify-email/code')
        .set(auth(accessToken))
        .send({ code: first.code })
        .expect(400);
    }
    await request(t.http)
      .post('/api/auth/verify-email/code')
      .set(auth(accessToken))
      .send({ code: second.code })
      .expect(200);
    // Once verified, resend is a no-op.
    const after = await request(t.http)
      .post('/api/auth/resend-verification')
      .set(auth(accessToken))
      .expect(200);
    expect(after.body).toMatchObject({ sent: false, alreadyVerified: true });
  });

  it('requires a session', async () => {
    await request(t.http).post('/api/auth/resend-verification').expect(401);
  });
});
