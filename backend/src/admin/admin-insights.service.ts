import { Injectable } from '@nestjs/common';
import type {
  AuctionStatus,
  Prisma,
  UserStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Errors } from '../common/errors.js';
import { money } from '../common/money.js';

const n = (v: unknown) => Number(v ?? 0);

export interface SuspicionFlag {
  kind:
    'SHARED_NETWORK' | 'SELLER_NETWORK' | 'SELLER_AFFINITY' | 'RAPID_BIDDING';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  auctionId?: string;
  auctionTitle?: string;
  users: { id: string; handle: string | null }[];
  evidence: Record<string, unknown>;
}

/**
 * Read-only aggregate queries for the admin dashboard and the admin AI assistant.
 * Every method is scoped and parameterised — nothing here accepts free-form SQL.
 */
@Injectable()
export class AdminInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────── Analytics ─────────────

  async analytics(days = 30) {
    const d = Math.min(Math.max(Math.trunc(days), 7), 180);
    const since = new Date(Date.now() - d * 86_400_000);
    const [
      totals,
      statusRows,
      bidsSeries,
      regSeries,
      categories,
      topAuctions,
      orderRows,
      volumeRows,
    ] = await Promise.all([
      this.prisma.$queryRaw<Record<string, bigint | number>[]>`
        SELECT
          (SELECT count(*) FROM users WHERE "deletedAt" IS NULL)::int AS users,
          (SELECT count(*) FROM users WHERE "createdAt" >= ${since})::int AS "newUsers",
          (SELECT count(DISTINCT "userId") FROM sessions
             WHERE "lastActiveAt" >= now() - interval '7 days' AND "revokedAt" IS NULL)::int AS "activeUsers7d",
          (SELECT count(DISTINCT "userId") FROM sessions
             WHERE "lastActiveAt" >= now() - interval '1 day' AND "revokedAt" IS NULL)::int AS "activeUsers24h",
          (SELECT count(*) FROM users WHERE "emailVerifiedAt" IS NOT NULL AND "deletedAt" IS NULL)::int AS "verifiedUsers",
          (SELECT count(*) FROM bids)::int AS bids,
          (SELECT count(*) FROM bids WHERE "createdAt" >= ${since})::int AS "bidsInPeriod",
          (SELECT count(DISTINCT "bidderId") FROM bids WHERE "createdAt" >= ${since})::int AS "activeBidders",
          (SELECT count(*) FROM auction_chat_messages WHERE "createdAt" >= ${since})::int AS "chatMessages",
          (SELECT count(*) FROM reports WHERE status IN ('OPEN','UNDER_REVIEW'))::int AS "openReports",
          (SELECT count(*) FROM seller_profiles WHERE "verificationStatus" = 'PENDING')::int AS "pendingSellers"`,
      this.prisma.auction.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<{ day: Date; bids: number; bidders: number }[]>`
        SELECT d::date AS day, count(b.id)::int AS bids, count(DISTINCT b."bidderId")::int AS bidders
        FROM generate_series((now() AT TIME ZONE 'UTC')::date - ${d - 1}::int, (now() AT TIME ZONE 'UTC')::date, interval '1 day') d
        LEFT JOIN bids b ON b."createdAt" >= d AND b."createdAt" < d + interval '1 day'
        GROUP BY d ORDER BY d`,
      this.prisma.$queryRaw<{ day: Date; users: number }[]>`
        SELECT d::date AS day, count(u.id)::int AS users
        FROM generate_series((now() AT TIME ZONE 'UTC')::date - ${d - 1}::int, (now() AT TIME ZONE 'UTC')::date, interval '1 day') d
        LEFT JOIN users u ON u."createdAt" >= d AND u."createdAt" < d + interval '1 day'
        GROUP BY d ORDER BY d`,
      this.prisma.$queryRaw<
        {
          slug: string;
          name: string;
          auctions: number;
          live: number;
          bids: number;
        }[]
      >`
        SELECT root.slug, root.name,
               count(DISTINCT a.id)::int AS auctions,
               count(DISTINCT a.id) FILTER (WHERE a.status = 'LIVE')::int AS live,
               coalesce(sum(a."bidCount"), 0)::int AS bids
        FROM categories root
        LEFT JOIN categories c ON c.id = root.id OR c."parentId" = root.id
        LEFT JOIN auctions a ON a."categoryId" = c.id AND a.status NOT IN ('DRAFT','PENDING_REVIEW')
        WHERE root."parentId" IS NULL
        GROUP BY root.slug, root.name, root."sortOrder"
        ORDER BY bids DESC, auctions DESC, root."sortOrder"`,
      this.prisma.$queryRaw<
        {
          id: string;
          title: string;
          status: AuctionStatus;
          bidCount: number;
          currentPriceCents: bigint | null;
          startingPriceCents: bigint;
          currency: string;
          bidders: number;
          chat: number;
          endsAt: Date;
        }[]
      >`
        SELECT a.id, a.title, a.status, a."bidCount", a."currentPriceCents", a."startingPriceCents", a.currency, a."endsAt",
               (SELECT count(DISTINCT "bidderId") FROM bids b WHERE b."auctionId" = a.id)::int AS bidders,
               (SELECT count(*) FROM auction_chat_messages m WHERE m."auctionId" = a.id)::int AS chat
        FROM auctions a
        WHERE a.status NOT IN ('DRAFT','PENDING_REVIEW')
        ORDER BY a."bidCount" DESC, a."updatedAt" DESC
        LIMIT 8`,
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<
        { currency: string; hammer: bigint; orders: number }[]
      >`
        SELECT currency, coalesce(sum("hammerPriceCents"), 0)::bigint AS hammer, count(*)::int AS orders
        FROM orders GROUP BY currency ORDER BY hammer DESC`,
    ]);
    const t = totals[0] ?? {};
    const status = Object.fromEntries(
      statusRows.map((r) => [r.status, r._count._all]),
    ) as Partial<Record<AuctionStatus, number>>;
    const orders = Object.fromEntries(
      orderRows.map((r) => [r.status, r._count._all]),
    ) as Record<string, number>;
    const ordersTotal = Object.values(orders).reduce((a, b) => a + b, 0);
    const demoCompleted = await this.prisma.order.count({
      where: { demoCompletedAt: { not: null } },
    });
    return {
      periodDays: d,
      generatedAt: new Date().toISOString(),
      totals: {
        users: n(t['users']),
        verifiedUsers: n(t['verifiedUsers']),
        newUsers: n(t['newUsers']),
        activeUsers7d: n(t['activeUsers7d']),
        activeUsers24h: n(t['activeUsers24h']),
        liveAuctions: status.LIVE ?? 0,
        scheduledAuctions: status.SCHEDULED ?? 0,
        pendingReview: status.PENDING_REVIEW ?? 0,
        completedAuctions:
          (status.SOLD ?? 0) + (status.UNSOLD ?? 0) + (status.ENDED ?? 0),
        soldAuctions: status.SOLD ?? 0,
        unsoldAuctions: status.UNSOLD ?? 0,
        bids: n(t['bids']),
        bidsInPeriod: n(t['bidsInPeriod']),
        activeBidders: n(t['activeBidders']),
        chatMessages: n(t['chatMessages']),
        openReports: n(t['openReports']),
        pendingSellers: n(t['pendingSellers']),
      },
      auctionStatus: status,
      bidsOverTime: bidsSeries.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        bids: r.bids,
        bidders: r.bidders,
      })),
      registrationsOverTime: regSeries.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        users: r.users,
      })),
      categories,
      mostActiveAuctions: topAuctions.map((a) => ({
        id: a.id,
        title: a.title,
        status: a.status,
        bidCount: a.bidCount,
        bidders: a.bidders,
        chatMessages: a.chat,
        endsAt: a.endsAt.toISOString(),
        price: money(a.currentPriceCents ?? a.startingPriceCents, a.currency),
      })),
      checkout: {
        ordersTotal,
        byStatus: orders,
        demoCompleted,
        completionRate: ordersTotal ? demoCompleted / ordersTotal : 0,
      },
      salesVolume: volumeRows.map((v) => ({
        orders: v.orders,
        hammer: money(v.hammer, v.currency),
      })),
    };
  }

  // ───────────── Auctions ─────────────

  async auctions(q: {
    status?: AuctionStatus | undefined;
    category?: string | undefined;
    sellerId?: string | undefined;
    q?: string | undefined;
    page?: number | undefined;
    limit?: number | undefined;
  }) {
    const limit = Math.min(q.limit ?? 25, 100);
    const page = Math.max(q.page ?? 1, 1);
    let categoryIds: string[] | undefined;
    if (q.category) {
      const root = await this.prisma.category.findUnique({
        where: { slug: q.category },
        select: { id: true, children: { select: { id: true } } },
      });
      categoryIds = root ? [root.id, ...root.children.map((c) => c.id)] : [];
    }
    const where: Prisma.AuctionWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.sellerId ? { sellerId: q.sellerId } : {}),
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' } },
              ...(/^\d+$/.test(q.q) ? [{ lotNumber: Number(q.q) }] : []),
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auction.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          category: { select: { name: true, slug: true } },
          seller: {
            select: { email: true, profile: { select: { handle: true } } },
          },
          winner: {
            select: { email: true, profile: { select: { handle: true } } },
          },
          order: { select: { id: true, orderNumber: true, status: true } },
        },
      }),
      this.prisma.auction.count({ where }),
    ]);
    return {
      total,
      page,
      limit,
      items: rows.map((a) => ({
        id: a.id,
        lotNumber: a.lotNumber,
        title: a.title,
        status: a.status,
        category: a.category.name,
        seller: {
          id: a.sellerId,
          handle: a.seller.profile?.handle ?? null,
          email: a.seller.email,
        },
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        bidCount: a.bidCount,
        price: money(a.currentPriceCents ?? a.startingPriceCents, a.currency),
        reserve:
          a.reservePriceCents === null
            ? null
            : money(a.reservePriceCents, a.currency),
        winner: a.winner
          ? {
              id: a.winnerId,
              handle: a.winner.profile?.handle ?? null,
              email: a.winner.email,
            }
          : null,
        order: a.order,
        cancelReason: a.cancelReason,
      })),
    };
  }

  /** Full auction view for staff, including real bidder identities (staff-only). */
  async auction(id: string) {
    const a = await this.prisma.auction.findUnique({
      where: { id },
      include: {
        category: { select: { name: true } },
        seller: {
          select: { email: true, profile: { select: { handle: true } } },
        },
        winner: {
          select: { email: true, profile: { select: { handle: true } } },
        },
        order: true,
        bids: {
          orderBy: { sequence: 'desc' },
          take: 200,
          include: {
            bidder: {
              select: { email: true, profile: { select: { handle: true } } },
            },
          },
        },
        events: { orderBy: { id: 'desc' }, take: 50 },
      },
    });
    if (!a) throw Errors.notFound('Auction');
    return {
      id: a.id,
      lotNumber: a.lotNumber,
      title: a.title,
      status: a.status,
      category: a.category.name,
      seller: {
        id: a.sellerId,
        handle: a.seller.profile?.handle ?? null,
        email: a.seller.email,
      },
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      startPrice: money(a.startingPriceCents, a.currency),
      reserve:
        a.reservePriceCents === null
          ? null
          : money(a.reservePriceCents, a.currency),
      price: money(a.currentPriceCents ?? a.startingPriceCents, a.currency),
      bidCount: a.bidCount,
      cancelReason: a.cancelReason,
      winner: a.winner
        ? {
            id: a.winnerId,
            handle: a.winner.profile?.handle ?? null,
            email: a.winner.email,
          }
        : null,
      order: a.order
        ? {
            id: a.order.id,
            orderNumber: a.order.orderNumber,
            status: a.order.status,
            total: money(a.order.totalCents, a.order.currency),
            demoCompletedAt: a.order.demoCompletedAt?.toISOString() ?? null,
          }
        : null,
      bids: a.bids.map((b) => ({
        id: b.id,
        sequence: b.sequence,
        amount: money(b.amountCents, b.currency),
        status: b.status,
        createdAt: b.createdAt.toISOString(),
        bidder: {
          id: b.bidderId,
          handle: b.bidder.profile?.handle ?? null,
          email: b.bidder.email,
        },
        network: b.ipHash?.slice(0, 8) ?? null,
      })),
      events: a.events.map((e) => ({
        id: e.id.toString(),
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        createdAt: e.createdAt.toISOString(),
        metadata: e.metadata,
      })),
    };
  }

  // ───────────── Users ─────────────

  async users(q: {
    q?: string | undefined;
    status?: UserStatus | undefined;
    role?: string | undefined;
    verified?: boolean | undefined;
    page?: number | undefined;
    limit?: number | undefined;
  }) {
    const limit = Math.min(q.limit ?? 25, 100);
    const page = Math.max(q.page ?? 1, 1);
    const term = q.q?.trim().toLowerCase();
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(term
        ? {
            OR: [
              { email: { contains: term } },
              { profile: { handle: { contains: term } } },
              {
                profile: {
                  displayName: { contains: term, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.role ? { roles: { some: { role: { key: q.role } } } } : {}),
      ...(q.verified === undefined
        ? {}
        : { emailVerifiedAt: q.verified ? { not: null } : null }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          email: true,
          status: true,
          suspendedUntil: true,
          emailVerifiedAt: true,
          createdAt: true,
          lastLoginAt: true,
          profile: { select: { handle: true, displayName: true } },
          roles: { select: { role: { select: { key: true } } } },
          sellerProfile: { select: { verificationStatus: true } },
          _count: { select: { bids: true, auctionsSelling: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      total,
      page,
      limit,
      items: rows.map((u) => ({
        id: u.id,
        email: u.email,
        status: u.status,
        suspendedUntil: u.suspendedUntil,
        emailVerified: !!u.emailVerifiedAt,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        handle: u.profile?.handle ?? null,
        displayName: u.profile?.displayName ?? null,
        roles: u.roles.map((r) => r.role.key),
        sellerStatus: u.sellerProfile?.verificationStatus ?? null,
        bids: u._count.bids,
        auctions: u._count.auctionsSelling,
      })),
    };
  }

  async user(id: string, opts: { includeSessions: boolean }) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        status: true,
        suspendedUntil: true,
        suspensionReason: true,
        emailVerifiedAt: true,
        createdAt: true,
        lastLoginAt: true,
        failedLoginCount: true,
        lockedUntil: true,
        profile: {
          select: { handle: true, displayName: true, country: true, bio: true },
        },
        roles: { select: { role: { select: { key: true } }, grantedAt: true } },
        sellerProfile: {
          select: {
            verificationStatus: true,
            type: true,
            businessName: true,
            rejectionReason: true,
            createdAt: true,
          },
        },
        _count: {
          select: {
            bids: true,
            auctionsSelling: true,
            auctionsWon: true,
            chatMessages: true,
            ordersAsBuyer: true,
            reportsFiled: true,
          },
        },
      },
    });
    if (!u) throw Errors.notFound('User');
    const [activity, bids, restriction, reportsAgainst, sessions, moderation] =
      await Promise.all([
        this.prisma.auditLog.findMany({
          where: { OR: [{ actorId: id }, { entityId: id }] },
          orderBy: { id: 'desc' },
          take: 40,
          select: {
            id: true,
            action: true,
            actorId: true,
            entityType: true,
            entityId: true,
            createdAt: true,
            metadata: true,
          },
        }),
        this.prisma.bid.findMany({
          where: { bidderId: id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            auction: { select: { id: true, title: true, status: true } },
          },
        }),
        this.prisma.chatRestriction.findFirst({
          where: {
            userId: id,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.report.count({
          where: { targetType: 'USER', targetId: id },
        }),
        opts.includeSessions
          ? this.prisma.session.findMany({
              where: {
                userId: id,
                revokedAt: null,
                expiresAt: { gt: new Date() },
              },
              orderBy: { lastActiveAt: 'desc' },
              select: {
                id: true,
                userAgent: true,
                ipHash: true,
                createdAt: true,
                lastActiveAt: true,
              },
            })
          : Promise.resolve(null),
        this.prisma.moderationAction.findMany({
          where: { subjectUserId: id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { action: true, reason: true, createdAt: true },
        }),
      ]);
    return {
      ...u,
      emailVerified: !!u.emailVerifiedAt,
      roles: u.roles.map((r) => r.role.key),
      counts: u._count,
      reportsAgainst,
      chatRestriction: restriction
        ? {
            id: restriction.id,
            type: restriction.type,
            expiresAt: restriction.expiresAt?.toISOString() ?? null,
            reason: restriction.reason,
          }
        : null,
      recentBids: bids.map((b) => ({
        id: b.id,
        auctionId: b.auctionId,
        auctionTitle: b.auction.title,
        auctionStatus: b.auction.status,
        amount: money(b.amountCents, b.currency),
        createdAt: b.createdAt.toISOString(),
      })),
      activity: activity.map((a) => ({
        ...a,
        id: a.id.toString(),
        createdAt: a.createdAt.toISOString(),
      })),
      moderation,
      sessions: sessions?.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        network: s.ipHash?.slice(0, 8) ?? null,
        createdAt: s.createdAt.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
      })),
    };
  }

  // ───────────── Bid integrity signals (for human review only) ─────────────

  async suspiciousBidding(days = 30): Promise<SuspicionFlag[]> {
    const since = new Date(
      Date.now() - Math.min(Math.max(days, 1), 180) * 86_400_000,
    );
    const handles = async (ids: string[]) => {
      const rows = await this.prisma.userProfile.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, handle: true },
      });
      const map = new Map(rows.map((r) => [r.userId, r.handle]));
      return ids.map((id) => ({ id, handle: map.get(id) ?? null }));
    };
    const flags: SuspicionFlag[] = [];

    // 1. Several accounts bidding on the same auction from one network fingerprint.
    const shared = await this.prisma.$queryRaw<
      {
        auctionId: string;
        title: string;
        ipHash: string;
        bidders: string[];
        bids: number;
      }[]
    >`
      SELECT b."auctionId", a.title, b."ipHash", array_agg(DISTINCT b."bidderId")::text[] AS bidders, count(*)::int AS bids
      FROM bids b JOIN auctions a ON a.id = b."auctionId"
      WHERE b."createdAt" >= ${since} AND b."ipHash" IS NOT NULL
      GROUP BY b."auctionId", a.title, b."ipHash"
      HAVING count(DISTINCT b."bidderId") >= 2
      ORDER BY bids DESC LIMIT 20`;
    for (const r of shared)
      flags.push({
        kind: 'SHARED_NETWORK',
        severity: r.bidders.length >= 3 ? 'high' : 'medium',
        summary: `${r.bidders.length} accounts bid on "${r.title}" from the same network fingerprint.`,
        auctionId: r.auctionId,
        auctionTitle: r.title,
        users: await handles(r.bidders),
        evidence: { network: r.ipHash.slice(0, 8), bids: r.bids },
      });

    // 2. A bidder sharing a network fingerprint with the seller of the auction.
    const sellerNet = await this.prisma.$queryRaw<
      {
        auctionId: string;
        title: string;
        bidderId: string;
        sellerId: string;
        bids: number;
      }[]
    >`
      SELECT b."auctionId", a.title, b."bidderId", a."sellerId", count(*)::int AS bids
      FROM bids b JOIN auctions a ON a.id = b."auctionId"
      WHERE b."createdAt" >= ${since} AND b."ipHash" IS NOT NULL
        AND EXISTS (SELECT 1 FROM sessions s WHERE s."userId" = a."sellerId" AND s."ipHash" = b."ipHash")
      GROUP BY b."auctionId", a.title, b."bidderId", a."sellerId"
      ORDER BY bids DESC LIMIT 20`;
    for (const r of sellerNet)
      flags.push({
        kind: 'SELLER_NETWORK',
        severity: 'high',
        summary: `A bidder on "${r.title}" used the same network as the seller (possible shill bidding).`,
        auctionId: r.auctionId,
        auctionTitle: r.title,
        users: await handles([r.bidderId, r.sellerId]),
        evidence: { bids: r.bids, roles: ['bidder', 'seller'] },
      });

    // 3. Bidders concentrated on one seller who never win.
    const affinity = await this.prisma.$queryRaw<
      {
        bidderId: string;
        sellerId: string;
        auctions: number;
        bids: number;
        share: number;
        wins: number;
      }[]
    >`
      WITH per AS (
        SELECT b."bidderId", a."sellerId", count(DISTINCT a.id)::int AS auctions, count(*)::int AS bids,
               count(DISTINCT a.id) FILTER (WHERE a."winnerId" = b."bidderId")::int AS wins
        FROM bids b JOIN auctions a ON a.id = b."auctionId"
        WHERE b."createdAt" >= ${since}
        GROUP BY b."bidderId", a."sellerId"
      ), tot AS (
        SELECT "bidderId", sum(bids)::int AS total FROM per GROUP BY "bidderId"
      )
      SELECT per."bidderId", per."sellerId", per.auctions, per.bids, per.wins,
             round(per.bids::numeric / tot.total, 2)::float AS share
      FROM per JOIN tot USING ("bidderId")
      WHERE per.auctions >= 3 AND per.bids::numeric / tot.total >= 0.7 AND per.wins = 0
      ORDER BY per.bids DESC LIMIT 20`;
    for (const r of affinity)
      flags.push({
        kind: 'SELLER_AFFINITY',
        severity: 'medium',
        summary: `A bidder placed ${Math.round(r.share * 100)}% of their bids on one seller's ${r.auctions} auctions and never won.`,
        users: await handles([r.bidderId, r.sellerId]),
        evidence: {
          bids: r.bids,
          auctions: r.auctions,
          share: r.share,
          wins: r.wins,
        },
      });

    // 4. Bursts: many bids by one bidder on one auction within a minute.
    const bursts = await this.prisma.$queryRaw<
      { auctionId: string; title: string; bidderId: string; bids: number }[]
    >`
      SELECT b."auctionId", a.title, b."bidderId", max(cnt)::int AS bids FROM (
        SELECT b1."auctionId", b1."bidderId",
               (SELECT count(*) FROM bids b2 WHERE b2."auctionId" = b1."auctionId" AND b2."bidderId" = b1."bidderId"
                  AND b2."createdAt" BETWEEN b1."createdAt" AND b1."createdAt" + interval '60 seconds') AS cnt
        FROM bids b1 WHERE b1."createdAt" >= ${since}
      ) b JOIN auctions a ON a.id = b."auctionId"
      WHERE cnt >= 6
      GROUP BY b."auctionId", a.title, b."bidderId"
      ORDER BY bids DESC LIMIT 20`;
    for (const r of bursts)
      flags.push({
        kind: 'RAPID_BIDDING',
        severity: r.bids >= 10 ? 'medium' : 'low',
        summary: `${r.bids} bids within one minute by one bidder on "${r.title}".`,
        auctionId: r.auctionId,
        auctionTitle: r.title,
        users: await handles([r.bidderId]),
        evidence: { bidsPerMinute: r.bids },
      });
    return flags;
  }

  /** Open reports with a readable summary of what was reported. */
  async reports(status?: string) {
    const rows = await this.prisma.report.findMany({
      where: status
        ? { status: status as Prisma.EnumReportStatusFilter['equals'] }
        : { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: {
        reporter: { select: { profile: { select: { handle: true } } } },
        handledBy: { select: { profile: { select: { handle: true } } } },
      },
    });
    const ids = (t: string) =>
      rows.filter((r) => r.targetType === t).map((r) => r.targetId);
    const [msgs, auctions, users] = await Promise.all([
      this.prisma.auctionChatMessage.findMany({
        where: { id: { in: ids('CHAT_MESSAGE') } },
        select: {
          id: true,
          body: true,
          status: true,
          auctionId: true,
          authorId: true,
          author: { select: { profile: { select: { handle: true } } } },
          auction: { select: { title: true } },
        },
      }),
      this.prisma.auction.findMany({
        where: { id: { in: ids('AUCTION') } },
        select: { id: true, title: true, status: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: ids('USER') } },
        select: {
          id: true,
          status: true,
          profile: { select: { handle: true } },
        },
      }),
    ]);
    return rows.map((r) => {
      let target: Record<string, unknown> | null = null;
      if (r.targetType === 'CHAT_MESSAGE') {
        const m = msgs.find((x) => x.id === r.targetId);
        target = m
          ? {
              kind: 'chat',
              body: m.body,
              status: m.status,
              auctionId: m.auctionId,
              auctionTitle: m.auction.title,
              authorId: m.authorId,
              author: m.author.profile?.handle ?? null,
            }
          : null;
      } else if (r.targetType === 'AUCTION') {
        const a = auctions.find((x) => x.id === r.targetId);
        target = a ? { kind: 'auction', ...a } : null;
      } else if (r.targetType === 'USER') {
        const u = users.find((x) => x.id === r.targetId);
        target = u
          ? {
              kind: 'user',
              id: u.id,
              status: u.status,
              handle: u.profile?.handle ?? null,
            }
          : null;
      }
      return {
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        details: r.details,
        status: r.status,
        resolution: r.resolution,
        createdAt: r.createdAt.toISOString(),
        reporter: r.reporter.profile?.handle ?? null,
        handledBy: r.handledBy?.profile?.handle ?? null,
        target,
      };
    });
  }
}
