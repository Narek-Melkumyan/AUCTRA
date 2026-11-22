import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { MetricsService } from '../metrics/metrics.service.js';
import type { AuthedRequest } from './auth-context.js';

const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;
const SLOW_MS = 1_000;

export type RequestWithId = Request & { id?: string };

/**
 * Correlation IDs + access logging + HTTP metrics.
 *  - Accepts a well-formed incoming `X-Request-Id` (from a load balancer) or creates
 *    one; echoes it in the response and in error bodies.
 *  - Logs one structured line per request when LOG_HTTP=true, and always for 5xx and
 *    slow requests. Only method, route and status are logged — never query strings,
 *    bodies, cookies or Authorization headers.
 */
export function requestContext(metrics: MetricsService, logAll: boolean) {
  const logger = new Logger('HTTP');
  return (req: RequestWithId, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const t0 = performance.now();
    res.on('finish', () => {
      const ms = performance.now() - t0;
      const route = req.route
        ? `${req.baseUrl ?? ''}${(req.route as { path: string }).path}`
        : 'unmatched';
      metrics.http(req.method, route, res.statusCode, ms);
      if (logAll || res.statusCode >= 500 || ms > SLOW_MS) {
        const line = JSON.stringify({
          requestId: id,
          method: req.method,
          route,
          status: res.statusCode,
          ms: Math.round(ms),
          userId: (req as AuthedRequest).auth?.userId,
        });
        if (res.statusCode >= 500) logger.error(line);
        else if (ms > SLOW_MS) logger.warn(line);
        else logger.log(line);
      }
    });
    next();
  };
}
