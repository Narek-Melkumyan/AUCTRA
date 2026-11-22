import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Req,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Request } from 'express';
import {
  AnnouncementAudience,
  DeliveryStatus,
  NotificationChannel,
  NotificationType,
} from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { CurrentUser, RequirePermissions } from '../common/decorators.js';
import { requestMeta, type AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import { Permission, RoleKey } from '../roles/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { NotificationsService } from './notifications.service.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import { JobProcessor } from './job-processor.service.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class PreferenceDto {
  @IsEnum(NotificationType) type!: NotificationType;
  @IsEnum(NotificationChannel) channel!: NotificationChannel;
  @IsBoolean() enabled!: boolean;
}

class PreferencesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PreferenceDto)
  preferences!: PreferenceDto[];
}

class ListQuery {
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) =>
      value === true || value === 'true' || value === '1',
  )
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional() @IsISO8601() before?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;

  /** Comma-separated NotificationType list. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsEnum(NotificationType, { each: true })
  types?: NotificationType[];
}

class AnnouncementDto {
  @Transform(trim) @IsString() @Length(3, 200) title!: string;
  @Transform(trim) @IsString() @Length(3, 2000) body!: string;
  @IsOptional() @IsEnum(AnnouncementAudience) audience?: AnnouncementAudience;
  @IsOptional() @IsBoolean() sendEmail?: boolean;
  /** In-app path only, e.g. "/live" or "/room/<id>". */
  @IsOptional() @Matches(/^\/[A-Za-z0-9/_\-?=&.]{0,299}$/) link?: string;
}

class DeliveriesQuery {
  @IsOptional() @IsEnum(DeliveryStatus) status?: DeliveryStatus;
  @IsOptional() @IsEnum(NotificationChannel) channel?: NotificationChannel;
  @IsOptional() @IsEnum(NotificationType) type?: NotificationType;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

const BATCH = 500;

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  private audienceWhere(a: AnnouncementAudience): Prisma.UserWhereInput {
    const base: Prisma.UserWhereInput = {
      deletedAt: null,
      status: { in: ['ACTIVE', 'SUSPENDED'] },
    };
    switch (a) {
      case 'SELLERS':
        return { ...base, roles: { some: { role: { key: RoleKey.SELLER } } } };
      case 'BIDDERS':
        return { ...base, bids: { some: {} } };
      case 'STAFF':
        return {
          ...base,
          roles: {
            some: {
              role: {
                key: {
                  in: [RoleKey.MODERATOR, RoleKey.ADMIN, RoleKey.SUPER_ADMIN],
                },
              },
            },
          },
        };
      default:
        return base;
    }
  }

