import { Controller, Get, HttpStatus, Module, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is up. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. 503 when PostgreSQL (or configured Redis) is down. */
  @Get()
  async ready(@Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    const database = await this.prisma
      .dbNow()
      .then((now) => ({
        status: 'up' as const,
        serverTime: now.toISOString(),
        latencyMs: Date.now() - started,
      }))
      .catch(() => ({ status: 'down' as const }));
    const redis = !this.redis.enabled
      ? { status: 'disabled' as const }
      : await this.redis
          .ping()
          .then((ok) => ({ status: ok ? ('up' as const) : ('down' as const) }))
          .catch(() => ({ status: 'down' as const }));
    const ok = database.status === 'up' && redis.status !== 'down';
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', database, redis };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
