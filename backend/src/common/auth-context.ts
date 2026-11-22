import type { Request } from 'express';
import type { UserStatus } from '../generated/prisma/client.js';

/** The authenticated principal attached to a request by JwtAuthGuard. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  emailVerified: boolean;
  status: UserStatus;
  suspendedUntil: Date | null;
  roles: string[];
  permissions: ReadonlySet<string>;
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

/** Suspended users can sign in and read, but not bid, list or message. */
export function isRestricted(
  auth: Pick<AuthContext, 'status' | 'suspendedUntil'>,
  now = new Date(),
): boolean {
  if (auth.status === 'ACTIVE') return false;
  if (
    auth.status === 'SUSPENDED' &&
    auth.suspendedUntil &&
    auth.suspendedUntil <= now
  )
    return false;
  return true;
}

export function requestMeta(req: Request) {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip,
    userAgent: typeof ua === 'string' ? ua.slice(0, 255) : undefined,
  };
}
