import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppConfig } from './config/app-config.js';
import { AuctraIoAdapter } from './realtime/io.adapter.js';
import { AppValidationPipe } from './common/validation.js';
import { requestContext } from './common/request-context.js';
import { MetricsService } from './metrics/metrics.service.js';
import { STORAGE_DRIVER, type StorageDriver } from './storage/storage.types.js';
import { LocalStorageDriver } from './storage/local-storage.driver.js';

/**
 * HTTP/WebSocket hardening shared by main.ts and the integration tests, so tests run
 * against the same pipeline as production.
 */
export async function configureApp(app: INestApplication): Promise<void> {
  const config = app.get(AppConfig);
  const express = app as NestExpressApplication;

  express.set('trust proxy', config.trustProxy);
  express.disable('x-powered-by');
  express.useBodyParser('json', { limit: '256kb' });
  app.use(
    requestContext(app.get(MetricsService), process.env['LOG_HTTP'] === 'true'),
  );

  app.use(
    helmet({
      // JSON API: no HTML is served, so lock CSP down completely.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
    }),
  );
  // Development-only disk storage (MEDIA_STORAGE=local): serve the stored WebP variants.
  // In production images are served by Cloudflare R2 (public bucket URL / custom domain).
  const driver = app.get<StorageDriver | null>(STORAGE_DRIVER, {
    strict: false,
  });
  if (driver instanceof LocalStorageDriver) {
    express.useStaticAssets(driver.root, {
      prefix: '/media/',
      index: false,
      dotfiles: 'deny',
      fallthrough: false,
      immutable: true,
      maxAge: '365d',
      setHeaders: (res) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    });
  }
  app.use(cookieParser());
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-CSRF-Token',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new AppValidationPipe());
  app.enableShutdownHooks();

  const io = new AuctraIoAdapter(app);
  await io.connectRedis();
  app.useWebSocketAdapter(io);
}
