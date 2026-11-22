import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { AppConfig } from '../config/app-config.js';
import { AppError } from '../common/errors.js';
import type { MetricsService } from '../metrics/metrics.service.js';
import {
  createR2Client,
  R2StorageDriver,
  type S3Like,
} from './r2-storage.driver.js';
import { StorageService, assertSafeKey } from './storage.service.js';
import { IMMUTABLE_CACHE_CONTROL } from './storage.types.js';
import { keyPrefixFor, variantKeys } from '../media/auction-images.service.js';

const R2 = {
  accountId: '0123456789abcdef0123456789abcdef',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'auctra',
  endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  publicBaseUrl: 'https://media.example.com/',
};

class FakeS3 implements S3Like {
  sent: unknown[] = [];
  respond: (cmd: unknown) => unknown = () => ({});
  send = (async (cmd: unknown) => {
    this.sent.push(cmd);
    return this.respond(cmd);
  }) as S3Like['send'];
}

describe('R2StorageDriver', () => {
  it('uploads with bucket, key, content type, length and immutable cache headers', async () => {
    const s3 = new FakeS3();
    const d = new R2StorageDriver(R2, s3);
    const body = Buffer.from('webp-bytes');
    await d.put('auctions/a/b/card.webp', body, {
      contentType: 'image/webp',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      metadata: { variant: 'card' },
    });
    const cmd = s3.sent[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: 'auctra',
      Key: 'auctions/a/b/card.webp',
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
      ContentLength: body.length,
      Metadata: { variant: 'card' },
    });
  });

  it('reads metadata and reports missing objects as null', async () => {
    const s3 = new FakeS3();
    const d = new R2StorageDriver(R2, s3);
    s3.respond = () => ({
      ContentType: 'image/webp',
      ContentLength: 42,
      CacheControl: 'x',
      ETag: '"e"',
    });
    expect(await d.head('auctions/a/b/full.webp')).toEqual({
      key: 'auctions/a/b/full.webp',
      contentType: 'image/webp',
      contentLength: 42,
      cacheControl: 'x',
      etag: '"e"',
    });
    expect(s3.sent[0]).toBeInstanceOf(HeadObjectCommand);
    s3.respond = () => {
      throw new S3ServiceException({
        name: 'NotFound',
        $fault: 'client',
        $metadata: { httpStatusCode: 404 },
      });
    };
    expect(await d.head('auctions/a/b/missing.webp')).toBeNull();
    s3.respond = () => {
      throw new S3ServiceException({
        name: 'InternalError',
        $fault: 'server',
        $metadata: { httpStatusCode: 500 },
      });
    };
    await expect(d.head('auctions/a/b/full.webp')).rejects.toThrow();
  });

  it('deletes single objects', async () => {
    const s3 = new FakeS3();
    await new R2StorageDriver(R2, s3).delete('auctions/a/b/thumbnail.webp');
    expect(s3.sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((s3.sent[0] as DeleteObjectCommand).input).toEqual({
      Bucket: 'auctra',
      Key: 'auctions/a/b/thumbnail.webp',
    });
  });

  it('builds public URLs from the configured base URL', () => {
    const d = new R2StorageDriver(R2, new FakeS3());
    expect(d.publicUrl('auctions/a/b/full.webp')).toBe(
      'https://media.example.com/auctions/a/b/full.webp',
    );
  });

  it('configures the S3 client for Cloudflare R2', async () => {
    const client = createR2Client(R2);
    expect(await client.config.region()).toBe('auto');
    const ep = await client.config.endpoint!();
    expect(`${ep.protocol}//${ep.hostname}`).toBe(R2.endpoint);
    expect(await client.config.requestChecksumCalculation()).toBe(
      'WHEN_REQUIRED',
    );
    client.destroy();
  });
});

