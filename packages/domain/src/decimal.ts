import { Decimal as DecimalBase } from 'decimal.js';

/**
 * Domain Decimal: an isolated decimal.js clone so no other code can change our
 * precision/rounding globally. 40 significant digits is far beyond any market
 * price or portfolio value; division is the only operation that rounds.
 * Rounding is ROUND_HALF_EVEN (banker's) — final display rounding is the UI's job.
 */
export const Decimal = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = DecimalBase;

const DECIMAL_STRING = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * Parses a plain decimal string (as stored in Postgres `numeric` / sent by the API).
 * Returns `null` for null/undefined/blank/anything that is not a finite plain decimal
 * (no exponent, NaN, Infinity, thousands separators) — never `0`.
 */
export function parseDecimal(value: string | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!DECIMAL_STRING.test(trimmed)) return null;
  return new Decimal(trimmed);
}

/** Serializes to a plain decimal string (never exponent notation). `null` stays `null`. */
export function decimalToString(value: Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toFixed();
}

/**
 * Re-wraps any decimal.js instance (possibly from a clone with different
 * precision/rounding) into the domain Decimal so foreign settings never leak
 * into our arithmetic. Digits are copied exactly, not re-rounded.
 */
export function asDecimal(value: DecimalBase): Decimal {
  return new Decimal(value);
}
