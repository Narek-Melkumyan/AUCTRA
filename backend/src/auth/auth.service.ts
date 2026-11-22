import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type TokenPurpose } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { AuditService } from '../audit/audit.service.js';
import { randomInt, randomUUID } from 'node:crypto';
import {
  EmailService,
  RESET_TTL_MINUTES,
  VERIFICATION_TTL_MINUTES,
  type EmailSendResult,
} from '../email/email.service.js';
import {
  hmacHex,
  randomToken,
  safeEqual,
  sha256Hex,
} from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { RoleKey } from '../roles/permissions.js';
import { meSelect, toMeDto, type MeDto } from '../users/user.mapper.js';
import { PasswordService } from './password.service.js';
import { SessionService, type IssuedRefreshToken } from './session.service.js';
import { AccessTokenService } from './access-token.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { describeUserAgent } from '../common/user-agent.js';

interface IssuedVerification {
  token: string;
  code: string;
  requestId: string;
}

interface Meta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface AuthResult {
  user: MeDto;
  accessToken: string;
  accessTokenExpiresAt: string;
  refresh: IssuedRefreshToken;
  /** Set on registration: whether the verification email was accepted by the provider. */
  verificationEmail?: EmailDeliveryInfo;
}

export interface EmailDeliveryInfo {
  /** True only when a real provider (Resend) accepted the message. */
  delivered: boolean;
  /** Provider configured at all (false in local dev with the log provider). */
  providerConfigured: boolean;
  reason?: string;
}

/** Outcome of a code check, decided inside the transaction and acted on after commit. */
type CodeOutcome =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: 'none' | 'expired' | 'locked' | 'mismatch';
      remaining: number;
    };

