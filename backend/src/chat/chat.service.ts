import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type AuctionStatus,
  type ChatMessageStatus,
  type ChatRestrictionType,
} from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { isRestricted, type AuthContext } from '../common/auth-context.js';
import { Permission, RoleKey } from '../roles/permissions.js';
import { AppConfig } from '../config/app-config.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export const CHAT_MAX_LENGTH = 500;
/** Statuses in which an auction's chat accepts new messages. */
const CHAT_OPEN: AuctionStatus[] = ['SCHEDULED', 'LIVE'];
const STAFF_ROLES: string[] = [
  RoleKey.MODERATOR,
  RoleKey.ADMIN,
  RoleKey.SUPER_ADMIN,
];

/** Spam limits per author (all auctions combined for the burst, per room for duplicates). */
export const CHAT_LIMITS = {
  burst: { count: 5, windowMs: 10_000 },
  sustained: { count: 20, windowMs: 120_000 },
  duplicateWindowMs: 60_000,
  maxLinks: 2,
};

export type CannotPostReason =
  | 'SIGN_IN_REQUIRED'
  | 'EMAIL_NOT_VERIFIED'
  | 'ACCOUNT_RESTRICTED'
  | 'MUTED'
  | 'BANNED'
  | 'CHAT_CLOSED';

export interface ChatViewer {
  canPost: boolean;
  reason?: CannotPostReason;
  mutedUntil?: string;
  isModerator: boolean;
}

export interface ChatMessageDto {
  id: string;
  seq: string;
  auctionId: string;
  author: {
    handle: string;
    displayName: string;
    isSeller: boolean;
    isStaff: boolean;
  };
  /** null when the message is hidden/deleted and the viewer is not a moderator. */
  body: string | null;
  status: ChatMessageStatus;
  createdAt: string;
  mine: boolean;
  /** Moderators only. */
  authorId?: string;
  moderation?: { reason: string | null; at: string | null };
}

const messageInclude = {
  author: {
    select: {
      id: true,
      profile: { select: { handle: true, displayName: true } },
      roles: { select: { role: { select: { key: true } } } },
    },
  },
  auction: { select: { sellerId: true } },
} satisfies Prisma.AuctionChatMessageInclude;

type MessageRow = Prisma.AuctionChatMessageGetPayload<{
  include: typeof messageInclude;
}>;

/**
 * Normalises user text: strips control and zero-width characters (keeping newlines),
 * collapses blank-line runs and trims. Output is plain text; clients render it as text.
 */
