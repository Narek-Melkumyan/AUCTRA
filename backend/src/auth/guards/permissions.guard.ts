import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS } from '../../common/decorators.js';
import type { AuthedRequest } from '../../common/auth-context.js';
import { Errors } from '../../common/errors.js';

/** Global guard enforcing @RequirePermissions(...) against DB-resolved permissions. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required?.length) return true;
    const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth) throw Errors.unauthorized();
    if (!required.every((p) => auth.permissions.has(p)))
      throw Errors.forbidden();
    return true;
  }
}
