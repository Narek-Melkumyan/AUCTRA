/**
 * One-time, audited role assignment for an EXISTING account (e.g. bootstrapping the first
 * super administrator, who cannot be promoted through the API because nobody holds
 * `role:assign` yet).
 *
 *   npm run admin:grant-role -- --email you@example.com --role SUPER_ADMIN          # dry run
 *   npm run admin:grant-role -- --email you@example.com --role SUPER_ADMIN --apply  # grant
 *
 * Rules:
 *  - Never creates accounts and never touches passwords, sessions or profile data; the
 *    account must already exist, be ACTIVE and have a verified email.
 *  - The role must already exist (roles come from reference data). Existing roles are kept.
 *  - Dry run unless --apply. Idempotent: an existing grant is reported, not duplicated.
 *  - Writes an audit-log entry (action "role.grant", metadata.via = "cli") in the same
 *    transaction as the grant.
 *  - Applies only to the database in DATABASE_URL. Refused when NODE_ENV=production unless
 *    --production is also passed.
 *  - Nothing about the account is stored in code: authorization stays purely data-driven,
 *    so registering with the same address elsewhere grants nothing.
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = args.includes('--apply');
const email = value('--email')?.trim().toLowerCase();
const roleKey = value('--role')?.trim().toUpperCase();

Logger.overrideLogger(['warn', 'error']);

async function main() {
  if (!email || !roleKey) {
    console.error(
      'Usage: npm run admin:grant-role -- --email <address> --role <ROLE_KEY> [--apply]',
    );
    process.exit(2);
  }
  const config = new AppConfig(process.env);
  if (config.nodeEnv === 'production' && !args.includes('--production')) {
    console.error(
      'Refusing to run with NODE_ENV=production without --production.',
    );
    process.exit(2);
  }
  const db = new URL(process.env['DATABASE_URL']!);
  console.log(
    `Database: ${db.hostname}:${db.port || 5432}${db.pathname} (${config.nodeEnv})`,
  );

  const prisma = new PrismaService(config);
  try {
    const role = await prisma.role.findUnique({ where: { key: roleKey } });
    if (!role) throw new Error(`Role ${roleKey} does not exist.`);
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        status: true,
        emailVerifiedAt: true,
        deletedAt: true,
        roles: { select: { role: { select: { key: true } } } },
      },
    });
    if (!user)
      throw new Error(
        'No account with that email. Register it in the app first — this tool never creates accounts.',
      );
    const current = user.roles.map((r) => r.role.key).sort();
    console.log(
      `Account ${user.id}: status ${user.status}, email ${user.emailVerifiedAt ? 'verified' : 'NOT verified'}, roles [${current.join(', ')}]`,
    );
    if (user.deletedAt || user.status !== 'ACTIVE')
      throw new Error('The account is not active; refusing to grant roles.');
    if (!user.emailVerifiedAt)
      throw new Error(
        'The email address is not verified; verify it before granting roles.',
      );
    if (current.includes(roleKey)) {
      console.log(`Already has ${roleKey}; nothing to do.`);
      return;
    }
    if (!APPLY) {
      console.log(
        `Dry run: would grant ${roleKey} (roles afterwards: [${[...current, roleKey].sort().join(', ')}]). Re-run with --apply.`,
      );
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.userRole.create({
        data: { userId: user.id, roleId: role.id, grantedById: null },
      });
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'role.grant',
          entityType: 'user',
          entityId: user.id,
          metadata: { role: roleKey, via: 'cli', previousRoles: current },
        },
      });
    });
    const after = await prisma.userRole.findMany({
      where: { userId: user.id },
      select: { role: { select: { key: true } } },
    });
    console.log(
      `Granted ${roleKey}. Roles now [${after
        .map((r) => r.role.key)
        .sort()
        .join(
          ', ',
        )}]. Sessions and password unchanged; permissions apply on the next request.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`grant-role failed: ${(err as Error).message}`);
  process.exit(1);
});
