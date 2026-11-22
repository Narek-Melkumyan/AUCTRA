import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { CurrentUser, RequirePermissions } from '../common/decorators.js';
import { isRestricted, type AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import { Permission } from '../roles/permissions.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class StartConversationDto {
  @IsUUID() auctionId!: string;
  @Transform(trim) @IsString() @Length(1, 4000) message!: string;
}
class MessageDto {
  @Transform(trim) @IsString() @Length(1, 4000) body!: string;
}
class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
}
class ThreadQuery {
  /** Load messages older than this message (pagination backwards in time). */
  @IsOptional() @IsUUID() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

const PAGE = 30;
const partySelect = {
  id: true,
  profile: { select: { displayName: true, handle: true } },
} as const;

type MessageRow = {
  id: string;
  senderId: string;
  body: string;
  hiddenAt: Date | null;
  createdAt: Date;
};

/**
 * Buyer ↔ seller messages about a listing. One thread per (auction, buyer). Only the two
 * participants can read or post; everyone else gets 404. New messages are pushed to both
 * participants over Socket.IO (via the transactional outbox) and the recipient gets one
 * notification per batch of unread messages.
 */
@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auctions: AuctionsService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  async start(auth: AuthContext, dto: StartConversationDto) {
    if (isRestricted(auth))
      throw Errors.forbidden('Your account is restricted.');
    const a = await this.prisma.auction.findUnique({
      where: { id: dto.auctionId },
      select: {
        id: true,
        sellerId: true,
        status: true,
        visibility: true,
        title: true,
      },
    });
    if (!a || !this.auctions.canView(a, auth)) throw Errors.notFound('Auction');
    if (a.sellerId === auth.userId)
      throw Errors.unprocessable('OWN_LISTING', 'You cannot message yourself.');
    const conversationId = await this.prisma.$transaction(async (tx) => {
      // Serialise per (auction, buyer) so two tabs cannot open two threads.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dm:${a.id}:${auth.userId}`}))`;
      const existing = await tx.conversation.findFirst({
        where: {
          auctionId: a.id,
          participants: { some: { userId: auth.userId } },
        },
        select: { id: true },
      });
      const id =
        existing?.id ??
        (
          await tx.conversation.create({
            data: {
              auctionId: a.id,
              subject: a.title.slice(0, 200),
              participants: {
                create: [{ userId: auth.userId }, { userId: a.sellerId }],
              },
            },
            select: { id: true },
          })
        ).id;
      await this.post(tx, auth, id, dto.message);
      return id;
    });
    this.outbox.kick();
    return this.thread(auth, conversationId, {});
  }

