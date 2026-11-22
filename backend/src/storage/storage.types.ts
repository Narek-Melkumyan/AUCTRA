/** Object metadata returned by a HEAD request. */
export interface StoredObjectInfo {
  key: string;
  contentType: string | undefined;
  contentLength: number | undefined;
  cacheControl: string | undefined;
  etag: string | undefined;
}

export interface PutObjectOptions {
  contentType: string;
  cacheControl: string;
  /** Small, non-sensitive x-amz-meta-* values (never user-controlled file names). */
  metadata?: Record<string, string>;
}

/**
 * A minimal object store. Implementations: Cloudflare R2 (S3 API) and a development-only
 * local disk store. Keys are always generated and validated by StorageService.
 */
export interface StorageDriver {
  readonly provider: 'R2' | 'LOCAL';
  put(key: string, body: Buffer, opts: PutObjectOptions): Promise<void>;
  /** Resolves null when the object does not exist. */
  head(key: string): Promise<StoredObjectInfo | null>;
  /** Deleting a key that does not exist is not an error. */
  delete(key: string): Promise<void>;
  /** Public URL for objects that are meant to be public (auction images only). */
  publicUrl(key: string): string;
}

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');

/** Variant objects are immutable: every upload gets a new random key, nothing is overwritten. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
