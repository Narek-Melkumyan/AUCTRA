import type {
  PutObjectOptions,
  StorageDriver,
  StoredObjectInfo,
} from '../src/storage/storage.types.js';

/**
 * In-memory stand-in for Cloudflare R2 used by the integration tests, with failure
 * injection for network errors. Behaves like the real store for everything the API
 * relies on (put/head/delete, idempotent delete, public URLs).
 */
export class FakeStorage implements StorageDriver {
  readonly provider = 'R2' as const;
  readonly objects = new Map<
    string,
    {
      body: Buffer;
      contentType: string;
      cacheControl: string;
      metadata?: Record<string, string>;
    }
  >();
  /** Return true to make the operation on that key fail like a network error. */
  failPut: (key: string) => boolean = () => false;
  failDelete: (key: string) => boolean = () => false;
  readonly calls: { op: string; key: string }[] = [];

  async put(key: string, body: Buffer, o: PutObjectOptions): Promise<void> {
    this.calls.push({ op: 'put', key });
    await new Promise((r) => setTimeout(r, 2));
    if (this.failPut(key)) throw networkError();
    this.objects.set(key, {
      body,
      contentType: o.contentType,
      cacheControl: o.cacheControl,
      ...(o.metadata ? { metadata: o.metadata } : {}),
    });
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    const o = this.objects.get(key);
    return o
      ? {
          key,
          contentType: o.contentType,
          contentLength: o.body.length,
          cacheControl: o.cacheControl,
          etag: undefined,
        }
      : null;
  }

  async delete(key: string): Promise<void> {
    this.calls.push({ op: 'delete', key });
    if (this.failDelete(key)) throw networkError();
    this.objects.delete(key);
  }

  publicUrl(key: string): string {
    return `https://media.test.auctra/${key}`;
  }

  keysUnder(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  reset() {
    this.objects.clear();
    this.calls.length = 0;
    this.failPut = () => false;
    this.failDelete = () => false;
  }
}

function networkError() {
  const e = new Error('connect ECONNRESET (simulated R2 outage)');
  e.name = 'TimeoutError';
  return e;
}
