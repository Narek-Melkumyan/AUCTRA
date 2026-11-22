import sharp from 'sharp';
import { AppError } from '../common/errors.js';
import {
  ProcessingQueue,
  processImage,
  sniffFormat,
  type ProcessedImage,
} from './image-processor.js';

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxPixels: 40_000_000 };

/** A photo-like test image (gradient + noise, so encoders behave like on real photos). */
function photo(width: number, height: number, alpha = false) {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha
        ? { r: 180, g: 90, b: 40, alpha: 0.6 }
        : { r: 180, g: 90, b: 40 },
      noise: { type: 'gaussian', mean: 120, sigma: 30 },
    },
  });
}

async function rejectCode(
  p: Promise<unknown>,
): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    return { status: e.getStatus(), code: e.code };
  }
  throw new Error('expected rejection');
}

const variant = (r: ProcessedImage, name: string) =>
  r.variants.find((v) => v.name === name)!;

describe('processImage', () => {
  it('converts a valid JPEG into three WebP variants with metadata stripped', async () => {
    const input = await photo(2400, 1600)
      .jpeg({ quality: 90 })
      .withExif({ IFD0: { Make: 'TestCam', Copyright: 'someone' } })
      .toBuffer();
    const r = await processImage(input, LIMITS);
    expect(r.format).toBe('jpeg');
    expect(r.inputMime).toBe('image/jpeg');
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.variants.map((v) => [v.name, v.width, v.height])).toEqual([
      ['thumbnail', 320, 213],
      ['card', 800, 533],
      ['full', 1600, 1067],
    ]);
    for (const v of r.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.format).toBe('webp');
      expect(m.exif).toBeUndefined();
      expect(m.icc).toBeUndefined();
      expect(v.bytes).toBe(v.data.length);
    }
    // Lower quality and size → monotonically smaller files.
    expect(variant(r, 'thumbnail').bytes).toBeLessThan(
      variant(r, 'card').bytes,
    );
    expect(variant(r, 'card').bytes).toBeLessThan(variant(r, 'full').bytes);
  });

  it('accepts PNG and keeps transparency', async () => {
    const input = await photo(1000, 500, true).png().toBuffer();
    const r = await processImage(input, LIMITS);
    expect(r.format).toBe('png');
    expect(r.hasAlpha).toBe(true);
    const m = await sharp(variant(r, 'full').data).metadata();
    expect(m.hasAlpha).toBe(true);
    expect([m.width, m.height]).toEqual([1000, 500]);
  });

  it('accepts WebP and AVIF input', async () => {
    const webp = await processImage(
      await photo(900, 600).webp().toBuffer(),
      LIMITS,
    );
    expect(webp.format).toBe('webp');
    const avif = await processImage(
      await photo(900, 600).avif().toBuffer(),
      LIMITS,
    );
    expect(avif.format).toBe('avif');
    expect(avif.inputMime).toBe('image/avif');
    expect((await sharp(variant(avif, 'card').data).metadata()).format).toBe(
      'webp',
    );
  });

  it('applies EXIF orientation (a sideways phone photo comes out upright)', async () => {
    // Stored pixels are landscape 1200×800; orientation 6 means "rotate 90° clockwise".
    const input = await photo(1200, 800)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const r = await processImage(input, LIMITS);
    expect([r.sourceWidth, r.sourceHeight]).toEqual([800, 1200]);
    expect([variant(r, 'full').width, variant(r, 'full').height]).toEqual([
      800, 1200,
    ]);
    expect([
      variant(r, 'thumbnail').width,
      variant(r, 'thumbnail').height,
    ]).toEqual([320, 480]);
    const m = await sharp(variant(r, 'full').data).metadata();
    expect(m.orientation).toBeUndefined();
  });

  it('preserves aspect ratio and never upscales small images', async () => {
    const r = await processImage(
      await photo(600, 450).jpeg().toBuffer(),
      LIMITS,
    );
    expect(r.variants.map((v) => [v.name, v.width, v.height])).toEqual([
      ['thumbnail', 320, 240],
      ['card', 600, 450],
      ['full', 600, 450],
    ]);
  });

  it('caps very tall images at 3× the variant width', async () => {
    const r = await processImage(
      await photo(400, 4000).jpeg().toBuffer(),
      LIMITS,
    );
    const full = variant(r, 'full');
    expect(full.height).toBe(4000); // 400 wide → height cap 4800, so untouched
    const thumb = variant(r, 'thumbnail');
    expect(thumb.height).toBe(960); // 320×3
    expect(thumb.width).toBe(96);
  });

  it('rejects files over the size limit before decoding', async () => {
    const input = await photo(300, 300).png().toBuffer();
    expect(
      await rejectCode(
        processImage(input, { ...LIMITS, maxBytes: input.length - 1 }),
      ),
    ).toEqual({
      status: 413,
      code: 'IMAGE_TOO_LARGE',
    });
  });

  it('rejects non-images and spoofed types by content, not by name or MIME', async () => {
    expect(
      await rejectCode(
        processImage(Buffer.from('not an image at all, just text'), LIMITS),
      ),
    ).toEqual({ status: 415, code: 'UNSUPPORTED_IMAGE_TYPE' });
    // GIF and SVG decode with libvips but are not accepted formats.
    const gif = await photo(200, 200).gif().toBuffer();
    expect((await rejectCode(processImage(gif, LIMITS))).code).toBe(
      'UNSUPPORTED_IMAGE_TYPE',
    );
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"/>',
    );
    expect((await rejectCode(processImage(svg, LIMITS))).code).toBe(
      'UNSUPPORTED_IMAGE_TYPE',
    );
    expect((await rejectCode(processImage(Buffer.alloc(0), LIMITS))).code).toBe(
      'EMPTY_FILE',
    );
  });

  it('rejects corrupted and truncated images', async () => {
    const jpeg = await photo(1200, 900).jpeg().toBuffer();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 3));
    expect(await rejectCode(processImage(truncated, LIMITS))).toEqual({
      status: 422,
      code: 'INVALID_IMAGE',
    });
    // Valid PNG signature followed by garbage.
    const fake = Buffer.concat([
      jpeg.subarray(0, 0),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(200, 7),
    ]);
    expect((await rejectCode(processImage(fake, LIMITS))).code).toBe(
      'INVALID_IMAGE',
    );
  });

  it('rejects images whose header declares too many pixels (decompression-bomb guard)', async () => {
    const input = await photo(1500, 1000).jpeg().toBuffer();
    expect(
      await rejectCode(
        processImage(input, { ...LIMITS, maxPixels: 1_000_000 }),
      ),
    ).toEqual({
      status: 422,
      code: 'IMAGE_DIMENSIONS_TOO_LARGE',
    });
  });

  it('rejects images that are too small to be listing photos', async () => {
    const input = await photo(80, 400).png().toBuffer();
    expect((await rejectCode(processImage(input, LIMITS))).code).toBe(
      'IMAGE_TOO_SMALL',
    );
  });
});

