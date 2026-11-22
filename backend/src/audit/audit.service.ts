import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { hashIp } from '../common/crypto.js';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  /** Never include secrets, tokens or password material. */
  metadata?: Prisma.InputJsonValue;
}

/** Structured security/business audit trail persisted in `audit_logs`. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async record(entry: AuditEntry, tx: Tx = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        ipHash: hashIp(entry.ip, this.config.ipHashSalt),
        userAgent: entry.userAgent ?? null,
        metadata: entry.metadata ?? Prisma.JsonNull,
      },
    });
    this.logger.log(
      JSON.stringify({
        action: entry.action,
        actorId: entry.actorId ?? null,
        entity: entry.entityType,
        id: entry.entityId,
      }),
    );
  }

  /** Audit without failing the caller (for best-effort records outside transactions). */
  async recordSafe(entry: AuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (err) {
      this.logger.error(
        `Failed to write audit log ${entry.action}: ${(err as Error).message}`,
      );
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
