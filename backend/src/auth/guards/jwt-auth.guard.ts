import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../../common/decorators.js';
import type { AuthedRequest } from '../../common/auth-context.js';
import { Errors } from '../../common/errors.js';
import { AccessTokenService } from '../access-token.service.js';

/**
 * Global guard: every route requires a valid `Authorization: Bearer <access token>`
 * unless marked @Public(). On public routes a valid token is still attached so the
 * handler can personalise the response; an invalid one is ignored there.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7).trim()
        : undefined;

    if (!token) {
      if (isPublic) return true;
      throw Errors.unauthorized();
    }
    try {
      req.auth = await this.tokens.authenticate(token);
    } catch (err) {
      if (isPublic) return true;
      throw err;
    }
    return true;
  }
}
