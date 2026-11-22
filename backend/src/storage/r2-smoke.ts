/**
 * Live Cloudflare R2 smoke test — runs the real image pipeline against the configured
 * bucket and cleans up after itself.
 *
 *   npm run r2:smoke
 *
 * What it does:
 *  1. Generates a harmless synthetic photo (a sideways "phone photo" with EXIF
 *     orientation 6 and a red marker in the corner that should end up top-left).
 *  2. Runs it through processImage (the same Sharp pipeline as uploads).
 *  3. Uploads the three WebP variants through StorageService under a unique prefix
 *     `integration-tests/<uuid>/` with `purpose=integration-test` object metadata.
 *  4. Verifies each object with HeadObject, GetObject (decoded with Sharp) and its public
 *     URL, and that nothing but the three variants exists under the prefix.
 *  5. Deletes exactly the keys it uploaded (also on failure) and verifies they are gone.
 *
 * It never lists, reads or deletes anything outside its own prefix and never prints
 * credentials. Exit code 0 = every check passed.
 */
import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { AppConfig } from '../config/app-config.js';
import type { MetricsService } from '../metrics/metrics.service.js';
import { processImage } from '../media/image-processor.js';
import { createR2Client, R2StorageDriver } from './r2-storage.driver.js';
import { StorageService } from './storage.service.js';
import { IMMUTABLE_CACHE_CONTROL } from './storage.types.js';

