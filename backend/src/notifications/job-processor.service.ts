import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { NotificationsService } from './notifications.service.js';

type JobRow = {
  id: bigint;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

const BATCH = 100;
const MAX_ATTEMPTS = 10;

/**
 * Executes background jobs written to the transactional outbox with
 * aggregateType = 'job' (e.g. the notifications caused by a bid).
 *
 * Bids enqueue one job row in the same commit as the bid; this processor turns it into
 * notifications OUTSIDE the auction row lock, which keeps bid transactions short.
 * Durable and at-least-once: rows are claimed with FOR UPDATE SKIP LOCKED and marked
 * published in the same transaction as the work; notification dedupe keys make a
 * re-run harmless. Failures back off and are retried.
 */
@Injectable()
export class JobProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobProcessor.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  private again = false;
  private unsubscribe?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.outboxRelayEnabled) return;
    this.unsubscribe = this.outbox.onKick(() => void this.drain());
    this.timer = setInterval(() => void this.drain(), 1_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.running;
  }

  drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          while ((await this.batch()) === BATCH);
        } while (this.again);
      } catch (err) {
        this.logger.error(`Job processing failed: ${(err as Error).message}`);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Processes up to BATCH due jobs; returns how many were claimed. */
  async batch(): Promise<number> {
    const rows = await this.prisma.$queryRaw<JobRow[]>`
      SELECT id, type, payload, attempts FROM outbox_events
      WHERE "aggregateType" = 'job' AND "publishedAt" IS NULL AND "availableAt" <= now()
      ORDER BY id LIMIT ${BATCH}`;
    for (const row of rows) {
      try {
        await this.prisma.$transaction(async (tx) => {
          // Claim: skip if another instance is processing (or already processed) it.
          const claimed = await tx.$queryRaw<{ id: bigint }[]>`
            SELECT id FROM outbox_events
            WHERE id = ${row.id} AND "publishedAt" IS NULL FOR UPDATE SKIP LOCKED`;
          if (!claimed.length) return;
          await this.handle(tx, row);
          await tx.outboxEvent.update({
            where: { id: row.id },
            data: { publishedAt: new Date() },
          });
        });
      } catch (err) {
        const attempts = row.attempts + 1;
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: (err as Error).message.slice(0, 1000),
            // Dead-letter after MAX_ATTEMPTS: never retried and never cleaned up (the
            // hourly cleanup only removes published rows), so it stays inspectable.
            availableAt:
              attempts >= MAX_ATTEMPTS
                ? new Date('9999-01-01T00:00:00Z')
                : new Date(Date.now() + Math.min(60_000, 500 * 2 ** attempts)),
          },
        });
        this.logger.error(
          `Job ${row.id} (${row.type}) failed: ${(err as Error).message}`,
        );
      }
    }
    if (rows.length) this.outbox.kick();
    return rows.length;
  }

  private async handle(tx: Prisma.TransactionClient, row: JobRow) {
    switch (row.type) {
      case 'notify.bid_placed': {
        const p = row.payload as {
          auctionId: string;
          title: string;
          sellerId: string;
          bidId: string;
          bidderId: string;
          sequence: number;
          amountMinor: string;
          currency: string;
          previousHighestBidderId: string | null;
        };
        const amount = formatMinor(BigInt(p.amountMinor), p.currency);
        await this.notifications.notifyMany(tx, [
          {
            userId: p.sellerId,
            type: 'NEW_BID',
            title: `New bid on ${p.title}`,
            body: `${amount} — bid #${p.sequence}.`,
            auctionId: p.auctionId,
            data: { amountMinor: p.amountMinor, currency: p.currency },
            dedupeKey: `newbid:${p.bidId}`,
          },
          ...(p.previousHighestBidderId &&
          p.previousHighestBidderId !== p.bidderId
            ? [
                {
                  userId: p.previousHighestBidderId,
                  type: 'OUTBID' as const,
                  title: `You've been outbid on ${p.title}`,
                  body: `The current bid is ${amount}.`,
                  auctionId: p.auctionId,
                  data: { amountMinor: p.amountMinor, currency: p.currency },
                  dedupeKey: `outbid:${p.bidId}`,
                },
              ]
            : []),
        ]);
        return;
      }
      default:
        throw new Error(`Unknown job type ${row.type}`);
    }
  }
}

function formatMinor(minor: bigint, currency: string): string {
  const digits = currency === 'JPY' ? 0 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: digits,
  }).format(Number(minor) / 10 ** digits);
}
