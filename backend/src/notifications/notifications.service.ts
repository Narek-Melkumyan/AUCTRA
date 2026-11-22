import { Injectable } from '@nestjs/common';
import type {
  NotificationChannel,
  NotificationType,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { Errors } from '../common/errors.js';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  auctionId?: string;
  data?: Record<string, unknown>;
  /** In-app click-through path (defaults to the auction room when auctionId is set). */
  link?: string;
  /** false: never email this one, whatever the preference (e.g. "email verified"). */
  email?: boolean;
  /** Same key for the same user never creates a second notification (retry-safe). */
  dedupeKey: string;
}

/** Defaults when the user has not set a preference row. In-app is on for everything. */
const EMAIL_DEFAULTS: Record<NotificationType, boolean> = {
  OUTBID: true,
  AUCTION_ENDING_SOON: false,
  AUCTION_WON: true,
  AUCTION_LOST: false,
  AUCTION_STARTED: false,
  AUCTION_SOLD: true,
  AUCTION_UNSOLD: true,
  AUCTION_REMINDER: true,
  ORDER_UPDATE: true,
  ACCOUNT_SECURITY: true,
  SYSTEM: false,
  NEW_BID: false,
  CHAT_MESSAGE: false,
  AUCTION_APPROVED: true,
  AUCTION_REJECTED: true,
  ANNOUNCEMENT: true,
  DIRECT_MESSAGE: true,
};

/** Types users cannot switch off (security). */
export const LOCKED_TYPES: NotificationType[] = ['ACCOUNT_SECURITY'];

