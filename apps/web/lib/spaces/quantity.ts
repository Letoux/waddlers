import { nullableQuantitySchema } from '@waddlers/contracts';

/** Rendered for a missing quantity (watchlist entry): never 0. */
export const UNAVAILABLE = '—';

export const QUANTITY_INVALID_MESSAGE =
  'Quantité invalide : nombre positif ou nul, jusqu’à 8 décimales (ex. 12,5).';
export const QUANTITY_AMBIGUOUS_MESSAGE =
  'Utilisez la virgule pour les décimales (ex. 1,234) ou un espace pour les milliers (1 234).';

const CANONICAL = /^(\d+)(?:\.(\d+))?$/;
// fr-FR groups thousands with a narrow no-break space (U+202F) and uses a decimal comma.
const GROUP_SEPARATOR = '\u202f';
// Digits, optionally grouped by spaces (regular, no-break, narrow no-break) in threes, then an
// optional `,` or `.` decimal part. At least one digit somewhere; a lone separator is rejected.
const INPUT = /^(?:(\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+))?(?:([.,])(\d+))?$/;

export type ParsedQuantity = { ok: true; value: string | null } | { ok: false; message: string };

const invalid = (message = QUANTITY_INVALID_MESSAGE): ParsedQuantity => ({ ok: false, message });

/**
 * Turns what the user typed into the API value, with string operations only (no floats):
 * - blank -> `null` (no quantity);
 * - spaces are accepted only as thousands separators (`1 234 567`), never elsewhere;
 * - `,` or `.` is the decimal separator (not both); `,5` -> `0.5`;
 * - a single `.` followed by exactly three digits (`1.234`) is ambiguous for a French reader
 *   (1 234 or 1,234?) and is rejected with a hint; `0.123` is unambiguous and accepted;
 * - canonical output: no leading zeros, no trailing fraction zeros, no bare separator
 *   (`5,0` -> `5`, `2,50` -> `2.5`), so an unchanged value compares equal to the stored one.
 * The result is validated with the contract's `nullableQuantitySchema` (non-negative,
 * at most 16 integer and 8 fraction digits).
 */
export function parseQuantityInput(raw: string): ParsedQuantity {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  const m = INPUT.exec(text);
  if (!m) return invalid();
  const [, intGroups, separator, frac] = m;
  if (intGroups === undefined && frac === undefined) return invalid();
  const digits = (intGroups ?? '').replace(/[ \u00a0\u202f]/g, '');
  if (separator === '.' && frac?.length === 3 && digits !== '' && /[1-9]/.test(digits)) {
    return invalid(QUANTITY_AMBIGUOUS_MESSAGE);
  }
  const int = digits.replace(/^0+(?=\d)/, '') || '0';
  const fraction = (frac ?? '').replace(/0+$/, '');
  const candidate = fraction === '' ? int : `${int}.${fraction}`;
  const parsed = nullableQuantitySchema.safeParse(candidate);
  return parsed.success ? { ok: true, value: parsed.data } : invalid();
}

/** Display: `1234.5` -> `1 234,5` (fr-FR), `null`/unparseable -> `—`. */
export function formatQuantity(quantity: string | null): string {
  if (quantity === null) return UNAVAILABLE;
  const m = CANONICAL.exec(quantity);
  if (!m) return UNAVAILABLE;
  const [, int = '', frac] = m;
  const grouped = int.replace(/\B(?=(\d{3})+$)/g, GROUP_SEPARATOR);
  return frac === undefined ? grouped : `${grouped},${frac}`;
}

/** Text to prefill the editor: decimal comma, no grouping; `null` -> empty. */
export function quantityToEditText(quantity: string | null): string {
  return quantity === null ? '' : quantity.replace('.', ',');
}