  async list(auth: AuthContext, page = 1) {
    const where = { participants: { some: { userId: auth.userId } } };
    const [total, rows] = await Promise.all([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: {
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          participants: { select: { user: { select: partySelect } } },
          auction: {
            select: {
              id: true,
              title: true,
              sellerId: true,
              status: true,
              media: {
                orderBy: { position: 'asc' },
                take: 1,
                select: { url: true, variants: true },
              },
            },
          },
        },
      }),
    ]);
    const unread = await this.unreadByConversation(
      auth.userId,
      rows.map((r) => r.id),
    );
    return {
      total,
      page,
      limit: PAGE,
      items: rows.map((c) => {
        const other = c.participants.find((p) => p.user.id !== auth.userId);
        const last = c.messages[0];
        return {
          id: c.id,
          subject: c.subject,
          auction: c.auction
            ? {
                id: c.auction.id,
                title: c.auction.title,
                status: c.auction.status,
                image: thumbOf(c.auction.media[0]),
              }
            : null,
          myRole: c.auction?.sellerId === auth.userId ? 'seller' : 'buyer',
          counterpart: other ? party(other.user) : null,
          lastMessage: last
            ? {
                body: last.hiddenAt ? null : last.body.slice(0, 200),
                createdAt: last.createdAt.toISOString(),
                mine: last.senderId === auth.userId,
              }
            : null,
          unread: unread.get(c.id) ?? 0,
          updatedAt: c.updatedAt.toISOString(),
        };
      }),
    };
  }

  /** Unread messages across all my conversations (for the header badge). */
  async unreadTotal(auth: AuthContext) {
    const [row] = await this.prisma.$queryRaw<
      { messages: bigint; conversations: bigint }[]
    >`
      SELECT count(*) AS messages, count(DISTINCT m."conversationId") AS conversations
      FROM messages m
      JOIN conversation_participants p
        ON p."conversationId" = m."conversationId" AND p."userId" = ${auth.userId}::uuid
      WHERE m."senderId" <> ${auth.userId}::uuid AND m."hiddenAt" IS NULL
        AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")`;
    return {
      messages: Number(row?.messages ?? 0),
      conversations: Number(row?.conversations ?? 0),
    };
  }

  async thread(auth: AuthContext, id: string, q: ThreadQuery) {
    const c = await this.prisma.conversation.findFirst({
      where: { id, participants: { some: { userId: auth.userId } } },
      include: {
        participants: {
          select: { lastReadAt: true, user: { select: partySelect } },
        },
        auction: {
          select: {
            id: true,
            title: true,
            sellerId: true,
            status: true,
            media: {
              orderBy: { position: 'asc' },
              take: 1,
              select: { url: true, variants: true },
            },
          },
        },
      },
    });
    if (!c) throw Errors.notFound('Conversation');
    const limit = q.limit ?? 50;
    let cursor: { createdAt: Date; id: string } | null = null;
    if (q.before) {
      cursor = await this.prisma.message.findFirst({
        where: { id: q.before, conversationId: id },
        select: { createdAt: true, id: true },
      });
      if (!cursor)
        throw Errors.badRequest('INVALID_CURSOR', 'Unknown message.');
    }
    const rows: MessageRow[] = await this.prisma.message.findMany({
      where: {
        conversationId: id,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const other = c.participants.find((p) => p.user.id !== auth.userId);
    return {
      id: c.id,
      subject: c.subject,
      auction: c.auction
        ? {
            id: c.auction.id,
            title: c.auction.title,
            status: c.auction.status,
            image: thumbOf(c.auction.media[0]),
          }
        : null,
      myRole: c.auction?.sellerId === auth.userId ? 'seller' : 'buyer',
      counterpart: other ? party(other.user) : null,
      /** When the other participant last read the thread (for "seen" markers). */
      counterpartReadAt: other?.lastReadAt?.toISOString() ?? null,
      hasMore,
      messages: page.map((m) => messageDto(m, auth.userId)),
    };
  }

  async markRead(auth: AuthContext, id: string) {
    const now = await this.prisma.dbNow();
    const r = await this.prisma.conversationParticipant.updateMany({
      where: { conversationId: id, userId: auth.userId },
      data: { lastReadAt: now },
    });
    if (!r.count) throw Errors.notFound('Conversation');
    return { readAt: now.toISOString() };
  }

  async send(auth: AuthContext, id: string, dto: MessageDto) {
    if (isRestricted(auth))
      throw Errors.forbidden('Your account is restricted.');
    const message = await this.prisma.$transaction(async (tx) => {
      const member = await tx.conversationParticipant.findUnique({
        where: {
          conversationId_userId: { conversationId: id, userId: auth.userId },
        },
      });
      if (!member) throw Errors.notFound('Conversation');
      return this.post(tx, auth, id, dto.body);
    });
    this.outbox.kick();
    return messageDto(message, auth.userId);
  }

  /** Inserts a message, pushes it to both participants and notifies the recipient. */
  private async post(
    tx: Tx,
    auth: AuthContext,
    conversationId: string,
    body: string,
  ) {
    const now = await this.prisma.dbNow(tx);
    const m = await tx.message.create({
      data: { conversationId, senderId: auth.userId, body, createdAt: now },
    });
    // The sender has read everything up to their own message.
    await tx.conversationParticipant.update({
      where: {
        conversationId_userId: { conversationId, userId: auth.userId },
      },
      data: { lastReadAt: now },
    });
    const conv = await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: now },
      select: {
        subject: true,
        participants: { select: { userId: true, lastReadAt: true } },
      },
    });
    const sender = await tx.userProfile.findUnique({
      where: { userId: auth.userId },
      select: { displayName: true, handle: true },
    });
    for (const p of conv.participants)
      await this.outbox.enqueue(tx, {
        aggregateType: 'user',
        aggregateId: p.userId,
        version: 0,
        type: 'user.message',
        payload: {
          conversationId,
          message: {
            id: m.id,
            senderId: m.senderId,
            body: m.body,
            createdAt: m.createdAt.toISOString(),
          },
        },
      });
    // One notification per batch: only when this is the recipient's first unread message.
    const recipients = conv.participants.filter(
      (p) => p.userId !== auth.userId,
    );
    for (const r of recipients) {
      const earlierUnread = await tx.message.count({
        where: {
          conversationId,
          senderId: { not: r.userId },
          hiddenAt: null,
          id: { not: m.id },
          ...(r.lastReadAt ? { createdAt: { gt: r.lastReadAt } } : {}),
        },
      });
      if (earlierUnread === 0)
        await this.notifications.notifyMany(tx, [
          {
            userId: r.userId,
            type: 'DIRECT_MESSAGE',
            title: `New message from ${sender?.displayName ?? 'a member'}`,
            body: `${conv.subject ? `${conv.subject}: ` : ''}${body.slice(0, 140)}`,
            link: `/messages?c=${conversationId}`,
            data: { conversationId },
            dedupeKey: `dm:${conversationId}:${m.id}`,
          },
        ]);
    }
    return m;
  }

  private async unreadByConversation(userId: string, ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const rows = await this.prisma.$queryRaw<
      { conversationId: string; n: bigint }[]
    >`
      SELECT m."conversationId", count(*) AS n
      FROM messages m
      JOIN conversation_participants p
        ON p."conversationId" = m."conversationId" AND p."userId" = ${userId}::uuid
      WHERE m."conversationId" = ANY(${ids}::uuid[])
        AND m."senderId" <> ${userId}::uuid AND m."hiddenAt" IS NULL
        AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
      GROUP BY m."conversationId"`;
    return new Map(rows.map((r) => [r.conversationId, Number(r.n)]));
  }
}

