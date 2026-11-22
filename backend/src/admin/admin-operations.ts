import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import type { DisputeStatus, OrderStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { CurrentUser, RequirePermissions } from '../common/decorators.js';
import { requestMeta, type AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import { money } from '../common/money.js';
import { Permission } from '../roles/permissions.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type Meta = { ip?: string | undefined; userAgent?: string | undefined };

// ───────────── DTOs ─────────────

class CreateCategoryDto {
  @Transform(trim) @IsString() @Length(2, 80) @Matches(SLUG) slug!: string;
  @Transform(trim) @IsString() @Length(2, 120) name!: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 1000)
  description?: string;
  /** Slug of an existing top-level category to create a subcategory. */
  @IsOptional() @Transform(trim) @IsString() @Matches(SLUG) parentSlug?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
}

class UpdateCategoryDto {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 120) name?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 1000)
  description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAYMENT_PROCESSING',
  'PAID',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'DISPUTED',
] as const;
const DISPUTE_STATUSES = [
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED_BUYER',
  'RESOLVED_SELLER',
  'CLOSED',
] as const;

class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
class OrdersQuery extends ListQuery {
  @IsOptional() @IsIn(ORDER_STATUSES) status?: OrderStatus;
}
class DisputesQuery extends ListQuery {
  @IsOptional() @IsIn(DISPUTE_STATUSES) status?: DisputeStatus;
}

class DisputeDecisionDto {
  @IsIn(['UNDER_REVIEW', 'RESOLVED_BUYER', 'RESOLVED_SELLER', 'CLOSED'])
  status!: Exclude<DisputeStatus, 'OPEN'>;
  /** Required when the dispute is resolved or closed; shown to both parties. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 2000)
  resolution?: string;
}

const party = (u: {
  id: string;
  email: string;
  profile: { displayName: string; handle: string } | null;
}) => ({
  id: u.id,
  email: u.email,
  displayName: u.profile?.displayName ?? null,
  handle: u.profile?.handle ?? null,
});
const partySelect = {
  select: {
    id: true,
    email: true,
    profile: { select: { displayName: true, handle: true } },
  },
} as const;

/**
 * Staff operations that complete the admin console: category management
 * (`category:manage`), the order book (`order:read:any`) and dispute handling
 * (`dispute:handle`). Every write is audited.
 */
@Injectable()
export class AdminOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ───────────── Categories ─────────────

