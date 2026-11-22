import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain error with a stable machine-readable `code` the frontend can switch on,
 * plus a human-readable message that is always safe to show to end users.
 */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, ...(details ? { details } : {}) }, status);
  }
}

export const Errors = {
  notFound: (what = 'Resource') =>
    new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found.`),
  forbidden: (message = 'You do not have permission to perform this action.') =>
    new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message),
  forbiddenCode: (
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => new AppError(HttpStatus.FORBIDDEN, code, message, details),
  unauthorized: (message = 'Authentication required.', code = 'UNAUTHORIZED') =>
    new AppError(HttpStatus.UNAUTHORIZED, code, message),
  conflict: (
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => new AppError(HttpStatus.CONFLICT, code, message, details),
  badRequest: (
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => new AppError(HttpStatus.BAD_REQUEST, code, message, details),
  unprocessable: (
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details),
  tooMany: (message = 'Too many requests. Please try again later.') =>
    new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', message),
  tooManyCode: (code: string, message: string) =>
    new AppError(HttpStatus.TOO_MANY_REQUESTS, code, message),
  unavailable: (code: string, message: string) =>
    new AppError(HttpStatus.SERVICE_UNAVAILABLE, code, message),
};
