import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../email/email.service.js';
import { notificationLink } from './notifications.service.js';

/** Retry schedule for transient provider failures; after the last one the row is FAILED. */
export const EMAIL_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3600_000,
];
export const EMAIL_MAX_ATTEMPTS = EMAIL_RETRY_DELAYS_MS.length + 1;
/** A claim lease: a crashed worker's rows become due again after this. */
const CLAIM_LEASE_MS = 5 * 60_000;
/** Anti-spam: at most this many notification emails per user per hour (security exempt). */
export const EMAIL_HOURLY_CAP = 12;
/** Anti-spam: one email per (user, type, auction) in this window (security exempt). */
const COALESCE_MS = 10 * 60_000;

export interface DeliveryReport {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

/**
 * Delivers PENDING email rows of notification_deliveries.
 *
 * 1. Claim a batch in a short transaction (FOR UPDATE SKIP LOCKED, then push
 *    `nextAttemptAt` forward as a lease) — safe with several workers.
 * 2. Send each email OUTSIDE any database transaction.
 * 3. Record the outcome: SENT only when the provider accepted it; transient failures
 *    are retried with back-off; permanent failures become FAILED; mails that must not go
 *    out (no provider, unverified address, spam limits, already read) become SKIPPED.
 */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async deliverDue(batch = 25): Promise<DeliveryReport> {
    const report: DeliveryReport = {
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
    };
    const claimed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE status = 'PENDING' AND channel = 'EMAIL' AND "nextAttemptAt" <= now()
        ORDER BY "nextAttemptAt", id
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length)
        await tx.notificationDelivery.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS) },
        });
      return rows.map((r) => r.id);
    });
    report.claimed = claimed.length;
    for (const id of claimed) {
      const outcome = await this.deliverOne(id).catch((err: Error) => {
        this.logger.error(`Delivery ${id} crashed: ${err.message}`);
        return 'retried' as const;
      });
      report[outcome]++;
    }
    return report;
  }

  private async deliverOne(
    id: string,
  ): Promise<'sent' | 'retried' | 'failed' | 'skipped'> {
    const d = await this.prisma.notificationDelivery.findUniqueOrThrow({
      where: { id },
      include: {
        notification: {
          include: {
            user: {
              select: { email: true, emailVerifiedAt: true, status: true },
            },
          },
        },
      },
    });
    const n = d.notification;
    const security = n.type === 'ACCOUNT_SECURITY';
    const skip = async (reason: string) => {
      await this.prisma.notificationDelivery.update({
        where: { id },
        data: { status: 'SKIPPED', lastError: reason },
      });
      return 'skipped' as const;
    };

    if (!security && !n.user.emailVerifiedAt) return skip('email not verified');
    if (n.user.status === 'BANNED' || n.user.status === 'DEACTIVATED')
      return skip('account disabled');
    if (!security && n.readAt) return skip('already read in app');
    if (!security) {
      const since = new Date(Date.now() - 3600_000);
      const sentLastHour = await this.prisma.notificationDelivery.count({
        where: {
          channel: 'EMAIL',
          status: 'SENT',
          sentAt: { gt: since },
          notification: { userId: n.userId },
        },
      });
      if (sentLastHour >= EMAIL_HOURLY_CAP) return skip('hourly email cap');
      if (n.auctionId) {
        const recent = await this.prisma.notificationDelivery.count({
          where: {
            id: { not: id },
            channel: 'EMAIL',
            status: 'SENT',
            sentAt: { gt: new Date(Date.now() - COALESCE_MS) },
            notification: {
              userId: n.userId,
              type: n.type,
              auctionId: n.auctionId,
            },
          },
        });
        if (recent) return skip('coalesced with a recent email');
      }
    }

    const path = notificationLink(n) ?? undefined;
    const res = security
      ? await this.email.provider.send({
          ...this.email.renderSecurity(n.title, n.body),
          to: n.user.email,
          template: 'security-alert',
          idempotencyKey: `notification/${id}`,
        })
      : await this.email.sendNotification(n.user.email, {
          title: n.title,
          body: n.body,
          path,
          deliveryId: id,
        });

    const attempts = d.attempts + 1;
    if (res.delivered) {
      await this.prisma.notificationDelivery.update({
        where: { id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          attempts,
          providerMessageId: res.providerMessageId ?? null,
          lastError: null,
        },
      });
      return 'sent';
    }
    const reason = (res.reason ?? 'not delivered').slice(0, 1000);
    // No provider configured / disabled: nothing will ever be sent. Not a failure.
    if (
      res.reason === 'no-provider-configured' ||
      res.reason === 'email-disabled'
    ) {
      await this.prisma.notificationDelivery.update({
        where: { id },
        data: { status: 'SKIPPED', attempts, lastError: reason },
      });
      return 'skipped';
    }
    if (res.retryable && attempts < EMAIL_MAX_ATTEMPTS) {
      await this.prisma.notificationDelivery.update({
        where: { id },
        data: {
          status: 'PENDING',
          attempts,
          lastError: reason,
          nextAttemptAt: new Date(
            Date.now() + EMAIL_RETRY_DELAYS_MS[attempts - 1]!,
          ),
        },
      });
      return 'retried';
    }
    await this.prisma.notificationDelivery.update({
      where: { id },
      data: { status: 'FAILED', attempts, lastError: reason },
    });
    return 'failed';
  }

  /** Admin action: puts a FAILED (or SKIPPED) email back in the queue. */
  async retry(id: string) {
    const d = await this.prisma.notificationDelivery.findUnique({
      where: { id },
      select: { id: true, channel: true, status: true },
    });
    if (!d || d.channel !== 'EMAIL') return null;
    if (d.status === 'SENT' || d.status === 'PENDING') return d;
    return this.prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
      },
      select: { id: true, channel: true, status: true },
    });
  }
}
