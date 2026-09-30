import { Decimal, decimalToString, isPlainDate, parseDecimal } from '@waddlers/domain';

/**
 * Field-level normalization shared by every adapter. Each function returns `null` for an
 * unusable value (missing, blank, NaN, infinite, zero, negative, non-numeric): callers drop that
 * field/row and count it as rejected. Nothing here ever returns 0 for a missing value.
 */

/** Column limits a value must fit WITHOUT rounding or overflowing (Postgres `numeric(p, s)`). */
export interface DecimalLimit {
  /** Digits before the decimal point (precision - scale). */
  intDigits: number;
  scale: number;
}
/** Prices: `numeric(24, 8)`. */
export const PRICE_LIMIT: DecimalLimit = { intDigits: 16, scale: 8 };
/** FX rates: `numeric(20, 10)`. */
export const FX_LIMIT: DecimalLimit = { intDigits: 10, scale: 10 };

/** No real provider value is this long; bounds the work done on hostile payloads. */
const MAX_LITERAL_LENGTH = 64;

/**
 * Positive finite decimal string from a provider number/string, or null. The value must fit the
 * target column exactly: more integer digits than `intDigits` (overflow), more decimals than
 * `scale` (the database would round it) or a value that is not > 0 are all rejected, never
 * repaired. Exponent forms are checked from their exponent BEFORE anything is expanded, so
 * `1e999999` costs nothing.
 */
export function toPositiveDecimalString(
  value: unknown,
  limit: DecimalLimit = PRICE_LIMIT,
): string | null {
  let decimal: Decimal | null = null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    decimal = new Decimal(value.toString());
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (text.length > MAX_LITERAL_LENGTH) return null;
    // Provider strings are decimal (optionally exponent for tiny prices): reuse the strict
    // domain parser first, fall back to Decimal for exponent notation.
    decimal = parseDecimal(text);
    if (decimal === null && /^[+]?\d+(\.\d+)?[eE][+-]?\d+$/.test(text)) {
      decimal = new Decimal(text);
    }
  }
  if (decimal === null || !decimal.isFinite() || !decimal.gt(0)) return null;
  if (decimal.e + 1 > limit.intDigits || decimal.decimalPlaces() > limit.scale) return null;
  return decimalToString(decimal);
}

/** `YYYY-MM-DD` calendar date or null (rejects `2026-02-30`). */
export function toPlainDate(value: unknown): string | null {
  return typeof value === 'string' && isPlainDate(value) ? value : null;
}

/** Valid Date from an ISO string or epoch seconds, or null. */
export function toDate(value: unknown): Date | null {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string') date = new Date(value);
  else if (typeof value === 'number' && Number.isFinite(value)) date = new Date(value * 1000);
  else return null;
  return Number.isNaN(date.getTime()) ? null : date;
}
