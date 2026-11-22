import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { AddressType, SellerType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import {
  CurrentUser,
  Public,
  RequirePermissions,
} from '../common/decorators.js';
import type { AuthContext } from '../common/auth-context.js';
import { Errors } from '../common/errors.js';
import { SUPPORTED_CURRENCIES } from '../common/money.js';
import { Permission } from '../roles/permissions.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
import { PartialDto } from '../common/validation.js';

class UpdateProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  @Matches(/^[^<>]*$/)
  displayName?: string;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(/^[a-z0-9_.]{3,32}$/, {
    message: 'handle must be 3–32 characters: a–z, 0–9, _ or .',
  })
  handle?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) bio?: string;
  @IsOptional() @Matches(/^\+?[0-9 ()-]{0,32}$/) phone?: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string;
}

class UpdatePreferencesDto {
  @IsOptional() @Matches(/^[a-z]{2}(-[A-Z]{2})?$/) locale?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional()
  @IsIn(Object.keys(SUPPORTED_CURRENCIES))
  preferredCurrency?: string;
  @IsOptional() @IsBoolean() marketingOptIn?: boolean;
}

class AddressDto {
  @IsEnum(AddressType) type!: AddressType;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) label?: string;
  @Transform(trim) @IsString() @Length(1, 120) fullName!: string;
  @Transform(trim) @IsString() @Length(1, 200) line1!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) line2?: string;
  @Transform(trim) @IsString() @Length(1, 100) city!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) region?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(20) postalCode?: string;
  @Matches(/^[A-Z]{2}$/) country!: string;
  @IsOptional() @Matches(/^\+?[0-9 ()-]{0,32}$/) phone?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

@PartialDto()
class UpdateAddressDto extends AddressDto {}

class SellerApplicationDto {
  @IsEnum(SellerType) type!: SellerType;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  businessName?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (dto.handle) {
      const taken = await this.prisma.userProfile.findFirst({
        where: { handle: dto.handle, userId: { not: userId } },
      });
      if (taken)
        throw Errors.conflict('HANDLE_TAKEN', 'That handle is already taken.');
    }
    await this.prisma.userProfile.update({ where: { userId }, data: dto });
    return this.auth.me(userId);
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    await this.prisma.userPreference.upsert({
      where: { userId },
      create: { userId, ...dto },
      update: dto,
    });
    return this.auth.me(userId);
  }

  listAddresses(userId: string) {
    return this.prisma.userAddress.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createAddress(userId: string, dto: AddressDto) {
    const count = await this.prisma.userAddress.count({ where: { userId } });
    if (count >= 20)
      throw Errors.unprocessable(
        'ADDRESS_LIMIT',
        'You can save up to 20 addresses.',
      );
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault)
        await tx.userAddress.updateMany({
          where: { userId, type: dto.type, isDefault: true },
          data: { isDefault: false },
        });
      return tx.userAddress.create({ data: { ...dto, userId } });
    });
  }

  async updateAddress(userId: string, id: string, dto: Partial<AddressDto>) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.userAddress.findFirst({
        where: { id, userId },
      });
      if (!existing) throw Errors.notFound('Address');
      const type = dto.type ?? existing.type;
      // A default address moved to another type stays the default there, so the old
      // default of that type must give way (one default per user and type).
      if (dto.isDefault ?? (existing.isDefault && type !== existing.type))
        await tx.userAddress.updateMany({
          where: { userId, type, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      return tx.userAddress.update({ where: { id }, data: dto });
    });
  }

  async deleteAddress(userId: string, id: string) {
    const res = await this.prisma.userAddress.deleteMany({
      where: { id, userId },
    });
    if (!res.count) throw Errors.notFound('Address');
  }

  async publicProfile(handle: string) {
    const p = await this.prisma.userProfile.findUnique({
      where: { handle: handle.toLowerCase() },
      include: {
        user: {
          select: {
            createdAt: true,
            status: true,
            deletedAt: true,
            sellerProfile: {
              select: {
                type: true,
                businessName: true,
                verificationStatus: true,
              },
            },
          },
        },
      },
    });
    if (!p || p.user.deletedAt || p.user.status === 'BANNED')
      throw Errors.notFound('User');
    return {
      handle: p.handle,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl,
      bio: p.bio,
      memberSince: p.user.createdAt.toISOString(),
      seller: p.user.sellerProfile
        ? {
            type: p.user.sellerProfile.type,
            businessName: p.user.sellerProfile.businessName,
            verified: p.user.sellerProfile.verificationStatus === 'VERIFIED',
          }
        : null,
    };
  }

  async applyAsSeller(auth: AuthContext, dto: SellerApplicationDto) {
    if (!auth.emailVerified)
      throw Errors.forbidden(
        'Verify your email address before applying to sell.',
      );
    if (dto.type !== 'PRIVATE' && !dto.businessName) {
      throw Errors.unprocessable(
        'BUSINESS_NAME_REQUIRED',
        'Dealers and businesses must provide a business name.',
      );
    }
    const existing = await this.prisma.sellerProfile.findUnique({
      where: { userId: auth.userId },
    });
    if (existing?.verificationStatus === 'VERIFIED')
      throw Errors.conflict(
        'ALREADY_SELLER',
        'You are already a verified seller.',
      );
    if (existing?.verificationStatus === 'PENDING')
      throw Errors.conflict(
        'APPLICATION_PENDING',
        'Your application is already under review.',
      );
    const data = {
      type: dto.type,
      businessName: dto.businessName ?? null,
      description: dto.description ?? null,
      verificationStatus: 'PENDING' as const,
      rejectionReason: null,
    };
    await this.prisma.sellerProfile.upsert({
      where: { userId: auth.userId },
      create: { userId: auth.userId, ...data },
      update: data,
    });
    await this.audit.recordSafe({
      actorId: auth.userId,
      action: 'seller.apply',
      entityType: 'user',
      entityId: auth.userId,
    });
    return this.auth.me(auth.userId);
  }
}

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Patch('me/profile')
  updateProfile(
    @CurrentUser() auth: AuthContext,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.users.updateProfile(auth.userId, dto);
  }

  @Patch('me/preferences')
  updatePreferences(
    @CurrentUser() auth: AuthContext,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.users.updatePreferences(auth.userId, dto);
  }

  @Get('me/addresses')
  addresses(@CurrentUser() auth: AuthContext) {
    return this.users.listAddresses(auth.userId);
  }

  @Post('me/addresses')
  createAddress(@CurrentUser() auth: AuthContext, @Body() dto: AddressDto) {
    return this.users.createAddress(auth.userId, dto);
  }

  @Patch('me/addresses/:id')
  updateAddress(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.users.updateAddress(auth.userId, id, dto);
  }

  @HttpCode(204)
  @Delete('me/addresses/:id')
  deleteAddress(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.users.deleteAddress(auth.userId, id);
  }

  @RequirePermissions(Permission.SELLER_APPLY)
  @Post('me/seller-application')
  apply(@CurrentUser() auth: AuthContext, @Body() dto: SellerApplicationDto) {
    return this.users.applyAsSeller(auth, dto);
  }

  @Public()
  @Get('users/:handle')
  publicProfile(@Param('handle') handle: string) {
    return this.users.publicProfile(handle);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
