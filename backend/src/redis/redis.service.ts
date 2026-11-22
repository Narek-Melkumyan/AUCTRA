import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';
import { AppConfig } from '../config/app-config.js';

/**
 * Optional Redis connections. Redis is used for cross-instance fan-out (Socket.IO
 * adapter) and shared rate-limit counters only — never as a source of truth for bids.
 *
 * Failure behaviour (verified by the load harness, scenario G1):
 *  - Commands fail fast while disconnected (`disableOfflineQueue`) instead of queueing
 *    without bound, so no HTTP request ever waits on Redis.
 *  - Reconnects use capped exponential back-off, forever; pub/sub channels are
 *    re-subscribed by the client automatically.
 *  - The API starts even if Redis is down at boot (connection continues in background).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private clients: RedisClientType[] = [];
  private main?: Promise<RedisClientType>;
  private readonly status = new Map<string, boolean>();

  constructor(private readonly config: AppConfig) {}

  get enabled() {
    return Boolean(this.config.redisUrl);
  }

  /** True when every Redis connection is currently ready. */
  get healthy() {
    return [...this.status.values()].every(Boolean);
  }

  /** Shared command client. */
  async client(): Promise<RedisClientType | undefined> {
    if (!this.enabled) return undefined;
    // Memoise the promise so concurrent first callers share one connection.
    this.main ??= this.connectNew('main');
    return this.main;
  }

  /**
   * A dedicated connection (e.g. for pub/sub, which blocks the connection).
   * Waits at most `waitMs` for the first connection, then returns the client anyway;
   * it keeps reconnecting in the background.
   */
  async connectNew(
    name: string,
    waitMs = 3_000,
    opts: { queueWhileDisconnected?: boolean } = {},
  ): Promise<RedisClientType> {
    if (!this.config.redisUrl) throw new Error('REDIS_URL is not configured');
    const client: RedisClientType = createClient({
      url: this.config.redisUrl,
      // Commands fail fast while disconnected — except on a subscriber connection,
      // where SUBSCRIBE must be queued and replayed once Redis is back.
      disableOfflineQueue: !opts.queueWhileDisconnected,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 2_000),
      },
    });
    this.status.set(name, false);
    client.on('ready', () => {
      if (!this.status.get(name)) this.logger.log(`Redis (${name}) connected`);
      this.status.set(name, true);
    });
    client.on('end', () => this.status.set(name, false));
    client.on('reconnecting', () => this.status.set(name, false));
    let lastLog = 0;
    client.on('error', (err: Error) => {
      this.status.set(name, false);
      // Throttle repetitive connection errors during an outage.
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        this.logger.warn(`Redis (${name}) unavailable: ${err.message}`);
      }
    });
    this.clients.push(client);
    const connecting = client.connect().catch((err: Error) => {
      this.logger.error(
        `Redis (${name}) initial connect failed: ${err.message}`,
      );
    });
    await Promise.race([
      connecting,
      new Promise((r) => setTimeout(r, waitMs).unref()),
    ]);
    if (!client.isReady)
      this.logger.warn(
        `Redis (${name}) not ready after ${waitMs}ms; continuing and retrying in the background`,
      );
    return client;
  }

  async ping(): Promise<boolean> {
    const c = await this.client();
    if (!c?.isReady) return false;
    try {
      return (await withTimeout(c.ping(), 500)) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    // A client stuck reconnecting never completes a graceful close: destroy it.
    await Promise.allSettled(
      this.clients.map((c) =>
        c.isReady ? c.close() : Promise.resolve(c.destroy()),
      ),
    );
    this.clients = [];
    this.main = undefined;
  }
}

/** Rejects if `p` does not settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      t.unref();
    }),
  ]).finally(() => clearTimeout(t));
}
