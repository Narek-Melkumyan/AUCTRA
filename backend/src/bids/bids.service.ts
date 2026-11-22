import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Bid } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { BidGate } from './bid-gate.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { sha256Hex } from '../common/crypto.js';
import {
  AuctionLifecycleService,
  type LockedAuction,
} from '../auctions/auction-lifecycle.service.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import {
  minimumNextBid,
  type LiveStateDto,
} from '../auctions/auction.mapper.js';
import { isRestricted, type AuthContext } from '../common/auth-context.js';
import { AppError, Errors } from '../common/errors.js';
import { hashIp } from '../common/crypto.js';
import { money, type MoneyDto } from '../common/money.js';
import { Permission } from '../roles/permissions.js';

export interface PlaceBidInput {
  auctionId: string;
  amount: bigint;
  idempotencyKey: string;
  /** Optional client assertion; rejected if it does not match the auction currency. */
  currency?: string | undefined;
  ip?: string | undefined;
}

export interface BidDto {
  id: string;
  sequence: number;
  amount: MoneyDto;
  bidderAlias: string;
  mine: boolean;
  createdAt: string;
}

export interface PlaceBidResult {
  bid: BidDto;
  auction: LiveStateDto;
  /** True when this response replays an earlier request with the same idempotency key. */
  replayed: boolean;
}

/**
 * The bidding engine.
 *
 * Concurrency strategy: pessimistic row lock on the auction (`SELECT … FOR UPDATE`) in a
 * READ COMMITTED transaction. All bids for one auction are therefore serialised by
 * PostgreSQL; bids on different auctions proceed in parallel. Under the lock we:
 *   - read the DB clock (clock_timestamp()) — the only clock that decides deadlines,
 *   - re-check idempotency (a concurrent duplicate may have committed while we waited),
 *   - validate against the freshly-read state,
 *   - assign `sequence = bidCount + 1` (deterministic order, unique per auction),
 *   - insert the bid, update the auction's denormalised price/version, append the
 *     lifecycle event and the outbox event — all in one commit.
 * Redis/Socket.IO are notified only after commit (via the outbox relay).
 */
@Injectable()
export class BidsService {
  private readonly logger = new Logger(BidsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly lifecycle: AuctionLifecycleService,
    private readonly auctions: AuctionsService,
    private readonly outbox: OutboxService,
    private readonly gate: BidGate,
    private readonly metrics: MetricsService,
  ) {}

