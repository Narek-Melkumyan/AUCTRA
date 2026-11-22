/**
 * Writes docs/catalog-image-credits.md: author, license and source for every demo-catalogue
 * photo, as stored on the images (the same data the lot pages show).
 *
 *   npm run catalog:credits
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppConfig } from '../../config/app-config.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

async function main() {
  const prisma = new PrismaService(new AppConfig(process.env));
  try {
    const rows = await prisma.listingMedia.findMany({
      where: {
        creditLicense: { not: null },
        auction: { seedKey: { not: null } },
      },
      orderBy: { auction: { seedKey: 'asc' } },
      select: {
        creditAuthor: true,
        creditLicense: true,
        creditLicenseUrl: true,
        creditSourceUrl: true,
        auction: { select: { title: true, seedKey: true } },
      },
    });
    const lines = [
      '# Demo catalogue image credits',
      '',
      'The AUCTRA demonstration catalogue is illustrated with freely licensed photographs from',
      '[Wikimedia Commons](https://commons.wikimedia.org/). Each photo was resized to 320, 800 and',
      '1600 px and converted to WebP (embedded metadata removed); adaptations of CC BY-SA images are',
      'shared under the same license. Property photos are illustrative and do not show the property',
      'described. All listings are fictional demo data — nothing is for sale.',
      '',
      'The same credit is shown under the photo on every lot page. Generated with',
      '`npm run catalog:credits` from the stored attribution data.',
      '',
      '| Lot | Photo | Author | License |',
      '| --- | --- | --- | --- |',
      ...rows.map((r) => {
        const file = decodeURIComponent(
          (r.creditSourceUrl ?? '').split('/wiki/')[1] ?? 'source',
        ).replace(/_/g, ' ');
        const lic = r.creditLicenseUrl
          ? `[${r.creditLicense}](${r.creditLicenseUrl})`
          : r.creditLicense!;
        return `| ${md(r.auction.title)} | [${md(file)}](${r.creditSourceUrl}) | ${md(r.creditAuthor ?? 'Unknown')} | ${lic} |`;
      }),
      '',
      `${rows.length} photos.`,
      '',
    ];
    const out = path.resolve('../docs/catalog-image-credits.md');
    writeFileSync(out, lines.join('\n'));
    console.log(
      `Wrote ${rows.length} credits to ${path.relative(process.cwd(), out)}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
void main();
