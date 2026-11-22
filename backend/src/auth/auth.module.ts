import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AccessTokenService } from './access-token.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { CsrfGuard, CsrfService } from './csrf.service.js';
import { RealtimeSessions } from './realtime-sessions.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Global()
@Module({
  // Secrets/algorithms are passed explicitly at sign/verify time (AccessTokenService).
  imports: [JwtModule.register({}), NotificationsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenService,
    PasswordService,
    SessionService,
    CsrfService,
    CsrfGuard,
    RealtimeSessions,
  ],
  exports: [
    AccessTokenService,
    PasswordService,
    SessionService,
    RealtimeSessions,
    AuthService,
  ],
})
export class AuthModule {}
