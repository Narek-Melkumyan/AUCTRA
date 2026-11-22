import { CATEGORIES } from '../reference-data.js';
import { FULL_CATALOG as CATALOG, DEMO_BUYERS, SELLERS } from './index.js';
import { licenseAllowed, plainAuthor, scaledUrl } from './commons.js';

describe('demo catalogue data', () => {
  it('has 200–250 lots with unique stable keys and one distinct photo each', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(200);
    expect(CATALOG.length).toBeLessThanOrEqual(250);
    expect(new Set(CATALOG.map((l) => l.key)).size).toBe(CATALOG.length);
    expect(new Set(CATALOG.map((l) => l.file)).size).toBe(CATALOG.length);
    for (const l of CATALOG) {
      expect(l.key, l.key).toMatch(/^[a-z0-9-]{3,80}$/);
      expect(l.file, l.key).toMatch(/^File:.+\.(jpe?g|png|tif)$/i);
    }
  });

  it('uses existing categories, subcategories and attributes (required ones present)', () => {
    for (const l of CATALOG) {
      const cat = CATEGORIES.find((c) => c.slug === l.category);
      expect(cat, l.key).toBeDefined();
      if (l.subcategory)
        expect(
          cat!.children?.some((s) => s.slug === l.subcategory),
          `${l.key}: ${l.subcategory}`,
        ).toBe(true);
      const defs = cat!.attributes ?? [];
      for (const key of Object.keys(l.attributes))
        expect(
          defs.some((d) => d.key === key),
          `${l.key}: ${key}`,
        ).toBe(true);
      for (const d of defs.filter((x) => x.required))
        expect(l.attributes[d.key], `${l.key} needs ${d.key}`).toBeDefined();
      for (const d of defs.filter(
        (x) => x.options && l.attributes[x.key] !== undefined,
      ))
        expect(d.options, `${l.key}: ${d.key}`).toContain(l.attributes[d.key]);
    }
  });

  it('has realistic, consistent pricing and schedules', () => {
    for (const l of CATALOG) {
      expect(l.start, l.key).toBeGreaterThan(0);
      expect(l.increment, l.key).toBeGreaterThan(0);
      expect(l.increment, l.key).toBeLessThanOrEqual(
        Math.max(5, l.start * 0.1),
      );
      if (l.reserve !== undefined)
        expect(l.reserve, l.key).toBeGreaterThan(l.start);
      if (l.plan === 'live' || l.plan === 'upcoming')
        expect(l.hours, l.key).toBeGreaterThan(0);
      if (l.plan === 'upcoming') expect(l.bids ?? 0, l.key).toBe(0);
      if (l.vehicle) expect(l.category, l.key).toBe('cars');
      if (l.watch) expect(l.category, l.key).toBe('watches');
    }
  });

  it('mixes live, upcoming and completed lots in every category', () => {
    for (const c of CATEGORIES) {
      const lots = CATALOG.filter((l) => l.category === c.slug);
      expect(lots.length, c.slug).toBeGreaterThanOrEqual(8);
      expect(
        lots.some((l) => l.plan === 'live'),
        c.slug,
      ).toBe(true);
      expect(
        lots.some((l) => l.plan === 'upcoming'),
        c.slug,
      ).toBe(true);
      expect(
        lots.some((l) => l.plan === 'sold' || l.plan === 'unsold'),
        c.slug,
      ).toBe(true);
    }
  });

  it('uses only fictional demo accounts', () => {
    for (const s of Object.values(SELLERS))
      expect(s.email).toMatch(/@demo\.auctra\.local$/);
    for (const [email] of DEMO_BUYERS)
      expect(email).toMatch(/@demo\.auctra\.local$/);
  });
});

describe('Commons license filter', () => {
  it('accepts free licenses and rejects NC, ND and unknown ones', () => {
    for (const ok of [
      'CC0',
      'Public domain',
      'CC BY 4.0',
      'CC BY-SA 2.0 de',
      'CC BY-SA 3.0',
    ])
      expect(licenseAllowed(ok), ok).toBe(true);
    for (const bad of [
      'CC BY-NC 2.0',
      'CC BY-NC-SA 4.0',
      'CC BY-ND 4.0',
      'GFDL',
      'All rights reserved',
      '',
    ])
      expect(licenseAllowed(bad), bad).toBe(false);
  });

  it('turns HTML author credits into plain text', () => {
    expect(
      plainAuthor('<a href="//x">Matti&#39;s &amp; Co</a> <span>photos</span>'),
    ).toBe("Matti's & Co photos");
    expect(plainAuthor(undefined)).toBe('Unknown author');
  });
});

describe('scaledUrl', () => {
  const orig =
    'https://upload.wikimedia.org/wikipedia/commons/f/fa/Vacheron_Constantin_Historique_222.jpg?utm_content=thumbnail_unscaled';
  it('rewrites an unscaled original to the largest standard thumbnail below its width', () => {
    expect(scaledUrl(orig, 1500)).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Vacheron_Constantin_Historique_222.jpg/1280px-Vacheron_Constantin_Historique_222.jpg',
    );
    expect(scaledUrl(orig, 1280)).toContain('/960px-');
  });
  it('leaves thumbnails, tiny originals and other hosts alone', () => {
    const thumb =
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/1600px-X.jpg';
    expect(scaledUrl(thumb, 4000)).toBe(thumb);
    expect(scaledUrl(orig, 300)).toBe(orig);
    expect(scaledUrl('https://example.com/a.jpg', 2000)).toBe(
      'https://example.com/a.jpg',
    );
  });
  it('requests a JPEG rendition for TIFF originals', () => {
    expect(
      scaledUrl(
        'https://upload.wikimedia.org/wikipedia/commons/1/12/Scan.tif',
        1400,
      ),
    ).toMatch(/\/1280px-Scan\.tif\.jpg$/);
  });
});
