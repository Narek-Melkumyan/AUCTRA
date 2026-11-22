import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { AppConfig } from '../config/app-config.js';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  /** The underlying pool, exposed for pool-utilisation metrics. */
  readonly pool: pg.Pool;

  constructor(config: AppConfig) {
    const url = new URL(config.databaseUrl);
    const schema = url.searchParams.get('schema') ?? undefined;
    url.searchParams.delete('schema');
    const pool = new pg.Pool({
      connectionString: url.toString(),
      max: config.dbPoolMax,
      // Fail fast instead of queueing forever when the pool is exhausted.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      // Every session runs in UTC: the driver adapter exchanges timestamps without an
      // offset, so a non-UTC server/database time zone would silently shift deadlines.
      // A statement timeout bounds any runaway query.
      options: '-c timezone=UTC -c statement_timeout=15000',
    });
    pool.on('error', (err) =>
      Logger.error(
        `Idle PostgreSQL client error: ${err.message}`,
        'PrismaService',
      ),
    );
    super({
      adapter: new PrismaPg(pool, schema ? { schema } : undefined),
      log: config.isProduction ? ['error'] : ['warn', 'error'],
    });
    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end().catch(() => undefined);
  }

  /** Database server time — the authority for every auction deadline. */
  async dbNow(tx: Tx | PrismaClient = this): Promise<Date> {
    const rows = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    return rows[0]!.now;
  }
}
