import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  OptionalUser,
  Public,
  RequirePermissions,
} from '../common/decorators.js';
import type { AuthContext } from '../common/auth-context.js';
import { Permission } from '../roles/permissions.js';
import { AuctionsService } from './auctions.service.js';
import {
  CreateAuctionDto,
  ListAuctionsQueryDto,
  ReasonDto,
  UpdateAuctionDto,
} from './dto.js';

@Controller()
export class AuctionsController {
  constructor(private readonly auctions: AuctionsService) {}

  @Public()
  @Get('auctions')
  list(
    @Query() query: ListAuctionsQueryDto,
    @OptionalUser() auth?: AuthContext,
  ) {
    return this.auctions.list(query, auth);
  }

  @Public()
  @Get('auctions/:id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @OptionalUser() auth?: AuthContext,
  ) {
    return this.auctions.get(id, auth);
  }

  @Public()
  @Get('auctions/:id/history')
  history(
    @Param('id', ParseUUIDPipe) id: string,
    @OptionalUser() auth?: AuthContext,
  ) {
    return this.auctions.history(id, auth);
  }

  @RequirePermissions(Permission.AUCTION_CREATE)
  @Post('auctions')
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateAuctionDto) {
    return this.auctions.create(auth, dto);
  }

  @RequirePermissions(Permission.AUCTION_MANAGE_OWN)
  @Patch('auctions/:id')
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAuctionDto,
  ) {
    return this.auctions.update(auth, id, dto);
  }

  @RequirePermissions(Permission.AUCTION_MANAGE_OWN)
  @HttpCode(200)
  @Post('auctions/:id/submit')
  submit(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.auctions.submit(auth, id);
  }

  @RequirePermissions(Permission.AUCTION_MANAGE_OWN)
  @HttpCode(200)
  @Post('auctions/:id/withdraw')
  withdraw(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.auctions.withdraw(auth, id);
  }

  /** Owner (rules apply) or moderator. Ownership is checked in the service. */
  @HttpCode(200)
  @Post('auctions/:id/cancel')
  cancel(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.auctions.cancel(auth, id, dto.reason);
  }

  @RequirePermissions(Permission.AUCTION_MANAGE_OWN)
  @Get('me/auctions')
  mine(@CurrentUser() auth: AuthContext) {
    return this.auctions.listMine(auth);
  }
}
