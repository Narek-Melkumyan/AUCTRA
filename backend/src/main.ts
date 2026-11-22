import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { configureApp } from './bootstrap.js';

// A server must not die because a background promise rejected; log it loudly instead.
process.on('unhandledRejection', (reason) => {
  Logger.error(
    `Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    'Process',
  );
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    // Structured JSON logs in production; readable colour logs in development.
    logger: new ConsoleLogger({
      json: process.env['NODE_ENV'] === 'production',
      logLevels:
        process.env['NODE_ENV'] === 'production'
          ? ['log', 'warn', 'error', 'fatal']
          : ['log', 'warn', 'error', 'fatal', 'debug'],
    }),
  });
  await configureApp(app);
  const config = app.get(AppConfig);
  await app.listen(config.port);
  Logger.log(
    `AUCTRA API: http://localhost:${config.port}/api (${config.nodeEnv})`,
    'Bootstrap',
  );
  Logger.log(describeMediaStorage(config), 'Bootstrap');
}

/** One line naming the active image storage — never credentials. */
function describeMediaStorage(c: AppConfig): string {
  const ns = c.mediaKeyPrefix ? `, key prefix "${c.mediaKeyPrefix}/"` : '';
  switch (c.mediaStorage) {
    case 'r2':
      return `Media storage: Cloudflare R2 (bucket "${c.r2!.bucket}", public ${c.r2!.publicBaseUrl}${ns})`;
    case 'local':
      return `Media storage: local disk ${c.mediaLocalDir} (development only${ns})`;
    default:
      return 'Media storage: disabled — image uploads return 503 MEDIA_STORAGE_NOT_CONFIGURED';
  }
}

void bootstrap();