  async create(actor: AuthContext, dto: AnnouncementDto, req: Request) {
    const audience = dto.audience ?? 'ALL';
    const announcement = await this.prisma.announcement.create({
      data: {
        title: dto.title,
        body: dto.body,
        audience,
        sendEmail: dto.sendEmail ?? false,
        link: dto.link ?? null,
        createdById: actor.userId,
      },
    });
    let recipients = 0;
    let cursor: string | undefined;
    // Fan out in batches, each in its own transaction (dedupe keys make retries safe).
    for (;;) {
      const users = await this.prisma.user.findMany({
        where: this.audienceWhere(audience),
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!users.length) break;
      await this.prisma.$transaction((tx) =>
        this.notifications.notifyMany(
          tx,
          users.map((u) => ({
            userId: u.id,
            type: 'ANNOUNCEMENT' as const,
            title: dto.title,
            body: dto.body,
            ...(dto.link ? { link: dto.link } : {}),
            email: dto.sendEmail ?? false,
            data: { announcementId: announcement.id },
            dedupeKey: `announcement:${announcement.id}`,
          })),
        ),
      );
      recipients += users.length;
      cursor = users[users.length - 1]!.id;
      if (users.length < BATCH) break;
    }
    this.outbox.kick();
    const saved = await this.prisma.announcement.update({
      where: { id: announcement.id },
      data: { recipientCount: recipients },
    });
    await this.audit.recordSafe({
      actorId: actor.userId,
      action: 'notification.announcement_sent',
      entityType: 'announcement',
      entityId: announcement.id,
      metadata: { audience, recipients, sendEmail: saved.sendEmail },
      ...requestMeta(req),
    });
    return this.withStats(saved);
  }

  async list() {
    const rows = await this.prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return Promise.all(rows.map((r) => this.withStats(r)));
  }

  private async withStats(a: {
    id: string;
    title: string;
    body: string;
    audience: AnnouncementAudience;
    sendEmail: boolean;
    link: string | null;
    recipientCount: number;
    createdAt: Date;
  }) {
    const key = `announcement:${a.id}`;
    const [read, deliveries] = await Promise.all([
      this.prisma.notification.count({
        where: { dedupeKey: key, readAt: { not: null } },
      }),
      this.prisma.notificationDelivery.groupBy({
        by: ['channel', 'status'],
        where: { notification: { dedupeKey: key } },
        _count: { _all: true },
      }),
    ]);
    return {
      ...a,
      createdAt: a.createdAt.toISOString(),
      read,
      deliveries: deliveries.map((d) => ({
        channel: d.channel,
        status: d.status,
        count: d._count._all,
      })),
    };
  }

  async deliveries(q: DeliveriesQuery) {
    const rows = await this.prisma.notificationDelivery.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.channel ? { channel: q.channel } : {}),
        ...(q.type ? { notification: { type: q.type } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: q.limit ?? 100,
      include: {
        notification: {
          select: {
            type: true,
            title: true,
            createdAt: true,
            user: { select: { email: true } },
          },
        },
      },
    });
    const summary = await this.prisma.notificationDelivery.groupBy({
      by: ['channel', 'status'],
      _count: { _all: true },
    });
    return {
      summary: summary.map((s) => ({
        channel: s.channel,
        status: s.status,
        count: s._count._all,
      })),
      items: rows.map((d) => ({
        id: d.id,
        channel: d.channel,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
        providerMessageId: d.providerMessageId,
        sentAt: d.sentAt?.toISOString() ?? null,
        nextAttemptAt: d.nextAttemptAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
        type: d.notification.type,
        title: d.notification.title,
        recipient: d.notification.user.email,
      })),
    };
  }
}

@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() auth: AuthContext, @Query() q: ListQuery) {
    return this.notifications.list(auth.userId, {
      unreadOnly: q.unreadOnly ?? false,
      ...(q.before ? { before: q.before } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
      ...(q.types ? { types: q.types } : {}),
    });
  }

  @HttpCode(204)
  @Post(':id/read')
  read(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.markRead(auth.userId, id);
  }

  @HttpCode(200)
  @Post('read-all')
  readAll(@CurrentUser() auth: AuthContext) {
    return this.notifications.markAllRead(auth.userId);
  }

  @Get('preferences')
  prefs(@CurrentUser() auth: AuthContext) {
    return this.notifications.getPreferences(auth.userId);
  }

  @Put('preferences')
  setPrefs(@CurrentUser() auth: AuthContext, @Body() dto: PreferencesDto) {
    return this.notifications.setPreferences(auth.userId, dto.preferences);
  }
}

@RequirePermissions(Permission.NOTIFICATION_BROADCAST)
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(
    private readonly announcements: AnnouncementsService,
    private readonly delivery: EmailDeliveryService,
    private readonly audit: AuditService,
  ) {}

  @Post('announcements')
  announce(
    @CurrentUser() auth: AuthContext,
    @Body() dto: AnnouncementDto,
    @Req() req: Request,
  ) {
    return this.announcements.create(auth, dto, req);
  }

  @Get('announcements')
  list() {
    return this.announcements.list();
  }

  @Get('deliveries')
  deliveries(@Query() q: DeliveriesQuery) {
    return this.announcements.deliveries(q);
  }

  @HttpCode(200)
  @Post('deliveries/:id/retry')
  async retry(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const r = await this.delivery.retry(id);
    if (!r) throw Errors.notFound('Email delivery');
    await this.audit.recordSafe({
      actorId: auth.userId,
      action: 'notification.delivery_retry',
      entityType: 'notification_delivery',
      entityId: id,
      ...requestMeta(req),
    });
    return r;
  }
}

@Module({
  controllers: [NotificationsController, AdminNotificationsController],
  providers: [
    NotificationsService,
    EmailDeliveryService,
    AnnouncementsService,
    JobProcessor,
  ],
  exports: [NotificationsService, EmailDeliveryService, JobProcessor],
})
export class NotificationsModule {}
