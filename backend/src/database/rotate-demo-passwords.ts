/**
 * Rotates the password of the seeded demo accounts (*@auctra.local) to the current
 * SEED_DEMO_PASSWORD. Re-seeding never changes an existing account's hash, so after
 * changing SEED_DEMO_PASSWORD in backend/.env run:
 *
 *   npm run db:rotate-demo-passwords             # dry run: which accounts would change
 *   npm run db:rotate-demo-passwords -- --apply  # rotate and sign those accounts out
 *
 * Rules:
 *  - Only the four addresses in DEMO_ACCOUNTS are touched. Any other account, including
 *    your own registered one, is never read for its hash or changed.
 *  - Never prints the password or any hash; output is addresses, outcomes and counts.
 *  - Applies only to the database in DATABASE_URL (run it once per database, e.g.
 *    `DATABASE_URL=… npm run db:rotate-demo-passwords -- --apply`).
 *  - Refused when NODE_ENV=production: demo accounts must not exist there.
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { demoPasswordFromEnv, rotateDemoPasswords } from './demo-accounts.js';

const APPLY = process.argv.slice(2).includes('--apply');
Logger.overrideLogger(['warn', 'error']);

async function main() {
  const config = new AppConfig(process.env);
  if (config.nodeEnv === 'production') {
    console.error('Refusing to run with NODE_ENV=production.');
    process.exit(2);
  }
  const password = demoPasswordFromEnv();
  const db = new URL(process.env['DATABASE_URL']!);
  console.log(
    `Database: ${db.hostname}:${db.port || 5432}${db.pathname} (${config.nodeEnv})`,
  );
  const prisma = new PrismaService(config);
  try {
    const results = await rotateDemoPasswords(prisma, password, {
      apply: APPLY,
    });
    for (const r of results)
      console.log(
        `  ${r.email.padEnd(22)} ${r.outcome}${r.sessions ? ` (${r.sessions} active session${r.sessions === 1 ? '' : 's'} ${r.outcome === 'rotated' ? 'revoked' : 'to revoke'})` : ''}`,
      );
    const pending = results.filter((r) => r.outcome === 'would-rotate').length;
    if (pending)
      console.log(
        `Dry run: ${pending} account(s) would be rotated. Re-run with --apply.`,
      );
    else if (APPLY)
      console.log(
        'Done. Password values were not printed; sign in with the new SEED_DEMO_PASSWORD.',
      );
    else console.log('Nothing to rotate.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`rotate-demo-passwords failed: ${(err as Error).message}`);
  process.exit(1);
});
