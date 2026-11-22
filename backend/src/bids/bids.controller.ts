import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import type { Request, Response } from 'express';
import {
  CurrentUser,
  OptionalUser,
  Public,
  RequirePermissions,
} from '../common/decorators.js';
import type { AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import {
  MINOR_AMOUNT_PATTERN,
  parseMinor,
  SUPPORTED_CURRENCIES,
} from '../common/money.js';
import { Permission } from '../roles/permissions.js';
import { BidsService } from './bids.service.js';

export class PlaceBidDto {
  @Matches(MINOR_AMOUNT_PATTERN, {
    message:
      'amountMinor must be a whole number of minor units, sent as a string',
  })
  amountMinor!: string;

  @IsOptional()
  @IsIn(Object.keys(SUPPORTED_CURRENCIES))
  currency?: string;
}

export class BidHistoryQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2) beforeSequence?: number;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{8,100}$/;

@Controller()
export class BidsController {
  constructor(private readonly bids: BidsService) {}

  /**
   * Place a bid. Requires an `Idempotency-Key` header (e.g. a UUID generated per click):
   * retrying with the same key returns the original result instead of bidding twice.
   * 201 = new bid accepted, 200 = replay of an earlier identical request.
   */
  @RequirePermissions(Permission.BID_PLACE)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('auctions/:id/bids')
  async place(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) auctionId: string,
    @Body() dto: PlaceBidDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw Errors.badRequest(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header (8–100 characters) with every bid.',
      );
    }
    const amount = parseMinor(dto.amountMinor);
    if (amount <= 0n)
      throw Errors.unprocessable(
        'BID_TOO_LOW',
        'Bid amount must be greater than zero.',
      );
    const result = await this.bids.placeBid(auth, {
      auctionId,
      amount,
      idempotencyKey,
      currency: dto.currency,
      ip: req.ip,
    });
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  @Public()
  @Get('auctions/:id/bids')
  history(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: BidHistoryQuery,
    @OptionalUser() auth?: AuthContext,
  ) {
    return this.bids.history(id, auth, q);
  }

  @Get('me/bids')
  mine(@CurrentUser() auth: AuthContext) {
    return this.bids.mine(auth);
  }
}
