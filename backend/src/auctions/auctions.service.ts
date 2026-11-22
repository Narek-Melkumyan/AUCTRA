import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type AuctionStatus,
  type ItemCondition,
} from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CategoriesService } from '../categories/categories.service.js';
import { AuditService } from '../audit/audit.service.js';
import { isRestricted, type AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import { parseMinor } from '../common/money.js';
import { Permission } from '../roles/permissions.js';
import { PUBLIC_STATUSES } from './auction-state.js';
import {
  auctionDetailInclude,
  toAuctionDto,
  type AuctionDto,
  type Viewer,
} from './auction.mapper.js';
import { AuctionLifecycleService } from './auction-lifecycle.service.js';
import type {
  AttributeInputDto,
  CreateAuctionDto,
  ListAuctionsQueryDto,
  UpdateAuctionDto,
} from './dto.js';

const MIN_DURATION_MS = 60_000;
const MAX_DURATION_MS = 90 * 86_400_000;
/** Categories whose typed detail record is mandatory before a listing can be submitted. */
const REQUIRED_DETAILS: Record<string, 'vehicle' | 'watch'> = {
  cars: 'vehicle',
  watches: 'watch',
};

@Injectable()
export class AuctionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly lifecycle: AuctionLifecycleService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly categories: CategoriesService,
    private readonly audit: AuditService,
  ) {}

  private viewer(auth?: AuthContext): Viewer | undefined {
    return auth
      ? {
          userId: auth.userId,
          canReadAny: auth.permissions.has(Permission.AUCTION_READ_ANY),
        }
      : undefined;
  }

  // ───────────── Reads ─────────────

  /** Pages over "open lots by endsAt asc" followed by "closed lots by endsAt desc". */
  private async listOpenThenClosed(
    where: Prisma.AuctionWhereInput,
    now: Date,
    page: number,
    limit: number,
  ) {
    const open: Prisma.AuctionWhereInput = {
      AND: [
        where,
        { status: { in: ['SCHEDULED', 'LIVE'] }, endsAt: { gt: now } },
      ],
    };
    const closed: Prisma.AuctionWhereInput = {
      AND: [
        where,
        { NOT: { status: { in: ['SCHEDULED', 'LIVE'] }, endsAt: { gt: now } } },
      ],
    };
    const [openTotal, closedTotal] = await Promise.all([
      this.prisma.auction.count({ where: open }),
      this.prisma.auction.count({ where: closed }),
    ]);
    const skip = (page - 1) * limit;
    const openRows =
      skip < openTotal
        ? await this.prisma.auction.findMany({
            where: open,
            orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
            include: auctionDetailInclude,
            skip,
            take: limit,
          })
        : [];
    const remaining = limit - openRows.length;
    const closedRows =
      remaining > 0
        ? await this.prisma.auction.findMany({
            where: closed,
            orderBy: [{ endsAt: 'desc' }, { id: 'asc' }],
            include: auctionDetailInclude,
            skip: Math.max(0, skip - openTotal),
            take: remaining,
          })
        : [];
    return [[...openRows, ...closedRows], openTotal + closedTotal] as const;
  }

  async list(query: ListAuctionsQueryDto, auth?: AuthContext) {
    const now = await this.prisma.dbNow();
    const limit = query.limit ?? 24;
    const page = query.page ?? 1;
    const where: Prisma.AuctionWhereInput = {
      visibility: 'PUBLIC',
      status: { in: PUBLIC_STATUSES },
    };
    const and: Prisma.AuctionWhereInput[] = [];
    switch (query.phase ?? 'all') {
      case 'live':
        and.push({
          status: { in: ['LIVE', 'SCHEDULED'] },
          startsAt: { lte: now },
          endsAt: { gt: now },
        });
        break;
      case 'upcoming':
        and.push({ status: 'SCHEDULED', startsAt: { gt: now } });
        break;
      case 'ended':
        and.push({
          OR: [
            { status: { in: ['ENDED', 'SOLD', 'UNSOLD'] } },
            { status: { in: ['LIVE', 'SCHEDULED'] }, endsAt: { lte: now } },
          ],
        });
        break;
      case 'all':
        and.push({ status: { not: 'CANCELLED' } });
        break;
    }
    if (query.category) {
      const slugs = query.category.split(',');
      and.push({
        OR: [
          { category: { slug: { in: slugs } } },
          { subcategory: { slug: { in: slugs } } },
        ],
      });
    }
    // Price = current bid, or the starting price before the first bid (minor units; the
    // bounds are major units of the lot's own currency).
    const minorOf = (major: number) => BigInt(major) * 100n;
    if (query.minPrice !== undefined) {
      const v = minorOf(query.minPrice);
      and.push({
        OR: [
          { currentPriceCents: { gte: v } },
          { currentPriceCents: null, startingPriceCents: { gte: v } },
        ],
      });
    }
    if (query.maxPrice !== undefined) {
      const v = minorOf(query.maxPrice);
      and.push({
        OR: [
          { currentPriceCents: { lte: v } },
          { currentPriceCents: null, startingPriceCents: { lte: v } },
        ],
      });
    }
    if (query.condition)
      and.push({
        condition: {
          in: query.condition.split(',') as ItemCondition[],
        },
      });
    if (query.sellerType)
      and.push({
        seller: {
          sellerProfile: { is: { type: query.sellerType } },
        },
      });
    if (query.seller)
      and.push({
        seller: { profile: { is: { handle: query.seller.toLowerCase() } } },
      });
    if (query.reserve === 'none') and.push({ reservePriceCents: null });
    else if (query.reserve === 'met')
      and.push({
        reservePriceCents: { not: null },
        currentPriceCents: {
          gte: this.prisma.auction.fields.reservePriceCents,
        },
      });
    else if (query.reserve === 'not_met')
      and.push({
        reservePriceCents: { not: null },
        OR: [
          { currentPriceCents: null },
          {
            currentPriceCents: {
              lt: this.prisma.auction.fields.reservePriceCents,
            },
          },
        ],
      });
    if (query.q) {
      and.push({
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { description: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }
    if (and.length) where.AND = and;

    const orderBy: Prisma.AuctionOrderByWithRelationInput[] =
      query.sort === 'newest'
        ? [{ createdAt: 'desc' }]
        : query.sort === 'price_desc'
          ? [
              { currentPriceCents: { sort: 'desc', nulls: 'last' } },
              { startingPriceCents: 'desc' },
            ]
          : query.sort === 'price_asc'
            ? [
                { currentPriceCents: { sort: 'asc', nulls: 'first' } },
                { startingPriceCents: 'asc' },
              ]
            : query.sort === 'most_bids'
              ? [{ bidCount: 'desc' }]
              : query.sort === 'recently_ended'
                ? [{ endsAt: 'desc' }]
                : [{ endsAt: 'asc' }];
    orderBy.push({ id: 'asc' });

    // "Ending soon" across every phase: open lots first (soonest end first), then closed
    // lots (most recently ended first) — otherwise long-finished lots would lead the list.
    const mixed =
      (query.phase ?? 'all') === 'all' &&
      (!query.sort || query.sort === 'ending_soon');
    const [rows, total] = mixed
      ? await this.listOpenThenClosed(where, now, page, limit)
      : await Promise.all([
          this.prisma.auction.findMany({
            where,
            orderBy,
            include: auctionDetailInclude,
            take: limit,
            skip: (page - 1) * limit,
          }),
          this.prisma.auction.count({ where }),
        ]);
    const watching = await this.watchingSet(
      auth,
      rows.map((r) => r.id),
    );
    const viewer = this.viewer(auth);
    return {
      items: rows.map((r) =>
        toAuctionDto(r, this.lifecycle.aliases, now, viewer, {
          watching: watching.has(r.id),
        }),
      ),
      page,
      limit,
      total,
      serverTime: now.toISOString(),
    };
  }

  async get(id: string, auth?: AuthContext): Promise<AuctionDto> {
    const [row, now] = await Promise.all([
      this.prisma.auction.findUnique({
        where: { id },
        include: auctionDetailInclude,
      }),
      this.prisma.dbNow(),
    ]);
    if (!row || !this.canView(row, auth)) throw Errors.notFound('Auction');
    const watching = await this.watchingSet(auth, [id]);
    return toAuctionDto(row, this.lifecycle.aliases, now, this.viewer(auth), {
      watching: watching.has(id),
    });
  }

  /** One cheap query: is the user the seller / watching this auction? */
  async viewerFlags(
    id: string,
    userId: string,
  ): Promise<{ isSeller: boolean; watching: boolean }> {
    const rows = await this.prisma.$queryRaw<
      { isSeller: boolean; watching: boolean }[]
    >`
      SELECT a."sellerId" = ${userId}::uuid AS "isSeller",
             EXISTS (SELECT 1 FROM watchlist_items w WHERE w."auctionId" = a.id AND w."userId" = ${userId}::uuid) AS watching
      FROM auctions a WHERE a.id = ${id}::uuid`;
    return rows[0] ?? { isSeller: false, watching: false };
  }

  canView(
    a: { sellerId: string; status: AuctionStatus; visibility: string },
    auth?: AuthContext,
  ): boolean {
    if (
      auth &&
      (a.sellerId === auth.userId ||
        auth.permissions.has(Permission.AUCTION_READ_ANY))
    )
      return true;
    return a.visibility !== 'PRIVATE' && PUBLIC_STATUSES.includes(a.status);
  }

  async listMine(auth: AuthContext) {
    const now = await this.prisma.dbNow();
    const rows = await this.prisma.auction.findMany({
      where: { sellerId: auth.userId },
      orderBy: { createdAt: 'desc' },
      include: auctionDetailInclude,
      take: 200,
    });
    return rows.map((r) =>
      toAuctionDto(r, this.lifecycle.aliases, now, this.viewer(auth)),
    );
  }

  async history(id: string, auth?: AuthContext) {
    const a = await this.prisma.auction.findUnique({
      where: { id },
      select: { sellerId: true, status: true, visibility: true },
    });
    if (!a || !this.canView(a, auth)) throw Errors.notFound('Auction');
    const events = await this.prisma.auctionEvent.findMany({
      where: { auctionId: id },
      orderBy: { id: 'asc' },
      take: 500,
    });
    return events.map((e) => ({
      id: e.id.toString(),
      type: e.type,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      version: e.version,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  private async watchingSet(auth: AuthContext | undefined, ids: string[]) {
    if (!auth || !ids.length) return new Set<string>();
    const rows = await this.prisma.watchlistItem.findMany({
      where: { userId: auth.userId, auctionId: { in: ids } },
      select: { auctionId: true },
    });
    return new Set(rows.map((r) => r.auctionId));
  }

  // ───────────── Seller writes ─────────────

  async create(auth: AuthContext, dto: CreateAuctionDto): Promise<AuctionDto> {
    this.assertCanSell(auth);
    const id = await this.prisma.$transaction(async (tx) => {
      const { category, subcategory, attributes } =
        await this.categories.resolve(
          tx,
          dto.categorySlug,
          dto.subcategorySlug,
        );
      const prices = validatePrices(dto);
      const { startsAt, endsAt } = validateWindow(dto.startsAt, dto.endsAt);
      const auction = await tx.auction.create({
        data: {
          sellerId: auth.userId,
          categoryId: category.id,
          subcategoryId: subcategory?.id ?? null,
          title: dto.title,
          description: dto.description,
          condition: dto.condition,
          conditionNotes: dto.conditionNotes ?? null,
          locationCity: dto.locationCity ?? null,
          locationRegion: dto.locationRegion ?? null,
          locationCountry: dto.locationCountry ?? null,
          currency: dto.currency,
          ...prices,
          startsAt,
          endsAt,
          originalEndsAt: endsAt,
          visibility: dto.visibility ?? 'PUBLIC',
          ...antiSniping(dto.antiSniping),
          fulfillmentMethod: dto.fulfillmentMethod ?? 'SHIPPING',
          shippingNotes: dto.shippingNotes ?? null,
          inspectionNotes: dto.inspectionNotes ?? null,
        },
      });
      await this.writeChildren(tx, auction.id, dto, attributes);
      await tx.auctionEvent.create({
        data: {
          auctionId: auction.id,
          type: 'CREATED',
          actorId: auth.userId,
          toStatus: 'DRAFT',
          version: 1,
        },
      });
      return auction.id;
    });
    return this.get(id, auth);
  }

  async update(
    auth: AuthContext,
    id: string,
    dto: Partial<UpdateAuctionDto>,
  ): Promise<AuctionDto> {
    this.assertCanSell(auth);
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lifecycle.lock(tx, id);
      if (!locked) throw Errors.notFound('Auction');
      const a = locked.auction;
      if (a.sellerId !== auth.userId) throw Errors.notFound('Auction');
      if (a.status !== 'DRAFT') {
        throw Errors.conflict(
          'AUCTION_NOT_EDITABLE',
          'Only draft auctions can be edited. Withdraw it from review first.',
        );
      }
      const merged = {
        startingPriceMinor:
          dto.startingPriceMinor ?? a.startingPriceCents.toString(),
        minIncrementMinor:
          dto.minIncrementMinor ?? a.minIncrementCents.toString(),
        reservePriceMinor:
          dto.reservePriceMinor ?? a.reservePriceCents?.toString(),
        buyNowPriceMinor:
          dto.buyNowPriceMinor ?? a.buyNowPriceCents?.toString(),
      };
      const prices = validatePrices(merged);
      const window = validateWindow(
        dto.startsAt ?? a.startsAt.toISOString(),
        dto.endsAt ?? a.endsAt.toISOString(),
      );
      let categoryId = a.categoryId;
      let subcategoryId = a.subcategoryId;
      let attributeDefs:
        | Awaited<ReturnType<CategoriesService['resolve']>>['attributes']
        | undefined;
      if (
        dto.categorySlug ||
        dto.subcategorySlug !== undefined ||
        dto.attributes
      ) {
        const current = await tx.category.findUniqueOrThrow({
          where: { id: a.categoryId },
        });
        const currentSub = a.subcategoryId
          ? await tx.category.findUnique({ where: { id: a.subcategoryId } })
          : null;
        const resolved = await this.categories.resolve(
          tx,
          dto.categorySlug ?? current.slug,
          dto.subcategorySlug !== undefined
            ? dto.subcategorySlug
            : currentSub?.slug,
        );
        categoryId = resolved.category.id;
        subcategoryId = resolved.subcategory?.id ?? null;
        attributeDefs = resolved.attributes;
      }
      await tx.auction.update({
        where: { id },
        data: {
          categoryId,
          subcategoryId,
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.condition !== undefined ? { condition: dto.condition } : {}),
          ...(dto.conditionNotes !== undefined
            ? { conditionNotes: dto.conditionNotes }
            : {}),
          ...(dto.locationCity !== undefined
            ? { locationCity: dto.locationCity }
            : {}),
          ...(dto.locationRegion !== undefined
            ? { locationRegion: dto.locationRegion }
            : {}),
          ...(dto.locationCountry !== undefined
            ? { locationCountry: dto.locationCountry }
            : {}),
          ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
          ...(dto.visibility !== undefined
            ? { visibility: dto.visibility }
            : {}),
          ...(dto.fulfillmentMethod !== undefined
            ? { fulfillmentMethod: dto.fulfillmentMethod }
            : {}),
          ...(dto.shippingNotes !== undefined
            ? { shippingNotes: dto.shippingNotes }
            : {}),
          ...(dto.inspectionNotes !== undefined
            ? { inspectionNotes: dto.inspectionNotes }
            : {}),
          ...(dto.antiSniping !== undefined
            ? antiSniping(dto.antiSniping)
            : {}),
          ...prices,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          originalEndsAt: window.endsAt,
          version: { increment: 1 },
        },
      });
      await this.writeChildren(tx, id, dto, attributeDefs);
      await tx.auctionEvent.create({
        data: {
          auctionId: id,
          type: 'UPDATED',
          actorId: auth.userId,
          version: a.version + 1,
        },
      });
    });
    return this.get(id, auth);
  }

  /** DRAFT → PENDING_REVIEW (or straight to SCHEDULED when review is disabled). */
  async submit(auth: AuthContext, id: string): Promise<AuctionDto> {
    this.assertCanSell(auth);
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lifecycle.lock(tx, id);
      if (!locked || locked.auction.sellerId !== auth.userId)
        throw Errors.notFound('Auction');
      const a = locked.auction;
      if (a.endsAt.getTime() - locked.now.getTime() < MIN_DURATION_MS) {
        throw Errors.unprocessable(
          'AUCTION_WINDOW_PASSED',
          'The auction end time must be in the future. Update the schedule first.',
        );
      }
      await this.assertComplete(tx, id);
      const to = this.config.auctionRequireReview
        ? 'PENDING_REVIEW'
        : 'SCHEDULED';
      await this.lifecycle.transition(tx, locked, to, {
        actorId: auth.userId,
        eventType:
          to === 'PENDING_REVIEW' ? 'SUBMITTED_FOR_REVIEW' : 'APPROVED',
        data: {
          submittedAt: locked.now,
          ...(to === 'SCHEDULED' ? { approvedAt: locked.now } : {}),
        },
      });
    });
    this.outbox.kick();
    return this.get(id, auth);
  }

  /** Seller withdraws a listing from review back to draft. */
  async withdraw(auth: AuthContext, id: string): Promise<AuctionDto> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lifecycle.lock(tx, id);
      if (!locked || locked.auction.sellerId !== auth.userId)
        throw Errors.notFound('Auction');
      if (locked.auction.status !== 'PENDING_REVIEW')
        throw Errors.conflict(
          'NOT_IN_REVIEW',
          'Only listings in review can be withdrawn.',
        );
      await this.lifecycle.transition(tx, locked, 'DRAFT', {
        actorId: auth.userId,
        eventType: 'UPDATED',
        metadata: { action: 'withdrawn' },
      });
    });
    return this.get(id, auth);
  }

  /**
   * Cancellation rules:
   *  - Seller: DRAFT, PENDING_REVIEW, SCHEDULED, or LIVE with zero bids.
   *  - Moderator (auction:moderate): any non-terminal state before settlement, reason required.
   * Settled (SOLD/UNSOLD) and ENDED auctions cannot be cancelled here — that is a dispute.
   */
  async cancel(
    auth: AuthContext,
    id: string,
    reason: string,
  ): Promise<AuctionDto> {
    const moderator = auth.permissions.has(Permission.AUCTION_MODERATE);
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lifecycle.lock(tx, id);
      if (!locked) throw Errors.notFound('Auction');
      const a = locked.auction;
      const isOwner = a.sellerId === auth.userId;
      if (!isOwner && !moderator) throw Errors.notFound('Auction');
      if (!moderator) {
        const liveWithBids = a.status === 'LIVE' && a.bidCount > 0;
        if (liveWithBids)
          throw Errors.conflict(
            'CANNOT_CANCEL_WITH_BIDS',
            'Auctions with bids can only be cancelled by AUCTRA support.',
          );
        if (
          !['DRAFT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE'].includes(a.status)
        ) {
          throw Errors.conflict(
            'INVALID_STATUS_TRANSITION',
            `A ${a.status} auction cannot be cancelled.`,
          );
        }
      }
      if (a.status === 'LIVE' && a.endsAt <= locked.now) {
        throw Errors.conflict(
          'AUCTION_ALREADY_ENDED',
          'This auction has already ended and is being settled.',
        );
      }
      await this.lifecycle.transition(tx, locked, 'CANCELLED', {
        actorId: auth.userId,
        eventType: 'CANCELLED',
        data: { cancelledAt: locked.now, cancelReason: reason },
        metadata: {
          reason,
          by: moderator && !isOwner ? 'moderator' : 'seller',
        },
      });
      const bidders = await tx.bid.findMany({
        where: { auctionId: id },
        distinct: ['bidderId'],
        select: { bidderId: true },
      });
      await this.notifications.notifyMany(tx, [
        ...bidders.map((b) => ({
          userId: b.bidderId,
          type: 'SYSTEM' as const,
          title: `Auction cancelled: ${a.title}`,
          body: 'This auction was cancelled. Your bids are void and you will not be charged.',
          auctionId: id,
          dedupeKey: `cancelled:${id}`,
        })),
        ...(isOwner
          ? []
          : [
              {
                userId: a.sellerId,
                type: 'SYSTEM' as const,
                title: `Auction cancelled: ${a.title}`,
                body: `Reason: ${reason}`,
                auctionId: id,
                dedupeKey: `cancelled:${id}`,
              },
            ]),
      ]);
      if (!isOwner) {
        await tx.moderationAction.create({
          data: {
            moderatorId: auth.userId,
            action: 'REMOVE_LISTING',
            targetType: 'AUCTION',
            targetId: id,
            subjectUserId: a.sellerId,
            reason,
          },
        });
      }
      await this.audit.record(
        {
          actorId: auth.userId,
          action: 'auction.cancel',
          entityType: 'auction',
          entityId: id,
          metadata: { reason },
        },
        tx,
      );
    });
    this.outbox.kick();
    return this.get(id, auth);
  }

  // ───────────── Moderation ─────────────

  async listForReview() {
    const now = await this.prisma.dbNow();
    const rows = await this.prisma.auction.findMany({
      where: { status: 'PENDING_REVIEW' },
      orderBy: { submittedAt: 'asc' },
      include: auctionDetailInclude,
      take: 100,
    });
    return rows.map((r) =>
      toAuctionDto(r, this.lifecycle.aliases, now, {
        userId: '',
        canReadAny: true,
      }),
    );
  }

  async approve(auth: AuthContext, id: string): Promise<AuctionDto> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lifecycle.lock(tx, id);
      if (!locked) throw Errors.notFound('Auction');
      const a = locked.auction;
      if (a.status !== 'PENDING_REVIEW')
        throw Errors.conflict(
          'NOT_IN_REVIEW',
          'Only listings in review can be approved.',
        );
      if (a.sellerId === auth.userId)
        throw Errors.forbidden('You cannot approve your own listing.');
      if (a.endsAt <= locked.now) {
        throw Errors.unprocessable(
          'AUCTION_WINDOW_PASSED',
          'The auction end time has passed; the seller must reschedule it.',
        );
      }
      await this.lifecycle.transition(tx, locked, 'SCHEDULED', {
        actorId: auth.userId,
        eventType: 'APPROVED',
        data: { approvedAt: locked.now },
      });
      await tx.moderationAction.create({
        data: {
          moderatorId: auth.userId,
          action: 'APPROVE_LISTING',
          targetType: 'AUCTION',
          targetId: id,
          subjectUserId: a.sellerId,
        },
      });
      await this.notifications.notifyMany(tx, [
        {
          userId: a.sellerId,
          type: 'AUCTION_APPROVED',
          title: `Approved: ${a.title}`,
          body: 'Your listing was approved and is scheduled.',
          auctionId: id,
          dedupeKey: `approved:${id}:${a.version}`,
        },
      ]);
      await this.audit.record(
        {
          actorId: auth.userId,
          action: 'auction.approve',
          entityType: 'auction',
          entityId: id,
        },
        tx,
      );
    });
    this.outbox.kick();
    return this.get(id, auth);
  }

  async reject(
    auth: AuthContext,
    id: string,
    reason: string,
  ): Promise<AuctionDto> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lifecycle.lock(tx, id);
      if (!locked) throw Errors.notFound('Auction');
      const a = locked.auction;
      if (a.status !== 'PENDING_REVIEW')
        throw Errors.conflict(
          'NOT_IN_REVIEW',
          'Only listings in review can be rejected.',
        );
      await this.lifecycle.transition(tx, locked, 'DRAFT', {
        actorId: auth.userId,
        eventType: 'REJECTED',
        metadata: { reason },
      });
      await tx.moderationAction.create({
        data: {
          moderatorId: auth.userId,
          action: 'REJECT_LISTING',
          targetType: 'AUCTION',
          targetId: id,
          subjectUserId: a.sellerId,
          reason,
        },
      });
      await this.notifications.notifyMany(tx, [
        {
          userId: a.sellerId,
          type: 'AUCTION_REJECTED',
          title: `Changes requested: ${a.title}`,
          body: reason,
          auctionId: id,
          dedupeKey: `rejected:${id}:${a.version}`,
        },
      ]);
      await this.audit.record(
        {
          actorId: auth.userId,
          action: 'auction.reject',
          entityType: 'auction',
          entityId: id,
          metadata: { reason },
        },
        tx,
      );
    });
    return this.get(id, auth);
  }

  // ───────────── helpers ─────────────

  private assertCanSell(auth: AuthContext) {
    if (!auth.permissions.has(Permission.AUCTION_CREATE))
      throw Errors.forbidden('Only verified sellers can list auctions.');
    if (isRestricted(auth))
      throw Errors.forbidden('Your account is restricted.');
  }

  private async writeChildren(
    tx: Tx,
    auctionId: string,
    dto: Partial<CreateAuctionDto>,
    attributeDefs?: Awaited<
      ReturnType<CategoriesService['resolve']>
    >['attributes'],
  ) {
    if (dto.media) {
      // URL-based media (https:// or bundled asset://) is replaced wholesale. Uploaded
      // photos live in object storage and are managed only through /auctions/:id/images,
      // so a URL list must never silently drop them (that would orphan their objects).
      const stored = await tx.listingMedia.count({
        where: { auctionId, storage: { in: ['R2', 'LOCAL'] } },
      });
      if (stored > 0)
        throw Errors.conflict(
          'MEDIA_MANAGED_BY_UPLOADS',
          'This listing has uploaded photos. Manage them with the image endpoints instead of the media field.',
        );
      await tx.listingMedia.deleteMany({ where: { auctionId } });
      if (dto.media.length) {
        await tx.listingMedia.createMany({
          data: dto.media.map((m, position) => ({
            auctionId,
            url: m.url,
            type: m.type ?? 'IMAGE',
            altText: m.altText ?? null,
            position,
            isPrimary: position === 0,
            storage: m.url.startsWith('asset://')
              ? ('BUNDLED' as const)
              : ('EXTERNAL' as const),
          })),
        });
      }
    }
    if (dto.attributes && attributeDefs) {
      await tx.auctionAttributeValue.deleteMany({ where: { auctionId } });
      const rows = dto.attributes.map((input) =>
        attributeRow(auctionId, input, attributeDefs),
      );
      if (rows.length)
        await tx.auctionAttributeValue.createMany({ data: rows });
    }
    if (dto.vehicle) {
      await tx.vehicleDetails.upsert({
        where: { auctionId },
        create: { auctionId, ...dto.vehicle },
        update: dto.vehicle,
      });
    }
    if (dto.watch) {
      const data = {
        ...dto.watch,
        caseDiameterMm:
          dto.watch.caseDiameterMm === undefined
            ? undefined
            : new Prisma.Decimal(dto.watch.caseDiameterMm),
      };
      await tx.watchDetails.upsert({
        where: { auctionId },
        create: { auctionId, ...data },
        update: data,
      });
    }
  }

  /** Checks a draft has everything a live listing needs. */
  private async assertComplete(tx: Tx, id: string) {
    // Sequential reads: one transaction = one connection, which must not run queries concurrently.
    const a = await tx.auction.findUniqueOrThrow({
      where: { id },
      include: { category: true },
    });
    const media = await tx.listingMedia.findMany({
      where: { auctionId: id },
      select: { type: true },
    });
    const values = await tx.auctionAttributeValue.findMany({
      where: { auctionId: id },
      select: { attributeId: true },
    });
    const vehicle = await tx.vehicleDetails.findUnique({
      where: { auctionId: id },
      select: { auctionId: true },
    });
    const watch = await tx.watchDetails.findUnique({
      where: { auctionId: id },
      select: { auctionId: true },
    });
    const missing: string[] = [];
    if (!media.some((m) => m.type === 'IMAGE'))
      missing.push('at least one image');
    const defs = await tx.categoryAttribute.findMany({
      where: {
        categoryId: {
          in: [a.categoryId, ...(a.subcategoryId ? [a.subcategoryId] : [])],
        },
        isRequired: true,
      },
    });
    for (const d of defs)
      if (!values.some((v) => v.attributeId === d.id)) missing.push(d.label);
    const detail = REQUIRED_DETAILS[a.category.slug];
    if (detail === 'vehicle' && !vehicle) missing.push('vehicle details');
    if (detail === 'watch' && !watch) missing.push('watch details');
    if (missing.length) {
      throw Errors.unprocessable(
        'LISTING_INCOMPLETE',
        `Add ${missing.join(', ')} before submitting.`,
        { missing },
      );
    }
  }
}

