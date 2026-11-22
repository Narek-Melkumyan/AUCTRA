import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '../../generated/prisma/client.js';
import { AppConfig } from '../../config/app-config.js';

type ErrorBody = {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
};

/**
 * Converts every error into `{ statusCode, code, message, details? }`.
 * Unknown errors are logged server-side and answered with a generic 500 so stack
 * traces, SQL and internal identifiers never reach clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly config: AppConfig) {}

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const body = this.toBody(exception, req);
    const requestId = (req as Request & { id?: string }).id;
    if (requestId) body.requestId = requestId;
    const retryMs = (body.details as { retryAfterMs?: number } | undefined)
      ?.retryAfterMs;
    if ((body.statusCode === 503 || body.statusCode === 429) && retryMs)
      res.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil(retryMs / 1000))),
      );
    if (body.statusCode >= 500) {
      this.logger.error(
        `${req.method} ${req.path} → ${body.statusCode} (request ${requestId ?? '-'})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    if (!res.headersSent) res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, req: Request): ErrorBody {
    if (exception instanceof ThrottlerException) {
      return {
        statusCode: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please slow down.',
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        const rawMessage = r['message'];
        // class-validator returns an array of messages.
        if (Array.isArray(rawMessage)) {
          return {
            statusCode: status,
            code: 'VALIDATION_FAILED',
            message: 'The request is invalid.',
            details: { errors: rawMessage },
          };
        }
        return {
          statusCode: status,
          code: typeof r['code'] === 'string' ? r['code'] : defaultCode(status),
          message:
            typeof rawMessage === 'string' ? rawMessage : exception.message,
          ...(r['details'] ? { details: r['details'] } : {}),
        };
      }
      return {
        statusCode: status,
        code: defaultCode(status),
        message: String(response),
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          statusCode: 409,
          code: 'CONFLICT',
          message: 'A record with these values already exists.',
        };
      }
      if (exception.code === 'P2025') {
        return {
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Resource not found.',
        };
      }
    }
    if (exception instanceof SyntaxError && 'body' in (exception as object)) {
      return {
        statusCode: 400,
        code: 'MALFORMED_JSON',
        message: 'Malformed JSON body.',
      };
    }
    void req;
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: this.config.isProduction
        ? 'Something went wrong. Please try again.'
        : `Internal error: ${exception instanceof Error ? exception.message : 'unknown'}`,
    };
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}
