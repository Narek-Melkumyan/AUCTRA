import { Injectable } from '@nestjs/common';
import type { FulfillmentMethod, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { Errors } from '../common/errors.js';
import { money } from '../common/money.js';
import type { AuthContext } from '../common/auth-context.js';
import { cardUrl } from '../media/media.mapper.js';

/**
 * SIMULATED CHECKOUT — AUCTRA is a portfolio demo and never processes real payments.
 *
 * Completing checkout records a demo order: a PaymentIntent and a CHARGE Transaction
 * with provider DEMO and `simulated = true` (a database CHECK ties the two together),
 * and the order moves to COMPLETED with `demoCompletedAt`. `paidAt` stays NULL because
 * nothing was paid. No card or bank data is ever accepted.
 */

export type DeliveryOption =
  'PICKUP' | 'INSURED_SHIPPING' | 'WHITE_GLOVE' | 'ARRANGED';

/** Flat delivery charges in minor units of the order currency (demo values). */
export const DELIVERY: Record<
  DeliveryOption,
  {
    label: string;
    method: FulfillmentMethod;
    minor: bigint;
    needsAddress: boolean;
  }
> = {
  PICKUP: {
    label: 'Collect from the seller',
    method: 'PICKUP',
    minor: 0n,
    needsAddress: false,
  },
  INSURED_SHIPPING: {
    label: 'Insured shipping',
    method: 'SHIPPING',
    minor: 24_000n,
    needsAddress: true,
  },
  WHITE_GLOVE: {
    label: 'White-glove delivery',
    method: 'SHIPPING',
    minor: 95_000n,
    needsAddress: true,
  },
  ARRANGED: {
    label: 'Handover arranged with the seller',
    method: 'ARRANGED',
    minor: 0n,
    needsAddress: false,
  },
};

export interface ShippingAddressInput {
  fullName: string;
  line1: string;
  line2?: string | undefined;
  city: string;
  postalCode: string;
  country: string;
}

function optionsFor(method: FulfillmentMethod): DeliveryOption[] {
  if (method === 'PICKUP') return ['PICKUP'];
  if (method === 'ARRANGED') return ['ARRANGED'];
  return ['PICKUP', 'INSURED_SHIPPING', 'WHITE_GLOVE'];
}

@Injectable()
export class DemoCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
  ) {}

  async terms() {
    const rows = await this.prisma.systemConfig.findMany({
      where: {
        key: { in: ['fees.buyer_premium_bps', 'fees.seller_commission_bps'] },
      },
    });
    const bps = (key: string) => {
      const v = rows.find((r) => r.key === key)?.value;
      return typeof v === 'number' ? v : 0;
    };
    return {
      simulated: true,
      buyerPremiumBps: bps('fees.buyer_premium_bps'),
      sellerCommissionBps: bps('fees.seller_commission_bps'),
      delivery: (Object.keys(DELIVERY) as DeliveryOption[]).map((key) => ({
        key,
        label: DELIVERY[key].label,
        priceMinor: DELIVERY[key].minor.toString(),
        needsAddress: DELIVERY[key].needsAddress,
      })),
    };
  }

  /** What the winner sees before confirming. Only the winning bidder may open it. */
  async summary(auth: AuthContext, auctionId: string) {
    const a = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      select: {
        id: true,
        title: true,
        lotNumber: true,
        status: true,
        winnerId: true,
        reservePriceCents: true,
        currentPriceCents: true,
        fulfillmentMethod: true,
        shippingNotes: true,
        media: {
          take: 1,
          orderBy: { position: 'asc' },
          select: { url: true, variants: true },
        },
        category: { select: { slug: true } },
        order: true,
      },
    });
    if (!a) throw Errors.notFound('Auction');
    if (a.status !== 'SOLD' || !a.order) {
      const reason =
        a.status === 'UNSOLD'
          ? 'This lot did not sell (no bids or the reserve was not met), so there is nothing to check out.'
          : a.status === 'ENDED'
            ? 'The auction has ended and the result is being settled. Try again in a moment.'
            : a.status === 'CANCELLED'
              ? 'This auction was cancelled.'
              : 'Checkout opens once the auction has ended with a winner.';
      throw Errors.conflict('CHECKOUT_NOT_AVAILABLE', reason, {
        status: a.status,
      });
    }
    if (a.winnerId !== auth.userId || a.order.buyerId !== auth.userId)
      throw Errors.forbiddenCode(
        'NOT_THE_WINNER',
        'Only the winning bidder can check out this lot.',
      );
    const o = a.order;
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      simulated: true,
      completed: !!o.demoCompletedAt,
      demoCompletedAt: o.demoCompletedAt?.toISOString() ?? null,
      auction: {
        id: a.id,
        title: a.title,
        lotNumber: a.lotNumber,
        image: a.media[0] ? cardUrl(a.media[0]) : null,
        categorySlug: a.category.slug,
        shippingNotes: a.shippingNotes,
      },
      hammerPrice: money(o.hammerPriceCents, o.currency),
      buyerPremium: money(o.buyerPremiumCents, o.currency),
      tax: money(o.taxCents, o.currency),
      shipping: money(o.shippingCents, o.currency),
      total: money(o.totalCents, o.currency),
      fulfillmentMethod: o.fulfillmentMethod,
      deliveryOptions: optionsFor(a.fulfillmentMethod).map((key) => ({
        key,
        label: DELIVERY[key].label,
        price: money(DELIVERY[key].minor, o.currency),
        needsAddress: DELIVERY[key].needsAddress,
      })),
    };
  }

  /**
   * Confirms the simulated purchase. Idempotent: the order row is locked, and a
   * completed order is returned unchanged (`replayed: true`) instead of being charged
   * twice; the unique `demo:<orderId>` keys make a second payment record impossible.
   */
  async complete(
    auth: AuthContext,
    orderId: string,
    input: {
      delivery: DeliveryOption;
      address?: ShippingAddressInput | undefined;
    },
    meta: { ip?: string | undefined; userAgent?: string | undefined },
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      if (!rows.length) throw Errors.notFound('Order');
      const o = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: {
          auction: {
            select: {
              id: true,
              title: true,
              status: true,
              winnerId: true,
              fulfillmentMethod: true,
              sellerId: true,
            },
          },
        },
      });
      // Winner validation: buyer on the order AND winner recorded on the auction.
      if (o.buyerId !== auth.userId || o.auction.winnerId !== auth.userId)
        throw Errors.forbiddenCode(
          'NOT_THE_WINNER',
          'Only the winning bidder can check out this lot.',
        );
      if (o.auction.status !== 'SOLD')
        throw Errors.conflict(
          'CHECKOUT_NOT_AVAILABLE',
          'This auction has not been sold.',
        );
      if (o.demoCompletedAt) return { order: o, replayed: true };
      if (o.status !== 'PENDING_PAYMENT')
        throw Errors.conflict(
          'ORDER_NOT_PAYABLE',
          'This order is not awaiting checkout.',
        );

      if (!optionsFor(o.auction.fulfillmentMethod).includes(input.delivery))
        throw Errors.unprocessable(
          'DELIVERY_NOT_OFFERED',
          'That delivery option is not available for this lot.',
        );
      const option = DELIVERY[input.delivery];
      if (option.needsAddress && !input.address)
        throw Errors.unprocessable(
          'ADDRESS_REQUIRED',
          'Enter a delivery address for this option.',
        );
      const shipping = option.minor;
      const total =
        o.hammerPriceCents + o.buyerPremiumCents + shipping + o.taxCents;
      const now = new Date();

      const updated = await tx.order.update({
        where: { id: o.id },
        data: {
          shippingCents: shipping,
          totalCents: total,
          status: 'COMPLETED',
          demoCompletedAt: now,
          fulfillmentMethod: option.method,
          shippingAddress: option.needsAddress
            ? (input.address as unknown as Prisma.InputJsonValue)
            : undefined,
        },
        include: {
          auction: {
            select: {
              id: true,
              title: true,
              status: true,
              winnerId: true,
              fulfillmentMethod: true,
              sellerId: true,
            },
          },
        },
      });
      const intent = await tx.paymentIntent.create({
        data: {
          orderId: o.id,
          provider: 'DEMO',
          simulated: true,
          status: 'SUCCEEDED',
          amountCents: total,
          currency: o.currency,
          idempotencyKey: `demo:${o.id}`,
        },
      });
      const charge = await tx.transaction.create({
        data: {
          orderId: o.id,
          paymentIntentId: intent.id,
          type: 'CHARGE',
          status: 'SUCCEEDED',
          provider: 'DEMO',
          simulated: true,
          amountCents: total,
          currency: o.currency,
          idempotencyKey: `demo-charge:${o.id}`,
          metadata: {
            simulated: true,
            note: 'Demo checkout — no real payment was taken.',
            delivery: input.delivery,
          },
        },
      });
      await tx.transactionAudit.create({
        data: {
          transactionId: charge.id,
          fromStatus: null,
          toStatus: 'SUCCEEDED',
          source: 'demo-checkout',
          metadata: { simulated: true },
        },
      });
      await this.notifications.notifyMany(tx, [
        {
          userId: o.buyerId,
          type: 'ORDER_UPDATE',
          title: `Demo order completed: ${o.auction.title}`,
          body: `Order ${o.orderNumber} is complete. This was a simulated transaction — no real payment was made.`,
          auctionId: o.auctionId,
          link: '/orders',
          dedupeKey: `demo-complete:${o.id}`,
        },
        {
          userId: o.sellerId,
          type: 'ORDER_UPDATE',
          title: `Buyer completed demo checkout: ${o.auction.title}`,
          body: `Order ${o.orderNumber} was completed through the simulated checkout. No money moved.`,
          auctionId: o.auctionId,
          link: '/orders',
          dedupeKey: `demo-complete:${o.id}`,
        },
      ]);
      await this.audit.record(
        {
          actorId: auth.userId,
          action: 'order.demo_checkout_completed',
          entityType: 'order',
          entityId: o.id,
          metadata: {
            simulated: true,
            delivery: input.delivery,
            totalMinor: total.toString(),
            currency: o.currency,
          },
          ...meta,
        },
        tx,
      );
      return { order: updated, replayed: false };
    });
    if (!result.replayed) this.outbox.kick();
    return result;
  }
}
