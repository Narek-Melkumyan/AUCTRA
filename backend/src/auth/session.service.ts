import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SessionRevokeReason } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { hashIp, randomToken, safeEqual, sha256Hex } from '../common/crypto.js';
import { Errors } from '../common/errors.js';

export interface IssuedRefreshToken {
  /** Opaque cookie value "<tokenId>.<secret>". Never stored; only SHA-256(secret) is. */
  value: string;
  expiresAt: Date;
  sessionId: string;
  userId: string;
}

interface DeviceMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

type LockedRefreshRow = {
  id: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  replacedById: string | null;
};

/**
 * Server-side sessions and rotating refresh tokens.
 *
 * - One Session per device login = one refresh-token family.
 * - Every refresh exchanges the presented token for a new one (rotation).
 * - Presenting an already-exchanged token is reuse (likely theft): the whole family
 *   is revoked — except within a short grace window right after rotation, where the
 *   request is answered 409 so that two tabs refreshing at once don't log the user out.
 * - The token row is locked (SELECT … FOR UPDATE) so concurrent refreshes of the same
 *   token serialise: exactly one wins.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    userId: string,
    meta: DeviceMeta,
    tx: Tx = this.prisma,
  ): Promise<IssuedRefreshToken> {
    const expiresAt = new Date(
      Date.now() + this.config.refreshTokenTtlDays * 86_400_000,
    );
    const session = await tx.session.create({
      data: {
        userId,
        userAgent: meta.userAgent ?? null,
        ipHash: hashIp(meta.ip, this.config.ipHashSalt),
        expiresAt,
      },
    });
    return this.mintToken(tx, session.id, userId, expiresAt);
  }

  private async mintToken(
    tx: Tx,
    sessionId: string,
    userId: string,
    sessionExpiresAt: Date,
  ) {
    const id = randomUUID();
    const secret = randomToken(32);
    const idle = new Date(
      Date.now() + this.config.refreshTokenIdleDays * 86_400_000,
    );
    const expiresAt = idle < sessionExpiresAt ? idle : sessionExpiresAt;
    await tx.refreshToken.create({
      data: { id, sessionId, tokenHash: sha256Hex(secret), expiresAt },
    });
    return {
      value: `${id}.${secret}`,
      expiresAt,
      sessionId,
      userId,
      tokenId: id,
    };
  }

  /** Exchanges a refresh token for a new one. Throws 401 (invalid/reuse) or 409 (race). */
  async rotate(
    presented: string | undefined,
    meta: DeviceMeta,
  ): Promise<IssuedRefreshToken> {
    const parsed = parseRefreshToken(presented);
    if (!parsed)
      throw Errors.unauthorized(
        'Refresh token missing or malformed.',
        'INVALID_REFRESH_TOKEN',
      );

    type Outcome =
      | { kind: 'ok'; token: IssuedRefreshToken }
      | { kind: 'reuse'; sessionId: string; userId: string }
      | { kind: 'race' }
      | { kind: 'invalid'; code: string; message: string };

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<Outcome> => {
        const rows = await tx.$queryRaw<LockedRefreshRow[]>`
        SELECT id, "sessionId", "tokenHash", "expiresAt", "usedAt", "revokedAt", "replacedById"
        FROM refresh_tokens WHERE id = ${parsed.id}::uuid FOR UPDATE`;
        const row = rows[0];
        if (!row || !safeEqual(row.tokenHash, sha256Hex(parsed.secret))) {
          return {
            kind: 'invalid',
            code: 'INVALID_REFRESH_TOKEN',
            message: 'Invalid refresh token.',
          };
        }
        const session = await tx.session.findUnique({
          where: { id: row.sessionId },
          include: {
            user: { select: { id: true, status: true, deletedAt: true } },
          },
        });
        if (!session)
          return {
            kind: 'invalid',
            code: 'INVALID_REFRESH_TOKEN',
            message: 'Invalid refresh token.',
          };
        const now = new Date();

        if (row.usedAt) {
          const withinGrace =
            now.getTime() - row.usedAt.getTime() <=
            this.config.refreshRaceGraceSec * 1000;
          if (withinGrace && !session.revokedAt) return { kind: 'race' };
          await this.revokeSessionTx(tx, session.id, 'TOKEN_REUSE');
          return {
            kind: 'reuse',
            sessionId: session.id,
            userId: session.userId,
          };
        }
        if (row.revokedAt || session.revokedAt) {
          return {
            kind: 'invalid',
            code: 'SESSION_REVOKED',
            message: 'Session has been signed out.',
          };
        }
        if (row.expiresAt <= now || session.expiresAt <= now) {
          return {
            kind: 'invalid',
            code: 'REFRESH_TOKEN_EXPIRED',
            message: 'Session expired. Please sign in again.',
          };
        }
        const user = session.user;
        if (
          user.deletedAt ||
          user.status === 'BANNED' ||
          user.status === 'DEACTIVATED'
        ) {
          await this.revokeSessionTx(tx, session.id, 'ADMIN');
          return {
            kind: 'invalid',
            code: 'ACCOUNT_DISABLED',
            message: 'Account is disabled.',
          };
        }

        const next = await this.mintToken(
          tx,
          session.id,
          session.userId,
          session.expiresAt,
        );
        await tx.refreshToken.update({
          where: { id: row.id },
          data: { usedAt: now, replacedById: next.tokenId },
        });
        await tx.session.update({
          where: { id: session.id },
          data: {
            lastActiveAt: now,
            ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
            ...(meta.ip
              ? { ipHash: hashIp(meta.ip, this.config.ipHashSalt) }
              : {}),
          },
        });
        return { kind: 'ok', token: next };
      },
    );

    switch (outcome.kind) {
      case 'ok':
        return outcome.token;
      case 'race':
        throw Errors.conflict(
          'REFRESH_IN_PROGRESS',
          'This session was just refreshed by another request. Retry with the latest cookie.',
        );
      case 'reuse':
        this.logger.warn(
          `Refresh token reuse detected; session ${outcome.sessionId} revoked`,
        );
        await this.audit.recordSafe({
          actorId: outcome.userId,
          action: 'auth.refresh_token_reuse',
          entityType: 'session',
          entityId: outcome.sessionId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        await this.notifications
          .notifyNow([
            {
              userId: outcome.userId,
              type: 'ACCOUNT_SECURITY',
              title: 'A device was signed out for your safety',
              body: 'An old sign-in token was used again, which can mean it was copied. We signed that device out. If you did not expect this, change your password.',
              link: '/settings',
              dedupeKey: `token-reuse:${outcome.sessionId}`,
            },
          ])
          .catch(() => undefined);
        throw Errors.unauthorized(
          'Session revoked for security reasons. Please sign in again.',
          'TOKEN_REUSE_DETECTED',
        );
      case 'invalid':
        throw Errors.unauthorized(outcome.message, outcome.code);
    }
  }

  /** Resolves the session a refresh cookie belongs to without rotating it (used by logout). */
  async sessionIdFromRefresh(
    presented: string | undefined,
  ): Promise<string | null> {
    const parsed = parseRefreshToken(presented);
    if (!parsed) return null;
    const row = await this.prisma.refreshToken.findUnique({
      where: { id: parsed.id },
      select: { sessionId: true, tokenHash: true },
    });
    if (!row || !safeEqual(row.tokenHash, sha256Hex(parsed.secret)))
      return null;
    return row.sessionId;
  }

  async revokeSession(
    sessionId: string,
    reason: SessionRevokeReason,
    userId?: string,
  ): Promise<boolean> {
    return this.prisma.$transaction((tx) =>
      this.revokeSessionTx(tx, sessionId, reason, userId),
    );
  }

  async revokeSessionTx(
    tx: Tx,
    sessionId: string,
    reason: SessionRevokeReason,
    userId?: string,
  ) {
    const now = new Date();
    const res = await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null, ...(userId ? { userId } : {}) },
      data: { revokedAt: now, revokeReason: reason },
    });
    await tx.refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
    return res.count > 0;
  }

  /** Revokes every live session of a user, optionally keeping one (the caller's). */
  async revokeAll(
    userId: string,
    reason: SessionRevokeReason,
    exceptSessionId?: string,
    tx: Tx = this.prisma,
  ) {
    const now = new Date();
    const sessions = await tx.session.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      select: { id: true },
    });
    const ids = sessions.map((s) => s.id);
    if (!ids.length) return 0;
    await tx.session.updateMany({
      where: { id: { in: ids } },
      data: { revokedAt: now, revokeReason: reason },
    });
    await tx.refreshToken.updateMany({
      where: { sessionId: { in: ids }, revokedAt: null },
      data: { revokedAt: now },
    });
    return ids.length;
  }

  listActive(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        ipHash: true,
        createdAt: true,
        lastActiveAt: true,
        expiresAt: true,
      },
    });
  }
}

export function parseRefreshToken(
  value: string | undefined,
): { id: string; secret: string } | null {
  if (!value || value.length > 200) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[A-Za-z0-9_-]{20,}$/.test(secret))
    return null;
  return { id, secret };
}
