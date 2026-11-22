import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { AuctionLifecycleService } from '../auctions/auction-lifecycle.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { EmailDeliveryService } from '../notifications/email-delivery.service.js';

export interface TickReport {
  activated: number;
  closed: number;
  settled: number;
  endingSoon: number;
  reminders: number;
  emails: number;
}

/**
 * Polling worker for time-driven auction transitions and deliveries.
 *
 * Why polling the database instead of a delayed-job queue: the auction table *is* the
 * schedule (startsAt/endsAt), so there is nothing to keep in sync, nothing to lose if
 * Redis restarts, and anti-sniping extensions need no job rescheduling. Every step locks
 * rows with SKIP LOCKED, so any number of instances can run the worker concurrently.
 *
 * Lateness never affects correctness: bids are validated against the DB clock under the
 * row lock, so an auction past `endsAt` rejects bids even if this worker is delayed.
 */
@Injectable()
export class LifecycleWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LifecycleWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastCleanup = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly lifecycle: AuctionLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
    private readonly emails: EmailDeliveryService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.lifecycleWorkerEnabled) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.config.lifecycleIntervalMs,
    );
    this.timer.unref();
    this.logger.log(
      `Lifecycle worker every ${this.config.lifecycleIntervalMs} ms`,
    );
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    // Graceful shutdown: finish the current pass (every step is transactional, so an
    // abrupt kill is also safe — the next instance simply redoes the remaining work).
    await this.current?.catch(() => undefined);
  }

  private current: Promise<TickReport | null> | null = null;

  tick(): Promise<TickReport | null> {
    if (this.running) return Promise.resolve(null);
    this.current = this.runTick();
    return this.current;
  }

  private async runTick(): Promise<TickReport | null> {
    this.running = true;
    try {
      const report: TickReport = {
        activated: await this.each(
          `SELECT id FROM auctions WHERE status = 'SCHEDULED' AND "startsAt" <= clock_timestamp() ORDER BY "startsAt" LIMIT 100`,
          (id) => this.lifecycle.activate(id),
        ),
        closed: await this.each(
          `SELECT id FROM auctions WHERE status = 'LIVE' AND "endsAt" <= clock_timestamp() ORDER BY "endsAt" LIMIT 100`,
          (id) => this.lifecycle.close(id),
        ),
        settled: await this.each(
          `SELECT id FROM auctions WHERE status = 'ENDED' ORDER BY "endsAt" LIMIT 100`,
          async (id) => (await this.lifecycle.settle(id)) !== null,
        ),
        endingSoon: await this.endingSoon(),
        reminders: await this.reminders(),
        emails: (await this.emails.deliverDue()).claimed,
      };
      if (Date.now() - this.lastCleanup > 3600_000) {
        this.lastCleanup = Date.now();
        await this.cleanup();
      }
      return report;
    } catch (err) {
      this.logger.error(
        `Lifecycle tick failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  private async each(
    sql: string,
    fn: (id: string) => Promise<boolean>,
  ): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(sql);
    let n = 0;
    for (const { id } of rows) {
      try {
        if (await fn(id)) n++;
      } catch (err) {
        this.logger.error(
          `Lifecycle step failed for auction ${id}: ${(err as Error).message}`,
        );
      }
    }
    return n;
  }

  /** Notifies watchers and bidders once when an auction enters its final minutes. */
  private async endingSoon(): Promise<number> {
    const minutes = this.config.endingSoonMinutes;
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM auctions
      WHERE status = 'LIVE' AND "endingSoonNotifiedAt" IS NULL
        AND "endsAt" > clock_timestamp() AND "endsAt" <= clock_timestamp() + make_interval(mins => ${minutes})
      LIMIT 100`;
    let n = 0;
    for (const { id } of ids) {
      const done = await this.prisma.$transaction(async (tx) => {
        const locked = await this.lifecycle.lock(tx, id, { skipLocked: true });
        if (
          !locked ||
          locked.auction.endingSoonNotifiedAt ||
          locked.auction.status !== 'LIVE'
        )
          return false;
        const a = locked.auction;
        await tx.auction.update({
          where: { id },
          data: { endingSoonNotifiedAt: locked.now },
        });
        const watchers = await tx.watchlistItem.findMany({
          where: { auctionId: id, notify: true },
          select: { userId: true },
        });
        const bidders = await tx.bid.findMany({
          where: { auctionId: id },
          distinct: ['bidderId'],
          select: { bidderId: true },
        });
        const users = new Set([
          ...watchers.map((w) => w.userId),
          ...bidders.map((b) => b.bidderId),
        ]);
        await this.notifications.notifyMany(
          tx,
          [...users].map((userId) => ({
            userId,
            type: 'AUCTION_ENDING_SOON' as const,
            title: `Ending soon: ${a.title}`,
            body: `Bidding closes in under ${minutes} minutes.`,
            auctionId: id,
            dedupeKey: `ending:${id}`,
          })),
        );
        return true;
      });
      if (done) n++;
    }
    if (n) this.outbox.kick();
    return n;
  }

  private async reminders(): Promise<number> {
    const n = await this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<
        { id: string; userId: string; auctionId: string }[]
      >`
        SELECT id, "userId", "auctionId" FROM auction_reminders
        WHERE "sentAt" IS NULL AND "remindAt" <= clock_timestamp()
        ORDER BY "remindAt" LIMIT 200 FOR UPDATE SKIP LOCKED`;
      if (!due.length) return 0;
      const auctions = await tx.auction.findMany({
        where: { id: { in: due.map((d) => d.auctionId) } },
        select: { id: true, title: true },
      });
      await this.notifications.notifyMany(
        tx,
        due.map((r) => ({
          userId: r.userId,
          type: 'AUCTION_REMINDER' as const,
          title: `Reminder: ${auctions.find((a) => a.id === r.auctionId)?.title ?? 'auction'}`,
          body: 'You asked us to remind you about this auction.',
          auctionId: r.auctionId,
          dedupeKey: `reminder:${r.id}`,
        })),
      );
      await tx.auctionReminder.updateMany({
        where: { id: { in: due.map((d) => d.id) } },
        data: { sentAt: new Date() },
      });
      return due.length;
    });
    if (n) this.outbox.kick();
    return n;
  }

  /** Deletes expired auth artefacts and old relayed outbox rows. */
  private async cleanup() {
    const day = 86_400_000;
    const now = Date.now();
    const [tokens, sessions, keys, outbox] = await Promise.all([
      this.prisma.verificationToken.deleteMany({
        where: { expiresAt: { lt: new Date(now - day) } },
      }),
      this.prisma.session.deleteMany({
        where: { expiresAt: { lt: new Date(now - 30 * day) } },
      }),
      this.prisma.idempotencyKey.deleteMany({
        where: { expiresAt: { lt: new Date(now) } },
      }),
      this.prisma.outboxEvent.deleteMany({
        where: { publishedAt: { lt: new Date(now - 7 * day) } },
      }),
    ]);
    this.logger.log(
      `Cleanup: ${tokens.count} tokens, ${sessions.count} sessions, ${keys.count} idempotency keys, ${outbox.count} outbox rows`,
    );
  }
}

@Module({
  imports: [NotificationsModule],
  providers: [LifecycleWorker],
  exports: [LifecycleWorker],
})
export class JobsModule {}
