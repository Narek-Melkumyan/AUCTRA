import {
  HttpStatus,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import type { Observable } from 'rxjs';
import { AppConfig } from '../config/app-config.js';
import { AppError, Errors } from '../common/errors.js';
import type { AuthedRequest } from '../common/auth-context.js';
import { StorageService } from '../storage/storage.service.js';
import { AuctionImagesService } from './auction-images.service.js';

/** Files accepted per request (each still goes through the bounded processing queue). */
export const MAX_FILES_PER_REQUEST = 6;
export const UPLOAD_FIELD = 'images';

/**
 * Parses multipart uploads into memory — but only after the caller has been authorised
 * for this auction, so strangers cannot make the server buffer large bodies. Limits are
 * enforced while streaming (multer/busboy), before any image decoding happens.
 */
@Injectable()
export class ImageUploadInterceptor implements NestInterceptor {
  private readonly parse: ReturnType<ReturnType<typeof multer>['array']>;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: StorageService,
    private readonly images: AuctionImagesService,
  ) {
    this.parse = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: config.mediaMaxUploadBytes,
        files: MAX_FILES_PER_REQUEST,
        fields: 4,
        fieldSize: 2048,
        parts: MAX_FILES_PER_REQUEST + 4,
        headerPairs: 50,
      },
    }).array(UPLOAD_FIELD, MAX_FILES_PER_REQUEST);
  }

  async intercept(
    ctx: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request & AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    if (!this.storage.enabled)
      throw Errors.unavailable(
        'MEDIA_STORAGE_NOT_CONFIGURED',
        'Image uploads are not configured on this server.',
      );
    await this.images.assertCanManage(req.auth!, String(req.params['id']));
    if (!req.is('multipart/form-data'))
      throw new AppError(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'MULTIPART_REQUIRED',
        `Send images as multipart/form-data in the "${UPLOAD_FIELD}" field.`,
      );
    const declared = Number(req.headers['content-length'] ?? 0);
    const ceiling =
      this.config.mediaMaxUploadBytes * MAX_FILES_PER_REQUEST + 64 * 1024;
    if (declared > ceiling) throw tooLarge(this.config.mediaMaxUploadBytes);

    await new Promise<void>((resolve, reject) =>
      this.parse(req, res, (err: unknown) =>
        err ? reject(this.mapError(err)) : resolve(),
      ),
    );
    return next.handle();
  }

  private mapError(err: unknown): Error {
    if (err instanceof MulterError) {
      switch (err.code) {
        case 'LIMIT_FILE_SIZE':
          return tooLarge(this.config.mediaMaxUploadBytes);
        case 'LIMIT_FILE_COUNT':
          return Errors.badRequest(
            'TOO_MANY_FILES',
            `Upload at most ${MAX_FILES_PER_REQUEST} images at a time.`,
          );
        case 'LIMIT_UNEXPECTED_FILE':
          return Errors.badRequest(
            'UNEXPECTED_FILE_FIELD',
            `Send images in the "${UPLOAD_FIELD}" field.`,
          );
        default:
          return Errors.badRequest(
            'INVALID_UPLOAD',
            'The upload could not be read.',
          );
      }
    }
    return Errors.badRequest('INVALID_UPLOAD', 'The upload could not be read.');
  }
}

function tooLarge(maxBytes: number) {
  return new AppError(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'IMAGE_TOO_LARGE',
    `Images must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`,
  );
}
