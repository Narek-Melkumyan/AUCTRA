// Checks every catalog file exists on Commons and is freely licensed. Prints problems only.
import { FULL_CATALOG as CATALOG } from './index.js';
import { licenseAllowed, plainAuthor, politeFetch } from './commons.js';
const titles = CATALOG.map((l) => l.file);
const bad: string[] = [];
const counts: Record<string, number> = {};
for (const l of CATALOG) counts[`${l.category}/${l.plan}`] = (counts[`${l.category}/${l.plan}`] ?? 0) + 1;
for (let i = 0; i < titles.length; i += 40) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', format: 'json', titles: titles.slice(i, i + 40).join('|'), prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiextmetadatafilter: 'LicenseShortName|Artist', iiurlwidth: '1600' }).toString();
  const body = (await (await politeFetch(u)).json()) as { query: { pages: Record<string, { title: string; missing?: string; imageinfo?: { width: number; extmetadata?: Record<string, { value: string }> }[] }>; normalized?: { from: string; to: string }[] } };
  for (const p of Object.values(body.query.pages)) {
    const lic = p.imageinfo?.[0]?.extmetadata?.['LicenseShortName']?.value ?? '';
    if (p.missing !== undefined) bad.push(`MISSING ${p.title}`);
    else if (!licenseAllowed(lic)) bad.push(`LICENSE ${lic} ${p.title}`);
    else if ((p.imageinfo?.[0]?.width ?? 0) < 1000) bad.push(`SMALL ${p.imageinfo?.[0]?.width} ${p.title}`);
    void plainAuthor;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`${CATALOG.length} lots, ${new Set(titles).size} distinct files, ${new Set(CATALOG.map((l) => l.key)).size} distinct keys`);
console.log(JSON.stringify(counts));
console.log(bad.length ? bad.join('\n') : 'all files found and freely licensed');