export const NOTIFICATION_TYPES = Object.keys(
  EMAIL_DEFAULTS,
) as NotificationType[];
export const USER_CHANNELS: NotificationChannel[] = ['IN_APP', 'EMAIL'];

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Creates in-app notifications (and pending email deliveries) inside the caller's
   * transaction and queues realtime pushes through the outbox.
   */
  async notifyMany(tx: Tx, items: NotifyInput[]): Promise<void> {
    if (!items.length) return;
    const userIds = [...new Set(items.map((i) => i.userId))];
    const prefs = await tx.notificationPreference.findMany({
      where: { userId: { in: userIds } },
    });
    const pref = (
      userId: string,
      type: NotificationType,
      channel: NotificationChannel,
    ) => {
      const row = prefs.find(
        (p) => p.userId === userId && p.type === type && p.channel === channel,
      );
      if (row) return row.enabled;
      return channel === 'IN_APP'
        ? true
        : channel === 'EMAIL'
          ? EMAIL_DEFAULTS[type]
          : false;
    };
    // Security notices cannot be switched off.
    const wanted = items.filter(
      (i) =>
        i.type === 'ACCOUNT_SECURITY' ||
        pref(i.userId, i.type, 'IN_APP') ||
        pref(i.userId, i.type, 'EMAIL'),
    );
    if (!wanted.length) return;

    await tx.notification.createMany({
      data: wanted.map((i) => ({
        userId: i.userId,
        type: i.type,
        title: i.title,
        body: i.body,
        auctionId: i.auctionId ?? null,
        data: {
          ...(i.data ?? {}),
          ...(i.link ? { link: i.link } : {}),
          ...(i.email === false ? { noEmail: true } : {}),
        } as Prisma.InputJsonValue,
        dedupeKey: i.dedupeKey,
      })),
      skipDuplicates: true,
    });
    const created = await tx.notification.findMany({
      where: {
        OR: wanted.map((i) => ({ userId: i.userId, dedupeKey: i.dedupeKey })),
        deliveries: { none: {} },
      },
    });
    if (!created.length) return;

    await tx.notificationDelivery.createMany({
      data: created.flatMap((n) => {
        const rows: Prisma.NotificationDeliveryCreateManyInput[] = [
          {
            notificationId: n.id,
            channel: 'IN_APP',
            status: 'SENT',
            sentAt: new Date(),
            attempts: 1,
          },
        ];
        const noEmail = (n.data as { noEmail?: boolean } | null)?.noEmail;
        if (
          !noEmail &&
          (n.type === 'ACCOUNT_SECURITY' || pref(n.userId, n.type, 'EMAIL'))
        ) {
          rows.push({
            notificationId: n.id,
            channel: 'EMAIL',
            status: 'PENDING',
          });
        }
        return rows;
      }),
      skipDuplicates: true,
    });
    await this.outbox.enqueueMany(
      tx,
      created
        .filter(
          (n) =>
            n.type === 'ACCOUNT_SECURITY' || pref(n.userId, n.type, 'IN_APP'),
        )
        .map((n) => ({
          aggregateType: 'user' as const,
          aggregateId: n.userId,
          version: 0,
          type: 'user.notification',
          payload: toNotificationDto(n) as unknown as Prisma.InputJsonValue,
        })),
    );
  }

  /** Creates notifications in their own transaction and pushes them right away. */
  async notifyNow(items: NotifyInput[]): Promise<void> {
    await this.prisma.$transaction((tx) => this.notifyMany(tx, items));
    this.outbox.kick();
  }

  async list(
    userId: string,
    opts: {
      unreadOnly?: boolean;
      limit?: number;
      before?: string;
      types?: NotificationType[];
    },
  ) {
    const limit = Math.min(opts.limit ?? 30, 100);
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(opts.unreadOnly ? { readAt: null } : {}),
        ...(opts.types?.length ? { type: { in: opts.types } } : {}),
        ...(opts.before ? { createdAt: { lt: new Date(opts.before) } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const unread = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return {
      items: rows.slice(0, limit).map(toNotificationDto),
      unread,
      hasMore: rows.length > limit,
    };
  }

  async markRead(userId: string, id: string) {
    const res = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (!res.count) {
      const exists = await this.prisma.notification.count({
        where: { id, userId },
      });
      if (!exists) throw Errors.notFound('Notification');
    }
  }

  async markAllRead(userId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  async getPreferences(userId: string) {
    const rows = await this.prisma.notificationPreference.findMany({
      where: { userId },
    });
    return NOTIFICATION_TYPES.flatMap((type) =>
      USER_CHANNELS.map((channel) => {
        const row = rows.find((r) => r.type === type && r.channel === channel);
        return {
          type,
          channel,
          enabled: row
            ? row.enabled
            : channel === 'IN_APP'
              ? true
              : EMAIL_DEFAULTS[type],
          locked: LOCKED_TYPES.includes(type),
        };
      }),
    );
  }

  async setPreferences(
    userId: string,
    prefs: {
      type: NotificationType;
      channel: NotificationChannel;
      enabled: boolean;
    }[],
  ) {
    await this.prisma.$transaction(
      prefs
        .filter((p) => !LOCKED_TYPES.includes(p.type))
        .map((p) =>
          this.prisma.notificationPreference.upsert({
            where: {
              userId_type_channel: { userId, type: p.type, channel: p.channel },
            },
            create: {
              userId,
              type: p.type,
              channel: p.channel,
              enabled: p.enabled,
            },
            update: { enabled: p.enabled },
          }),
        ),
    );
    return this.getPreferences(userId);
  }
}

/** Where clicking the notification should take the user. */
export function notificationLink(n: {
  type: NotificationType;
  auctionId: string | null;
  data: Prisma.JsonValue | null;
}): string | null {
  const link = (n.data as { link?: unknown } | null)?.link;
  if (typeof link === 'string' && link.startsWith('/')) return link;
  if (n.type === 'ACCOUNT_SECURITY') return '/settings';
  if (n.type === 'AUCTION_WON' && n.auctionId)
    return `/checkout/${n.auctionId}`;
  if (n.type === 'ORDER_UPDATE') return '/orders';
  if (n.type === 'AUCTION_REJECTED') return '/dashboard';
  return n.auctionId ? `/room/${n.auctionId}` : null;
}

export function toNotificationDto(n: {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  auctionId: string | null;
  data: Prisma.JsonValue | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    auctionId: n.auctionId,
    link: notificationLink(n),
    read: n.readAt !== null,
    createdAt: n.createdAt.toISOString(),
  };
}
