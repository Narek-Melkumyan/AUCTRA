import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsUUID,
  MaxLength,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  AuctionStatus,
  ReportStatus,
  UserStatus,
} from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import { RealtimeSessions } from '../auth/realtime-sessions.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { CurrentUser, RequirePermissions } from '../common/decorators.js';
import { requestMeta, type AuthContext } from '../common/auth-context.js';
import { AdminInsightsService } from './admin-insights.service.js';
import { Errors } from '../common/errors.js';
import { Permission, RoleKey } from '../roles/permissions.js';
import { ReasonDto } from '../auctions/dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class SuspendDto {
  @Transform(trim) @IsString() @Length(3, 500) reason!: string;
  /** Omit for an open-ended suspension. */
  @IsOptional() @IsDateString({ strict: true }) until?: string;
  @IsOptional() @IsIn(['SUSPENDED', 'BANNED']) level?: 'SUSPENDED' | 'BANNED';
}

class RoleDto {
  @IsIn(Object.values(RoleKey)) role!: string;
}

class SellerDecisionDto {
  @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) reason?: string;
}

class ReportDecisionDto {
  @IsEnum(ReportStatus) status!: ReportStatus;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  resolution?: string;
}

const toBool = ({ value }: { value: unknown }) =>
  value === undefined || value === ''
    ? undefined
    : value === true || value === 'true' || value === '1';

class UsersQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsIn(Object.values(RoleKey)) role?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() verified?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

class AdminAuctionsQuery {
  @IsOptional() @IsEnum(AuctionStatus) status?: AuctionStatus;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsUUID() sellerId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

class DaysQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(180) days?: number;
}

