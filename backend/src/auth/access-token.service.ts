import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.js';
import type { UserStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  typ: 'access';
}

/**
 * Short-lived JWT access tokens (HS256). Claims are minimal: subject + session id.
 * Roles/permissions are resolved from the database on each request so revocation,
 * suspension and role changes take effect immediately rather than at token expiry.
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async issue(
    userId: string,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const claims: AccessTokenClaims = {
      sub: userId,
      sid: sessionId,
      typ: 'access',
    };
    const token = await this.jwt.signAsync(claims, {
      secret: this.config.jwtAccessSecret,
      algorithm: 'HS256',
      expiresIn: this.config.jwtAccessTtlSec,
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
    });
    return {
      token,
      expiresAt: new Date(Date.now() + this.config.jwtAccessTtlSec * 1000),
    };
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const claims = await this.jwt.verifyAsync<
        AccessTokenClaims & { exp: number }
      >(token, {
        secret: this.config.jwtAccessSecret,
        algorithms: ['HS256'],
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
      });
      if (
        claims.typ !== 'access' ||
        typeof claims.sub !== 'string' ||
        typeof claims.sid !== 'string'
      ) {
        throw new Error('wrong token type');
      }
      return claims;
    } catch (err) {
      const expired = err instanceof Error && err.name === 'TokenExpiredError';
      throw Errors.unauthorized(
        expired ? 'Access token expired.' : 'Invalid access token.',
        expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      );
    }
  }

  /** Verifies the token AND that its session is still live; resolves the principal. */
  async authenticate(token: string): Promise<AuthContext> {
    const claims = await this.verify(token);
    // One statement (session + user + roles + permissions), read on every request so
    // revocations, bans and role changes take effect immediately.
    const rows = await this.prisma.$queryRaw<
      {
        userId: string;
        revokedAt: Date | null;
        expiresAt: Date;
        lastActiveAt: Date;
        email: string;
        emailVerifiedAt: Date | null;
        status: UserStatus;
        suspendedUntil: Date | null;
        deletedAt: Date | null;
        roles: string[];
        permissions: string[];
      }[]
    >`
      SELECT s."userId", s."revokedAt", s."expiresAt", s."lastActiveAt",
             u.email, u."emailVerifiedAt", u.status, u."suspendedUntil", u."deletedAt",
             COALESCE(array_agg(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles,
             COALESCE(array_agg(DISTINCT p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
      FROM sessions s
      JOIN users u ON u.id = s."userId"
      LEFT JOIN user_roles ur ON ur."userId" = u.id
      LEFT JOIN roles r ON r.id = ur."roleId"
      LEFT JOIN role_permissions rp ON rp."roleId" = r.id
      LEFT JOIN permissions p ON p.id = rp."permissionId"
      WHERE s.id = ${claims.sid}::uuid
      GROUP BY s.id, u.id`;
    const session = rows[0];
    const now = new Date();
    if (
      !session ||
      session.userId !== claims.sub ||
      session.revokedAt ||
      session.expiresAt <= now
    ) {
      throw Errors.unauthorized(
        'Session is no longer valid.',
        'SESSION_REVOKED',
      );
    }
    const user = session;
    if (
      user.deletedAt ||
      user.status === 'BANNED' ||
      user.status === 'DEACTIVATED'
    ) {
      throw Errors.unauthorized('Account is disabled.', 'ACCOUNT_DISABLED');
    }
    // Touch last activity at most once a minute to avoid a write per request.
    if (now.getTime() - session.lastActiveAt.getTime() > 60_000) {
      await this.prisma.session.updateMany({
        where: {
          id: claims.sid,
          lastActiveAt: { lt: new Date(now.getTime() - 60_000) },
        },
        data: { lastActiveAt: now },
      });
    }
    const roles = user.roles;
    const permissions = new Set(user.permissions);
    return {
      userId: session.userId,
      sessionId: claims.sid,
      email: user.email,
      emailVerified: Boolean(user.emailVerifiedAt),
      status: user.status,
      suspendedUntil: user.suspendedUntil,
      roles,
      permissions,
    };
  }
}
