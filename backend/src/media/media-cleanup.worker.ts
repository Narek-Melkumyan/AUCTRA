import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { StorageService } from '../storage/storage.service.js';
import { variantKeys } from './auction-images.service.js';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH = 25;
/** A claimed task is invisible to other instances for this long. */
const LEASE = '5 minutes';

export interface SweepReport {
  deleted: number;
  skippedInUse: number;
  failed: number;
}

/**
 * Deletes objects listed in media_cleanup_tasks: images that were removed or replaced
 * (normally deleted inline already — this retries failures) and uploads that never
 * committed (a crash or lost connection between upload and insert). Tasks are leased
 * with SKIP LOCKED, so any number of API instances can run it.
 */
@Injectable()
export class MediaCleanupWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MediaCleanupWorker.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<SweepReport> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly storage: StorageService,
  ) {}

  onApplicationBootstrap() {
    // Same switch as the other background workers (off in tests, which call sweep()).
    if (!this.config.lifecycleWorkerEnabled || !this.storage.enabled) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  sweep(): Promise<SweepReport> {
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<SweepReport> {
    const report: SweepReport = { deleted: 0, skippedInUse: 0, failed: 0 };
    if (!this.storage.enabled) return report;
    const provider = this.storage.provider;
    let tasks: { id: string; keyPrefix: string; attempts: number }[];
    try {
      tasks = await this.prisma.$queryRaw`
        UPDATE media_cleanup_tasks
           SET "runAfter" = clock_timestamp() + ${LEASE}::interval, attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM media_cleanup_tasks
            WHERE "runAfter" <= clock_timestamp() AND storage = ${provider}::"MediaStorage"
            ORDER BY "runAfter" LIMIT ${BATCH}
            FOR UPDATE SKIP LOCKED)
        RETURNING id, "keyPrefix", attempts`;
    } catch (err) {
      this.logger.warn(`Cleanup sweep skipped: ${(err as Error).message}`);
      return report;
    }
    for (const t of tasks) {
      // Never delete objects that a committed image row still points at.
      const inUse = await this.prisma.listingMedia.findUnique({
        where: { storageKeyPrefix: t.keyPrefix },
        select: { id: true },
      });
      if (inUse) {
        await this.prisma.mediaCleanupTask.deleteMany({ where: { id: t.id } });
        report.skippedInUse++;
        continue;
      }
      try {
        await this.storage.deleteMany(variantKeys(t.keyPrefix));
        await this.prisma.mediaCleanupTask.deleteMany({ where: { id: t.id } });
        report.deleted++;
      } catch (err) {
        report.failed++;
        const backoffMin = Math.min(2 ** t.attempts, 360);
        await this.prisma.mediaCleanupTask
          .updateMany({
            where: { id: t.id },
            data: {
              lastError: String((err as Error).message).slice(0, 500),
              runAfter: new Date(Date.now() + backoffMin * 60_000),
            },
          })
          .catch(() => undefined);
      }
    }
    if (tasks.length)
      this.logger.log({ msg: 'media cleanup sweep', ...report });
    return report;
  }
}
