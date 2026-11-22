import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type { Request } from 'express';
import { CurrentUser, OptionalUser, Public } from '../common/decorators.js';
import type { AuthContext } from '../common/auth-context.js';
import {
  AuctionImagesService,
  type UploadedFile,
} from './auction-images.service.js';
import { ImageUploadInterceptor } from './image-upload.interceptor.js';

export class ReorderImagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  imageIds!: string[];
}

/** Text fields sent alongside the files in the multipart body. */
export class UploadFieldsDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(300)
  altText?: string;
}

const files = (req: Request) =>
  ((req as Request & { files?: UploadedFile[] }).files ?? []) as UploadedFile[];

/**
 * Listing images. Writes are allowed for the listing owner (drafts only) and for
 * moderators; ownership is checked before an upload body is read.
 */
@Controller('auctions/:id/images')
export class AuctionImagesController {
  constructor(private readonly images: AuctionImagesService) {}

  @Public()
  @Get()
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @OptionalUser() auth?: AuthContext,
  ) {
    return this.images.list(id, auth);
  }

  /** multipart/form-data: up to 6 files in "images", optional "altText". */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(ImageUploadInterceptor)
  @Post()
  upload(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body() body: UploadFieldsDto,
  ) {
    return this.images.upload(auth, id, files(req), body.altText);
  }

  /** Replaces one image (multipart, one file in "images"); the old one is kept if this fails. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(ImageUploadInterceptor)
  @Post(':imageId/replace')
  replace(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Req() req: Request,
  ) {
    const list = files(req);
    if (list.length > 1) list.length = 1;
    return this.images.replace(auth, id, imageId, list[0]);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Patch('reorder')
  reorder(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderImagesDto,
  ) {
    return this.images.reorder(auth, id, dto.imageIds);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Patch(':imageId/primary')
  setPrimary(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ) {
    return this.images.setPrimary(auth, id, imageId);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Delete(':imageId')
  remove(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ) {
    return this.images.remove(auth, id, imageId);
  }
}
