/**
 * Listing photos as the UI uses them. Uploaded photos (Cloudflare R2 / dev storage) carry
 * three WebP variants; bundled demo images and external URLs use one URL for every size.
 */
export type Photo = {
  thumb: string;
  card: string;
  full: string;
  /** Real pixel widths of each variant (uploaded photos only) — used for srcset. */
  widths?: { thumb: number; card: number; full: number };
  /** Full-size dimensions, used as intrinsic size to avoid layout shift. */
  width?: number;
  height?: number;
  alt?: string;
  /** Attribution to show with third-party photos. */
  credit?: {
    author: string | null;
    license: string;
    licenseUrl: string | null;
    sourceUrl: string | null;
    notice?: string | null;
  };
};

export const photoFromUrl = (url: string, alt?: string): Photo => ({
  thumb: url,
  card: url,
  full: url,
  ...(alt ? { alt } : {}),
});

/** Photo i of a listing: its stored variants when present, else the plain image URL. */
export function photoOf(a: { images: string[]; photos?: Photo[] }, i = 0): Photo | undefined {
  const p = a.photos?.[i];
  if (p) return p;
  const url = a.images[i];
  return url ? photoFromUrl(url) : undefined;
}
