/**
 * The local demo accounts that `npm run db:seed:demo` creates, and the only accounts whose
 * password comes from SEED_DEMO_PASSWORD. Password rotation is limited to exactly these
 * addresses: no other account (a real, registered one included) is ever read for its hash
 * or changed.
 */
import * as argon2 from 'argon2';
import type { PrismaClient } from '../generated/prisma/client.js';
import { RoleKey } from '../roles/permissions.js';

export const DEMO_ACCOUNTS = [
  {
    email: 'admin@auctra.local',
    displayName: 'AUCTRA Admin',
    handle: 'auctra_admin',
    roles: [RoleKey.USER, RoleKey.ADMIN, RoleKey.SUPER_ADMIN],
  },
  {
    email: 'seller@auctra.local',
    displayName: 'Demo Dealer',
    handle: 'demo_dealer',
    roles: [RoleKey.USER, RoleKey.SELLER],
  },
  {
    email: 'bidder1@auctra.local',
    displayName: 'Demo Bidder One',
    handle: 'demo_bidder_one',
    roles: [RoleKey.USER],
  },
  {
    email: 'bidder2@auctra.local',
    displayName: 'Demo Bidder Two',
    handle: 'demo_bidder_two',
    roles: [RoleKey.USER],
  },
] as const;

export const DEMO_SELLER_EMAIL = 'seller@auctra.local';

/** Reads SEED_DEMO_PASSWORD; never logs or returns it anywhere else. */
export function demoPasswordFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const password = env['SEED_DEMO_PASSWORD'];
  if (!password || password.length < 12)
    throw new Error(
      'Set SEED_DEMO_PASSWORD (≥ 12 chars) in backend/.env to seed or rotate demo accounts',
    );
  return password;
}

/** Argon2id with the API's default parameters (m=19 MiB, t=2, p=1). */
export const hashDemoPassword = (password: string) =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

export type RotationOutcome =
  | 'missing' // no such account in this database
  | 'current' // already uses this password; nothing to do
  | 'would-rotate' // dry run
  | 'rotated';

export interface RotationResult {
  email: string;
  outcome: RotationOutcome;
  /** Active sessions that were (or, in a dry run, would be) revoked. */
  sessions: number;
}

/**
 * Sets every existing demo account's password to `password` and signs those accounts out
 * everywhere, the same way a user's own password change does (sessions and refresh tokens
 * revoked with reason PASSWORD_CHANGED, plus an audit-log entry without any password
 * material). Dry run unless `apply`. Idempotent: accounts already on `password` are left
 * alone, so re-running never logs anyone out twice.
 */
export async function rotateDemoPasswords(
  prisma: PrismaClient,
  password: string,
  { apply }: { apply: boolean },
): Promise<RotationResult[]> {
  const emails: string[] = DEMO_ACCOUNTS.map((a) => a.email);
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, passwordHash: true },
  });
  let hash: string | undefined;
  const results: RotationResult[] = [];
  for (const email of emails) {
    const user = users.find((u) => u.email === email);
    if (!user) {
      results.push({ email, outcome: 'missing', sessions: 0 });
      continue;
    }
    const matches = await argon2
      .verify(user.passwordHash, password)
      .catch(() => false);
    if (matches) {
      results.push({ email, outcome: 'current', sessions: 0 });
      continue;
    }
    const active = { userId: user.id, revokedAt: null };
    if (!apply) {
      const sessions = await prisma.session.count({ where: active });
      results.push({ email, outcome: 'would-rotate', sessions });
      continue;
    }
    hash ??= await hashDemoPassword(password);
    const newHash = hash;
    const sessions = await prisma.$transaction(async (tx) => {
      const now = new Date();
      // Guarded on the hash read above, so a concurrent change is never overwritten.
      const changed = await tx.user.updateMany({
        where: { id: user.id, passwordHash: user.passwordHash },
        data: {
          passwordHash: newHash,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      if (changed.count !== 1)
        throw new Error(`${email} changed during rotation; nothing written`);
      const open = await tx.session.findMany({
        where: active,
        select: { id: true },
      });
      const ids = open.map((s) => s.id);
      await tx.session.updateMany({
        where: { id: { in: ids } },
        data: { revokedAt: now, revokeReason: 'PASSWORD_CHANGED' },
      });
      await tx.refreshToken.updateMany({
        where: { sessionId: { in: ids }, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: user.id,
          metadata: {
            via: 'cli',
            reason: 'demo-password-rotation',
            sessionsRevoked: ids.length,
          },
        },
      });
      return ids.length;
    });
    results.push({ email, outcome: 'rotated', sessions });
  }
  return results;
}
