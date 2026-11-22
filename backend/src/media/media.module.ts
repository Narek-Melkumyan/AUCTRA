import { Module } from '@nestjs/common';
import { AuctionImagesController } from './auction-images.controller.js';
import { AuctionImagesService } from './auction-images.service.js';
import { ImageUploadInterceptor } from './image-upload.interceptor.js';
import { MediaCleanupWorker } from './media-cleanup.worker.js';

@Module({
  controllers: [AuctionImagesController],
  providers: [AuctionImagesService, ImageUploadInterceptor, MediaCleanupWorker],
  exports: [AuctionImagesService, MediaCleanupWorker],
})
export class MediaModule {}