const EMAIL_TOKEN_TTL_MS = VERIFICATION_TTL_MINUTES * 60_000;
const RESET_TOKEN_TTL_MS = RESET_TTL_MINUTES * 60_000;
/** Wrong codes allowed per verification request before it is void. */
export const MAX_CODE_ATTEMPTS = 5;
const RESEND_MIN_INTERVAL_MS = 60_000;
const RESEND_MAX_PER_DAY = 5;
const RESET_MAX_PER_HOUR = 3;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly accessTokens: AccessTokenService,
    private readonly audit: AuditService,
    private readonly mail: EmailService,
    private readonly notifications: NotificationsService,
  ) {
    // Dedicated key for code HMACs, derived from (never equal to) the JWT secret.
    this.codeKey = hmacHex(config.jwtAccessSecret, 'auctra/email-code/v1');
  }

  private readonly codeKey: string;

  // ───────────── Registration & login ─────────────

  async register(
    input: { email: string; password: string; displayName: string },
    meta: Meta,
  ): Promise<AuthResult> {
    assertPasswordAcceptable(input.password, input.email);
    const passwordHash = await this.passwords.hash(input.password);
    const userRole = await this.prisma.role.findUnique({
      where: { key: RoleKey.USER },
    });
    if (!userRole)
      throw new Error(
        'Reference data missing: run the seed (role USER not found)',
      );

    let verification: IssuedVerification;
    let refresh: IssuedRefreshToken;
    let userId: string;
    try {
      ({ userId, refresh, verification } = await this.prisma.$transaction(
        async (tx) => {
          const user = await tx.user.create({
            data: {
              email: input.email,
              passwordHash,
              profile: {
                create: {
                  displayName: input.displayName,
                  handle: await this.uniqueHandle(tx, input),
                },
              },
              preferences: { create: {} },
              identityVerification: { create: {} },
              roles: { create: { roleId: userRole.id } },
            },
          });
          const v = await this.createVerification(tx, user.id);
          const r = await this.sessions.create(user.id, meta, tx);
          await this.audit.record(
            {
              actorId: user.id,
              action: 'auth.register',
              entityType: 'user',
              entityId: user.id,
              ...meta,
            },
            tx,
          );
          return { userId: user.id, refresh: r, verification: v };
        },
      ));
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw Errors.conflict(
          'EMAIL_TAKEN',
          'An account with this email already exists.',
        );
      }
      throw err;
    }
    const sent = await this.mail.sendSafe(() =>
      this.mail.sendVerification(input.email, {
        ...verification,
        displayName: input.displayName,
      }),
    );
    return {
      ...(await this.result(userId, refresh)),
      verificationEmail: this.deliveryInfo(sent),
    };
  }

  async login(
    input: { email: string; password: string },
    meta: Meta,
  ): Promise<AuthResult> {
    const invalid = () =>
      Errors.unauthorized('Invalid email or password.', 'INVALID_CREDENTIALS');
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        passwordHash: true,
        status: true,
        deletedAt: true,
        lockedUntil: true,
        failedLoginCount: true,
      },
    });
    if (!user || user.deletedAt) {
      await this.passwords.verifyDummy(input.password);
      await this.audit.recordSafe({
        action: 'auth.login_failed',
        metadata: { reason: 'unknown_email' },
        ...meta,
      });
      throw invalid();
    }
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      await this.audit.recordSafe({
        actorId: user.id,
        action: 'auth.login_blocked_locked',
        ...meta,
      });
      throw Errors.tooMany(
        'Too many failed sign-in attempts. Try again later or reset your password.',
      );
    }
    const ok = await this.passwords.verify(user.passwordHash, input.password);
    if (!ok) {
      const failures = user.failedLoginCount + 1;
      const over = failures - this.config.loginMaxFailures;
      const lockedUntil =
        over >= 0
          ? new Date(
              now.getTime() +
                Math.min(this.config.loginLockMinutes * 2 ** over, 24 * 60) *
                  60_000,
            )
          : null;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failures,
          ...(lockedUntil ? { lockedUntil } : {}),
        },
      });
      await this.audit.recordSafe({
        actorId: user.id,
        action: lockedUntil ? 'auth.account_locked' : 'auth.login_failed',
        metadata: { failures },
        ...meta,
      });
      throw invalid();
    }
    if (user.status === 'BANNED' || user.status === 'DEACTIVATED') {
      await this.audit.recordSafe({
        actorId: user.id,
        action: 'auth.login_blocked_disabled',
        ...meta,
      });
      throw Errors.forbidden('This account has been disabled.');
    }
    const rehash = this.passwords.needsRehash(user.passwordHash)
      ? await this.passwords.hash(input.password)
      : undefined;
    const knownDevice = await this.isKnownDevice(user.id, meta.userAgent);
    const refresh = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
          ...(rehash ? { passwordHash: rehash } : {}),
        },
      });
      const r = await this.sessions.create(user.id, meta, tx);
      await this.audit.record(
        {
          actorId: user.id,
          action: 'auth.login',
          entityType: 'session',
          entityId: r.sessionId,
          ...meta,
        },
        tx,
      );
      if (!knownDevice)
        await this.notifications.notifyMany(tx, [
          {
            userId: user.id,
            type: 'ACCOUNT_SECURITY',
            title: 'New sign-in to your account',
            body: `Your AUCTRA account was just signed in from ${describeUserAgent(meta.userAgent)} (${now.toUTCString()}). If this was you, no action is needed. If not, reset your password and sign out other devices.`,
            link: '/settings',
            data: { sessionId: r.sessionId },
            dedupeKey: `login:${r.sessionId}`,
          },
        ]);
      return r;
    });
    return this.result(user.id, refresh);
  }

  async refresh(cookie: string | undefined, meta: Meta): Promise<AuthResult> {
    const refresh = await this.sessions.rotate(cookie, meta);
    return this.result(refresh.userId, refresh);
  }

  async logout(
    sessionId: string | null,
    actorId: string | undefined,
    meta: Meta,
  ) {
    if (!sessionId) return;
    const revoked = await this.sessions.revokeSession(sessionId, 'LOGOUT');
    if (revoked) {
      await this.audit.recordSafe({
        actorId,
        action: 'auth.logout',
        entityType: 'session',
        entityId: sessionId,
        ...meta,
      });
    }
  }

  async logoutAll(auth: AuthContext, meta: Meta) {
    const count = await this.sessions.revokeAll(auth.userId, 'LOGOUT_ALL');
    await this.audit.recordSafe({
      actorId: auth.userId,
      action: 'auth.logout_all',
      metadata: { count },
      ...meta,
    });
    await this.notifications
      .notifyNow([
        {
          userId: auth.userId,
          type: 'ACCOUNT_SECURITY',
          title: 'Signed out everywhere',
          body: `You signed out of AUCTRA on all ${count} device(s).`,
          link: '/settings',
          email: false,
          dedupeKey: `logout-all:${Date.now()}`,
        },
      ])
      .catch(() => undefined);
    return count;
  }

  async me(userId: string): Promise<MeDto> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: meSelect,
    });
    if (!u) throw Errors.notFound('User');
    return toMeDto(u);
  }

  private async result(
    userId: string,
    refresh: IssuedRefreshToken,
  ): Promise<AuthResult> {
    const access = await this.accessTokens.issue(userId, refresh.sessionId);
    return {
      user: await this.me(userId),
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refresh,
    };
  }

  // ───────────── Email verification ─────────────
  //
  // One verification request = one verification_tokens row holding BOTH the link token
  // hash and the HMAC of a 6-digit code. Using either marks the row used, so the other
  // stops working too. Wrong codes count against the row; after MAX_CODE_ATTEMPTS the
  // request is void and the user must request a new email.

  /** Link method: the token from the emailed URL. */
  async verifyEmail(token: string, meta: Meta): Promise<void> {
    const userId = await this.consumeToken(
      token,
      'EMAIL_VERIFICATION',
      async (tx, uid) => this.markVerified(tx, uid),
    );
    await this.audit.recordSafe({
      actorId: userId,
      action: 'auth.email_verified',
      metadata: { method: 'link' },
      ...meta,
    });
    await this.notifyVerified(userId);
  }

  private async notifyVerified(userId: string) {
    await this.notifications
      .notifyNow([
        {
          userId,
          type: 'ACCOUNT_SECURITY',
          title: 'Email address verified',
          body: 'Your email address is confirmed. You can now bid and chat in auction rooms.',
          link: '/live',
          email: false,
          dedupeKey: 'email-verified',
        },
      ])
      .catch(() => undefined);
  }

  /** A device counts as known when this user signed in with the same user-agent in 90 days. */
  private async isKnownDevice(userId: string, userAgent?: string) {
    const prior = await this.prisma.session.findMany({
      where: {
        userId,
        createdAt: { gt: new Date(Date.now() - 90 * 86_400_000) },
      },
      select: { userAgent: true },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });
    // First sign-in after registration is not "new": registration created a session.
    if (!prior.length) return true;
    const ua = (userAgent ?? '').slice(0, 255);
    return prior.some((p) => (p.userAgent ?? '') === ua);
  }

  /**
   * Code method. Signed-in users verify their own address; without a session the caller
   * supplies the email, and every failure returns the same generic error so the endpoint
   * cannot be used to probe accounts.
   */
  async verifyEmailCode(
    code: string,
    who: { userId: string } | { email: string },
    meta: Meta,
  ): Promise<void> {
    const generic = 'userId' in who ? false : true;
    const userId =
      'userId' in who
        ? who.userId
        : (
            await this.prisma.user.findUnique({
              where: { email: who.email },
              select: { id: true },
            })
          )?.id;
    const outcome: CodeOutcome = userId
      ? await this.prisma.$transaction((tx) => this.checkCode(tx, userId, code))
      : { ok: false, reason: 'none', remaining: 0 };

    if (outcome.ok) {
      await this.audit.recordSafe({
        actorId: outcome.userId,
        action: 'auth.email_verified',
        metadata: { method: 'code' },
        ...meta,
      });
      await this.notifyVerified(outcome.userId);
      return;
    }
    if (userId && outcome.reason !== 'none') {
      await this.audit.recordSafe({
        actorId: userId,
        action: 'auth.email_code_failed',
        metadata: { reason: outcome.reason, remaining: outcome.remaining },
        ...meta,
      });
    }
    if (generic)
      throw Errors.badRequest(
        'INVALID_OR_EXPIRED_CODE',
        'That code is invalid or has expired. Check the latest email or request a new code.',
      );
    switch (outcome.reason) {
      case 'mismatch':
        throw Errors.badRequest(
          'INVALID_CODE',
          outcome.remaining > 0
            ? `That code isn't right. ${outcome.remaining} ${outcome.remaining === 1 ? 'attempt' : 'attempts'} left.`
            : 'Too many incorrect codes. Request a new verification email.',
          { attemptsRemaining: outcome.remaining },
        );
      case 'locked':
        throw Errors.badRequest(
          'TOO_MANY_ATTEMPTS',
          'Too many incorrect codes. Request a new verification email.',
          { attemptsRemaining: 0 },
        );
      case 'expired':
        throw Errors.badRequest(
          'CODE_EXPIRED',
          'This code has expired. Request a new verification email.',
        );
      default:
        throw Errors.badRequest(
          'NO_ACTIVE_CODE',
          'There is no active verification code. Request a new verification email.',
        );
    }
  }

  /** Runs under a row lock so concurrent guesses are counted exactly. */
  private async checkCode(
    tx: Tx,
    userId: string,
    code: string,
  ): Promise<CodeOutcome> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        codeHash: string | null;
        attempts: number;
        expiresAt: Date;
        verified: boolean;
      }[]
    >`
      SELECT t.id, t."codeHash", t.attempts, t."expiresAt",
             (u."emailVerifiedAt" IS NOT NULL) AS verified
      FROM verification_tokens t JOIN users u ON u.id = t."userId"
      WHERE t."userId" = ${userId}::uuid AND t.purpose = 'EMAIL_VERIFICATION'
        AND t."usedAt" IS NULL AND t."codeHash" IS NOT NULL
      ORDER BY t."createdAt" DESC LIMIT 1
      FOR UPDATE OF t`;
    const row = rows[0];
    if (!row || row.verified)
      return { ok: false, reason: 'none', remaining: 0 };
    if (row.attempts >= MAX_CODE_ATTEMPTS)
      return { ok: false, reason: 'locked', remaining: 0 };
    if (row.expiresAt <= new Date())
      return { ok: false, reason: 'expired', remaining: 0 };
    const expected = this.codeHash(row.id, code);
    if (!safeEqual(expected, row.codeHash!)) {
      await tx.verificationToken.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
      });
      return {
        ok: false,
        reason: 'mismatch',
        remaining: MAX_CODE_ATTEMPTS - row.attempts - 1,
      };
    }
    await tx.verificationToken.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    });
    await this.markVerified(tx, userId);
    return { ok: true, userId };
  }

  private async markVerified(tx: Tx, userId: string) {
    await tx.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    // Retire every other outstanding verification request (links and codes).
    await tx.verificationToken.updateMany({
      where: { userId, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    });
  }

  async resendVerification(auth: AuthContext): Promise<{
    sent: boolean;
    alreadyVerified: boolean;
    email?: EmailDeliveryInfo;
    expiresInMinutes?: number;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        email: true,
        emailVerifiedAt: true,
        profile: { select: { displayName: true } },
      },
    });
    if (!user) throw Errors.notFound('User');
    if (user.emailVerifiedAt) return { sent: false, alreadyVerified: true };
    const recent = await this.prisma.verificationToken.findMany({
      where: {
        userId: auth.userId,
        purpose: 'EMAIL_VERIFICATION',
        createdAt: { gt: new Date(Date.now() - 86_400_000) },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (
      recent[0] &&
      Date.now() - recent[0].createdAt.getTime() < RESEND_MIN_INTERVAL_MS
    ) {
      throw Errors.tooMany(
        'Please wait a minute before requesting another verification email.',
      );
    }
    if (recent.length >= RESEND_MAX_PER_DAY) {
      throw Errors.tooMany(
        'Daily limit for verification emails reached. Try again tomorrow.',
      );
    }
    const verification = await this.prisma.$transaction(async (tx) => {
      // A new request retires every older link and code.
      await tx.verificationToken.updateMany({
        where: {
          userId: auth.userId,
          purpose: 'EMAIL_VERIFICATION',
          usedAt: null,
        },
        data: { usedAt: new Date(), expiresAt: new Date() },
      });
      return this.createVerification(tx, auth.userId);
    });
    const sent = await this.mail.sendSafe(() =>
      this.mail.sendVerification(user.email, {
        ...verification,
        ...(user.profile?.displayName
          ? { displayName: user.profile.displayName }
          : {}),
      }),
    );
    return {
      sent: true,
      alreadyVerified: false,
      email: this.deliveryInfo(sent),
      expiresInMinutes: VERIFICATION_TTL_MINUTES,
    };
  }

  private deliveryInfo(r: EmailSendResult): EmailDeliveryInfo {
    return {
      delivered: r.delivered,
      providerConfigured: this.mail.configured,
      ...(r.delivered || !r.reason ? {} : { reason: r.reason }),
    };
  }

  // ───────────── Password reset & change ─────────────

  /**
   * Always resolves the same way regardless of whether the email exists. The actual
   * work happens after the response is decided, so timing does not leak existence either.
   */
  requestPasswordReset(email: string, meta: Meta): void {
    void this.processPasswordReset(email, meta).catch((err: Error) =>
      this.logger.error(`Password reset processing failed: ${err.message}`),
    );
  }

  /** Exposed for tests; production callers use requestPasswordReset. */
  async processPasswordReset(email: string, meta: Meta): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, status: true, deletedAt: true },
    });
    if (
      !user ||
      user.deletedAt ||
      user.status === 'BANNED' ||
      user.status === 'DEACTIVATED'
    )
      return;
    const recent = await this.prisma.verificationToken.count({
      where: {
        userId: user.id,
        purpose: 'PASSWORD_RESET',
        createdAt: { gt: new Date(Date.now() - 3600_000) },
      },
    });
    if (recent >= RESET_MAX_PER_HOUR) {
      await this.audit.recordSafe({
        actorId: user.id,
        action: 'auth.password_reset_throttled',
        ...meta,
      });
      return;
    }
    const token = await this.prisma.$transaction(async (tx) => {
      await tx.verificationToken.deleteMany({
        where: { userId: user.id, purpose: 'PASSWORD_RESET', usedAt: null },
      });
      return this.createToken(
        tx,
        user.id,
        'PASSWORD_RESET',
        RESET_TOKEN_TTL_MS,
      );
    });
    await this.audit.recordSafe({
      actorId: user.id,
      action: 'auth.password_reset_requested',
      ...meta,
    });
    const sent = await this.mail.sendSafe(() =>
      this.mail.sendPasswordReset(user.email, token.token, token.id),
    );
    if (!sent.delivered && this.mail.configured)
      await this.audit.recordSafe({
        actorId: user.id,
        action: 'auth.password_reset_email_failed',
        metadata: { reason: sent.reason },
      });
  }

  async resetPassword(
    token: string,
    newPassword: string,
    meta: Meta,
  ): Promise<void> {
    const hash = await this.passwords.hash(newPassword);
    let email = '';
    const userId = await this.consumeToken(
      token,
      'PASSWORD_RESET',
      async (tx, uid) => {
        const u = await tx.user.findUniqueOrThrow({
          where: { id: uid },
          select: { email: true, emailVerifiedAt: true },
        });
        assertPasswordAcceptable(newPassword, u.email);
        email = u.email;
        await tx.user.update({
          where: { id: uid },
          data: {
            passwordHash: hash,
            passwordChangedAt: new Date(),
            failedLoginCount: 0,
            lockedUntil: null,
            // Following the emailed link proves control of the address.
            ...(u.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
          },
        });
        await tx.verificationToken.deleteMany({
          where: { userId: uid, purpose: 'PASSWORD_RESET', usedAt: null },
        });
        await this.sessions.revokeAll(uid, 'PASSWORD_RESET', undefined, tx);
      },
    );
    await this.audit.recordSafe({
      actorId: userId,
      action: 'auth.password_reset',
      ...meta,
    });
    void email;
    await this.notifications
      .notifyNow([
        {
          userId,
          type: 'ACCOUNT_SECURITY',
          title: 'Your password was reset',
          body: `The password for your AUCTRA account was reset at ${new Date().toUTCString()} and every device was signed out. If this wasn't you, contact support immediately.`,
          link: '/settings',
          dedupeKey: `password-reset:${Date.now()}`,
        },
      ])
      .catch(() => undefined);
  }

  async changePassword(
    auth: AuthContext,
    current: string,
    next: string,
    meta: Meta,
  ): Promise<{ revokedSessions: number }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { email: true, passwordHash: true },
    });
    if (!(await this.passwords.verify(user.passwordHash, current))) {
      await this.audit.recordSafe({
        actorId: auth.userId,
        action: 'auth.password_change_failed',
        ...meta,
      });
      throw Errors.badRequest(
        'INVALID_CURRENT_PASSWORD',
        'Current password is incorrect.',
      );
    }
    if (current === next)
      throw Errors.badRequest(
        'PASSWORD_UNCHANGED',
        'Choose a password you have not just used.',
      );
    assertPasswordAcceptable(next, user.email);
    const hash = await this.passwords.hash(next);
    const revoked = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: auth.userId },
        data: { passwordHash: hash, passwordChangedAt: new Date() },
      });
      return this.sessions.revokeAll(
        auth.userId,
        'PASSWORD_CHANGED',
        auth.sessionId,
        tx,
      );
    });
    await this.audit.recordSafe({
      actorId: auth.userId,
      action: 'auth.password_changed',
      metadata: { revoked },
      ...meta,
    });
    await this.notifications
      .notifyNow([
        {
          userId: auth.userId,
          type: 'ACCOUNT_SECURITY',
          title: 'Your password was changed',
          body: `The password for your AUCTRA account was changed at ${new Date().toUTCString()}. ${revoked} other device(s) were signed out. If this wasn't you, reset your password now.`,
          link: '/settings',
          dedupeKey: `password-changed:${Date.now()}`,
        },
      ])
      .catch(() => undefined);
    return { revokedSessions: revoked };
  }

  // ───────────── Token helpers ─────────────

  private async createToken(
    tx: Tx,
    userId: string,
    purpose: TokenPurpose,
    ttlMs: number,
  ): Promise<{ token: string; id: string }> {
    const token = randomToken(32);
    const row = await tx.verificationToken.create({
      data: {
        userId,
        purpose,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + ttlMs),
      },
      select: { id: true },
    });
    return { token, id: row.id };
  }

  /** New email-verification request: a link token and a 6-digit code on one row. */
  private async createVerification(
    tx: Tx,
    userId: string,
  ): Promise<IssuedVerification> {
    const id = randomUUID();
    const token = randomToken(32);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await tx.verificationToken.create({
      data: {
        id,
        userId,
        purpose: 'EMAIL_VERIFICATION',
        tokenHash: sha256Hex(token),
        codeHash: this.codeHash(id, code),
        expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
      },
    });
    return { token, code, requestId: id };
  }

  private codeHash(requestId: string, code: string): string {
    return hmacHex(this.codeKey, `${requestId}:${code}`);
  }

  /** Locks, validates and marks a single-use token as used, then runs `apply` in the same transaction. */
  private async consumeToken(
    token: string,
    purpose: TokenPurpose,
    apply: (tx: Tx, userId: string) => Promise<void>,
  ): Promise<string> {
    const hash = sha256Hex(token);
    const invalid = () =>
      Errors.badRequest(
        'INVALID_OR_EXPIRED_TOKEN',
        'This link is invalid or has expired. Request a new one.',
      );
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          userId: string;
          purpose: TokenPurpose;
          expiresAt: Date;
          usedAt: Date | null;
          attempts: number;
        }[]
      >`
        SELECT id, "userId", purpose, "expiresAt", "usedAt", attempts FROM verification_tokens
        WHERE "tokenHash" = ${hash} FOR UPDATE`;
      const row = rows[0];
      if (
        !row ||
        row.purpose !== purpose ||
        row.usedAt ||
        row.attempts >= MAX_CODE_ATTEMPTS ||
        row.expiresAt <= new Date()
      )
        throw invalid();
      await tx.verificationToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      });
      await apply(tx, row.userId);
      return row.userId;
    });
  }

  private async uniqueHandle(
    tx: Tx,
    input: { email: string; displayName: string },
  ): Promise<string> {
    const base =
      (input.displayName || input.email.split('@')[0] || 'bidder')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9_.]+/g, '_')
        .replace(/^[_.]+|[_.]+$/g, '')
        .slice(0, 24) || 'bidder';
    const padded = base.length < 3 ? `${base}_user` : base;
    for (let i = 0; i < 5; i++) {
      const candidate =
        i === 0
          ? padded
          : `${padded}_${randomToken(3)
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '0')}`;
      const taken = await tx.userProfile.findUnique({
        where: { handle: candidate },
        select: { userId: true },
      });
      if (!taken) return candidate;
    }
    return `bidder_${randomToken(6)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '0')}`;
  }
}

function assertPasswordAcceptable(password: string, email: string) {
  const p = password.toLowerCase();
  if (p === email.toLowerCase() || p === email.split('@')[0]?.toLowerCase()) {
    throw Errors.badRequest(
      'WEAK_PASSWORD',
      'Password must not match your email address.',
    );
  }
  if (/^(.)\1+$/.test(password))
    throw Errors.badRequest('WEAK_PASSWORD', 'Password is too easy to guess.');
}
