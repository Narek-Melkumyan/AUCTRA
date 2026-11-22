import {
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import type { Request, Response } from 'express';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { requestMeta } from '../common/auth-context.js';
import {
  DELIVERY,
  DemoCheckoutService,
  type DeliveryOption,
} from './demo-checkout.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CurrentUser,
  Public,
  RequirePermissions,
} from '../common/decorators.js';
import type { AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import { money } from '../common/money.js';
import { cardUrl } from '../media/media.mapper.js';
import { Permission } from '../roles/permissions.js';
class OrdersQuery {
  @IsOptional() @IsUUID() auctionId?: string;
}

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Delivery address for the demo order. No payment details are accepted anywhere. */
class AddressDto {
  @Transform(trim) @IsString() @Length(2, 120) fullName!: string;
  @Transform(trim) @IsString() @Length(3, 200) line1!: string;
  @IsOptional() @Transform(trim) @IsString() @Length(0, 200) line2?: string;
  @Transform(trim) @IsString() @Length(2, 100) city!: string;
  @Transform(trim) @IsString() @Length(2, 20) postalCode!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{2}$/, { message: 'country must be a 2-letter code' })
  country!: string;
}

class DemoCheckoutDto {
  @IsIn(Object.keys(DELIVERY)) delivery!: DeliveryOption;
  @IsOptional() @ValidateNested() @Type(() => AddressDto) address?: AddressDto;
}

const orderInclude = {
  auction: {
    select: {
      id: true,
      title: true,
      lotNumber: true,
      media: { take: 1, orderBy: { position: 'asc' as const } },
    },
  },
  fees: true,
  shipments: {
    select: {
      id: true,
      status: true,
      carrier: true,
      trackingNumber: true,
      shippedAt: true,
      deliveredAt: true,
    },
  },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

function toOrderDto(o: OrderRow, viewerId: string) {
  const isSeller = o.sellerId === viewerId;
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    role: isSeller ? 'seller' : 'buyer',
    status: o.status,
    auction: {
      id: o.auction.id,
      title: o.auction.title,
      lotNumber: o.auction.lotNumber,
      image: o.auction.media[0] ? cardUrl(o.auction.media[0]) : null,
    },
    hammerPrice: money(o.hammerPriceCents, o.currency),
    buyerPremium: money(o.buyerPremiumCents, o.currency),
    shipping: money(o.shippingCents, o.currency),
    tax: money(o.taxCents, o.currency),
    total: money(o.totalCents, o.currency),
    // Seller commission is the seller's business, not the buyer's.
    ...(isSeller
      ? {
          sellerCommission:
            o.fees
              .filter((f) => f.type === 'SELLER_COMMISSION')
              .map((f) => ({
                rateBps: f.rateBps,
                amount: money(f.amountCents, f.currency),
              }))[0] ?? null,
        }
      : {}),
    shipments: o.shipments,
    paymentDueAt: o.paymentDueAt?.toISOString() ?? null,
    paidAt: o.paidAt?.toISOString() ?? null,
    /** Every AUCTRA order is settled through the simulated checkout. */
    simulated: true,
    demoCompletedAt: o.demoCompletedAt?.toISOString() ?? null,
    fulfillmentMethod: o.fulfillmentMethod,
    createdAt: o.createdAt.toISOString(),
  };
}

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: AuthContext, q: OrdersQuery) {
    const rows = await this.prisma.order.findMany({
      where: {
        OR: [{ buyerId: auth.userId }, { sellerId: auth.userId }],
        ...(q.auctionId ? { auctionId: q.auctionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: orderInclude,
      take: 200,
    });
    return rows.map((o) => toOrderDto(o, auth.userId));
  }

  async get(auth: AuthContext, id: string) {
    const o = await this.prisma.order.findUnique({
      where: { id },
      include: orderInclude,
    });
    const allowed =
      o &&
      (o.buyerId === auth.userId ||
        o.sellerId === auth.userId ||
        auth.permissions.has(Permission.ORDER_READ_ANY));
    if (!o || !allowed) throw Errors.notFound('Order');
    return toOrderDto(o, auth.userId);
  }
}

@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly checkout: DemoCheckoutService,
  ) {}

  @RequirePermissions(Permission.ORDER_READ_OWN)
  @Get('me/orders')
  list(@CurrentUser() auth: AuthContext, @Query() q: OrdersQuery) {
    return this.orders.list(auth, q);
  }

  @Get('orders/:id')
  get(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.get(auth, id);
  }

  /** Public checkout terms: configured fee rates and delivery options (demo values). */
  @Public()
  @Get('checkout-terms')
  terms() {
    return this.checkout.terms();
  }

  /** Demo checkout summary for the winning bidder of an auction. */
  @RequirePermissions(Permission.ORDER_READ_OWN)
  @Get('checkout/:auctionId')
  summary(
    @CurrentUser() auth: AuthContext,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
  ) {
    return this.checkout.summary(auth, auctionId);
  }

  /**
   * Completes the SIMULATED checkout (no real payment). Requires an Idempotency-Key so a
   * retried request is recognised; the order lock makes completion happen exactly once.
   */
  @RequirePermissions(Permission.ORDER_READ_OWN)
  @Post('orders/:id/demo-checkout')
  async complete(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DemoCheckoutDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw Errors.badRequest(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header (8–100 URL-safe characters).',
      );
    const r = await this.checkout.complete(
      auth,
      id,
      { delivery: dto.delivery, address: dto.address },
      requestMeta(req),
    );
    res.status(r.replayed ? 200 : 201);
    return {
      replayed: r.replayed,
      order: await this.orders.get(auth, id),
    };
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [OrdersController],
  // AUCTRA is a demo: there is deliberately no payment provider (no Stripe/PayPal).
  providers: [OrdersService, DemoCheckoutService],
})
export class OrdersModule {}