Logger.overrideLogger(['warn', 'error']);

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
}
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** Portrait 1600×2400 scene with a red block top-left, stored sideways + orientation 6. */
async function sidewaysPhoto(): Promise<Buffer> {
  const W = 1600;
  const H = 2400;
  const scene = await sharp({
    create: {
      width: W,
      height: H,
      channels: 3,
      background: { r: 70, g: 110, b: 150 },
      noise: { type: 'gaussian', mean: 128, sigma: 25 },
    },
  })
    // Soften the noise so the encoder sees photo-like texture (pure noise is incompressible).
    .blur(2)
    .composite([
      {
        input: {
          create: {
            width: 300,
            height: 300,
            channels: 3,
            background: { r: 230, g: 20, b: 20 },
          },
        },
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  // Store the pixels rotated 90° counter-clockwise; orientation 6 tells viewers to rotate
  // them 90° clockwise again, exactly like a phone held upright.
  return sharp(scene)
    .rotate(-90)
    .jpeg({ quality: 88 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

async function main() {
  const config = new AppConfig(process.env);
  if (config.mediaStorage !== 'r2' || !config.r2) {
    console.error(
      `MEDIA_STORAGE resolves to "${config.mediaStorage}", not "r2". Set the R2_* variables in backend/.env first.`,
    );
    process.exit(2);
  }
  const r2 = config.r2;
  const endpointHost = new URL(r2.endpoint).hostname.replace(
    /^[0-9a-f]{32}/,
    '<account-id>',
  );
  console.log(
    `Bucket: ${r2.bucket}\nEndpoint: https://${endpointHost} (region auto)\nPublic base URL: ${r2.publicBaseUrl}\n`,
  );

  const client: S3Client = createR2Client(r2);
  const metrics = {
    storageOps: { inc: () => undefined },
  } as unknown as MetricsService;
  const storage = new StorageService(new R2StorageDriver(r2, client), metrics);
  const runId = randomUUID();
  const prefix = `integration-tests/${runId}/`;
  console.log(`Test prefix: ${prefix}\n`);
  const uploaded: string[] = [];

  const listPrefix = async () => {
    const r = await client.send(
      new ListObjectsV2Command({ Bucket: r2.bucket, Prefix: prefix }),
    );
    return (r.Contents ?? []).map((o) => o.Key!).sort();
  };

  try {
    // 1. Connectivity + permissions (list is scoped to our unique, still-empty prefix).
    try {
      const before = await listPrefix();
      check('connect and list (scoped to test prefix)', before.length === 0);
    } catch (err) {
      const e = err as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      check(
        'connect and list (scoped to test prefix)',
        false,
        `${e.name} HTTP ${e.$metadata?.httpStatusCode ?? '?'}`,
      );
      throw err;
    }

    // 2. Real Sharp pipeline.
    const input = await sidewaysPhoto();
    const inMeta = await sharp(input).metadata();
    const started = performance.now();
    const processed = await processImage(input, {
      maxBytes: config.mediaMaxUploadBytes,
      maxPixels: config.mediaMaxPixels,
    });
    const ms = Math.round(performance.now() - started);
    console.log(
      `Input: JPEG ${inMeta.width}×${inMeta.height} stored, EXIF orientation ${inMeta.orientation}, ${kb(input.length)}; processed in ${ms} ms\n`,
    );
    check(
      'EXIF orientation applied (source is upright portrait 1600×2400)',
      processed.sourceWidth === 1600 && processed.sourceHeight === 2400,
      `${processed.sourceWidth}×${processed.sourceHeight}`,
    );

    // 3. Upload through the application's StorageService.
    for (const v of processed.variants) {
      const key = `${prefix}${v.name}.webp`;
      await storage.put(key, v.data, {
        contentType: 'image/webp',
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        metadata: {
          purpose: 'integration-test',
          'run-id': runId,
          variant: v.name,
        },
      });
      uploaded.push(key);
    }
    check('uploaded three variants', uploaded.length === 3);

    // 4. Verify every object.
    const expected = {
      thumbnail: [320, 480],
      card: [800, 1200],
      full: [1600, 2400],
    };
    const rows: string[] = [];
    for (const v of processed.variants) {
      const key = `${prefix}${v.name}.webp`;
      const head = await storage.head(key);
      check(
        `${v.name}: HeadObject content-type/length/cache-control`,
        head?.contentType === 'image/webp' &&
          head.contentLength === v.bytes &&
          head.cacheControl === IMMUTABLE_CACHE_CONTROL,
        `${head?.contentType}, ${head?.contentLength} B, "${head?.cacheControl}"`,
      );

      const got = await client.send(
        new GetObjectCommand({ Bucket: r2.bucket, Key: key }),
      );
      const body = Buffer.from(await got.Body!.transformToByteArray());
      const m = await sharp(body).metadata();
      const [ew, eh] = expected[v.name];
      check(
        `${v.name}: GetObject decodes as WebP ${ew}×${eh}, no EXIF/ICC`,
        m.format === 'webp' &&
          m.width === ew &&
          m.height === eh &&
          !m.exif &&
          !m.icc &&
          !m.orientation,
        `${m.format} ${m.width}×${m.height}`,
      );
      check(
        `${v.name}: object metadata labelled`,
        got.Metadata?.['purpose'] === 'integration-test' &&
          got.Metadata?.['run-id'] === runId,
      );
      // Red marker must be top-left after orientation was applied.
      const { data } = await sharp(body)
        .extract({
          left: 2,
          top: 2,
          width: 4,
          height: 4,
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      check(
        `${v.name}: upright (marker top-left)`,
        data[0]! > 180 && data[1]! < 80 && data[2]! < 80,
        `rgb(${data[0]},${data[1]},${data[2]})`,
      );

      const url = storage.publicUrl(key);
      const res = await fetch(url);
      const pub = Buffer.from(await res.arrayBuffer());
      const same =
        createHash('sha256').update(pub).digest('hex') ===
        createHash('sha256').update(v.data).digest('hex');
      check(
        `${v.name}: public URL serves the object`,
        res.status === 200 &&
          res.headers.get('content-type') === 'image/webp' &&
          same,
        `HTTP ${res.status}, ${res.headers.get('content-type')}, cache-control "${res.headers.get('cache-control')}"`,
      );
      rows.push(
        `  ${v.name.padEnd(9)} ${`${v.width}×${v.height}`.padEnd(10)} ${kb(v.bytes).padStart(9)}  ${url}`,
      );
    }
    const ratio = processed.sourceWidth / processed.sourceHeight;
    check(
      'aspect ratio preserved in every variant',
      processed.variants.every(
        (v) => Math.abs(v.width / v.height - ratio) < 0.01,
      ),
    );
    check(
      'variant sizes reasonable (each < input, monotonically increasing)',
      processed.variants.every((v) => v.bytes < input.length) &&
        processed.variants[0]!.bytes < processed.variants[1]!.bytes &&
        processed.variants[1]!.bytes < processed.variants[2]!.bytes,
    );
    const listed = await listPrefix();
    check(
      'only the three variants exist under the prefix (no original stored)',
      JSON.stringify(listed) === JSON.stringify([...uploaded].sort()),
      listed.map((k) => k.slice(prefix.length)).join(', '),
    );
    console.log(`\nVariants:\n${rows.join('\n')}\n`);
  } finally {
    // 5. Remove exactly what this run uploaded.
    if (uploaded.length) {
      await storage.deleteMany(uploaded);
      const left = await Promise.all(uploaded.map((k) => storage.head(k)));
      check(
        'cleanup: deleted only the objects this run created',
        left.every((h) => h === null),
        `${uploaded.length} deleted`,
      );
      check('cleanup: test prefix is empty', (await listPrefix()).length === 0);
    }
    client.destroy();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed against bucket "${r2.bucket}".`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err: unknown) => {
  const e = err as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  console.error(
    `\nR2 smoke test aborted: ${e.name ?? 'Error'} ${e.$metadata?.httpStatusCode ? `HTTP ${e.$metadata.httpStatusCode} ` : ''}${(e.message ?? '').slice(0, 200)}`,
  );
  process.exit(1);
});
