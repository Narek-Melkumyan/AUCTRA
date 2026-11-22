import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { AuthContext, AuthedRequest } from './auth-context.js';
import { Errors } from './errors.js';
import type { PermissionKey } from '../roles/permissions.js';

export const IS_PUBLIC = 'auctra:isPublic';
export const PERMISSIONS = 'auctra:permissions';

/** Route does not require authentication (a valid token is still attached if sent). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route requires every listed permission (in addition to authentication). */
export const RequirePermissions = (...perms: PermissionKey[]) =>
  SetMetadata(PERMISSIONS, perms);

/** Injects the authenticated principal; throws 401 if absent. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.auth) throw Errors.unauthorized();
    return req.auth;
  },
);

/** Injects the principal if the caller is signed in, otherwise undefined (for @Public routes). */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().auth,
);
