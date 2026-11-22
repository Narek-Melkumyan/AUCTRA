import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppConfig } from '../config/app-config.js';
import { hmacHex, randomToken, safeEqual } from '../common/crypto.js';
import { Errors } from '../common/errors.js';

export const CSRF_COOKIE = 'auctra_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const AUTH_COOKIE_PATH = '/api/auth';

/**
 * CSRF protection for the cookie-authenticated auth endpoints (login, register,
 * refresh, logout). Everything else authenticates with a bearer header that browsers
 * never attach automatically, so it is not CSRF-exposed.
 *
 * Defence in depth:
 *  1. The refresh cookie is SameSite=Strict and scoped to /api/auth.
 *  2. Origin / Sec-Fetch-Site must match an allowed frontend origin.
 *  3. Signed double-submit token: `GET /api/auth/csrf` sets an HttpOnly cookie and
 *     returns the same value in the body (readable only by allowed origins via CORS);
 *     the client echoes it in `X-CSRF-Token`. The value is HMAC-signed so it cannot
 *     be forged by a sibling subdomain that can plant cookies.
 */
@Injectable()
export class CsrfService {
  constructor(private readonly config: AppConfig) {}

  issue(res: Response): string {
    const nonce = randomToken(24);
    const token = `${nonce}.${hmacHex(this.config.csrfSecret, nonce)}`;
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      path: AUTH_COOKIE_PATH,
      domain: this.config.cookieDomain,
      maxAge: 12 * 3600 * 1000,
    });
    return token;
  }

  verify(req: Request): void {
    this.verifyOrigin(req);
    const header = req.headers[CSRF_HEADER];
    const cookie = (req.cookies as Record<string, string> | undefined)?.[
      CSRF_COOKIE
    ];
    if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie)) {
      throw Errors.forbidden('Missing or invalid CSRF token.');
    }
    const [nonce, sig] = header.split('.');
    if (
      !nonce ||
      !sig ||
      !safeEqual(sig, hmacHex(this.config.csrfSecret, nonce))
    ) {
      throw Errors.forbidden('Missing or invalid CSRF token.');
    }
  }

  private verifyOrigin(req: Request): void {
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      if (!this.config.corsOrigins.includes(origin.replace(/\/$/, ''))) {
        throw Errors.forbidden('Request origin is not allowed.');
      }
      return;
    }
    // No Origin header (same-origin GET-style or non-browser client): reject only if the
    // browser tells us the request is cross-site.
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw Errors.forbidden('Cross-site request blocked.');
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly csrf: CsrfService) {}

  canActivate(ctx: ExecutionContext): boolean {
    this.csrf.verify(ctx.switchToHttp().getRequest<Request>());
    return true;
  }
}