function validatePrices(dto: {
  startingPriceMinor: string;
  minIncrementMinor: string;
  reservePriceMinor?: string | undefined;
  buyNowPriceMinor?: string | undefined;
}) {
  const starting = parseMinor(dto.startingPriceMinor);
  const increment = parseMinor(dto.minIncrementMinor);
  const reserve = dto.reservePriceMinor
    ? parseMinor(dto.reservePriceMinor)
    : null;
  const buyNow = dto.buyNowPriceMinor ? parseMinor(dto.buyNowPriceMinor) : null;
  if (starting <= 0n)
    throw Errors.unprocessable(
      'INVALID_PRICE',
      'Starting price must be greater than zero.',
    );
  if (increment <= 0n)
    throw Errors.unprocessable(
      'INVALID_PRICE',
      'Minimum increment must be greater than zero.',
    );
  if (reserve !== null && reserve < starting)
    throw Errors.unprocessable(
      'INVALID_PRICE',
      'Reserve price cannot be below the starting price.',
    );
  if (buyNow !== null && buyNow <= starting)
    throw Errors.unprocessable(
      'INVALID_PRICE',
      'Buy-now price must exceed the starting price.',
    );
  if (buyNow !== null && reserve !== null && buyNow < reserve) {
    throw Errors.unprocessable(
      'INVALID_PRICE',
      'Buy-now price cannot be below the reserve price.',
    );
  }
  return {
    startingPriceCents: starting,
    minIncrementCents: increment,
    reservePriceCents: reserve,
    buyNowPriceCents: buyNow,
  };
}