class AuditQuery {
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() actorId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly realtime: RealtimeSessions,
    private readonly notifications: NotificationsService,
  ) {}

  async suspend(actor: AuthContext, userId: string, dto: SuspendDto) {
    if (userId === actor.userId)
      throw Errors.forbidden('You cannot suspend yourself.');
    await this.assertNotPrivilegedTarget(actor, userId);
    const level = dto.level ?? 'SUSPENDED';
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          status: level,
          suspensionReason: dto.reason,
          suspendedUntil: dto.until ? new Date(dto.until) : null,
        },
      });
      // A ban ends every session; a suspension leaves read access.
      if (level === 'BANNED')
        await this.sessions.revokeAll(
          userId,
          'ACCOUNT_SUSPENDED',
          undefined,
          tx,
        );
      await tx.moderationAction.create({
        data: {
          moderatorId: actor.userId,
          action: 'SUSPEND_USER',
          targetType: 'USER',
          targetId: userId,
          subjectUserId: userId,
          reason: dto.reason,
        },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: `user.${level.toLowerCase()}`,
          entityType: 'user',
          entityId: userId,
          metadata: { reason: dto.reason },
        },
        tx,
      );
    });
    if (level === 'BANNED') this.realtime.disconnectUser(userId);
    return { userId, status: level };
  }

  async unsuspend(actor: AuthContext, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'ACTIVE',
          suspendedUntil: null,
          suspensionReason: null,
        },
      });
      await tx.moderationAction.create({
        data: {
          moderatorId: actor.userId,
          action: 'UNSUSPEND_USER',
          targetType: 'USER',
          targetId: userId,
          subjectUserId: userId,
        },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'user.unsuspend',
          entityType: 'user',
          entityId: userId,
        },
        tx,
      );
    });
    return { userId, status: 'ACTIVE' };
  }

  async grantRole(actor: AuthContext, userId: string, roleKey: string) {
    const role = await this.prisma.role.findUnique({ where: { key: roleKey } });
    if (!role) throw Errors.notFound('Role');
    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      create: { userId, roleId: role.id, grantedById: actor.userId },
      update: {},
    });
    await this.audit.recordSafe({
      actorId: actor.userId,
      action: 'role.grant',
      entityType: 'user',
      entityId: userId,
      metadata: { role: roleKey },
    });
    return { userId, role: roleKey, granted: true };
  }

  async revokeRole(actor: AuthContext, userId: string, roleKey: string) {
    if (roleKey === RoleKey.USER)
      throw Errors.unprocessable(
        'ROLE_REQUIRED',
        'The USER role cannot be removed.',
      );
    if (userId === actor.userId && roleKey === RoleKey.SUPER_ADMIN)
      throw Errors.forbidden('You cannot remove your own super-admin role.');
    const role = await this.prisma.role.findUnique({ where: { key: roleKey } });
    if (!role) throw Errors.notFound('Role');
    await this.prisma.userRole.deleteMany({
      where: { userId, roleId: role.id },
    });
    await this.audit.recordSafe({
      actorId: actor.userId,
      action: 'role.revoke',
      entityType: 'user',
      entityId: userId,
      metadata: { role: roleKey },
    });
    return { userId, role: roleKey, granted: false };
  }

  sellerApplications() {
    return this.prisma.sellerProfile.findMany({
      where: { verificationStatus: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            email: true,
            profile: { select: { handle: true, displayName: true } },
          },
        },
      },
    });
  }

  /** Approving a seller grants the SELLER role (and with it auction:create). */
  async decideSeller(
    actor: AuthContext,
    userId: string,
    dto: SellerDecisionDto,
  ) {
    const sellerRole = await this.prisma.role.findUniqueOrThrow({
      where: { key: RoleKey.SELLER },
    });
    await this.prisma.$transaction(async (tx) => {
      const profile = await tx.sellerProfile.findUnique({ where: { userId } });
      if (!profile || profile.verificationStatus !== 'PENDING')
        throw Errors.conflict(
          'NO_PENDING_APPLICATION',
          'No pending seller application.',
        );
      if (dto.decision === 'approve') {
        await tx.sellerProfile.update({
          where: { userId },
          data: {
            verificationStatus: 'VERIFIED',
            verifiedAt: new Date(),
            rejectionReason: null,
          },
        });
        await tx.userRole.upsert({
          where: { userId_roleId: { userId, roleId: sellerRole.id } },
          create: { userId, roleId: sellerRole.id, grantedById: actor.userId },
          update: {},
        });
      } else {
        if (!dto.reason)
          throw Errors.unprocessable(
            'REASON_REQUIRED',
            'Give the applicant a reason.',
          );
        await tx.sellerProfile.update({
          where: { userId },
          data: { verificationStatus: 'REJECTED', rejectionReason: dto.reason },
        });
      }
      await tx.moderationAction.create({
        data: {
          moderatorId: actor.userId,
          action:
            dto.decision === 'approve' ? 'APPROVE_SELLER' : 'REJECT_SELLER',
          targetType: 'USER',
          targetId: userId,
          subjectUserId: userId,
          reason: dto.reason ?? null,
        },
      });
      await this.notifications.notifyMany(tx, [
        {
          userId,
          type: 'SYSTEM',
          title:
            dto.decision === 'approve'
              ? 'You are now a verified AUCTRA seller'
              : 'Seller application declined',
          body:
            dto.decision === 'approve'
              ? 'You can now create auction listings.'
              : (dto.reason ?? ''),
          dedupeKey: `seller-decision:${userId}:${Date.now()}`,
        },
      ]);
      await this.audit.record(
        {
          actorId: actor.userId,
          action: `seller.${dto.decision}`,
          entityType: 'user',
          entityId: userId,
        },
        tx,
      );
    });
    return { userId, decision: dto.decision };
  }

  async auditLogs(q: AuditQuery) {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(q.action ? { action: q.action } : {}),
        ...(q.actorId ? { actorId: q.actorId } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit ?? 100,
    });
    return rows.map((r) => ({ ...r, id: r.id.toString() }));
  }

  async decideReport(
    actor: AuthContext,
    id: string,
    dto: ReportDecisionDto,
    meta: { ip?: string | undefined; userAgent?: string | undefined } = {},
  ) {
    const existing = await this.prisma.report.findUnique({ where: { id } });
    if (!existing) throw Errors.notFound('Report');
    const r = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.report.update({
        where: { id },
        data: {
          status: dto.status,
          resolution: dto.resolution ?? null,
          handledById: actor.userId,
        },
      });
      if (dto.status === 'DISMISSED')
        await tx.moderationAction.create({
          data: {
            moderatorId: actor.userId,
            action: 'DISMISS_REPORT',
            targetType: existing.targetType,
            targetId: existing.targetId,
            reportId: id,
            reason: dto.resolution ?? null,
          },
        });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'report.decide',
          entityType: 'report',
          entityId: id,
          metadata: { status: dto.status, targetType: existing.targetType },
          ...meta,
        },
        tx,
      );
      return updated;
    });
    return r;
  }

  /** Signs a user out everywhere (e.g. compromised account). */
  async revokeSessions(
    actor: AuthContext,
    userId: string,
    meta: { ip?: string | undefined; userAgent?: string | undefined },
  ) {
    if (userId !== actor.userId)
      await this.assertNotPrivilegedTarget(actor, userId);
    const count = await this.sessions.revokeAll(userId, 'ADMIN');
    this.realtime.disconnectUser(userId);
    await this.audit.recordSafe({
      actorId: actor.userId,
      action: 'user.sessions_revoked',
      entityType: 'user',
      entityId: userId,
      metadata: { count },
      ...meta,
    });
    return { userId, revokedSessions: count };
  }

  /** Admins may not act on accounts holding admin roles unless they are super-admins. */
  private async assertNotPrivilegedTarget(actor: AuthContext, userId: string) {
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      select: { role: { select: { key: true } } },
    });
    const keys = roles.map((r) => r.role.key);
    if (
      (keys.includes(RoleKey.ADMIN) || keys.includes(RoleKey.SUPER_ADMIN)) &&
      !actor.roles.includes(RoleKey.SUPER_ADMIN)
    ) {
      throw Errors.forbidden(
        'Only a super-admin can act on administrator accounts.',
      );
    }
  }
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly auctions: AuctionsService,
    private readonly insights: AdminInsightsService,
  ) {}

  @RequirePermissions(Permission.ANALYTICS_READ)
  @Get('analytics')
  analytics(@Query() q: DaysQuery) {
    return this.insights.analytics(q.days ?? 30);
  }

  @RequirePermissions(Permission.AUCTION_READ_ANY, Permission.ANALYTICS_READ)
  @Get('integrity/bidding')
  integrity(@Query() q: DaysQuery) {
    return this.insights.suspiciousBidding(q.days ?? 30);
  }

  @RequirePermissions(Permission.AUCTION_MODERATE)
  @Get('auctions/review')
  reviewQueue() {
    return this.auctions.listForReview();
  }

  @RequirePermissions(Permission.AUCTION_MODERATE)
  @HttpCode(200)
  @Post('auctions/:id/approve')
  approve(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.auctions.approve(a, id);
  }

  @RequirePermissions(Permission.AUCTION_MODERATE)
  @HttpCode(200)
  @Post('auctions/:id/reject')
  reject(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.auctions.reject(a, id, dto.reason);
  }

  @RequirePermissions(Permission.AUCTION_READ_ANY)
  @Get('auctions')
  auctionsList(@Query() q: AdminAuctionsQuery) {
    return this.insights.auctions(q);
  }

  @RequirePermissions(Permission.AUCTION_READ_ANY)
  @Get('auctions/:id')
  auctionDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.insights.auction(id);
  }

  /** Staff cancellation (any time before the auction ends; documented rule). */
  @RequirePermissions(Permission.AUCTION_MODERATE)
  @HttpCode(200)
  @Post('auctions/:id/cancel')
  cancelAuction(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.auctions.cancel(a, id, dto.reason);
  }

  @RequirePermissions(Permission.USER_READ_ANY)
  @Get('users')
  users(@Query() q: UsersQuery) {
    return this.insights.users(q);
  }

  @RequirePermissions(Permission.USER_READ_ANY)
  @Get('users/:id')
  user(@CurrentUser() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    // Session details are limited to staff who can act on accounts.
    return this.insights.user(id, {
      includeSessions: a.permissions.has(Permission.USER_SUSPEND),
    });
  }

  @RequirePermissions(Permission.USER_SUSPEND)
  @HttpCode(200)
  @Post('users/:id/sessions/revoke')
  revokeSessions(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.admin.revokeSessions(a, id, requestMeta(req));
  }

  @RequirePermissions(Permission.USER_SUSPEND)
  @HttpCode(200)
  @Post('users/:id/suspend')
  suspend(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendDto,
  ) {
    return this.admin.suspend(a, id, dto);
  }

  @RequirePermissions(Permission.USER_SUSPEND)
  @HttpCode(200)
  @Post('users/:id/unsuspend')
  unsuspend(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.admin.unsuspend(a, id);
  }

  @RequirePermissions(Permission.ROLE_ASSIGN)
  @HttpCode(200)
  @Post('users/:id/roles/grant')
  grant(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RoleDto,
  ) {
    return this.admin.grantRole(a, id, dto.role);
  }

  @RequirePermissions(Permission.ROLE_ASSIGN)
  @HttpCode(200)
  @Post('users/:id/roles/revoke')
  revoke(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RoleDto,
  ) {
    return this.admin.revokeRole(a, id, dto.role);
  }

  @RequirePermissions(Permission.SELLER_VERIFY)
  @Get('sellers/applications')
  sellerApplications() {
    return this.admin.sellerApplications();
  }

  @RequirePermissions(Permission.SELLER_VERIFY)
  @HttpCode(200)
  @Post('sellers/:userId/decision')
  decideSeller(
    @CurrentUser() a: AuthContext,
    @Param('userId', ParseUUIDPipe) id: string,
    @Body() dto: SellerDecisionDto,
  ) {
    return this.admin.decideSeller(a, id, dto);
  }

  @RequirePermissions(Permission.AUDIT_READ)
  @Get('audit-logs')
  auditLogs(@Query() q: AuditQuery) {
    return this.admin.auditLogs(q);
  }

  @RequirePermissions(Permission.REPORT_HANDLE)
  @Get('reports')
  reports(@Query('status') status?: ReportStatus) {
    return this.insights.reports(
      status && Object.values(ReportStatus).includes(status)
        ? status
        : undefined,
    );
  }

  @RequirePermissions(Permission.REPORT_HANDLE)
  @HttpCode(200)
  @Post('reports/:id/decision')
  decideReport(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportDecisionDto,
    @Req() req: Request,
  ) {
    return this.admin.decideReport(a, id, dto, requestMeta(req));
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [AdminController],
  providers: [AdminService, AdminInsightsService],
  exports: [AdminInsightsService],
})
export class AdminModule {}