  async placeBid(
    auth: AuthContext,
    input: PlaceBidInput,
  ): Promise<PlaceBidResult> {
    if (!auth.permissions.has(Permission.BID_PLACE))
      throw Errors.forbidden('Your account cannot place bids.');
    if (isRestricted(auth)) {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'ACCOUNT_RESTRICTED',
        'Your account is restricted and cannot place bids.',
      );
    }
    if (this.config.biddingRequireVerifiedEmail && !auth.emailVerified) {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'EMAIL_NOT_VERIFIED',
        'Verify your email address before bidding.',
      );
    }
    const requestHash = bidRequestHash(input);

    // Pre-screen (no lock, no queue): replays, and rejections that are already
    // certain from the latest committed state.
    const pre = await this.prescreen(auth, input, requestHash);
    if (pre) return pre;

    const started = performance.now();
    try {
      const outcome = await this.gate.run(input.auctionId, async () => {
        // At the head of the queue the committed price has usually moved on (bids
        // ahead of us committed): re-screen with one statement before paying for a
        // locked transaction. Most requests in a burst end here.
        const again = await this.prescreen(auth, input, requestHash);
        if (again) return { kind: 'ok' as const, result: again };
        return this.prisma.$transaction(
          (tx) => this.placeInTx(tx, auth, input, requestHash),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 5_000,
            timeout: 10_000,
          },
        );
      });
      this.metrics.bidOutcome(
        outcome.kind === 'rejected'
          ? outcome.error.code
          : outcome.result.replayed
            ? 'REPLAYED'
            : 'ACCEPTED',
        performance.now() - started,
      );
      if (outcome.kind === 'rejected') throw outcome.error;
      if (!outcome.result.replayed) this.outbox.kick();
      return outcome.result;
    } catch (err) {
      if (err instanceof AppError) {
        if (err.getStatus() >= 500)
          this.metrics.bidOutcome(err.code, performance.now() - started);
        throw err;
      }
      // Same idempotency key used concurrently for another auction: replay/compare.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.bid.findUnique({
          where: {
            bidderId_idempotencyKey: {
              bidderId: auth.userId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing) return this.replay(auth, existing, input);
        const rej = await this.prisma.idempotencyKey.findUnique({
          where: {
            userId_scope_key: {
              userId: auth.userId,
              scope: BID_SCOPE,
              key: input.idempotencyKey,
            },
          },
        });
        if (rej) throw storedRejection(rej, requestHash);
      }
      if (isBusyError(err)) {
        this.metrics.bidOutcome('BID_SYSTEM_BUSY', performance.now() - started);
        this.logger.warn(
          `Bid on ${input.auctionId} timed out waiting for the auction lock/connection`,
        );
        // Nothing was committed: retrying with the same Idempotency-Key is safe.
        throw new AppError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'BID_SYSTEM_BUSY',
          'The auction is very busy and your bid was not placed. Please retry.',
          { retryAfterMs: 500 },
        );
      }
      throw err;
    }
  }

  /**
   * Lock-free pre-screen, one statement (one snapshot):
   *  - a request whose idempotency key already has an outcome is replayed;
   *  - a bid that is ALREADY doomed by monotonic facts is rejected (and recorded)
   *    without queueing for the auction lock. Prices only increase and final statuses
   *    never revert, so if `amount < minimumNextBid(committed state)` or the auction is
   *    finished, the locked evaluation could only reach the same answer.
   * Non-monotonic checks (e.g. ALREADY_HIGHEST_BIDDER) are left to the locked path.
   * Because the duplicate-key check and the auction read share one snapshot, a
   * concurrent copy of the same request that commits a bid is either seen here (and
   * replayed) or not yet committed — in which case it is doomed too (same amount).
   */
  private async prescreen(
    auth: AuthContext,
    input: PlaceBidInput,
    requestHash: string,
  ): Promise<PlaceBidResult | null> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        status: LockedAuction['status'];
        visibility: string;
        sellerId: string;
        currency: string;
        startingPriceCents: bigint;
        minIncrementCents: bigint;
        currentPriceCents: bigint | null;
        startsAt: Date;
        endsAt: Date;
        antiSnipingEnabled: boolean;
        now: Date;
        dupBid: string | null;
        dupRejection: StoredRejection | null;
      }[]
    >`
      SELECT a.id, a.status, a.visibility, a."sellerId", a.currency,
        a."startingPriceCents", a."minIncrementCents", a."currentPriceCents",
        a."startsAt", a."endsAt", a."antiSnipingEnabled", clock_timestamp() AS now,
        (SELECT id FROM bids
          WHERE "bidderId" = ${auth.userId}::uuid AND "idempotencyKey" = ${input.idempotencyKey}) AS "dupBid",
        (SELECT json_build_object('requestHash', "requestHash", 'responseCode', "responseCode", 'responseBody', "responseBody")
          FROM idempotency_keys
          WHERE "userId" = ${auth.userId}::uuid AND scope = ${BID_SCOPE} AND key = ${input.idempotencyKey}) AS "dupRejection"
      FROM auctions a WHERE a.id = ${input.auctionId}::uuid`;
    const a = rows[0];
    if (!a) {
      // Unknown auction — but the key may belong to a bid elsewhere (key reuse).
      const prior = await this.prisma.bid.findUnique({
        where: {
          bidderId_idempotencyKey: {
            bidderId: auth.userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (prior) return this.replay(auth, prior, input);
      throw Errors.notFound('Auction');
    }
    if (a.dupBid) {
      const prior = await this.prisma.bid.findUniqueOrThrow({
        where: { id: a.dupBid },
      });
      return this.replay(auth, prior, input);
    }
    if (a.dupRejection) throw storedRejection(a.dupRejection, requestHash);
    if (!this.auctions.canView(a, auth)) return null; // locked path answers 404

    let rejection: AppError | null = null;
    const finished =
      ['ENDED', 'SOLD', 'UNSOLD', 'CANCELLED'].includes(a.status) ||
      (a.status === 'LIVE' && a.now >= a.endsAt && !a.antiSnipingEnabled);
    if (a.sellerId === auth.userId) rejection = selfBidError();
    else if (input.currency && input.currency !== a.currency)
      rejection = currencyError(a.currency);
    else if (finished) {
      try {
        this.assertAcceptingBids(a as unknown as LockedAuction, a.now);
      } catch (err) {
        if (err instanceof AppError) rejection = err;
        else throw err;
      }
    } else if (input.amount < minimumNextBid(a)) {
      rejection = tooLowError(a);
    }
    if (!rejection) return null;
    const body = rejection.getResponse() as Record<string, unknown>;
    // A rejection record has no side effects to protect, so it is committed without
    // waiting for the WAL flush (synchronous_commit = off). After a crash the worst
    // case is a lost rejection record — never a lost or duplicated bid.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL synchronous_commit = off');
      await tx.idempotencyKey.createMany({
        data: [
          {
            userId: auth.userId,
            scope: BID_SCOPE,
            key: input.idempotencyKey,
            requestHash,
            status: 'COMPLETED',
            responseCode: rejection.getStatus(),
            responseBody: body as Prisma.InputJsonValue,
            expiresAt: new Date(a.now.getTime() + 24 * 3600_000),
          },
        ],
        skipDuplicates: true,
      });
    });
    this.metrics.bidOutcome(rejection.code, 0);
    throw rejection;
  }

  /**
   * One bid, inside a READ COMMITTED transaction:
   *   1. take the auction row lock (its own statement);
   *   2. in a NEW statement (fresh snapshot, so it sees everything committed by the
   *      transactions we queued behind) read the auction, its highest bidder, any
   *      outcome already recorded for this idempotency key, and the DB clock;
   *   3. validate and either record the rejection or write the bid, the price update,
   *      the lifecycle event and the outbox rows (broadcast + notification job).
   * Business rejections are COMMITTED as idempotency records (not thrown inside the
   * transaction), so a concurrent or later retry of the same request gets the same answer.
   */
  private async placeInTx(
    tx: Tx,
    auth: AuthContext,
    input: PlaceBidInput,
    requestHash: string,
  ): Promise<
    | { kind: 'ok'; result: PlaceBidResult }
    | { kind: 'rejected'; error: AppError }
  > {
    await tx.$executeRawUnsafe(
      `SET LOCAL lock_timeout = '${this.config.bidLockTimeoutMs}ms'`,
    );
    const lockStarted = performance.now();
    const lockedRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM auctions WHERE id = ${input.auctionId}::uuid FOR UPDATE`;
    this.metrics.lockWait(performance.now() - lockStarted);
    if (!lockedRows.length) throw Errors.notFound('Auction');

    const rows = await tx.$queryRaw<
      (Omit<LockedAuction, 'highestBid'> & {
        _now: Date;
        _hbBidder: string | null;
        _hbAmount: bigint | null;
        _dupBid: string | null;
        _dupRejection: StoredRejection | null;
      })[]
    >`
      SELECT a.*, clock_timestamp() AS "_now",
        hb."bidderId" AS "_hbBidder", hb."amountCents" AS "_hbAmount",
        (SELECT id FROM bids
          WHERE "bidderId" = ${auth.userId}::uuid AND "idempotencyKey" = ${input.idempotencyKey}) AS "_dupBid",
        (SELECT json_build_object('requestHash', "requestHash", 'responseCode', "responseCode", 'responseBody', "responseBody")
          FROM idempotency_keys
          WHERE "userId" = ${auth.userId}::uuid AND scope = ${BID_SCOPE} AND key = ${input.idempotencyKey}) AS "_dupRejection"
      FROM auctions a LEFT JOIN bids hb ON hb.id = a."highestBidId"
      WHERE a.id = ${input.auctionId}::uuid`;
    const row = rows[0]!;
    const {
      _now: now,
      _hbBidder,
      _hbAmount,
      _dupBid,
      _dupRejection,
      ...auctionCols
    } = row;
    // A request with this key committed while we waited for the lock.
    if (_dupBid) {
      const dup = await tx.bid.findUniqueOrThrow({ where: { id: _dupBid } });
      return { kind: 'ok', result: await this.replay(auth, dup, input, tx) };
    }
    if (_dupRejection)
      return {
        kind: 'rejected',
        error: storedRejection(_dupRejection, requestHash),
      };

    const locked = {
      auction: {
        ...auctionCols,
        highestBid:
          auctionCols.highestBidId && _hbBidder
            ? {
                id: auctionCols.highestBidId,
                bidderId: _hbBidder,
                amountCents: _hbAmount!,
              }
            : null,
      } as LockedAuction,
      now,
    };

    try {
      return {
        kind: 'ok',
        result: await this.acceptInTx(tx, auth, input, locked),
      };
    } catch (err) {
      if (err instanceof AppError && STORED_REJECTIONS.has(err.code)) {
        const body = err.getResponse() as Record<string, unknown>;
        // Rejection-only commit: no WAL flush wait (see prescreen).
        await tx.$executeRawUnsafe('SET LOCAL synchronous_commit = off');
        await tx.idempotencyKey.create({
          data: {
            userId: auth.userId,
            scope: BID_SCOPE,
            key: input.idempotencyKey,
            requestHash,
            status: 'COMPLETED',
            responseCode: err.getStatus(),
            responseBody: body as Prisma.InputJsonValue,
            expiresAt: new Date(now.getTime() + 24 * 3600_000),
          },
        });
        return { kind: 'rejected', error: err };
      }
      throw err;
    }
  }

  private async acceptInTx(
    tx: Tx,
    auth: AuthContext,
    input: PlaceBidInput,
    locked: { auction: LockedAuction; now: Date },
  ): Promise<PlaceBidResult> {
    let a = locked.auction;
    const now = locked.now;
    if (!this.auctions.canView(a, auth)) throw Errors.notFound('Auction');
    if (a.sellerId === auth.userId) throw selfBidError();
    if (input.currency && input.currency !== a.currency)
      throw currencyError(a.currency);

    // Activate inline if the scheduler has not yet flipped a due SCHEDULED auction.
    if (a.status === 'SCHEDULED' && a.startsAt <= now && now < a.endsAt) {
      a = await this.lifecycle.transition(tx, locked, 'LIVE', {
        eventType: 'STARTED',
        metadata: { trigger: 'first_bid' },
      });
    }
    this.assertAcceptingBids(a, now);

    if (input.amount < minimumNextBid(a)) throw tooLowError(a);
    if (a.highestBid?.bidderId === auth.userId) {
      throw Errors.conflict(
        'ALREADY_HIGHEST_BIDDER',
        'You are already the highest bidder.',
      );
    }

    const sequence = a.bidCount + 1;
    const version = a.version + 1;
    const previousHighest = a.highestBid;
    let endsAt = a.endsAt;
    let extended = false;
    if (
      a.antiSnipingEnabled &&
      a.endsAt.getTime() - now.getTime() <= a.antiSnipingWindowSec * 1000
    ) {
      const candidate = new Date(
        now.getTime() + a.antiSnipingExtensionSec * 1000,
      );
      if (candidate > endsAt) {
        endsAt = candidate;
        extended = true;
      }
    }

    const bid = await tx.bid.create({
      data: {
        auctionId: a.id,
        currency: a.currency,
        bidderId: auth.userId,
        amountCents: input.amount,
        sequence,
        idempotencyKey: input.idempotencyKey,
        previousPriceCents: a.currentPriceCents,
        ipHash: hashIp(input.ip, this.config.ipHashSalt),
        // DB time, read under the lock: bid order and deadline checks use one clock.
        createdAt: now,
      },
    });
    // Optimistic guard on top of the lock: the version must not have moved.
    const res = await tx.auction.updateMany({
      where: { id: a.id, version: a.version },
      data: {
        currentPriceCents: input.amount,
        highestBidId: bid.id,
        bidCount: sequence,
        version,
        endsAt,
      },
    });
    if (res.count !== 1)
      throw Errors.conflict(
        'CONCURRENT_MODIFICATION',
        'The auction changed; retry.',
      );
    const events: Prisma.AuctionEventCreateManyInput[] = [
      {
        auctionId: a.id,
        type: 'BID_PLACED',
        actorId: auth.userId,
        version,
        metadata: {
          bidId: bid.id,
          sequence,
          amountMinor: input.amount.toString(),
        },
      },
    ];
    if (extended)
      events.push({
        auctionId: a.id,
        type: 'EXTENDED',
        version,
        metadata: {
          from: a.endsAt.toISOString(),
          to: endsAt.toISOString(),
          bidId: bid.id,
        },
      });
    await tx.auctionEvent.createMany({ data: events });

    const after: LockedAuction = {
      ...a,
      currentPriceCents: input.amount,
      highestBidId: bid.id,
      bidCount: sequence,
      version,
      endsAt,
      highestBid: {
        id: bid.id,
        bidderId: auth.userId,
        amountCents: input.amount,
      },
    };
    const state = this.lifecycle.liveState(after, now);
    // Broadcast event + durable notification job, in the same commit as the bid.
    // Notifications are built outside the auction lock by the job processor.
    await this.outbox.enqueueMany(tx, [
      {
        aggregateType: 'auction',
        aggregateId: a.id,
        version,
        type: 'auction.bid_placed',
        payload: {
          bid: this.toBidDto(bid, undefined),
          state,
          extended,
        } as unknown as Prisma.InputJsonValue,
      },
      {
        aggregateType: 'job',
        aggregateId: a.id,
        version,
        type: 'notify.bid_placed',
        payload: {
          auctionId: a.id,
          title: a.title,
          sellerId: a.sellerId,
          bidId: bid.id,
          bidderId: auth.userId,
          sequence,
          amountMinor: input.amount.toString(),
          currency: a.currency,
          previousHighestBidderId: previousHighest?.bidderId ?? null,
        },
      },
    ]);
    return {
      bid: this.toBidDto(bid, auth.userId),
      auction: state,
      replayed: false,
    };
  }

  private assertAcceptingBids(
    a: Pick<LockedAuction, 'status' | 'startsAt' | 'endsAt'>,
    now: Date,
  ) {
    if (a.status === 'LIVE' && now < a.endsAt && now >= a.startsAt) return;
    if (a.status === 'SCHEDULED' && now < a.startsAt) {
      throw Errors.conflict(
        'AUCTION_NOT_STARTED',
        'This auction has not started yet.',
        { startsAt: a.startsAt.toISOString() },
      );
    }
    if (a.status === 'CANCELLED')
      throw Errors.conflict('AUCTION_CANCELLED', 'This auction was cancelled.');
    if (['LIVE', 'SCHEDULED', 'ENDED', 'SOLD', 'UNSOLD'].includes(a.status)) {
      throw Errors.conflict('AUCTION_ENDED', 'This auction has ended.', {
        endedAt: a.endsAt.toISOString(),
      });
    }
    throw Errors.conflict(
      'AUCTION_NOT_LIVE',
      'This auction is not accepting bids.',
    );
  }

  private async replay(
    auth: AuthContext,
    bid: Bid,
    input: PlaceBidInput,
    tx: Tx | PrismaService = this.prisma,
  ): Promise<PlaceBidResult> {
    if (bid.auctionId !== input.auctionId || bid.amountCents !== input.amount) {
      throw Errors.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different bid.',
      );
    }
    const a = await tx.auction.findUniqueOrThrow({
      where: { id: bid.auctionId },
      include: {
        highestBid: { select: { id: true, bidderId: true, amountCents: true } },
      },
    });
    const now = await this.prisma.dbNow(tx);
    return {
      bid: this.toBidDto(bid, auth.userId),
      auction: this.lifecycle.liveState(a, now),
      replayed: true,
    };
  }

  /** The pseudonym this user has in this auction's public bid history. */
  aliasFor(auctionId: string, userId: string): string {
    return this.lifecycle.aliases.alias(auctionId, userId);
  }

  toBidDto(
    bid: Pick<
      Bid,
      | 'id'
      | 'auctionId'
      | 'bidderId'
      | 'sequence'
      | 'amountCents'
      | 'currency'
      | 'createdAt'
    >,
    viewerId: string | undefined,
  ): BidDto {
    return {
      id: bid.id,
      sequence: bid.sequence,
      amount: money(bid.amountCents, bid.currency),
      bidderAlias: this.lifecycle.aliases.alias(bid.auctionId, bid.bidderId),
      mine: viewerId === bid.bidderId,
      createdAt: bid.createdAt.toISOString(),
    };
  }

  /** Public bid history, newest first, bidders pseudonymised. */
  async history(
    auctionId: string,
    auth: AuthContext | undefined,
    opts: { limit?: number; beforeSequence?: number },
  ) {
    const a = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      select: { sellerId: true, status: true, visibility: true },
    });
    if (!a || !this.auctions.canView(a, auth)) throw Errors.notFound('Auction');
    const bids = await this.prisma.bid.findMany({
      where: {
        auctionId,
        status: 'ACCEPTED',
        ...(opts.beforeSequence
          ? { sequence: { lt: opts.beforeSequence } }
          : {}),
      },
      orderBy: { sequence: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
    });
    return bids.map((b) => this.toBidDto(b, auth?.userId));
  }

  /** The signed-in user's bidding activity, one entry per auction. */
  async mine(auth: AuthContext) {
    const now = await this.prisma.dbNow();
    const grouped = await this.prisma.bid.groupBy({
      by: ['auctionId'],
      where: { bidderId: auth.userId },
      _max: { amountCents: true, createdAt: true },
      _count: { _all: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take: 200,
    });
    const auctions = await this.prisma.auction.findMany({
      where: { id: { in: grouped.map((g) => g.auctionId) } },
      include: {
        highestBid: { select: { id: true, bidderId: true, amountCents: true } },
      },
    });
    return grouped.flatMap((g) => {
      const a = auctions.find((x) => x.id === g.auctionId);
      if (!a) return [];
      const state = this.lifecycle.liveState(a, now);
      const leading = a.highestBid?.bidderId === auth.userId;
      return [
        {
          auctionId: a.id,
          title: a.title,
          myHighestBid: money(g._max.amountCents ?? 0n, a.currency),
          myBidCount: g._count._all,
          lastBidAt: g._max.createdAt?.toISOString() ?? null,
          leading,
          won: a.status === 'SOLD' && a.winnerId === auth.userId,
          state,
        },
      ];
    });
  }
}

export function formatMinor(minor: bigint, currency: string): string {
  const digits = currency === 'JPY' ? 0 : 2;
  const s = minor.toString().padStart(digits + 1, '0');
  const whole = digits ? s.slice(0, -digits) : s;
  const frac = digits ? s.slice(-digits) : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}${frac && frac !== '00' ? `.${frac}` : ''}`;
}

const BID_SCOPE = 'bid';
/** Auction-state rejections that are final for a given request and safe to replay. */
const STORED_REJECTIONS = new Set([
  'BID_TOO_LOW',
  'ALREADY_HIGHEST_BIDDER',
  'AUCTION_ENDED',
  'AUCTION_NOT_STARTED',
  'AUCTION_CANCELLED',
  'AUCTION_NOT_LIVE',
  'SELF_BIDDING_NOT_ALLOWED',
  'CURRENCY_MISMATCH',
]);

interface StoredRejection {
  requestHash: string;
  responseCode: number | null;
  responseBody: unknown;
}

/** Same logical request = same auction + amount (+ asserted currency). */
function bidRequestHash(input: PlaceBidInput): string {
  return sha256Hex(
    `${input.auctionId}|${input.amount.toString()}|${input.currency ?? ''}`,
  );
}

/** Re-raises a recorded rejection, or IDEMPOTENCY_KEY_REUSED if the request differs. */
function storedRejection(r: StoredRejection, requestHash: string): AppError {
  if (r.requestHash !== requestHash)
    return Errors.conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different bid.',
    );
  const body = (r.responseBody ?? {}) as {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  return new AppError(
    (r.responseCode ?? 422) as HttpStatus,
    body.code ?? 'BID_REJECTED',
    body.message ?? 'This bid was rejected.',
    { ...(body.details ?? {}), replayed: true },
  );
}

/** Lock wait, transaction or pool timeouts: nothing committed, safe to retry. */
function isBusyError(err: unknown): boolean {
  const e = err as {
    code?: string;
    message?: string;
    meta?: { code?: string };
  };
  if (e?.code === 'P2028' || e?.code === 'P2024') return true;
  const text = `${e?.message ?? ''} ${e?.meta?.code ?? ''}`;
  return /55P03|lock timeout|canceling statement due to lock timeout|40P01|deadlock detected/i.test(
    text,
  );
}

function selfBidError() {
  return new AppError(
    HttpStatus.FORBIDDEN,
    'SELF_BIDDING_NOT_ALLOWED',
    'You cannot bid on your own auction.',
  );
}

function currencyError(currency: string) {
  return Errors.unprocessable(
    'CURRENCY_MISMATCH',
    `This auction is priced in ${currency}.`,
  );
}

function tooLowError(a: {
  currency: string;
  currentPriceCents: bigint | null;
  startingPriceCents: bigint;
  minIncrementCents: bigint;
}) {
  const minimum = minimumNextBid(a);
  return Errors.unprocessable(
    'BID_TOO_LOW',
    `The minimum bid is ${formatMinor(minimum, a.currency)}.`,
    {
      minimum: money(minimum, a.currency),
      currentPrice:
        a.currentPriceCents === null
          ? null
          : money(a.currentPriceCents, a.currency),
    },
  );
}
