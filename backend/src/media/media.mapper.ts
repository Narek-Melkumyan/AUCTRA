import type { ListingMedia } from '../generated/prisma/client.js';
import type { VariantName } from './image-processor.js';

/** Shape of `listing_media.variants` for stored images. Keys never leave the server. */
export type StoredVariants = Record<
  VariantName,
  { key: string; url: string; width: number; height: number; bytes: number }
>;

export interface ImageVariantDto {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

export type MediaRow = Pick<
  ListingMedia,
  | 'id'
  | 'url'
  | 'type'
  | 'altText'
  | 'position'
  | 'isPrimary'
  | 'storage'
  | 'width'
  | 'height'
  | 'mimeType'
  | 'bytes'
  | 'variants'
  | 'createdAt'
  | 'updatedAt'
> &
  Partial<
    Pick<
      ListingMedia,
      | 'creditAuthor'
      | 'creditLicense'
      | 'creditLicenseUrl'
      | 'creditSourceUrl'
      | 'creditNotice'
    >
  >;

/**
 * Public image metadata. `url` is always the full-size image (unchanged for existing
 * clients); `variants` is present for uploaded images so clients can pick the smallest
 * size that fits (thumbnail 320 px, card 800 px, full 1600 px — never upscaled).
 */
export function toImageDto(m: MediaRow) {
  const v = m.variants as StoredVariants | null;
  const variant = (name: VariantName): ImageVariantDto => ({
    url: v![name].url,
    width: v![name].width,
    height: v![name].height,
    bytes: v![name].bytes,
  });
  return {
    id: m.id,
    url: m.url,
    type: m.type,
    altText: m.altText,
    position: m.position,
    isPrimary: m.isPrimary,
    storage: m.storage.toLowerCase() as 'external' | 'bundled' | 'r2' | 'local',
    width: m.width,
    height: m.height,
    mimeType: m.mimeType,
    bytes: m.bytes,
    variants: v
      ? {
          thumbnail: variant('thumbnail'),
          card: variant('card'),
          full: variant('full'),
        }
      : null,
    /** Attribution for third-party (e.g. Wikimedia Commons) photos; null for own uploads. */
    credit: m.creditLicense
      ? {
          author: m.creditAuthor ?? null,
          license: m.creditLicense,
          licenseUrl: m.creditLicenseUrl ?? null,
          sourceUrl: m.creditSourceUrl ?? null,
          notice: m.creditNotice ?? null,
        }
      : null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export type ImageDto = ReturnType<typeof toImageDto>;

/** Best URL for a small card/list preview: the 800 px variant when one exists. */
export function cardUrl(m: Pick<ListingMedia, 'url' | 'variants'>): string {
  return (m.variants as StoredVariants | null)?.card.url ?? m.url;
}
