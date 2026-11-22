import { Injectable } from '@nestjs/common';

/**
 * Small indirection so the auth module can force-disconnect a user's sockets (after
 * logout-all, password change, suspension) without depending on the realtime module.
 * The realtime gateway registers the implementation at startup.
 */
@Injectable()
export class RealtimeSessions {
  private impl?: (userId: string) => void;

  register(fn: (userId: string) => void) {
    this.impl = fn;
  }

  disconnectUser(userId: string) {
    this.impl?.(userId);
  }
}
