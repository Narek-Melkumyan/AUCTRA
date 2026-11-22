/**
 * Wikimedia Commons helpers for the demo catalog: search, license filtering and
 * attribution. Only freely licensed files are accepted (CC0, public domain, CC BY, CC BY-SA);
 * non-commercial, no-derivatives and GFDL-only files are rejected.
 */
export const USER_AGENT =
  'AUCTRA-demo-catalog/1.0 (local development seed for a non-commercial portfolio project)';

export type CommonsImage = {
  file: string;
  /** Rendition at ≤1600 px wide (what we download). */
  url: string;
  width: number;
  height: number;
  author: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
};

const ALLOWED = [
  /^CC0/i,
  /^Public domain/i,
  /^PD/i,
  /^CC BY(-SA)? \d(\.\d)?( [a-z-]+)?$/i,
];

export function licenseAllowed(name: string): boolean {
  return ALLOWED.some((r) => r.test(name.trim())) && !/NC|ND/i.test(name);
}

/** Plain-text author from Commons' HTML "Artist" field. */
export function plainAuthor(html: string | undefined): string {
  const text = (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return (text || 'Unknown author').slice(0, 300);
}

type ApiPage = {
  title: string;
  imageinfo?: {
    width: number;
    height: number;
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    descriptionurl: string;
    extmetadata?: Record<string, { value: string }>;
  }[];
};

export async function searchCommons(
  query: string,
  limit = 20,
): Promise<CommonsImage[]> {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: `${query} filetype:bitmap`,
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist',
    iiurlwidth: '1600',
  }).toString();
  const res = await politeFetch(u);
  if (!res.ok) throw new Error(`Commons search failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    query?: { pages?: Record<string, ApiPage & { index: number }> };
  };
  const pages = Object.values(body.query?.pages ?? {}).sort(
    (a, b) => a.index - b.index,
  );
  const out: CommonsImage[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    const meta = ii?.extmetadata ?? {};
    const license = meta['LicenseShortName']?.value ?? '';
    if (!ii?.thumburl || !licenseAllowed(license)) continue;
    out.push({
      file: p.title,
      url: scaledUrl(ii.thumburl, ii.width),
      width: ii.width,
      height: ii.height,
      author: plainAuthor(meta['Artist']?.value),
      license,
      licenseUrl: meta['LicenseUrl']?.value ?? null,
      sourceUrl: ii.descriptionurl,
    });
  }
  return out;
}

/** Wikimedia's standard thumbnail widths (pre-rendered and cached at the edge). */
const THUMB_STEPS = [1280, 960, 500, 330] as const;

/**
 * When a file is narrower than the requested width, Commons returns the ORIGINAL file's URL
 * instead of a thumbnail — and upload.wikimedia.org throttles original downloads from
 * scripts (HTTP 429, Retry-After: 600) while serving thumbnails freely. Rewrite such a URL
 * to the largest standard thumbnail step below the original width.
 */
export function scaledUrl(url: string, width: number): string {
  const u = new URL(url);
  if (u.pathname.includes('/thumb/')) return url;
  const step = THUMB_STEPS.find((w) => w < width);
  const m = /^(\/wikipedia\/commons)\/(.+\/)([^/]+)$/.exec(u.pathname);
  if (!step || !m) return url;
  const [, root, dirs, name] = m;
  const suffix = /\.tiff?$/i.test(name) ? '.jpg' : '';
  return `${u.origin}${root}/thumb/${dirs}${name}/${step}px-${name}${suffix}`;
}

/**
 * GET with Wikimedia's etiquette: identifying User-Agent, and on 429/503 wait (honouring
 * Retry-After) and retry a few times with exponential backoff.
 */
export async function politeFetch(
  url: URL | string,
  attempts = 6,
): Promise<Response> {
  for (let i = 0; ; i++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      // Timeouts and connection resets are retried like 429/503.
      if (i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
      continue;
    }
    if ((res.status !== 429 && res.status !== 503) || i >= attempts - 1)
      return res;
    const after = Number(res.headers.get('retry-after'));
    const wait =
      Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** i;
    // Honour Retry-After in full (Wikimedia asks for 120–600 s when throttling); cap at
    // 10 minutes so a misconfigured header cannot stall the seed indefinitely.
    await new Promise((r) => setTimeout(r, Math.min(wait, 600_000)));
  }
}
