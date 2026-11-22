import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppConfig } from '../config/app-config.js';
import { CurrentUser, OptionalUser, Public } from '../common/decorators.js';
import { requestMeta, type AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import { AuthService, type AuthResult } from './auth.service.js';
import { SessionService } from './session.service.js';
import { AUTH_COOKIE_PATH, CsrfGuard, CsrfService } from './csrf.service.js';
import {
  ChangePasswordDto,
  EmailDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  TokenDto,
  VerifyCodeDto,
} from './dto.js';
import { RealtimeSessions } from './realtime-sessions.js';

export const REFRESH_COOKIE = 'auctra_rt';

const MINUTE = 60_000;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly csrf: CsrfService,
    private readonly config: AppConfig,
    private readonly realtime: RealtimeSessions,
  ) {}

  /** Issues the CSRF token required by the cookie-based endpoints below. */
  @Public()
  @Get('csrf')
  getCsrf(@Res({ passthrough: true }) res: Response) {
    return { csrfToken: this.csrf.issue(res) };
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.register(dto, requestMeta(req)));
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.login(dto, requestMeta(req)));
  }

  /**
   * Rotates the refresh cookie and returns a fresh access token. Without any refresh cookie
   * (an anonymous visitor's silent session check) it answers 204 "no session" instead of a
   * 401, so every page load of a signed-out visitor does not log an error. An invalid,
   * expired or replayed cookie is still a 401.
   */
  @Public()
  @UseGuards(CsrfGuard)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookie = this.readRefreshCookie(req);
    if (!cookie) {
      res.status(HttpStatus.NO_CONTENT);
      return;
    }
    try {
      return this.respond(
        res,
        await this.auth.refresh(cookie, requestMeta(req)),
      );
    } catch (err) {
      // Keep the cookie on a benign race (the winner already set the new one); clear it otherwise.
      const code = (err as { code?: string }).code;
      if (code !== 'REFRESH_IN_PROGRESS') this.clearRefreshCookie(res);
      throw err;
    }
  }

  /** Signs out the current device. Works with the refresh cookie even if the access token expired. */
  @Public()
  @UseGuards(CsrfGuard)
  @HttpCode(204)
  @Post('logout')
  async logout(
    @OptionalUser() auth: AuthContext | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const sessionId =
      auth?.sessionId ??
      (await this.sessions.sessionIdFromRefresh(this.readRefreshCookie(req)));
    await this.auth.logout(sessionId, auth?.userId, requestMeta(req));
    this.clearRefreshCookie(res);
  }

  @HttpCode(200)
  @Post('logout-all')
  async logoutAll(
    @CurrentUser() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const revoked = await this.auth.logoutAll(auth, requestMeta(req));
    this.clearRefreshCookie(res);
    this.realtime.disconnectUser(auth.userId);
    return { revokedSessions: revoked };
  }

  @Get('me')
  me(@CurrentUser() auth: AuthContext) {
    return this.auth.me(auth.userId);
  }

  @Get('sessions')
  async listSessions(@CurrentUser() auth: AuthContext) {
    const sessions = await this.sessions.listActive(auth.userId);
    return sessions.map((s) => ({
      id: s.id,
      current: s.id === auth.sessionId,
      userAgent: s.userAgent,
      /** Short fingerprint so users can tell sessions apart without exposing the IP. */
      networkFingerprint: s.ipHash?.slice(0, 8) ?? null,
      createdAt: s.createdAt.toISOString(),
      lastActiveAt: s.lastActiveAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    }));
  }

  @HttpCode(204)
  @Delete('sessions/:id')
  async revokeSession(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const ok = await this.sessions.revokeSession(
      id,
      'USER_REVOKED',
      auth.userId,
    );
    if (!ok) throw Errors.notFound('Session');
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @HttpCode(200)
  @Post('verify-email')
  async verifyEmail(@Body() dto: TokenDto, @Req() req: Request) {
    await this.auth.verifyEmail(dto.token, requestMeta(req));
    return { verified: true };
  }

  /** Code method. Signed in: verifies the caller. Signed out: `email` is required. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @HttpCode(200)
  @Post('verify-email/code')
  async verifyEmailCode(
    @Body() dto: VerifyCodeDto,
    @OptionalUser() auth: AuthContext | undefined,
    @Req() req: Request,
  ) {
    if (!auth && !dto.email)
      throw Errors.badRequest(
        'EMAIL_REQUIRED',
        'Sign in, or enter the email address the code was sent to.',
      );
    await this.auth.verifyEmailCode(
      dto.code,
      auth ? { userId: auth.userId } : { email: dto.email! },
      requestMeta(req),
    );
    return { verified: true };
  }

  @Throttle({ default: { limit: 3, ttl: 15 * MINUTE } })
  @HttpCode(200)
  @Post('resend-verification')
  resendVerification(@CurrentUser() auth: AuthContext) {
    return this.auth.resendVerification(auth);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE } })
  @HttpCode(202)
  @Post('forgot-password')
  forgotPassword(@Body() dto: EmailDto, @Req() req: Request) {
    this.auth.requestPasswordReset(dto.email, requestMeta(req));
    return {
      message:
        'If an account exists for that email, a reset link has been sent.',
    };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @HttpCode(200)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.auth.resetPassword(dto.token, dto.newPassword, requestMeta(req));
    return { reset: true };
  }

  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE } })
  @HttpCode(200)
  @Post('change-password')
  changePassword(
    @CurrentUser() auth: AuthContext,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.auth.changePassword(
      auth,
      dto.currentPassword,
      dto.newPassword,
      requestMeta(req),
    );
  }

  // ───────────── cookie helpers ─────────────

  private respond(res: Response, result: AuthResult) {
    res.cookie(REFRESH_COOKIE, result.refresh.value, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      path: AUTH_COOKIE_PATH,
      domain: this.config.cookieDomain,
      expires: result.refresh.expiresAt,
    });
    res.setHeader('Cache-Control', 'no-store');
    return {
      user: result.user,
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      ...(result.verificationEmail
        ? { verificationEmail: result.verificationEmail }
        : {}),
    };
  }

  private clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      path: AUTH_COOKIE_PATH,
      domain: this.config.cookieDomain,
    });
  }

  private readRefreshCookie(req: Request): string | undefined {
    const v = (req.cookies as Record<string, unknown> | undefined)?.[
      REFRESH_COOKIE
    ];
    return typeof v === 'string' ? v : undefined;
  }
}
