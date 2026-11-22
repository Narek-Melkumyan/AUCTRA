import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  PutObjectOptions,
  StorageDriver,
  StoredObjectInfo,
} from './storage.types.js';

const TYPES: Record<string, string> = { '.webp': 'image/webp' };

/**
 * Development-only object store on the API server's disk, served at /media by the API
 * (see bootstrap.ts). It exists so the upload flow can be exercised without Cloudflare
 * credentials; configuration refuses it in production.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly provider = 'LOCAL' as const;
  readonly root: string;
  private readonly base: string;

  constructor(dir: string, publicBaseUrl: string) {
    this.root = path.resolve(dir);
    this.base = publicBaseUrl.replace(/\/+$/, '');
  }

  private pathOf(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep))
      throw new Error('Key resolves outside the storage directory');
    return p;
  }

  async put(key: string, body: Buffer, _o: PutObjectOptions): Promise<void> {
    const p = this.pathOf(key);
    await mkdir(path.dirname(p), { recursive: true });
    // Write-then-rename so a reader never sees a half-written file.
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, body, { flag: 'wx' });
    await rename(tmp, p);
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const s = await stat(this.pathOf(key));
      return {
        key,
        contentType: TYPES[path.extname(key)],
        contentLength: s.size,
        cacheControl: undefined,
        etag: undefined,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.pathOf(key);
    await rm(p, { force: true });
    // Remove now-empty image/auction folders; ignore "not empty".
    for (let dir = path.dirname(p); dir.startsWith(this.root + path.sep);) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  publicUrl(key: string): string {
    return `${this.base}/${key}`;
  }
}