  async categories() {
    const all = await this.prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { auctions: true, auctionsInSubcat: true } },
      },
    });
    const open = await this.prisma.auction.groupBy({
      by: ['categoryId'],
      where: { status: { in: ['PENDING_REVIEW', 'SCHEDULED', 'LIVE'] } },
      _count: { _all: true },
    });
    const openSub = await this.prisma.auction.groupBy({
      by: ['subcategoryId'],
      where: {
        status: { in: ['PENDING_REVIEW', 'SCHEDULED', 'LIVE'] },
        subcategoryId: { not: null },
      },
      _count: { _all: true },
    });
    const openBy = new Map<string, number>();
    for (const r of open) openBy.set(r.categoryId, r._count._all);
    for (const r of openSub)
      if (r.subcategoryId) openBy.set(r.subcategoryId, r._count._all);
    const dto = (c: (typeof all)[number]) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
      auctionCount: c.parentId ? c._count.auctionsInSubcat : c._count.auctions,
      openAuctionCount: openBy.get(c.id) ?? 0,
    });
    return all
      .filter((c) => !c.parentId)
      .map((root) => ({
        ...dto(root),
        subcategories: all.filter((c) => c.parentId === root.id).map(dto),
      }));
  }

  async createCategory(actor: AuthContext, dto: CreateCategoryDto, meta: Meta) {
    if (await this.prisma.category.findUnique({ where: { slug: dto.slug } }))
      throw Errors.conflict('CATEGORY_EXISTS', 'That slug is already in use.');
    let parentId: string | null = null;
    if (dto.parentSlug) {
      const parent = await this.prisma.category.findUnique({
        where: { slug: dto.parentSlug },
      });
      if (!parent || parent.parentId)
        throw Errors.unprocessable(
          'INVALID_PARENT',
          'Subcategories can only be added to an existing top-level category.',
        );
      parentId = parent.id;
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const c = await tx.category.create({
        data: {
          slug: dto.slug,
          name: dto.name,
          description: dto.description || null,
          sortOrder: dto.sortOrder ?? 100,
          parentId,
        },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'category.create',
          entityType: 'category',
          entityId: c.id,
          metadata: { slug: c.slug, parentSlug: dto.parentSlug ?? null },
          ...meta,
        },
        tx,
      );
      return c;
    });
    return { id: created.id, slug: created.slug };
  }

  async updateCategory(
    actor: AuthContext,
    slug: string,
    dto: UpdateCategoryDto,
    meta: Meta,
  ) {
    const c = await this.prisma.category.findUnique({
      where: { slug },
      include: { children: { select: { id: true } } },
    });
    if (!c) throw Errors.notFound('Category');
    if (dto.isActive === false && c.isActive) {
      const ids = [c.id, ...c.children.map((x) => x.id)];
      const open = await this.prisma.auction.count({
        where: {
          status: { in: ['PENDING_REVIEW', 'SCHEDULED', 'LIVE'] },
          OR: [{ categoryId: { in: ids } }, { subcategoryId: { in: ids } }],
        },
      });
      if (open)
        throw Errors.conflict(
          'CATEGORY_IN_USE',
          `${open} open listing${open === 1 ? '' : 's'} use this category; it can be hidden once they have ended.`,
        );
    }
    const changes = Object.fromEntries(
      Object.entries({
        name: dto.name,
        description: dto.description,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      }).filter(([, v]) => v !== undefined),
    );
    if (!Object.keys(changes).length)
      throw Errors.badRequest('NOTHING_TO_UPDATE', 'No changes were sent.');
    await this.prisma.$transaction(async (tx) => {
      await tx.category.update({ where: { id: c.id }, data: changes });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'category.update',
          entityType: 'category',
          entityId: c.id,
          metadata: { slug, changes },
          ...meta,
        },
        tx,
      );
    });
    return { slug, ...changes };
  }

  // ───────────── Orders ─────────────

  async orders(q: OrdersQuery) {
    const limit = q.limit ?? 25;
    const page = q.page ?? 1;
    const where = q.status ? { status: q.status } : {};
    const [total, rows, byStatus] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          auction: { select: { id: true, title: true, lotNumber: true } },
          buyer: partySelect,
          seller: partySelect,
          _count: {
            select: {
              disputes: { where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } },
            },
          },
        },
      }),
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return {
      total,
      page,
      limit,
      counts: Object.fromEntries(
        byStatus.map((s) => [s.status, s._count._all]),
      ),
      items: rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        auction: o.auction,
        buyer: party(o.buyer),
        seller: party(o.seller),
        hammerPrice: money(o.hammerPriceCents, o.currency),
        buyerPremium: money(o.buyerPremiumCents, o.currency),
        total: money(o.totalCents, o.currency),
        demoCompletedAt: o.demoCompletedAt,
        fulfillmentMethod: o.fulfillmentMethod,
        openDisputes: o._count.disputes,
        createdAt: o.createdAt,
      })),
    };
  }

  // ───────────── Disputes ─────────────

  async disputes(q: DisputesQuery) {
    const limit = q.limit ?? 25;
    const page = q.page ?? 1;
    const where = q.status ? { status: q.status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.dispute.count({ where }),
      this.prisma.dispute.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          openedBy: partySelect,
          handledBy: partySelect,
          order: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
              totalCents: true,
              currency: true,
              buyerId: true,
              sellerId: true,
              auction: { select: { id: true, title: true } },
            },
          },
        },
      }),
    ]);
    return {
      total,
      page,
      limit,
      items: rows.map((d) => ({
        id: d.id,
        status: d.status,
        reason: d.reason,
        details: d.details,
        resolution: d.resolution,
        resolvedAt: d.resolvedAt,
        createdAt: d.createdAt,
        openedBy: party(d.openedBy),
        openedByRole: d.openedById === d.order.buyerId ? 'buyer' : 'seller',
        handledBy: d.handledBy ? party(d.handledBy) : null,
        order: {
          id: d.order.id,
          orderNumber: d.order.orderNumber,
          status: d.order.status,
          total: money(d.order.totalCents, d.order.currency),
          auction: d.order.auction,
        },
      })),
    };
  }

  /**
   * Moves a dispute along OPEN → UNDER_REVIEW → RESOLVED_BUYER | RESOLVED_SELLER | CLOSED.
   * When it ends, the order leaves DISPUTED: cancelled in the buyer's favour, otherwise
   * back to where the demo checkout left it. No money moves (there are no real payments).
   */
  async decideDispute(
    actor: AuthContext,
    id: string,
    dto: DisputeDecisionDto,
    meta: Meta,
  ) {
    const final = dto.status !== 'UNDER_REVIEW';
    if (final && !dto.resolution)
      throw Errors.badRequest(
        'RESOLUTION_REQUIRED',
        'Explain the decision; both parties will see it.',
      );
    return this.prisma.$transaction(async (tx) => {
      // Row lock: two staff members cannot decide the same dispute concurrently.
      const locked = await tx.$queryRaw<{ status: DisputeStatus }[]>`
        SELECT status FROM disputes WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw Errors.notFound('Dispute');
      const d = await tx.dispute.findUniqueOrThrow({
        where: { id },
        include: { order: true },
      });
      if (!['OPEN', 'UNDER_REVIEW'].includes(d.status))
        throw Errors.conflict(
          'DISPUTE_CLOSED',
          'This dispute has already been decided.',
        );
      const now = await this.prisma.dbNow(tx);
      await tx.dispute.update({
        where: { id },
        data: {
          status: dto.status,
          handledById: actor.userId,
          ...(dto.resolution ? { resolution: dto.resolution } : {}),
          ...(final ? { resolvedAt: now } : {}),
        },
      });
      let orderStatus: OrderStatus = d.order.status;
      if (final && d.order.status === 'DISPUTED') {
        orderStatus =
          dto.status === 'RESOLVED_BUYER'
            ? 'CANCELLED'
            : d.order.demoCompletedAt
              ? 'COMPLETED'
              : 'PENDING_PAYMENT';
        await tx.order.update({
          where: { id: d.orderId },
          data: {
            status: orderStatus,
            ...(orderStatus === 'CANCELLED' ? { cancelledAt: now } : {}),
          },
        });
      }
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'dispute.decide',
          entityType: 'dispute',
          entityId: id,
          metadata: {
            from: d.status,
            to: dto.status,
            orderId: d.orderId,
            orderStatus,
          },
          ...meta,
        },
        tx,
      );
      if (final) {
        const label =
          dto.status === 'RESOLVED_BUYER'
            ? 'resolved in the buyer’s favour'
            : dto.status === 'RESOLVED_SELLER'
              ? 'resolved in the seller’s favour'
              : 'closed';
        await this.notifications.notifyMany(
          tx,
          [d.order.buyerId, d.order.sellerId].map((userId) => ({
            userId,
            type: 'ORDER_UPDATE' as const,
            title: `Dispute ${label}`,
            body: `Order ${d.order.orderNumber}: ${dto.resolution}`,
            link: '/orders',
            data: { disputeId: id, orderId: d.orderId, status: dto.status },
            dedupeKey: `dispute:${id}:${dto.status}`,
          })),
        );
      }
      return { id, status: dto.status, orderStatus };
    });
  }
}

@Controller('admin')
export class AdminOperationsController {
  constructor(private readonly ops: AdminOperationsService) {}

  @RequirePermissions(Permission.CATEGORY_MANAGE)
  @Get('categories')
  categories() {
    return this.ops.categories();
  }

  @RequirePermissions(Permission.CATEGORY_MANAGE)
  @Post('categories')
  createCategory(
    @CurrentUser() a: AuthContext,
    @Body() dto: CreateCategoryDto,
    @Req() req: Request,
  ) {
    return this.ops.createCategory(a, dto, requestMeta(req));
  }

  @RequirePermissions(Permission.CATEGORY_MANAGE)
  @Patch('categories/:slug')
  updateCategory(
    @CurrentUser() a: AuthContext,
    @Param('slug') slug: string,
    @Body() dto: UpdateCategoryDto,
    @Req() req: Request,
  ) {
    if (!SLUG.test(slug)) throw Errors.notFound('Category');
    return this.ops.updateCategory(a, slug, dto, requestMeta(req));
  }

  @RequirePermissions(Permission.ORDER_READ_ANY)
  @Get('orders')
  orders(@Query() q: OrdersQuery) {
    return this.ops.orders(q);
  }

  @RequirePermissions(Permission.DISPUTE_HANDLE)
  @Get('disputes')
  disputes(@Query() q: DisputesQuery) {
    return this.ops.disputes(q);
  }

  @RequirePermissions(Permission.DISPUTE_HANDLE)
  @HttpCode(200)
  @Post('disputes/:id/decision')
  decideDispute(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DisputeDecisionDto,
    @Req() req: Request,
  ) {
    return this.ops.decideDispute(a, id, dto, requestMeta(req));
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [AdminOperationsController],
  providers: [AdminOperationsService],
})
export class AdminOperationsModule {}
