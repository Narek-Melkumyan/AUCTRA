import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { IsBoolean, IsDateString, IsOptional, IsUUID } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import { CurrentUser, RequirePermissions } from '../common/decorators.js';
import type { AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import { Permission } from '../roles/permissions.js';

class WatchDto {
  @IsOptional() @IsBoolean() notify?: boolean;
}

class ReminderDto {
  @IsUUID() auctionId!: string;
  @IsDateString({ strict: true }) remindAt!: string;
}

@Injectable()
export class EngagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auctions: AuctionsService,
  ) {}

  private async assertVisible(auth: AuthContext, auctionId: string) {
    const a = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      select: { sellerId: true, status: true, visibility: true },
    });
    if (!a || !this.auctions.canView(a, auth)) throw Errors.notFound('Auction');
  }

  async watchlist(auth: AuthContext) {
    const items = await this.prisma.watchlistItem.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return items.map((i) => ({
      auctionId: i.auctionId,
      notify: i.notify,
      createdAt: i.createdAt.toISOString(),
    }));
  }

  async watch(auth: AuthContext, auctionId: string, notify = true) {
    await this.assertVisible(auth, auctionId);
    await this.prisma.watchlistItem.upsert({
      where: { userId_auctionId: { userId: auth.userId, auctionId } },
      create: { userId: auth.userId, auctionId, notify },
      update: { notify },
    });
    return { auctionId, watching: true, notify };
  }

  async unwatch(auth: AuthContext, auctionId: string) {
    await this.prisma.watchlistItem.deleteMany({
      where: { userId: auth.userId, auctionId },
    });
  }

  async favorites(auth: AuthContext) {
    const items = await this.prisma.favorite.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return items.map((i) => ({
      auctionId: i.auctionId,
      createdAt: i.createdAt.toISOString(),
    }));
  }

  async favorite(auth: AuthContext, auctionId: string) {
    await this.assertVisible(auth, auctionId);
    await this.prisma.favorite.upsert({
      where: { userId_auctionId: { userId: auth.userId, auctionId } },
      create: { userId: auth.userId, auctionId },
      update: {},
    });
    return { auctionId, favorite: true };
  }

  async unfavorite(auth: AuthContext, auctionId: string) {
    await this.prisma.favorite.deleteMany({
      where: { userId: auth.userId, auctionId },
    });
  }

  async reminders(auth: AuthContext) {
    return this.prisma.auctionReminder.findMany({
      where: { userId: auth.userId, sentAt: null },
      orderBy: { remindAt: 'asc' },
    });
  }

  async addReminder(auth: AuthContext, dto: ReminderDto) {
    await this.assertVisible(auth, dto.auctionId);
    const remindAt = new Date(dto.remindAt);
    const a = await this.prisma.auction.findUniqueOrThrow({
      where: { id: dto.auctionId },
      select: { endsAt: true },
    });
    if (remindAt <= new Date() || remindAt >= a.endsAt) {
      throw Errors.unprocessable(
        'INVALID_REMINDER',
        'Reminders must be in the future and before the auction ends.',
      );
    }
    const count = await this.prisma.auctionReminder.count({
      where: { userId: auth.userId, sentAt: null },
    });
    if (count >= 100)
      throw Errors.unprocessable(
        'REMINDER_LIMIT',
        'You have too many pending reminders.',
      );
    return this.prisma.auctionReminder.upsert({
      where: {
        userId_auctionId_remindAt: {
          userId: auth.userId,
          auctionId: dto.auctionId,
          remindAt,
        },
      },
      create: { userId: auth.userId, auctionId: dto.auctionId, remindAt },
      update: {},
    });
  }

  async deleteReminder(auth: AuthContext, id: string) {
    const res = await this.prisma.auctionReminder.deleteMany({
      where: { id, userId: auth.userId },
    });
    if (!res.count) throw Errors.notFound('Reminder');
  }
}

@Controller('me')
@RequirePermissions(Permission.WATCHLIST_MANAGE)
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  @Get('watchlist') watchlist(@CurrentUser() a: AuthContext) {
    return this.engagement.watchlist(a);
  }
  @Put('watchlist/:auctionId') watch(
    @CurrentUser() a: AuthContext,
    @Param('auctionId', ParseUUIDPipe) id: string,
    @Body() dto: WatchDto,
  ) {
    return this.engagement.watch(a, id, dto.notify ?? true);
  }
  @HttpCode(204) @Delete('watchlist/:auctionId') unwatch(
    @CurrentUser() a: AuthContext,
    @Param('auctionId', ParseUUIDPipe) id: string,
  ) {
    return this.engagement.unwatch(a, id);
  }
  @Get('favorites') favorites(@CurrentUser() a: AuthContext) {
    return this.engagement.favorites(a);
  }
  @Put('favorites/:auctionId') favorite(
    @CurrentUser() a: AuthContext,
    @Param('auctionId', ParseUUIDPipe) id: string,
  ) {
    return this.engagement.favorite(a, id);
  }
  @HttpCode(204) @Delete('favorites/:auctionId') unfavorite(
    @CurrentUser() a: AuthContext,
    @Param('auctionId', ParseUUIDPipe) id: string,
  ) {
    return this.engagement.unfavorite(a, id);
  }
  @Get('reminders') reminders(@CurrentUser() a: AuthContext) {
    return this.engagement.reminders(a);
  }
  @Post('reminders') addReminder(
    @CurrentUser() a: AuthContext,
    @Body() dto: ReminderDto,
  ) {
    return this.engagement.addReminder(a, dto);
  }
  @HttpCode(204) @Delete('reminders/:id') deleteReminder(
    @CurrentUser() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.engagement.deleteReminder(a, id);
  }
}

@Module({ controllers: [EngagementController], providers: [EngagementService] })
export class EngagementModule {}
