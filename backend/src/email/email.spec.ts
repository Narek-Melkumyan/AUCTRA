import { AppConfig } from '../config/app-config.js';
import {
  EmailService,
  ResendEmailProvider,
  redactEmail,
  type ResendLike,
} from './email.service.js';
import { notificationEmail, verificationEmail } from './templates.js';

const message = {
  to: 'buyer@example.com',
  subject: 's',
  html: '<p>h</p>',
  text: 't',
  template: 'verify-email',
};

function fakeResend(
  ...results: (Awaited<ReturnType<ResendLike['emails']['send']>> | Error)[]
) {
  const calls: unknown[][] = [];
  const client: ResendLike = {
    emails: {
      send: async (...args: unknown[]) => {
        calls.push(args);
        const next = results.shift();
        if (!next) throw new Error('unexpected call');
        if (next instanceof Error) throw next;
        return next;
      },
    } as ResendLike['emails'],
  };
  return { client, calls };
}

const env = {
  DATABASE_URL: 'postgresql://x@localhost/x',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  CSRF_SECRET: 'b'.repeat(40),
  FRONTEND_URL: 'https://auctra.example',
};

describe('ResendEmailProvider', () => {
  it('reports delivery with the provider id and sends from the configured address', async () => {
    const { client, calls } = fakeResend({
      data: { id: 'em_123' },
      error: null,
    });
    const p = new ResendEmailProvider(client, 'AUCTRA <hi@auctra.example>');
    const res = await p.send({ ...message, idempotencyKey: 'verify-email/1' });
    expect(res).toEqual({ delivered: true, providerMessageId: 'em_123' });
    const [payload, opts] = calls[0] as [Record<string, unknown>, unknown];
    expect(payload).toMatchObject({
      from: 'AUCTRA <hi@auctra.example>',
      to: ['buyer@example.com'],
      tags: [{ name: 'template', value: 'verify-email' }],
    });
    expect(opts).toEqual({ idempotencyKey: 'verify-email/1' });
  });

  it('treats validation errors as permanent and rate limits / outages as retryable', async () => {
    const { client } = fakeResend(
      {
        data: null,
        error: {
          name: 'validation_error',
          message: 'domain not verified',
          statusCode: 403,
        },
      },
      {
        data: null,
        error: {
          name: 'rate_limit_exceeded',
          message: 'slow',
          statusCode: 429,
        },
      },
      new Error('fetch failed'),
    );
    const p = new ResendEmailProvider(client, 'x@y.z');
    expect(await p.send(message)).toEqual({
      delivered: false,
      reason: 'resend:validation_error',
      retryable: false,
    });
    expect(await p.send(message)).toMatchObject({
      delivered: false,
      retryable: true,
    });
    expect(await p.send(message)).toEqual({
      delivered: false,
      reason: 'resend:network_error',
      retryable: true,
    });
  });
});

describe('EmailService', () => {
  it('retries a transient failure once, and never more', async () => {
    const { client, calls } = fakeResend(new Error('ECONNRESET'), {
      data: { id: 'em_2' },
      error: null,
    });
    const svc = new EmailService(
      new ResendEmailProvider(client, 'x@y.z'),
      new AppConfig(env),
    );
    expect(await svc.send(message)).toMatchObject({ delivered: true });
    expect(calls).toHaveLength(2);

    const failing = fakeResend(new Error('down'), new Error('down'));
    const svc2 = new EmailService(
      new ResendEmailProvider(failing.client, 'x@y.z'),
      new AppConfig(env),
    );
    expect(await svc2.send(message)).toMatchObject({ delivered: false });
    expect(failing.calls).toHaveLength(2);
  });

  it('builds links on FRONTEND_URL with encoded tokens', () => {
    const svc = new EmailService(
      new ResendEmailProvider(fakeResend().client, 'x@y.z'),
      new AppConfig(env),
    );
    expect(svc.link('/verify-email', { token: 'a+b/c' })).toBe(
      'https://auctra.example/verify-email?token=a%2Bb%2Fc',
    );
  });
});

describe('templates', () => {
  it('escape user-controlled content', () => {
    const r = notificationEmail({
      appUrl: 'https://auctra.example',
      title: '<script>alert(1)</script>',
      body: 'Bid on "Rolex" & more',
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('&quot;Rolex&quot; &amp; more');
  });

  it('refuse non-http links', () => {
    expect(() =>
      verificationEmail({
        appUrl: 'https://auctra.example',
        link: 'javascript:alert(1)',
        code: '123456',
        ttlMinutes: 15,
      }),
    ).toThrow();
  });
});

describe('config', () => {
  it('selects Resend automatically when a key is present and requires a sender', () => {
    expect(
      () => new AppConfig({ ...env, RESEND_API_KEY: 're_test_123' }),
    ).toThrow(/RESEND_FROM_EMAIL/);
    const c = new AppConfig({
      ...env,
      RESEND_API_KEY: 're_test_123',
      RESEND_FROM_EMAIL: 'AUCTRA <onboarding@resend.dev>',
    });
    expect(c.emailProvider).toBe('resend');
    expect(c.appPublicUrl).toBe('https://auctra.example');
    expect(new AppConfig(env).emailProvider).toBe('log');
  });
});

it('redacts recipients in logs', () => {
  expect(redactEmail('narek@example.com')).toBe('n***@example.com');
});