function validateWindow(startsAtIso: string, endsAtIso: string) {
  const startsAt = new Date(startsAtIso);
  const endsAt = new Date(endsAtIso);
  const duration = endsAt.getTime() - startsAt.getTime();
  if (Number.isNaN(duration))
    throw Errors.unprocessable(
      'INVALID_SCHEDULE',
      'Invalid start or end time.',
    );
  if (duration < MIN_DURATION_MS)
    throw Errors.unprocessable(
      'INVALID_SCHEDULE',
      'An auction must run for at least one minute.',
    );
  if (duration > MAX_DURATION_MS)
    throw Errors.unprocessable(
      'INVALID_SCHEDULE',
      'An auction can run for at most 90 days.',
    );
  return { startsAt, endsAt };
}

function antiSniping(a: CreateAuctionDto['antiSniping']) {
  return a?.enabled
    ? {
        antiSnipingEnabled: true,
        antiSnipingWindowSec: a.windowSec,
        antiSnipingExtensionSec: a.extensionSec,
      }
    : {
        antiSnipingEnabled: false,
        antiSnipingWindowSec: 0,
        antiSnipingExtensionSec: 0,
      };
}

function attributeRow(
  auctionId: string,
  input: AttributeInputDto,
  defs: Awaited<ReturnType<CategoriesService['resolve']>>['attributes'],
): Prisma.AuctionAttributeValueCreateManyInput {
  const def = defs.find((d) => d.key === input.key);
  if (!def)
    throw Errors.unprocessable(
      'UNKNOWN_ATTRIBUTE',
      `"${input.key}" is not an attribute of this category.`,
    );
  const v = input.value;
  const bad = () =>
    Errors.unprocessable(
      'INVALID_ATTRIBUTE',
      `Invalid value for ${def.label}.`,
    );
  const base = { auctionId, attributeId: def.id };
  switch (def.type) {
    case 'TEXT':
      if (typeof v !== 'string' || !v.trim() || v.length > 1000) throw bad();
      return { ...base, valueText: v.trim() };
    case 'ENUM':
      if (typeof v !== 'string' || !def.options.includes(v)) throw bad();
      return { ...base, valueText: v };
    case 'NUMBER': {
      const s = typeof v === 'number' ? String(v) : v;
      if (typeof s !== 'string' || !/^-?\d{1,14}(\.\d{1,6})?$/.test(s))
        throw bad();
      return { ...base, valueNumber: new Prisma.Decimal(s) };
    }
    case 'BOOLEAN':
      if (typeof v !== 'boolean') throw bad();
      return { ...base, valueBoolean: v };
    case 'DATE':
      if (
        typeof v !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
        Number.isNaN(Date.parse(v))
      )
        throw bad();
      return { ...base, valueDate: new Date(`${v}T00:00:00Z`) };
  }
}
