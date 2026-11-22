// Dev helper: prints license-checked Commons candidates for each query (no downloads).
import { searchCommons } from './commons.js';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const OUT = process.argv[3]!;
const done = existsSync(OUT) ? new Set([...readFileSync(OUT, 'utf8').matchAll(/^## (\S+)/gm)].map((m) => m[1])) : new Set();
const BAD = /crash|wreck|logo|interior|engine bay|badge|emblem|dashboard|steering|wheel|rim|diagram|map|svg|cockpit|museum label|tail ?light|headlight|seat|drawing|sketch|advert|poster|screenshot/i;
const queries = JSON.parse(process.argv[2]!) as [string, string, string][];
for (const [key, q, must] of queries) {
  if (done.has(key)) continue;
  let out = '';
  const words = must.toLowerCase().split('|');
  const res = (await searchCommons(q, 25)).filter((c) => {
    const t = c.file.toLowerCase();
    return words.every((w) => t.includes(w)) && !BAD.test(c.file) && c.width >= 1200;
  });
  out += `## ${key}\n`;
  for (const c of res.slice(0, 4)) out += `   ${c.width}x${c.height} ${c.license.padEnd(14)} ${c.file.slice(5, 110)}\n`;
  appendFileSync(OUT, out);
  await new Promise((r) => setTimeout(r, 1500));
}
