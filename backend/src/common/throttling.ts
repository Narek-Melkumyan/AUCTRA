import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';
import type { AuthedRequest } from './auth-context.js';
import { withTimeout, type RedisService } from '../redis/redis.service.js';

/**
 * Rate-limit guard. Signed-in callers are tracked by user id (so a NAT'd office does
 * not share one bucket); anonymous callers by client IP (`trust proxy` must be set
 * correctly behind a load balancer).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const r = req as unknown as AuthedRequest;
    return r.auth ? `u:${r.auth.userId}` : `ip:${r.ip ?? 'unknown'}`;
  }

  protected override async shouldSkip(ctx: ExecutionContext): Promise<boolean> {
    return ctx.getType() !== 'http';
  }
}

/**
 * Fixed-window counters in Redis so limits hold across all API instances.
 * Falls back to allowing the request (fail-open) if Redis is unreachable — rate
 * limiting is abuse protection, not a correctness mechanism.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  /** Per-instance fallback counters used while Redis is unavailable. */
  private readonly local = new Map<
    string,
    { hits: number; resetAt: number; blockedUntil: number }
  >();
  private lastWarn = 0;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      // Never let a slow or absent Redis delay a request.
      return await withTimeout(
        this.incrementRedis(key, ttl, limit, blockDuration, throttlerName),
        150,
      );
    } catch (err) {
      if (Date.now() - this.lastWarn > 10_000) {
        this.lastWarn = Date.now();
        this.logger.warn(
          `Rate-limit storage unavailable, using per-instance counters: ${(err as Error).message}`,
        );
      }
      return this.incrementLocal(
        `${throttlerName}:${key}`,
        ttl,
        limit,
        blockDuration,
      );
    }
  }

  /** Fixed-window fallback: still limits each instance while Redis is down. */
  private incrementLocal(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): ThrottlerStorageRecord {
    const now = Date.now();
    if (this.local.size > 50_000)
      for (const [k, v] of this.local)
        if (v.resetAt < now && v.blockedUntil < now) this.local.delete(k);
    let rec = this.local.get(key);
    if (!rec || rec.resetAt <= now) {
      rec = {
        hits: 0,
        resetAt: now + ttl,
        blockedUntil: rec?.blockedUntil ?? 0,
      };
      this.local.set(key, rec);
    }
    if (rec.blockedUntil > now) {
      const s = Math.ceil((rec.blockedUntil - now) / 1000);
      return {
        totalHits: limit + 1,
        timeToExpire: s,
        isBlocked: true,
        timeToBlockExpire: s,
      };
    }
    rec.hits++;
    const isBlocked = rec.hits > limit;
    if (isBlocked && blockDuration > 0) rec.blockedUntil = now + blockDuration;
    return {
      totalHits: rec.hits,
      timeToExpire: Math.ceil((rec.resetAt - now) / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
    };
  }

  private async incrementRedis(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    {
      const client = await this.redis.client();
      if (!client?.isReady) throw new Error('redis not ready');
      const hitKey = `throttle:${throttlerName}:${key}`;
      const blockKey = `${hitKey}:blocked`;
      const blockedTtl = await client.pTTL(blockKey);
      if (blockedTtl > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: Math.ceil(blockedTtl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockedTtl / 1000),
        };
      }
      const replies = (await client
        .multi()
        .incr(hitKey)
        .pExpire(hitKey, ttl, 'NX')
        .pTTL(hitKey)
        .exec()) as unknown[];
      const hits = Number(replies[0]);
      const pttl = Number(replies[2]);
      const isBlocked = hits > limit;
      if (isBlocked && blockDuration > 0)
        await client.set(blockKey, '1', { PX: blockDuration });
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(Math.max(pttl, 0) / 1000),
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
      };
    }
  }
}
