import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { AppError, Errors } from '../common/errors.js';
import { HttpStatus } from '@nestjs/common';

// Server defaults: no libvips operation cache (memory stays predictable under bursts of
// uploads); concurrency per image is bounded separately by ImageProcessor.
sharp.cache(false);

export type VariantName = 'thumbnail' | 'card' | 'full';

/**
 * Output variants. Widths are upper bounds: images are never enlarged. Height is capped at
 * 3x the width so extreme panoramas stay inside WebP's 16383 px limit and a sane file size.
 */
export const VARIANTS: readonly {
  name: VariantName;
  maxWidth: number;
  quality: number;
}[] = [
  { name: 'thumbnail', maxWidth: 320, quality: 75 },
  { name: 'card', maxWidth: 800, quality: 80 },
  { name: 'full', maxWidth: 1600, quality: 85 },
];

export type InputFormat = 'jpeg' | 'png' | 'webp' | 'avif';

export const INPUT_MIME: Record<InputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

export const MIN_DIMENSION = 100;

export interface ProcessedVariant {
  name: VariantName;
  data: Buffer;
  width: number;
  height: number;
  bytes: number;
}

export interface ProcessedImage {
  format: InputFormat;
  inputMime: string;
  inputBytes: number;
  /** Source dimensions after EXIF orientation. */
  sourceWidth: number;
  sourceHeight: number;
  hasAlpha: boolean;
  /** SHA-256 of the uploaded bytes. */
  contentHash: string;
  variants: ProcessedVariant[];
}

export interface ImageLimits {
  maxBytes: number;
  maxPixels: number;
}

/**
 * Identifies the format from the file's own bytes (magic numbers), ignoring the client's
 * Content-Type and file name, which are trivially spoofed.
 */
export function sniffFormat(buf: Buffer): InputFormat | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp';
  // ISO-BMFF: [size]ftyp<brand>; AVIF uses the avif (still) or avis (sequence) brand.
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const size = buf.readUInt32BE(0);
    const end = Math.min(buf.length, size >= 16 && size <= 4096 ? size : 32);
    const brands = [buf.toString('latin1', 8, 12)];
    for (let i = 16; i + 4 <= end; i += 4)
      brands.push(buf.toString('latin1', i, i + 4));
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'avif';
  }
  return null;
}

const invalid = (message: string, code = 'INVALID_IMAGE') =>
  Errors.unprocessable(code, message);

/**
 * Validates an uploaded image and encodes the WebP variants. Throws AppError with a
 * stable code for every rejection; never returns partially processed output.
 */
export async function processImage(
  input: Buffer,
  limits: ImageLimits,
): Promise<ProcessedImage> {
  if (input.length === 0) throw invalid('The file is empty.', 'EMPTY_FILE');
  if (input.length > limits.maxBytes)
    throw new AppError(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'IMAGE_TOO_LARGE',
      `Images must be ${Math.round(limits.maxBytes / 1024 / 1024)} MB or smaller.`,
    );

  const format = sniffFormat(input);
  if (!format)
    throw new AppError(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'UNSUPPORTED_IMAGE_TYPE',
      'Upload a JPEG, PNG, WebP or AVIF image.',
    );

  const open = () =>
    sharp(input, {
      // Hard ceiling enforced by libvips while decoding (decompression-bomb guard).
      limitInputPixels: limits.maxPixels,
      // Reject truncated or corrupt data instead of encoding a half-decoded image.
      failOn: 'error',
      animated: false,
    });

  let meta: Metadata;
  try {
    meta = await open().metadata();
  } catch (err) {
    // libvips checks limitInputPixels from the header, before decoding any pixels.
    if (/pixel limit/i.test((err as Error).message ?? ''))
      throw invalid(
        `The image is too large. Maximum is ${Math.round(limits.maxPixels / 1e6)} megapixels.`,
        'IMAGE_DIMENSIONS_TOO_LARGE',
      );
    throw invalid('The file is not a readable image.');
  }
  const decoded =
    meta.format === 'heif'
      ? meta.compression === 'av1'
        ? 'avif'
        : null
      : meta.format;
  if (decoded !== format)
    throw new AppError(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'UNSUPPORTED_IMAGE_TYPE',
      'Upload a JPEG, PNG, WebP or AVIF image.',
    );
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  // Checked from the header before any pixel is decoded.
  if (w * h > limits.maxPixels)
    throw invalid(
      `The image is too large (${w}×${h}). Maximum is ${Math.round(limits.maxPixels / 1e6)} megapixels.`,
      'IMAGE_DIMENSIONS_TOO_LARGE',
    );
  if (w < MIN_DIMENSION || h < MIN_DIMENSION)
    throw invalid(
      `Images must be at least ${MIN_DIMENSION}×${MIN_DIMENSION} pixels.`,
      'IMAGE_TOO_SMALL',
    );

  // EXIF orientations 5–8 swap width and height.
  const rotated = (meta.orientation ?? 1) >= 5;
  const sourceWidth = rotated ? h : w;
  const sourceHeight = rotated ? w : h;
  const hasAlpha = Boolean(meta.hasAlpha);

  // Target sizes are computed from the original (oriented) dimensions so every variant
  // keeps the source aspect ratio exactly, without rounding drift between variants.
  const target = (maxWidth: number) => {
    const scale = Math.min(
      1,
      maxWidth / sourceWidth,
      (maxWidth * 3) / sourceHeight,
    );
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
      fit: 'fill' as const,
    };
  };
  const variants: ProcessedVariant[] = [];
  try {
    // Decode the original exactly once, straight to the largest variant's size (JPEG
    // shrink-on-load makes this cheap). The raw buffer is at most 1600×4800×4 bytes.
    const largest = VARIANTS[VARIANTS.length - 1]!;
    const base = await open()
      .rotate() // apply EXIF orientation, then drop the tag
      .resize(target(largest.maxWidth))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = {
      width: base.info.width,
      height: base.info.height,
      channels: base.info.channels,
    };
    for (const v of VARIANTS) {
      const { data, info } = await sharp(base.data, { raw })
        .resize(target(v.maxWidth))
        .webp({
          quality: v.quality,
          alphaQuality: 90,
          smartSubsample: true,
          effort: 4,
        })
        // No withMetadata(): EXIF (incl. GPS), XMP and IPTC are stripped; colours are
        // converted to sRGB.
        .toBuffer({ resolveWithObject: true });
      variants.push({
        name: v.name,
        data,
        width: info.width,
        height: info.height,
        bytes: info.size,
      });
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = (err as Error).message ?? '';
    if (/pixel limit/i.test(msg))
      throw invalid(
        'The image has too many pixels.',
        'IMAGE_DIMENSIONS_TOO_LARGE',
      );
    throw invalid('The image data is corrupted or incomplete.');
  }

  return {
    format,
    inputMime: INPUT_MIME[format],
    inputBytes: input.length,
    sourceWidth,
    sourceHeight,
    hasAlpha,
    contentHash: createHash('sha256').update(input).digest('hex'),
    variants,
  };
}

/**
 * Bounds simultaneous image processing so a burst of uploads cannot exhaust memory or
 * CPU: at most `concurrency` images are decoded at once, up to `queueMax` wait, and the
 * rest are refused with a retryable 503.
 */
export class ProcessingQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly queueMax: number,
  ) {}

  get stats() {
    return { active: this.active, waiting: this.waiting.length };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.queueMax)
        throw Errors.unavailable(
          'MEDIA_BUSY',
          'The server is processing many images right now. Try again in a moment.',
        );
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
