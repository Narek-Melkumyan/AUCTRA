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
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AppConfig } from '../config/app-config.js';
import {
  CurrentUser,
  OptionalUser,
  Public,
  RequirePermissions,
} from '../common/decorators.js';
import type { AuthContext } from '../common/auth-context.js';
import { AppError } from '../common/errors.js';
import { Permission } from '../roles/permissions.js';
import { AdminModule } from '../admin/admin.module.js';
import { LLM_CLIENT, OpenAiLlmClient, type LlmClient } from './llm.client.js';
import { AiToolsService, type AiScopeKey } from './ai-tools.js';
import { AiService, type AiEvent } from './ai.service.js';

const SCOPES = ['user', 'admin'] as const;
const toScope = (s: string | undefined): AiScopeKey =>
  s === 'admin' ? 'ADMIN' : 'USER';

class ChatDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  // Hard cap at the HTTP layer; the service enforces AI_MAX_INPUT_CHARS.
  @MaxLength(20_000)
  message!: string;

  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsUUID() auctionId?: string;
}

class ScopeQuery {
  @IsOptional() @IsIn(SCOPES) scope?: (typeof SCOPES)[number];
}

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Whether the assistant is configured, and the caller's remaining daily budget. */
  @Public()
  @Get('status')
  status(@Query() q: ScopeQuery, @OptionalUser() auth?: AuthContext) {
    return this.ai.status(auth, toScope(q.scope));
  }

  @Get('conversations')
  list(@Query() q: ScopeQuery, @CurrentUser() auth: AuthContext) {
    return this.ai.conversations(auth, toScope(q.scope));
  }

  @Get('conversations/:id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() auth: AuthContext,
  ) {
    return this.ai.conversation(auth, id);
  }

  @HttpCode(204)
  @Delete('conversations/:id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() auth: AuthContext,
  ) {
    return this.ai.deleteConversation(auth, id);
  }

  /** Streams one assistant turn as Server-Sent Events (meta, tool, delta, done | error). */
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Post('chat')
  async chat(
    @Query() q: ScopeQuery,
    @Body() dto: ChatDto,
    @CurrentUser() auth: AuthContext,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const scope = toScope(q.scope);
    const abort = new AbortController();
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    };
    const emit = (e: AiEvent) => {
      start();
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      await this.ai.chat(auth, scope, dto, emit, abort.signal);
    } catch (err) {
      // Errors before the stream starts are ordinary JSON errors (status codes intact).
      if (!started) {
        if (err instanceof AppError) {
          res.status(err.getStatus()).json({
            statusCode: err.getStatus(),
            ...(err.getResponse() as object),
          });
          return;
        }
        throw err;
      }
      emit({
        type: 'error',
        code: 'AI_ERROR',
        message: 'The assistant stopped unexpectedly.',
      });
    }
    res.end();
  }

  @RequirePermissions(Permission.AI_ADMIN)
  @Get('usage')
  usage(@Query('days') days?: string) {
    return this.ai.usageReport(Number(days) || 30);
  }
}

@Module({
  imports: [AdminModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiToolsService,
    {
      provide: LLM_CLIENT,
      inject: [AppConfig],
      useFactory: (config: AppConfig): LlmClient | null =>
        config.openaiApiKey
          ? new OpenAiLlmClient(config.openaiApiKey, config.openaiModel)
          : null,
    },
  ],
  exports: [AiService],
})
export class AiModule {}