describe('sniffFormat', () => {
  it('identifies formats from magic bytes', async () => {
    expect(sniffFormat(await photo(10, 10).jpeg().toBuffer())).toBe('jpeg');
    expect(sniffFormat(await photo(10, 10).png().toBuffer())).toBe('png');
    expect(sniffFormat(await photo(10, 10).webp().toBuffer())).toBe('webp');
    expect(sniffFormat(await photo(64, 64).avif().toBuffer())).toBe('avif');
    expect(sniffFormat(Buffer.from('GIF89a........'))).toBeNull();
  });
});

describe('ProcessingQueue', () => {
  it('bounds concurrency and refuses work beyond the queue limit', async () => {
    const q = new ProcessingQueue(2, 1);
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const job = () =>
      q.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((r) => gates.push(r));
        running--;
      });
    const a = job();
    const b = job();
    const c = job(); // waits
    await new Promise((r) => setTimeout(r, 5));
    expect(q.stats).toEqual({ active: 2, waiting: 1 });
    const err = await job().catch((e: AppError) => e);
    expect((err as AppError).code).toBe('MEDIA_BUSY');
    expect((err as AppError).getStatus()).toBe(503);
    while (gates.length || running) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all([a, b, c]);
    expect(peak).toBe(2);
    expect(q.stats).toEqual({ active: 0, waiting: 0 });
  });
});
