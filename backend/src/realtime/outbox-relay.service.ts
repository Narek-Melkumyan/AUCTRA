import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { AuctionsGateway, auctionRoom, userRoom } from './auctions.gateway.js';
import { MetricsService } from '../metrics/metrics.service.js';

type OutboxRow = {
  id: bigint;
  createdAt: Date;
  aggregateType: string;
  aggregateId: string;
  version: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

const BATCH = 200;
const HEARTBEAT_MS = 10_000;
const LOCK_BUSY = -1;
/** Arbitrary constant identifying the relay's advisory lock. */
const RELAY_LOCK_KEY = 7_340_211_001n;

/**
 * Publishes committed outbox events to Socket.IO (and, through the Redis adapter, to
 * every instance). Runs on every instance; `FOR UPDATE SKIP LOCKED` hands each row to
 * exactly one relay at a time. Delivery is at-least-once: a crash between emit and
 * commit re-sends the event, and clients de-duplicate by `eventId` / `version`.
 *
 * Ordering: each batch is published under a cluster-wide transaction-scoped advisory
 * lock, so only one relay publishes at a time and events leave in commit (id) order —
 * clients normally never see out-of-order versions even with many instances.
 *
 * Redis pub/sub itself is fire-and-forget, so a client that was disconnected at the
 * moment of an emit (or behind an instance whose Redis link was down) misses it. Two
 * mechanisms recover: the version-gap check on the next event, and a periodic
 * per-instance room heartbeat (`auction:tick`, emitted LOCALLY without Redis) carrying
 * the authoritative version, so idle rooms also notice they are behind and resync.
 */
@Injectable()
export class OutboxRelayService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private again = false;
  private unsubscribe?: () => void;

  private heartbeat?: NodeJS.Timeout;
  private draining: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly outbox: OutboxService,
    private readonly gateway: AuctionsGateway,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.outboxRelayEnabled) return;
    this.unsubscribe = this.outbox.onKick(() => void this.drain());
    this.timer = setInterval(
      () => void this.drain(),
      this.config.outboxIntervalMs,
    );
    this.timer.unref();
    this.heartbeat = setInterval(() => void this.tickRooms(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribe?.();
    // Graceful shutdown: let an in-flight batch finish before the pool closes.
    await this.draining?.catch(() => undefined);
  }

  /**
   * Room heartbeat: for every auction room with sockets on THIS instance, emit the
   * current authoritative version/status/deadline to the local sockets only. One DB
   * query per instance per interval regardless of viewer count.
   */
  async tickRooms(): Promise<number> {
    const server = this.gateway.server;
    if (!server) return 0;
    const rooms = [...server.of('/').adapter.rooms.keys()]
      .filter((r) => r.startsWith('auction:'))
      .map((r) => r.slice('auction:'.length));
    if (!rooms.length) return 0;
    try {
      const rows = await this.prisma.$queryRaw<
        { id: string; version: number; status: string; endsAt: Date }[]
      >`SELECT id, version, status, "endsAt" FROM auctions WHERE id = ANY(${rooms}::uuid[])`;
      const serverTime = new Date().toISOString();
      for (const r of rows)
        server.local.to(auctionRoom(r.id)).emit('auction:tick', {
          auctionId: r.id,
          version: r.version,
          status: r.status,
          endsAt: r.endsAt.toISOString(),
          serverTime,
        });
      return rows.length;
    } catch (err) {
      this.logger.warn(`Room heartbeat failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Publishes until the outbox is empty. Coalesces concurrent triggers. */
  async drain(): Promise<number> {
    if (this.running) {
      this.again = true;
      return 0;
    }
    this.running = true;
    const p = this.drainLoop();
    this.draining = p;
    return p;
  }

  private async drainLoop(): Promise<number> {
    let total = 0;
    try {
      do {
        this.again = false;
        let n: number;
        let contended = 0;
        do {
          n = await this.publishBatch();
          if (n === LOCK_BUSY) {
            // Another instance is publishing; it may have missed our newest rows.
            if (++contended > 40) break;
            await new Promise((r) => setTimeout(r, 10));
            continue;
          }
          total += n;
        } while (n === BATCH || n === LOCK_BUSY);
      } while (this.again);
    } catch (err) {
      this.logger.error(`Outbox relay failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
      this.draining = null;
    }
    return total;
  }

  private async publishBatch(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // One publisher at a time across the cluster => events go out in commit order.
      const [{ got }] = await tx.$queryRaw<{ got: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${RELAY_LOCK_KEY}) AS got`;
      if (!got) return LOCK_BUSY;
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, "aggregateType", "aggregateId", version, type, payload, attempts, "createdAt"
        FROM outbox_events
        WHERE "publishedAt" IS NULL AND "availableAt" <= now() AND "aggregateType" <> 'job'
        ORDER BY id
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED`;
      if (!rows.length) return 0;
      const published: bigint[] = [];
      for (const row of rows) {
        try {
          this.emit(row);
          published.push(row.id);
          this.metrics.outboxPublished.inc({ kind: row.aggregateType });
          this.metrics.outboxLag.observe(
            (Date.now() - row.createdAt.getTime()) / 1000,
          );
        } catch (err) {
          const delayMs = Math.min(60_000, 500 * 2 ** row.attempts);
          await tx.outboxEvent.update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              lastError: (err as Error).message.slice(0, 1000),
              availableAt: new Date(Date.now() + delayMs),
            },
          });
        }
      }
      if (published.length) {
        await tx.outboxEvent.updateMany({
          where: { id: { in: published } },
          data: { publishedAt: new Date() },
        });
      }
      return rows.length;
    });
  }

  private emit(row: OutboxRow) {
    const server = this.gateway.server;
    if (!server) throw new Error('Socket.IO server not ready');
    const eventId = row.id.toString();
    if (row.aggregateType === 'auction') {
      this.gateway.invalidate(row.aggregateId);
      const envelope = {
        eventId,
        auctionId: row.aggregateId,
        version: row.version,
        type: row.type,
        ...row.payload,
      };
      server
        .to(auctionRoom(row.aggregateId))
        .emit(
          row.type === 'auction.bid_placed' ? 'auction:bid' : 'auction:state',
          envelope,
        );
      return;
    }
    if (row.aggregateType === 'chat') {
      server
        .to(auctionRoom(row.aggregateId))
        .emit(row.type === 'chat.message' ? 'chat:message' : 'chat:update', {
          eventId,
          ...row.payload,
        });
      return;
    }
    if (row.aggregateType === 'user' && row.type === 'user.message') {
      // Delivered only to the participant's private room; never broadcast.
      server
        .to(userRoom(row.aggregateId))
        .emit('message', { eventId, ...row.payload });
      return;
    }
    if (row.aggregateType === 'user' && row.type === 'user.notification') {
      server
        .to(userRoom(row.aggregateId))
        .emit('notification', { eventId, ...row.payload });
      return;
    }
    this.logger.warn(
      `Unknown outbox event ${row.aggregateType}/${row.type}; marking as published`,
    );
  }
}
