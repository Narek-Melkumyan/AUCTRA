import { ValidationPipe } from '@nestjs/common';
import type { ValidatorOptions } from 'class-validator';

const PARTIAL_DTO = Symbol('auctra:partialDto');

/**
 * Marks a DTO used for PATCH: every rule still applies to fields that are present,
 * but absent fields are allowed (class-validator `skipMissingProperties`).
 */
export function PartialDto(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(PARTIAL_DTO, true, target);
  };
}

/** Global validation pipe: strict whitelist, with per-DTO partial validation. */
export class AppValidationPipe extends ValidationPipe {
  constructor() {
    super({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: false,
    });
  }

  protected override validate(
    object: object,
    validatorOptions?: ValidatorOptions,
  ) {
    const partial =
      Reflect.getMetadata(PARTIAL_DTO, object.constructor) === true;
    return super.validate(
      object,
      partial
        ? { ...validatorOptions, skipMissingProperties: true }
        : validatorOptions,
    );
  }
}
