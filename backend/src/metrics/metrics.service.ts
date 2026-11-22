import {
  Controller,
  Get,
  Global,
  Headers,
  Injectable,
  Module,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import client from 'prom-client';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Public } from '../common/decorators.js';
import { Errors } from '../common/errors.js';
import { safeEqual } from '../common/crypto.js';

/**
 * Prometheus metrics. Bid outcomes/latency, row-lock wait, HTTP latency, socket
 * connections, outbox lag and DB pool utilisation, plus default Node process metrics
 * (CPU, memory, event-loop lag, GC).
 */
@Injectable()
export class MetricsService {
  readonly registry = new client.Registry();
  private readonly bidRequests = new client.Counter({
    name: 'auctra_bid_requests_total',
    help: 'Bid requests by outcome code',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly bidDuration = new client.Histogram({
    name: 'auctra_bid_duration_seconds',
    help: 'Time to decide a bid (queue + transaction)',
    labelNames: ['outcome'] as const,
    buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly lockWaitHist = new client.Histogram({
    name: 'auctra_bid_lock_wait_seconds',
    help: 'Time spent waiting for the auction row lock',
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1, 3],
    registers: [this.registry],
  });
  private readonly httpDuration = new client.Histogram({
    name: 'auctra_http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly socketConnections = new client.Gauge({
    name: 'auctra_socket_connections',
    help: 'Connected Socket.IO clients on this instance',
    registers: [this.registry],
  });
  readonly outboxPublished = new client.Counter({
    name: 'auctra_outbox_published_total',
    help: 'Outbox events published',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  readonly outboxLag = new client.Histogram({
    name: 'auctra_outbox_lag_seconds',
    help: 'Commit-to-publish delay of outbox events',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5, 30],
    registers: [this.registry],
  });

  readonly mediaUploads = new client.Counter({
    name: 'auctra_media_uploads_total',
    help: 'Listing image uploads by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });
  readonly mediaProcessing = new client.Histogram({
    name: 'auctra_media_processing_seconds',
    help: 'Time to validate and encode one image into its WebP variants',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],
    registers: [this.registry],
  });
  readonly storageOps = new client.Counter({
    name: 'auctra_storage_operations_total',
    help: 'Object storage operations by operation and result',
    labelNames: ['op', 'result'] as const,
    registers: [this.registry],
  });

  constructor(prisma: PrismaService) {
    client.collectDefaultMetrics({
      register: this.registry,
      prefix: 'auctra_',
    });
    const pool = prisma.pool;
    new client.Gauge({
      name: 'auctra_db_pool_connections',
      help: 'PostgreSQL pool connections by state',
      labelNames: ['state'] as const,
      registers: [this.registry],
      collect() {
        this.set({ state: 'total' }, pool.totalCount);
        this.set({ state: 'idle' }, pool.idleCount);
        this.set({ state: 'waiting' }, pool.waitingCount);
      },
    });
  }

  bidOutcome(outcome: string, ms: number) {
    this.bidRequests.inc({ outcome });
    this.bidDuration.observe({ outcome }, ms / 1000);
  }

  lockWait(ms: number) {
    this.lockWaitHist.observe(ms / 1000);
  }

  http(method: string, route: string, status: number, ms: number) {
    this.httpDuration.observe(
      { method, route, status: String(status) },
      ms / 1000,
    );
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Prometheus scrape endpoint. Requires `Authorization: Bearer <METRICS_TOKEN>`;
   * disabled (404) when METRICS_TOKEN is not configured.
   */
  @Public()
  @Get()
  async scrape(
    @Headers('authorization') authz: string | undefined,
    @Res() res: Response,
  ) {
    const token = this.config.metricsToken;
    if (!token) throw Errors.notFound('Route');
    if (!authz || !safeEqual(authz, `Bearer ${token}`))
      throw Errors.unauthorized('Metrics token required.');
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
