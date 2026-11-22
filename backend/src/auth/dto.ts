import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** 10–128 chars. Length beats composition rules (NIST SP 800-63B). */
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

export class RegisterDto {
  @Transform(trimLower)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN, {
    message: `Password must be at least ${PASSWORD_MIN} characters.`,
  })
  @MaxLength(PASSWORD_MAX)
  password!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 80)
  @Matches(/^[^<>]*$/, { message: 'Display name contains invalid characters.' })
  displayName!: string;
}

export class LoginDto {
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX)
  password!: string;
}

export class EmailDto {
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class TokenDto {
  @IsString()
  @Length(20, 200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  token!: string;
}

export class ResetPasswordDto extends TokenDto {
  @IsString()
  @MinLength(PASSWORD_MIN, {
    message: `Password must be at least ${PASSWORD_MIN} characters.`,
  })
  @MaxLength(PASSWORD_MAX)
  newPassword!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(PASSWORD_MAX)
  currentPassword!: string;

  @IsString()
  @MinLength(PASSWORD_MIN, {
    message: `Password must be at least ${PASSWORD_MIN} characters.`,
  })
  @MaxLength(PASSWORD_MAX)
  newPassword!: string;
}

export class VerifyCodeDto {
  @Transform(trim)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from the email.' })
  code!: string;

  /** Only needed when not signed in. */
  @IsOptional()
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(320)
  email?: string;
}
