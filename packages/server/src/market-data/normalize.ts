import { Decimal, decimalToString, isPlainDate, parseDecimal } from '@waddlers/domain';

/**
 * Field-level normalization shared by every adapter. Each function returns `null` for an
 * unusable value (missing, blank, NaN, infinite, zero, negative, non-numeric): callers drop that
 * field/row and count it as rejected. Nothing here ever returns 0 for a missing value.
 */

/** Positive finite decimal string from a provider number/string, or null. */
export function toPositiveDecimalString(value: unknown): string | null {
  let decimal: Decimal | null = null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    decimal = new Decimal(value.toString());
  } else if (typeof value === 'string') {
    // Provider strings are decimal (optionally exponent for tiny prices): reuse the strict
    // domain parser first, fall back to Decimal for exponent notation.
    decimal = parseDecimal(value.trim());
    if (decimal === null && /^[+]?\d+(\.\d+)?[eE][+-]?\d+$/.test(value.trim())) {
      decimal = new Decimal(value.trim());
    }
  }
  if (decimal === null || !decimal.isFinite() || !decimal.gt(0)) return null;
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