describe('StorageService', () => {
  const metrics = {
    storageOps: { inc: () => undefined },
  } as unknown as MetricsService;

  it('only accepts server-shaped keys', () => {
    expect(() => assertSafeKey('auctions/0b9c/1d2e/full.webp')).not.toThrow();
    expect(() =>
      assertSafeKey('integration-tests/0b9c/auctions/1d2e/3f4a/card.webp'),
    ).not.toThrow();
    for (const bad of [
      '../etc/passwd',
      '/auctions/a/b.webp',
      'auctions/../../x',
      'auctions/A/B.webp',
      'auctions',
      'auctions//b.webp',
      'auctions/a/b c.webp',
      'auctions/a/.hidden',
      '-x/a/b.webp',
      'Integration-tests/a/b.webp',
    ])
      expect(() => assertSafeKey(bad), bad).toThrow();
  });

  it('builds object keys with an optional namespace', () => {
    expect(keyPrefixFor('a1', 'i1')).toBe('auctions/a1/i1/');
    expect(keyPrefixFor('a1', 'i1', 'integration-tests/r1')).toBe(
      'integration-tests/r1/auctions/a1/i1/',
    );
    expect(variantKeys('dev/auctions/a1/i1/')).toEqual([
      'dev/auctions/a1/i1/thumbnail.webp',
      'dev/auctions/a1/i1/card.webp',
      'dev/auctions/a1/i1/full.webp',
    ]);
  });

  it('refuses every operation with 503 when storage is not configured', async () => {
    const svc = new StorageService(null, metrics);
    expect(svc.enabled).toBe(false);
    const err = await svc
      .put('auctions/a/b/full.webp', Buffer.from('x'), {
        contentType: 'image/webp',
        cacheControl: 'x',
      })
      .catch((e: AppError) => e);
    expect((err as AppError).code).toBe('MEDIA_STORAGE_NOT_CONFIGURED');
    expect((err as AppError).getStatus()).toBe(503);
  });

  it('deleteMany attempts every key even if one fails', async () => {
    const s3 = new FakeS3();
    s3.respond = (cmd) => {
      if ((cmd as DeleteObjectCommand).input.Key?.endsWith('card.webp'))
        throw new Error('boom');
      return {};
    };
    const svc = new StorageService(new R2StorageDriver(R2, s3), metrics);
    await expect(
      svc.deleteMany([
        'auctions/a/b/thumbnail.webp',
        'auctions/a/b/card.webp',
        'auctions/a/b/full.webp',
      ]),
    ).rejects.toThrow('boom');
    expect(s3.sent).toHaveLength(3);
  });
});

describe('AppConfig media settings', () => {
  const base = {
    DATABASE_URL: 'postgresql://x@localhost/db',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    CSRF_SECRET: 'b'.repeat(40),
  };

  it('defaults to local disk in development and disabled elsewhere', () => {
    expect(
      new AppConfig({ ...base, NODE_ENV: 'development' }).mediaStorage,
    ).toBe('local');
    expect(new AppConfig({ ...base, NODE_ENV: 'test' }).mediaStorage).toBe(
      'disabled',
    );
  });

  it('switches to R2 when configured and derives the account endpoint', () => {
    const c = new AppConfig({
      ...base,
      R2_ACCOUNT_ID: R2.accountId,
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_PUBLIC_BASE_URL: 'https://pub-123.r2.dev/',
    });
    expect(c.mediaStorage).toBe('r2');
    expect(c.r2).toMatchObject({
      bucket: 'auctra',
      endpoint: `https://${R2.accountId}.r2.cloudflarestorage.com`,
      publicBaseUrl: 'https://pub-123.r2.dev',
    });
  });

  it('accepts an optional key namespace and rejects unsafe ones', () => {
    expect(new AppConfig(base).mediaKeyPrefix).toBe('');
    expect(
      new AppConfig({ ...base, MEDIA_KEY_PREFIX: '/integration-tests/abc-1/' })
        .mediaKeyPrefix,
    ).toBe('integration-tests/abc-1');
    for (const bad of ['../x', 'Dev', 'a b', 'a/b/c/d/e', 'a//b', 'x.y'])
      expect(
        () => new AppConfig({ ...base, MEDIA_KEY_PREFIX: bad }),
        bad,
      ).toThrow(/MEDIA_KEY_PREFIX/);
  });

  it('fails fast on incomplete R2 settings and refuses local storage in production', () => {
    expect(
      () => new AppConfig({ ...base, R2_ACCOUNT_ID: R2.accountId }),
    ).toThrow(
      /R2_ACCESS_KEY_ID is required[\s\S]*R2_PUBLIC_BASE_URL is required/,
    );
    expect(
      () =>
        new AppConfig({
          ...base,
          MEDIA_STORAGE: 'r2',
          R2_ACCOUNT_ID: R2.accountId,
          R2_ACCESS_KEY_ID: 'k',
          R2_SECRET_ACCESS_KEY: 's',
          R2_PUBLIC_BASE_URL: 'http://insecure.example.com',
        }),
    ).toThrow(/R2_PUBLIC_BASE_URL must be an https/);
    expect(
      () =>
        new AppConfig({
          ...base,
          NODE_ENV: 'production',
          MEDIA_STORAGE: 'local',
          COOKIE_SECURE: 'true',
          IP_HASH_SALT: 'salt',
          EMAIL_PROVIDER: 'disabled',
        }),
    ).toThrow(/MEDIA_STORAGE=local is not allowed in production/);
  });
});
