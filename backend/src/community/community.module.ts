import {
  Body,
  Controller,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { ReportTargetType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CurrentUser, RequirePermissions } from '../common/decorators.js';
import type { AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import { Permission } from '../roles/permissions.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class ReportDto {
  @IsEnum(ReportTargetType) targetType!: ReportTargetType;
  @IsUUID() targetId!: string;
  @Transform(trim) @IsString() @Length(3, 100) reason!: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 4000) details?: string;
}

class DisputeDto {
  @Transform(trim) @IsString() @Length(3, 100) reason!: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 4000) details?: string;
}

@Injectable()
export class CommunityService {
  constructor(private readonly prisma: PrismaService) {}

  async report(auth: AuthContext, dto: ReportDto) {
    const open = await this.prisma.report.count({
      where: {
        reporterId: auth.userId,
        status: 'OPEN',
        createdAt: { gt: new Date(Date.now() - 86_400_000) },
      },
    });
    if (open >= 20)
      throw Errors.tooMany(
        'You have filed many reports today. Our team will review them.',
      );
    return this.prisma.report.create({
      data: { reporterId: auth.userId, ...dto },
    });
  }

  async openDispute(auth: AuthContext, orderId: string, dto: DisputeDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (
      !order ||
      (order.buyerId !== auth.userId && order.sellerId !== auth.userId)
    )
      throw Errors.notFound('Order');
    const open = await this.prisma.dispute.findFirst({
      where: { orderId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
    });
    if (open)
      throw Errors.conflict(
        'DISPUTE_OPEN',
        'A dispute is already open for this order.',
      );
    if (order.status === 'CANCELLED' || order.status === 'REFUNDED')
      throw Errors.conflict(
        'ORDER_CLOSED',
        'This order is closed; disputes can no longer be opened.',
      );
    try {
      return await this.prisma.$transaction(async (tx) => {
        const d = await tx.dispute.create({
          data: {
            orderId,
            openedById: auth.userId,
            reason: dto.reason,
            details: dto.details ?? null,
          },
        });
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'DISPUTED' },
        });
        return d;
      });
    } catch (err) {
      // disputes_one_active_per_order: a concurrent request opened one first.
      if ((err as { code?: string }).code === 'P2002')
        throw Errors.conflict(
          'DISPUTE_OPEN',
          'A dispute is already open for this order.',
        );
      throw err;
    }
  }
}

@Controller()
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @RequirePermissions(Permission.REPORT_CREATE)
  @Post('reports')
  report(@CurrentUser() a: AuthContext, @Body() dto: ReportDto) {
    return this.community.report(a, dto);
  }

  @RequirePermissions(Permission.DISPUTE_OPEN)
  @Post('orders/:id/disputes')
  dispute(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DisputeDto,
  ) {
    return this.community.openDispute(a, id, dto);
  }
}

@Module({ controllers: [CommunityController], providers: [CommunityService] })
export class CommunityModule {}
