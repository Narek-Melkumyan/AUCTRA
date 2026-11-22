import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AppConfigModule } from './config/config.module.js';
import { AppConfig } from './config/app-config.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { RedisService } from './redis/redis.service.js';
import { AuditModule } from './audit/audit.service.js';
import { EmailModule } from './email/email.service.js';
import { OutboxModule } from './outbox/outbox.service.js';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './auth/guards/permissions.guard.js';
import {
  AppThrottlerGuard,
  RedisThrottlerStorage,
} from './common/throttling.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { HealthModule } from './health/health.controller.js';
import { UsersModule } from './users/users.module.js';
import { CategoriesModule } from './categories/categories.service.js';
import { AuctionsModule } from './auctions/auctions.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { JobsModule } from './jobs/lifecycle.worker.js';
import { EngagementModule } from './engagement/engagement.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AdminOperationsModule } from './admin/admin-operations.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { CommunityModule } from './community/community.module.js';
import { ChatModule } from './chat/chat.module.js';
import { AiModule } from './ai/ai.module.js';
import { MetricsModule } from './metrics/metrics.service.js';
import { StorageModule } from './storage/storage.service.js';
import { MediaModule } from './media/media.module.js';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    AuditModule,
    EmailModule,
    OutboxModule,
    MetricsModule,
    StorageModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfig, RedisService],
      useFactory: (config: AppConfig, redis: RedisService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
        skipIf: () => !config.rateLimitEnabled,
        ...(redis.enabled ? { storage: new RedisThrottlerStorage(redis) } : {}),
      }),
    }),
    AuthModule,
    HealthModule,
    UsersModule,
    CategoriesModule,
    NotificationsModule,
    AuctionsModule,
    RealtimeModule,
    JobsModule,
    EngagementModule,
    OrdersModule,
    AdminModule,
    AdminOperationsModule,
    MessagingModule,
    CommunityModule,
    ChatModule,
    AiModule,
    MediaModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Order matters: authenticate → rate-limit (per user when signed in) → authorise.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
