import { Injectable, Logger } from '@nestjs/common';
import type {
  AuctionEventType,
  AuctionStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  NotificationsService,
  type NotifyInput,
} from '../notifications/notifications.service.js';
import { AppConfig } from '../config/app-config.js';
import { applyBps } from '../common/money.js';
import { Errors } from '../common/errors.js';
import { assertTransition } from './auction-state.js';
import {
  BidderAliases,
  reserveState,
  toLiveState,
  type LiveStateSource,
} from './auction.mapper.js';

export type LockedAuction = Prisma.AuctionGetPayload<{
  include: {
    highestBid: { select: { id: true; bidderId: true; amountCents: true } };
  };
}>;

/**
 * Owns every auction status change. Each change:
 *   1. runs inside a transaction holding the auction row lock (SELECT … FOR UPDATE),
 *   2. is validated against the state machine,
 *   3. bumps `version`, appends an AuctionEvent, and writes an outbox event — atomically.
 *
 * The scheduled worker only *triggers* these methods; correctness never depends on it
 * running on time, because bidding re-checks deadlines against database time.
 */
@Injectable()
export class AuctionLifecycleService {
  private readonly logger = new Logger(AuctionLifecycleService.name);
  readonly aliases: BidderAliases;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    config: AppConfig,
  ) {
    this.aliases = new BidderAliases(config.jwtAccessSecret);
  }

  /**
   * Locks the auction row for the rest of the transaction and returns it with the
   * database clock reading taken *after* the lock was granted.
   * `skipLocked` returns null instead of waiting when another transaction holds it.
   */
  async lock(
    tx: Tx,
    id: string,
    opts: { skipLocked?: boolean } = {},
  ): Promise<{ auction: LockedAuction; now: Date } | null> {
    const rows = opts.skipLocked
      ? await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM auctions WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`
      : await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM auctions WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    const auction = await tx.auction.findUniqueOrThrow({
      where: { id },
      include: {
        highestBid: { select: { id: true, bidderId: true, amountCents: true } },
      },
    });
    const now = await this.prisma.dbNow(tx);
    return { auction, now };
  }

  liveState(
    a: LiveStateSource & { highestBid: { bidderId: string } | null },
    now: Date,
  ) {
    return toLiveState(
      a,
      a.highestBid ? this.aliases.alias(a.id, a.highestBid.bidderId) : null,
      now,
    );
  }

  /**
   * Applies a validated status transition to a locked auction. Returns the new version.
   */
  async transition(
    tx: Tx,
    locked: { auction: LockedAuction; now: Date },
    to: AuctionStatus,
    opts: {
      actorId?: string | null;
      eventType: AuctionEventType;
      data?: Prisma.AuctionUncheckedUpdateInput;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<LockedAuction> {
    const a = locked.auction;
    assertTransition(a.status, to);
    const version = a.version + 1;
    const res = await tx.auction.updateMany({
      where: { id: a.id, status: a.status, version: a.version },
      data: { ...opts.data, status: to, version },
    });
    if (res.count !== 1)
      throw Errors.conflict(
        'CONCURRENT_MODIFICATION',
        'The auction changed; retry.',
      );
    await tx.auctionEvent.create({
      data: {
        auctionId: a.id,
        type: opts.eventType,
        actorId: opts.actorId ?? null,
        fromStatus: a.status,
        toStatus: to,
        version,
        metadata: opts.metadata ?? undefined,
      },
    });
    const updated = await tx.auction.findUniqueOrThrow({
      where: { id: a.id },
      include: {
        highestBid: { select: { id: true, bidderId: true, amountCents: true } },
      },
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'auction',
      aggregateId: a.id,
      version,
      type: `auction.${to.toLowerCase()}`,
      payload: {
        state: this.liveState(updated, locked.now),
      } as unknown as Prisma.InputJsonValue,
    });
    locked.auction = updated;
    return updated;
  }

  // ───────────── Scheduled steps (each idempotent, multi-instance safe) ─────────────

  /** SCHEDULED → LIVE once startsAt has passed. */
  async activate(id: string): Promise<boolean> {
    const done = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lock(tx, id, { skipLocked: true });
      if (!locked) return false;
      const { auction: a, now } = locked;
      if (a.status !== 'SCHEDULED' || a.startsAt > now) return false;
      await this.transition(tx, locked, 'LIVE', { eventType: 'STARTED' });
      await this.notifyWatchers(
        tx,
        a.id,
        'AUCTION_STARTED',
        `Live now: ${a.title}`,
        'Bidding is open.',
        `started:${a.id}`,
      );
      return true;
    });
    if (done) this.outbox.kick();
    return done;
  }

  /** LIVE → ENDED once endsAt has passed (DB clock). No bid can be accepted after this. */
  async close(id: string): Promise<boolean> {
    const done = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lock(tx, id, { skipLocked: true });
      if (!locked) return false;
      const { auction: a, now } = locked;
      if (a.status !== 'LIVE' || a.endsAt > now) return false;
      await this.transition(tx, locked, 'ENDED', {
        eventType: 'ENDED',
        data: { endedAt: now },
      });
      return true;
    });
    if (done) this.outbox.kick();
    return done;
  }

  /**
   * ENDED → SOLD | UNSOLD. The winner is the highest accepted bid; it wins only if the
   * reserve is absent or met. Creating the order in the same transaction, with
   * `orders.auctionId` UNIQUE, makes double settlement impossible.
   */
  async settle(id: string): Promise<'SOLD' | 'UNSOLD' | null> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lock(tx, id, { skipLocked: true });
      if (!locked) return null;
      const a = locked.auction;
      if (a.status !== 'ENDED') return null;

      const top = a.highestBid;
      const reserveMet = reserveState(a) !== 'not_met';
      const bidderIds = (
        await tx.bid.findMany({
          where: { auctionId: a.id, status: 'ACCEPTED' },
          distinct: ['bidderId'],
          select: { bidderId: true },
        })
      ).map((b) => b.bidderId);

      if (top && reserveMet) {
        await this.transition(tx, locked, 'SOLD', {
          eventType: 'SOLD',
          data: {
            winnerId: top.bidderId,
            winningBidId: top.id,
            settledAt: locked.now,
          },
          metadata: {
            winningBidId: top.id,
            hammerMinor: top.amountCents.toString(),
          },
        });
        await this.createOrder(tx, a, top);
        const notes: NotifyInput[] = [
          {
            userId: top.bidderId,
            type: 'AUCTION_WON',
            title: `You won ${a.title}`,
            body: 'Congratulations — your bid won. Complete the demo checkout (simulated, no real payment) to finish.',
            auctionId: a.id,
            dedupeKey: `won:${a.id}`,
          },
          {
            userId: a.sellerId,
            type: 'AUCTION_SOLD',
            title: `Sold: ${a.title}`,
            body: 'Your auction ended with a winning bid.',
            auctionId: a.id,
            dedupeKey: `sold:${a.id}`,
          },
          ...bidderIds
            .filter((uid) => uid !== top.bidderId)
            .map((uid) => ({
              userId: uid,
              type: 'AUCTION_LOST' as const,
              title: `Auction closed: ${a.title}`,
              body: 'Another bidder won this lot.',
              auctionId: a.id,
              dedupeKey: `lost:${a.id}`,
            })),
        ];
        await this.notifications.notifyMany(tx, notes);
        return 'SOLD' as const;
      }

      await this.transition(tx, locked, 'UNSOLD', {
        eventType: 'UNSOLD',
        data: { settledAt: locked.now },
        metadata: { reason: top ? 'reserve_not_met' : 'no_bids' },
      });
      await this.notifications.notifyMany(tx, [
        {
          userId: a.sellerId,
          type: 'AUCTION_UNSOLD',
          title: `Not sold: ${a.title}`,
          body: top
            ? 'Bidding ended below your reserve price.'
            : 'The auction ended without bids.',
          auctionId: a.id,
          dedupeKey: `unsold:${a.id}`,
        },
        ...bidderIds.map((uid) => ({
          userId: uid,
          type: 'AUCTION_LOST' as const,
          title: `Reserve not met: ${a.title}`,
          body: 'The auction closed below the reserve price, so no sale was made.',
          auctionId: a.id,
          dedupeKey: `lost:${a.id}`,
        })),
      ]);
      return 'UNSOLD' as const;
    });
    if (outcome) this.outbox.kick();
    return outcome;
  }

  private async createOrder(
    tx: Tx,
    a: LockedAuction,
    top: NonNullable<LockedAuction['highestBid']>,
  ) {
    const commissionBps = await readBps(tx, 'fees.seller_commission_bps');
    const premiumBps = await readBps(tx, 'fees.buyer_premium_bps');
    const hammer = top.amountCents;
    const premium = applyBps(hammer, premiumBps);
    const order = await tx.order.create({
      data: {
        orderNumber: `ORD-${String(a.lotNumber).padStart(6, '0')}`,
        auctionId: a.id,
        buyerId: top.bidderId,
        sellerId: a.sellerId,
        currency: a.currency,
        hammerPriceCents: hammer,
        buyerPremiumCents: premium,
        totalCents: hammer + premium,
      },
    });
    await tx.platformFee.createMany({
      data: [
        {
          orderId: order.id,
          type: 'SELLER_COMMISSION',
          rateBps: commissionBps,
          amountCents: applyBps(hammer, commissionBps),
          currency: a.currency,
        },
        {
          orderId: order.id,
          type: 'BUYER_PREMIUM',
          rateBps: premiumBps,
          amountCents: premium,
          currency: a.currency,
        },
      ],
    });
  }

  async notifyWatchers(
    tx: Tx,
    auctionId: string,
    type: NotifyInput['type'],
    title: string,
    body: string,
    dedupeKey: string,
  ) {
    const watchers = await tx.watchlistItem.findMany({
      where: { auctionId, notify: true },
      select: { userId: true },
    });
    await this.notifications.notifyMany(
      tx,
      watchers.map((w) => ({
        userId: w.userId,
        type,
        title,
        body,
        auctionId,
        dedupeKey,
      })),
    );
  }
}

/** Fee rates are configuration data (system_config), defaulting to 0 when unset. */
async function readBps(tx: Tx, key: string): Promise<number> {
  const row = await tx.systemConfig.findUnique({ where: { key } });
  const v = row?.value;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10000
    ? v
    : 0;
}