function party(u: {
  id: string;
  profile: { displayName: string; handle: string } | null;
}) {
  return {
    id: u.id,
    displayName: u.profile?.displayName ?? 'Member',
    handle: u.profile?.handle ?? null,
  };
}

function messageDto(m: MessageRow, me: string) {
  return {
    id: m.id,
    mine: m.senderId === me,
    body: m.hiddenAt ? null : m.body,
    hidden: Boolean(m.hiddenAt),
    createdAt: m.createdAt.toISOString(),
  };
}

function thumbOf(
  media: { url: string; variants: unknown } | undefined,
): string | null {
  if (!media) return null;
  const v = media.variants as { thumbnail?: { url?: string } } | null;
  return v?.thumbnail?.url ?? media.url;
}

@Controller('conversations')
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  list(@CurrentUser() a: AuthContext, @Query() q: ListQuery) {
    return this.messaging.list(a, q.page ?? 1);
  }

  @Get('unread')
  unread(@CurrentUser() a: AuthContext) {
    return this.messaging.unreadTotal(a);
  }

  @RequirePermissions(Permission.MESSAGE_SEND)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  start(@CurrentUser() a: AuthContext, @Body() dto: StartConversationDto) {
    return this.messaging.start(a, dto);
  }

  @Get(':id')
  thread(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ThreadQuery,
  ) {
    return this.messaging.thread(a, id, q);
  }

  @HttpCode(200)
  @Post(':id/read')
  read(@CurrentUser() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.messaging.markRead(a, id);
  }

  @RequirePermissions(Permission.MESSAGE_SEND)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/messages')
  send(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MessageDto,
  ) {
    return this.messaging.send(a, id, dto);
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [MessagingController],
  providers: [MessagingService],
})
export class MessagingModule {}
