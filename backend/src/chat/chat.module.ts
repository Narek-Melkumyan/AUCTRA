import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request, Response } from 'express';
import {
  ChatMessageStatus,
  ChatRestrictionType,
} from '../generated/prisma/enums.js';
import {
  CurrentUser,
  OptionalUser,
  Public,
  RequirePermissions,
} from '../common/decorators.js';
import { requestMeta, type AuthContext } from '../common/auth-context.js';
import { Permission } from '../roles/permissions.js';
import { CHAT_MAX_LENGTH, ChatService } from './chat.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1';

class SendChatDto {
  @IsString()
  // Generous raw limit; the service enforces CHAT_MAX_LENGTH after sanitising.
  @MaxLength(CHAT_MAX_LENGTH * 2)
  body!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  clientMessageId?: string;
}

class ChatPageQuery {
  @IsOptional() @Matches(/^\d{1,19}$/) before?: string;
  @IsOptional() @Matches(/^\d{1,19}$/) after?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

class ReportChatDto {
  @Transform(trim) @IsString() @Length(3, 100) reason!: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 1000) details?: string;
}

class ModerateDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 500) reason?: string;
}

class RestrictDto {
  @IsUUID() userId!: string;
  @IsEnum(ChatRestrictionType) type!: ChatRestrictionType;
  /** MUTE only: 1 minute – 30 days. */
  @IsOptional() @IsInt() @Min(1) @Max(43_200) minutes?: number;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 500) reason?: string;
  @IsOptional() @IsBoolean() hideRecentMessages?: boolean;
}

class SearchQuery {
  @IsOptional() @IsUUID() auctionId?: string;
  @IsOptional() @IsUUID() authorId?: string;
  @IsOptional() @IsEnum(ChatMessageStatus) status?: ChatMessageStatus;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() reported?: boolean;
  @IsOptional() @Matches(/^\d{1,19}$/) before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

@Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** Recent history (default), older pages (`before`) or missed messages (`after`). */
  @Public()
  @Get('auctions/:id/chat')
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ChatPageQuery,
    @OptionalUser() auth?: AuthContext,
  ) {
    return this.chat.list(id, auth, q);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermissions(Permission.CHAT_SEND)
  @Post('auctions/:id/chat')
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendChatDto,
    @CurrentUser() auth: AuthContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.chat.send(id, auth, dto);
    if (r.replayed) res.status(200);
    return r.message;
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermissions(Permission.REPORT_CREATE)
  @HttpCode(201)
  @Post('chat/messages/:id/report')
  report(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportChatDto,
    @CurrentUser() auth: AuthContext,
  ) {
    return this.chat.report(id, auth, dto);
  }
}

@RequirePermissions(Permission.CHAT_MODERATE)
@Controller('admin/chat')
export class ChatModerationController {
  constructor(private readonly chat: ChatService) {}

  @Get('messages')
  search(@Query() q: SearchQuery, @CurrentUser() auth: AuthContext) {
    return this.chat.searchMessages(auth, q);
  }

  @HttpCode(200)
  @Post('messages/:id/hide')
  hide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateDto,
    @CurrentUser() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.chat.moderateMessage(
      id,
      auth,
      'hide',
      dto.reason,
      requestMeta(req),
    );
  }

  @HttpCode(200)
  @Post('messages/:id/delete')
  delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateDto,
    @CurrentUser() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.chat.moderateMessage(
      id,
      auth,
      'delete',
      dto.reason,
      requestMeta(req),
    );
  }

  @HttpCode(200)
  @Post('messages/:id/restore')
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateDto,
    @CurrentUser() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.chat.moderateMessage(
      id,
      auth,
      'restore',
      dto.reason,
      requestMeta(req),
    );
  }

  @Get('restrictions')
  restrictions(@Query('active') active?: string) {
    return this.chat.restrictions(active !== 'false');
  }

  @Post('restrictions')
  restrict(
    @Body() dto: RestrictDto,
    @CurrentUser() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.chat.restrict(auth, dto, requestMeta(req));
  }

  @HttpCode(200)
  @Delete('restrictions/:id')
  lift(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.chat.lift(auth, id, requestMeta(req));
  }

  @Get('moderation-log')
  log(@Query('limit') limit?: string) {
    return this.chat.moderationLog(Number(limit) || 100);
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [ChatController, ChatModerationController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
