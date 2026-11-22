/**
 * Exact money handling. Amounts are bigint minor units (cents for USD) end-to-end;
 * they are serialised as decimal strings because JSON numbers lose precision above 2^53.
 */
export const SUPPORTED_CURRENCIES = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  AED: 2,
  JPY: 0,
} as const;

export type CurrencyCode = keyof typeof SUPPORTED_CURRENCIES;

export const MINOR_AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})$/;

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.hasOwn(SUPPORTED_CURRENCIES, code);
}

/** Parses a non-negative integer minor-unit string. Throws on anything else. */
export function parseMinor(value: string): bigint {
  if (!MINOR_AMOUNT_PATTERN.test(value))
    throw new RangeError(`Invalid minor amount: ${value}`);
  return BigInt(value);
}

export type MoneyDto = { minor: string; currency: string };

export function money(minor: bigint, currency: string): MoneyDto {
  return { minor: minor.toString(), currency };
}

export function moneyOrNull(
  minor: bigint | null | undefined,
  currency: string,
): MoneyDto | null {
  return minor === null || minor === undefined ? null : money(minor, currency);
}

/** basis-points fee, rounded half-up, in exact integer arithmetic. */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000)
    throw new RangeError('bps out of range');
  return (amount * BigInt(bps) + 5000n) / 10000n;
}
