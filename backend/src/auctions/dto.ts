import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AuctionVisibility,
  FulfillmentMethod,
  ItemCondition,
  MediaType,
} from '../generated/prisma/enums.js';
import { MINOR_AMOUNT_PATTERN, SUPPORTED_CURRENCIES } from '../common/money.js';
import { PartialDto } from '../common/validation.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const MINOR_MSG =
  'must be a whole number of minor currency units, sent as a string (e.g. "1250000" for 12,500.00)';

/** Public URLs (https) or bundled demo assets (asset://name). Binary uploads go to object storage, not the DB. */
const MEDIA_URL = /^(https:\/\/[^\s<>"']{1,2040}|asset:\/\/[a-z0-9-]{1,40})$/;

export class MediaInputDto {
  @Matches(MEDIA_URL, { message: 'media url must be an https:// URL' })
  url!: string;

  @IsOptional()
  @IsEnum(MediaType)
  type?: MediaType;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  altText?: string;
}

export class AttributeInputDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,59}$/)
  key!: string;

  /** Validated against the attribute's declared type in the service. */
  @IsOptional()
  value!: string | number | boolean | null;
}

export class AntiSnipingDto {
  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  @Min(1)
  @Max(3600)
  windowSec!: number;

  @IsInt()
  @Min(1)
  @Max(3600)
  extensionSec!: number;
}

export class VehicleDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-HJ-NPR-Z0-9]{17}$/, {
    message: 'vin must be a 17-character VIN',
  })
  vin?: string;

  @Transform(trim) @IsString() @Length(1, 60) make!: string;
  @Transform(trim) @IsString() @Length(1, 80) model!: string;
  @IsInt() @Min(1885) @Max(2100) year!: number;
  @IsOptional() @IsInt() @Min(0) @Max(5_000_000) mileageKm?: number;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  transmission?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) fuelType?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  exteriorColor?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) bodyStyle?: string;
}

export class WatchDto {
  @Transform(trim) @IsString() @Length(1, 60) brand!: string;
  @Transform(trim) @IsString() @Length(1, 80) model!: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  referenceNumber?: string;
  @IsOptional() @IsInt() @Min(1700) @Max(2100) year?: number;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  caseMaterial?: string;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(100)
  caseDiameterMm?: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) movement?: string;
  @IsOptional() @IsBoolean() hasBox?: boolean;
  @IsOptional() @IsBoolean() hasPapers?: boolean;
}

/**
 * Fields a seller controls. Status, current price, bid count, winner and seller are
 * deliberately absent: they can only change through the lifecycle/bidding services.
 * (The global ValidationPipe strips unknown properties and rejects them.)
 */
export class CreateAuctionDto {
  @Transform(trim) @IsString() @Length(5, 200) title!: string;
  @Transform(trim) @IsString() @Length(20, 20000) description!: string;
  @IsString() @Matches(/^[a-z0-9-]{1,80}$/) categorySlug!: string;
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{1,80}$/)
  subcategorySlug?: string;
  @IsEnum(ItemCondition) condition!: ItemCondition;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  conditionNotes?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  locationCity?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  locationRegion?: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/) locationCountry?: string;
  @IsIn(Object.keys(SUPPORTED_CURRENCIES)) currency!: string;

  @Matches(MINOR_AMOUNT_PATTERN, { message: `startingPriceMinor ${MINOR_MSG}` })
  startingPriceMinor!: string;
  @Matches(MINOR_AMOUNT_PATTERN, { message: `minIncrementMinor ${MINOR_MSG}` })
  minIncrementMinor!: string;
  @IsOptional()
  @Matches(MINOR_AMOUNT_PATTERN, { message: `reservePriceMinor ${MINOR_MSG}` })
  reservePriceMinor?: string;
  @IsOptional()
  @Matches(MINOR_AMOUNT_PATTERN, { message: `buyNowPriceMinor ${MINOR_MSG}` })
  buyNowPriceMinor?: string;

  @IsDateString({ strict: true }) startsAt!: string;
  @IsDateString({ strict: true }) endsAt!: string;

  @IsOptional() @IsEnum(AuctionVisibility) visibility?: AuctionVisibility;
  @IsOptional()
  @ValidateNested()
  @Type(() => AntiSnipingDto)
  antiSniping?: AntiSnipingDto;
  @IsOptional()
  @IsEnum(FulfillmentMethod)
  fulfillmentMethod?: FulfillmentMethod;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  shippingNotes?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  inspectionNotes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => MediaInputDto)
  media?: MediaInputDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AttributeInputDto)
  attributes?: AttributeInputDto[];

  @IsOptional() @ValidateNested() @Type(() => VehicleDto) vehicle?: VehicleDto;
  @IsOptional() @ValidateNested() @Type(() => WatchDto) watch?: WatchDto;
}

/** Same rules; fields that are omitted stay unchanged. */
@PartialDto()
export class UpdateAuctionDto extends CreateAuctionDto {}

export class ListAuctionsQueryDto {
  @IsOptional() @IsIn(['live', 'upcoming', 'ended', 'all']) phase?:
    'live' | 'upcoming' | 'ended' | 'all';
  /** One slug, or several comma-separated slugs (category or subcategory). */
  @IsOptional()
  @Matches(/^[a-z0-9-]{1,80}(,[a-z0-9-]{1,80}){0,19}$/)
  category?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  /** Current (or starting) price bounds in major units of the lot's currency. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  minPrice?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  maxPrice?: number;
  /** Comma-separated ItemCondition values, e.g. NEW,EXCELLENT. */
  @IsOptional()
  @Matches(
    /^(NEW|EXCELLENT|VERY_GOOD|GOOD|FAIR|POOR)(,(NEW|EXCELLENT|VERY_GOOD|GOOD|FAIR|POOR)){0,5}$/,
  )
  condition?: string;
  @IsOptional() @IsIn(['PRIVATE', 'DEALER', 'BUSINESS']) sellerType?:
    'PRIVATE' | 'DEALER' | 'BUSINESS';
  @IsOptional() @IsIn(['none', 'met', 'not_met']) reserve?:
    'none' | 'met' | 'not_met';
  /** Public handle of the seller (seller profile pages). */
  @IsOptional() @Matches(/^[a-z0-9_]{2,32}$/i) seller?: string;
  @IsOptional()
  @IsIn([
    'ending_soon',
    'recently_ended',
    'newest',
    'price_asc',
    'price_desc',
    'most_bids',
  ])
  sort?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page?: number;
}

export class ReasonDto {
  @Transform(trim) @IsString() @Length(3, 500) reason!: string;
}
