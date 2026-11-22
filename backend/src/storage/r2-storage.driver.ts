import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type {
  PutObjectOptions,
  StorageDriver,
  StoredObjectInfo,
} from './storage.types.js';

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** https://<ACCOUNT_ID>.r2.cloudflarestorage.com unless overridden (e.g. EU jurisdiction). */
  endpoint: string;
  /** r2.dev URL or a custom domain connected to the bucket. */
  publicBaseUrl: string;
}

/** Only `send` is used, which keeps the driver easy to test with a fake client. */
export type S3Like = Pick<S3Client, 'send'>;

export function createR2Client(opts: R2Options): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: opts.endpoint,
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
    // R2 does not need the SDK's default CRC32 request checksums; only send them when an
    // operation requires one (Cloudflare's recommended setting for SDK v3).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  });
}

/** Cloudflare R2 through its S3-compatible API (AWS SDK v3). */
export class R2StorageDriver implements StorageDriver {
  readonly provider = 'R2' as const;
  private readonly base: string;

  constructor(
    private readonly opts: R2Options,
    private readonly client: S3Like = createR2Client(opts),
  ) {
    this.base = opts.publicBaseUrl.replace(/\/+$/, '');
  }

  async put(key: string, body: Buffer, o: PutObjectOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: o.contentType,
        CacheControl: o.cacheControl,
        ...(o.metadata ? { Metadata: o.metadata } : {}),
      }),
    );
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      );
      return {
        key,
        contentType: r.ContentType,
        contentLength: r.ContentLength,
        cacheControl: r.CacheControl,
        etag: r.ETag,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // Single-object deletes: idempotent (204 for missing keys) and need no checksum header.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }),
    );
  }

  publicUrl(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}

function isNotFound(err: unknown): boolean {
  if (err instanceof S3ServiceException)
    return err.$metadata.httpStatusCode === 404 || err.name === 'NotFound';
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}