export function sanitizeChatBody(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auctions: AuctionsService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly notifications: NotificationsService,
  ) {}

  isModerator(auth?: AuthContext) {
    return !!auth?.permissions.has(Permission.CHAT_MODERATE);
  }

  private async loadAuction(auctionId: string, auth?: AuthContext) {
    const a = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      select: {
        id: true,
        sellerId: true,
        status: true,
        visibility: true,
        endsAt: true,
      },
    });
    if (!a || !this.auctions.canView(a, auth)) throw Errors.notFound('Auction');
    return a;
  }

  async activeRestriction(
    userId: string,
    db: Tx | PrismaService = this.prisma,
  ) {
    return db.chatRestriction.findFirst({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      // A ban outranks a mute; then the longest-running restriction.
      orderBy: [
        { type: 'desc' },
        { expiresAt: { sort: 'desc', nulls: 'first' } },
      ],
    });
  }

  async viewer(
    auction: { status: AuctionStatus; endsAt: Date },
    auth?: AuthContext,
  ): Promise<ChatViewer> {
    const isModerator = this.isModerator(auth);
    const no = (reason: CannotPostReason, extra: Partial<ChatViewer> = {}) => ({
      canPost: false,
      reason,
      isModerator,
      ...extra,
    });
    if (!auth) return no('SIGN_IN_REQUIRED');
    if (
      !CHAT_OPEN.includes(auction.status) ||
      auction.endsAt.getTime() <= Date.now()
    )
      return no('CHAT_CLOSED');
    if (isRestricted(auth) || !auth.permissions.has(Permission.CHAT_SEND))
      return no('ACCOUNT_RESTRICTED');
    if (this.config.biddingRequireVerifiedEmail && !auth.emailVerified)
      return no('EMAIL_NOT_VERIFIED');
    const r = await this.activeRestriction(auth.userId);
    if (r?.type === 'BAN') return no('BANNED');
    if (r?.type === 'MUTE')
      return no('MUTED', { mutedUntil: r.expiresAt!.toISOString() });
    return { canPost: true, isModerator };
  }

  async list(
    auctionId: string,
    auth: AuthContext | undefined,
    q: { before?: string; after?: string; limit?: number },
  ): Promise<{
    messages: ChatMessageDto[];
    hasMore: boolean;
    viewer: ChatViewer;
  }> {
    const auction = await this.loadAuction(auctionId, auth);
    const mod = this.isModerator(auth);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    const where: Prisma.AuctionChatMessageWhereInput = {
      auctionId,
      ...(mod ? {} : { status: 'VISIBLE' }),
      ...(q.after ? { seq: { gt: BigInt(q.after) } } : {}),
      ...(q.before ? { seq: { lt: BigInt(q.before) } } : {}),
    };
    const ascending = !!q.after;
    const rows = await this.prisma.auctionChatMessage.findMany({
      where,
      include: messageInclude,
      orderBy: { seq: ascending ? 'asc' : 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    if (!ascending) page.reverse();
    return {
      messages: page.map((m) => this.toDto(m, auth)),
      hasMore,
      viewer: await this.viewer(auction, auth),
    };
  }

  async send(
    auctionId: string,
    auth: AuthContext,
    input: { body: string; clientMessageId?: string | undefined },
  ): Promise<{ message: ChatMessageDto; replayed: boolean }> {
    const body = sanitizeChatBody(input.body);
    if (!body)
      throw Errors.badRequest('EMPTY_MESSAGE', 'Write a message first.');
    if (body.length > CHAT_MAX_LENGTH)
      throw Errors.badRequest(
        'MESSAGE_TOO_LONG',
        `Messages can be at most ${CHAT_MAX_LENGTH} characters.`,
      );
    if ((body.match(/https?:\/\/|www\./gi) ?? []).length > CHAT_LIMITS.maxLinks)
      throw Errors.unprocessable(
        'TOO_MANY_LINKS',
        'Messages can contain at most two links.',
      );

    if (input.clientMessageId) {
      const existing = await this.prisma.auctionChatMessage.findUnique({
        where: {
          authorId_clientMessageId: {
            authorId: auth.userId,
            clientMessageId: input.clientMessageId,
          },
        },
        include: messageInclude,
      });
      if (existing) {
        if (existing.auctionId !== auctionId)
          throw Errors.conflict(
            'CLIENT_ID_REUSED',
            'This message id was already used in another room.',
          );
        return { message: this.toDto(existing, auth), replayed: true };
      }
    }

    const auction = await this.loadAuction(auctionId, auth);
    const v = await this.viewer(auction, auth);
    if (!v.canPost) throw this.cannotPost(v);

    const row = await this.prisma.$transaction(async (tx) => {
      // Serialise one author's sends so the spam limits are counted exactly.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chat:${auth.userId}`}, 0))`;
      const now = Date.now();
      const recent = await tx.auctionChatMessage.findMany({
        where: {
          authorId: auth.userId,
          createdAt: {
            gt: new Date(now - CHAT_LIMITS.sustained.windowMs),
          },
        },
        select: { createdAt: true, body: true, auctionId: true },
        orderBy: { createdAt: 'desc' },
      });
      const inBurst = recent.filter(
        (r) => r.createdAt.getTime() > now - CHAT_LIMITS.burst.windowMs,
      ).length;
      if (
        inBurst >= CHAT_LIMITS.burst.count ||
        recent.length >= CHAT_LIMITS.sustained.count
      )
        throw Errors.tooMany(
          "You're sending messages too quickly. Wait a few seconds.",
        );
      const dup = recent.some(
        (r) =>
          r.auctionId === auctionId &&
          r.body.toLowerCase() === body.toLowerCase() &&
          r.createdAt.getTime() > now - CHAT_LIMITS.duplicateWindowMs,
      );
      if (dup)
        throw Errors.conflict(
          'DUPLICATE_MESSAGE',
          'You just sent that message.',
        );
      const created = await tx.auctionChatMessage.create({
        data: {
          auctionId,
          authorId: auth.userId,
          body,
          clientMessageId: input.clientMessageId ?? null,
        },
        include: messageInclude,
      });
      await this.outbox.enqueue(tx, {
        aggregateType: 'chat',
        aggregateId: auctionId,
        version: 0,
        type: 'chat.message',
        payload: this.publicPayload(created) as Prisma.InputJsonValue,
      });
      if (auction.sellerId !== auth.userId) {
        // At most one "new chat activity" notification per seller per room per 15 min.
        const bucket = Math.floor(now / (15 * 60_000));
        await this.notifications.notifyMany(tx, [
          {
            userId: auction.sellerId,
            type: 'CHAT_MESSAGE',
            title: `New questions in your auction chat`,
            body: `@${created.author.profile?.handle ?? 'member'}: ${body.slice(0, 140)}`,
            auctionId,
            dedupeKey: `chat:${auctionId}:${bucket}`,
          },
        ]);
      }
      return created;
    });
    this.outbox.kick();
    return { message: this.toDto(row, auth), replayed: false };
  }

  private cannotPost(v: ChatViewer) {
    switch (v.reason) {
      case 'EMAIL_NOT_VERIFIED':
        return Errors.forbiddenCode(
          'EMAIL_NOT_VERIFIED',
          'Verify your email address before chatting.',
        );
      case 'MUTED':
        return Errors.forbiddenCode(
          'CHAT_MUTED',
          `You're muted in auction chat until ${new Date(v.mutedUntil!).toUTCString()}.`,
          { mutedUntil: v.mutedUntil },
        );
      case 'BANNED':
        return Errors.forbiddenCode(
          'CHAT_BANNED',
          'You can no longer post in auction chat.',
        );
      case 'CHAT_CLOSED':
        return Errors.unprocessable(
          'CHAT_CLOSED',
          'Chat is closed for this auction.',
        );
      default:
        return Errors.forbiddenCode(
          'ACCOUNT_RESTRICTED',
          'Your account cannot post in chat.',
        );
    }
  }

  async report(
    messageId: string,
    auth: AuthContext,
    input: { reason: string; details?: string | undefined },
  ) {
    const msg = await this.prisma.auctionChatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, auctionId: true, authorId: true, status: true },
    });
    if (!msg || msg.status === 'DELETED') throw Errors.notFound('Message');
    await this.loadAuction(msg.auctionId, auth);
    if (msg.authorId === auth.userId)
      throw Errors.unprocessable(
        'OWN_MESSAGE',
        'You cannot report your own message.',
      );
    const dup = await this.prisma.report.findFirst({
      where: {
        reporterId: auth.userId,
        targetType: 'CHAT_MESSAGE',
        targetId: messageId,
      },
      select: { id: true },
    });
    if (dup) return { reported: true, duplicate: true };
    await this.prisma.report.create({
      data: {
        reporterId: auth.userId,
        targetType: 'CHAT_MESSAGE',
        targetId: messageId,
        reason: input.reason,
        details: input.details ?? null,
      },
    });
    return { reported: true, duplicate: false };
  }

  // ───────────── Moderation ─────────────

  async moderateMessage(
    messageId: string,
    actor: AuthContext,
    action: 'hide' | 'delete' | 'restore',
    reason: string | undefined,
    meta: { ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<ChatMessageDto> {
    const status: ChatMessageStatus =
      action === 'hide'
        ? 'HIDDEN'
        : action === 'delete'
          ? 'DELETED'
          : 'VISIBLE';
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.auctionChatMessage.findUnique({
        where: { id: messageId },
        select: { id: true, status: true, authorId: true, auctionId: true },
      });
      if (!current) throw Errors.notFound('Message');
      if (current.status === status)
        return tx.auctionChatMessage.findUniqueOrThrow({
          where: { id: messageId },
          include: messageInclude,
        });
      const updated = await tx.auctionChatMessage.update({
        where: { id: messageId },
        data: {
          status,
          moderatedById: actor.userId,
          moderatedAt: new Date(),
          moderationReason: reason ?? null,
        },
        include: messageInclude,
      });
      await tx.moderationAction.create({
        data: {
          moderatorId: actor.userId,
          action:
            action === 'hide'
              ? 'HIDE_MESSAGE'
              : action === 'delete'
                ? 'DELETE_MESSAGE'
                : 'RESTORE_MESSAGE',
          targetType: 'CHAT_MESSAGE',
          targetId: messageId,
          subjectUserId: current.authorId,
          reason: reason ?? null,
        },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: `chat.message_${action}`,
          entityType: 'chat_message',
          entityId: messageId,
          metadata: { auctionId: current.auctionId, reason: reason ?? null },
          ...meta,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        aggregateType: 'chat',
        aggregateId: current.auctionId,
        version: 0,
        type: 'chat.update',
        payload: this.publicPayload(updated) as Prisma.InputJsonValue,
      });
      return updated;
    });
    this.outbox.kick();
    return this.toDto(row, actor);
  }

  async restrict(
    actor: AuthContext,
    input: {
      userId: string;
      type: ChatRestrictionType;
      minutes?: number | undefined;
      reason?: string | undefined;
      hideRecentMessages?: boolean | undefined;
    },
    meta: { ip?: string | undefined; userAgent?: string | undefined },
  ) {
    if (input.userId === actor.userId)
      throw Errors.unprocessable(
        'SELF_ACTION',
        'You cannot restrict yourself.',
      );
    const target = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        roles: { select: { role: { select: { key: true } } } },
      },
    });
    if (!target) throw Errors.notFound('User');
    // Staff can only be restricted by a super-admin.
    const targetIsStaff = target.roles.some((r) =>
      STAFF_ROLES.includes(r.role.key),
    );
    if (targetIsStaff && !actor.roles.includes(RoleKey.SUPER_ADMIN))
      throw Errors.forbidden('Only a super-admin can restrict staff accounts.');
    if (input.type === 'MUTE' && !input.minutes)
      throw Errors.badRequest('MINUTES_REQUIRED', 'Choose how long to mute.');

    const restriction = await this.prisma.$transaction(async (tx) => {
      const r = await tx.chatRestriction.create({
        data: {
          userId: input.userId,
          type: input.type,
          reason: input.reason ?? null,
          expiresAt:
            input.type === 'MUTE'
              ? new Date(Date.now() + input.minutes! * 60_000)
              : null,
          createdById: actor.userId,
        },
      });
      await tx.moderationAction.create({
        data: {
          moderatorId: actor.userId,
          action: input.type === 'MUTE' ? 'MUTE_USER' : 'BAN_FROM_CHAT',
          targetType: 'USER',
          targetId: input.userId,
          subjectUserId: input.userId,
          reason: input.reason ?? null,
        },
      });
      let hidden = 0;
      if (input.hideRecentMessages) {
        const recent = await tx.auctionChatMessage.findMany({
          where: {
            authorId: input.userId,
            status: 'VISIBLE',
            createdAt: { gt: new Date(Date.now() - 86_400_000) },
          },
          include: messageInclude,
        });
        for (const m of recent) {
          const u = await tx.auctionChatMessage.update({
            where: { id: m.id },
            data: {
              status: 'HIDDEN',
              moderatedById: actor.userId,
              moderatedAt: new Date(),
              moderationReason: input.reason ?? 'User restricted',
            },
            include: messageInclude,
          });
          await this.outbox.enqueue(tx, {
            aggregateType: 'chat',
            aggregateId: m.auctionId,
            version: 0,
            type: 'chat.update',
            payload: this.publicPayload(u) as Prisma.InputJsonValue,
          });
        }
        hidden = recent.length;
      }
      await this.audit.record(
        {
          actorId: actor.userId,
          action:
            input.type === 'MUTE' ? 'chat.user_muted' : 'chat.user_banned',
          entityType: 'user',
          entityId: input.userId,
          metadata: {
            restrictionId: r.id,
            minutes: input.minutes ?? null,
            reason: input.reason ?? null,
            hiddenMessages: hidden,
          },
          ...meta,
        },
        tx,
      );
      return { ...r, hiddenMessages: hidden };
    });
    this.outbox.kick();
    return restriction;
  }

  async lift(
    actor: AuthContext,
    restrictionId: string,
    meta: { ip?: string | undefined; userAgent?: string | undefined },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.chatRestriction.findUnique({
        where: { id: restrictionId },
      });
      if (!r) throw Errors.notFound('Restriction');
      if (r.revokedAt) return r;
      const updated = await tx.chatRestriction.update({
        where: { id: restrictionId },
        data: { revokedAt: new Date(), revokedById: actor.userId },
      });
      await tx.moderationAction.create({
        data: {
          moderatorId: actor.userId,
          action: 'LIFT_CHAT_RESTRICTION',
          targetType: 'USER',
          targetId: r.userId,
          subjectUserId: r.userId,
        },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'chat.restriction_lifted',
          entityType: 'user',
          entityId: r.userId,
          metadata: { restrictionId },
          ...meta,
        },
        tx,
      );
      return updated;
    });
  }

  async searchMessages(
    auth: AuthContext,
    q: {
      auctionId?: string | undefined;
      authorId?: string | undefined;
      status?: ChatMessageStatus | undefined;
      q?: string | undefined;
      reported?: boolean | undefined;
      before?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const limit = Math.min(q.limit ?? 50, 100);
    let reportedIds: string[] | undefined;
    if (q.reported) {
      reportedIds = (
        await this.prisma.report.findMany({
          where: {
            targetType: 'CHAT_MESSAGE',
            status: { in: ['OPEN', 'UNDER_REVIEW'] },
          },
          select: { targetId: true },
          distinct: ['targetId'],
        })
      ).map((r) => r.targetId);
    }
    const rows = await this.prisma.auctionChatMessage.findMany({
      where: {
        ...(q.auctionId ? { auctionId: q.auctionId } : {}),
        ...(q.authorId ? { authorId: q.authorId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.q ? { body: { contains: q.q, mode: 'insensitive' } } : {}),
        ...(reportedIds ? { id: { in: reportedIds } } : {}),
        ...(q.before ? { seq: { lt: BigInt(q.before) } } : {}),
      },
      include: {
        ...messageInclude,
        auction: { select: { sellerId: true, title: true, id: true } },
      },
      orderBy: { seq: 'desc' },
      take: limit,
    });
    const counts = await this.prisma.report.groupBy({
      by: ['targetId'],
      where: {
        targetType: 'CHAT_MESSAGE',
        targetId: { in: rows.map((r) => r.id) },
        status: { in: ['OPEN', 'UNDER_REVIEW'] },
      },
      _count: { _all: true },
    });
    const openReports = new Map(counts.map((c) => [c.targetId, c._count._all]));
    return rows.map((r) => ({
      ...this.toDto(r, auth),
      authorId: r.authorId,
      auctionTitle: r.auction.title,
      openReports: openReports.get(r.id) ?? 0,
    }));
  }

  async restrictions(activeOnly: boolean) {
    const rows = await this.prisma.chatRestriction.findMany({
      where: activeOnly
        ? {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          }
        : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        user: {
          select: { email: true, profile: { select: { handle: true } } },
        },
        createdBy: { select: { profile: { select: { handle: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      handle: r.user.profile?.handle ?? null,
      email: r.user.email,
      type: r.type,
      reason: r.reason,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy?.profile?.handle ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      active:
        !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > Date.now()),
    }));
  }

  async moderationLog(limit = 100) {
    const rows = await this.prisma.moderationAction.findMany({
      where: {
        OR: [
          { targetType: 'CHAT_MESSAGE' },
          {
            action: {
              in: [
                'MUTE_USER',
                'BAN_FROM_CHAT',
                'LIFT_CHAT_RESTRICTION',
                'DISMISS_REPORT',
              ],
            },
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: {
        moderator: { select: { profile: { select: { handle: true } } } },
        subjectUser: { select: { profile: { select: { handle: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      moderator: r.moderator?.profile?.handle ?? null,
      subject: r.subjectUser?.profile?.handle ?? null,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ───────────── Mapping ─────────────

  private authorInfo(m: MessageRow) {
    return {
      handle: m.author.profile?.handle ?? 'member',
      displayName: m.author.profile?.displayName ?? 'Member',
      isSeller: m.authorId === m.auction.sellerId,
      isStaff: m.author.roles.some((r) => STAFF_ROLES.includes(r.role.key)),
    };
  }

  toDto(m: MessageRow, auth?: AuthContext): ChatMessageDto {
    const mod = this.isModerator(auth);
    const visible = m.status === 'VISIBLE';
    return {
      id: m.id,
      seq: m.seq.toString(),
      auctionId: m.auctionId,
      author: this.authorInfo(m),
      body: visible || mod ? m.body : null,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      mine: auth?.userId === m.authorId,
      ...(mod
        ? {
            authorId: m.authorId,
            moderation: {
              reason: m.moderationReason,
              at: m.moderatedAt?.toISOString() ?? null,
            },
          }
        : {}),
    };
  }

  /** What goes over the public room socket: never the body of a non-visible message. */
  private publicPayload(m: MessageRow) {
    return {
      id: m.id,
      seq: m.seq.toString(),
      auctionId: m.auctionId,
      author: this.authorInfo(m),
      body: m.status === 'VISIBLE' ? m.body : null,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
