import { nullableQuantitySchema } from '@waddlers/contracts';

/** Rendered for a missing quantity (watchlist entry): never 0. */
export const UNAVAILABLE = '—';

const CANONICAL = /^(\d+)(?:\.(\d+))?$/;
// fr-FR groups thousands with a narrow no-break space (U+202F) and uses a decimal comma.
const GROUP_SEPARATOR = ' ';

export type ParsedQuantity = { ok: true; value: string | null } | { ok: false };

/**
 * Turns what the user typed into the API value, with string operations only (no floats):
 * blank -> `null` (no quantity); spaces (incl. no-break) are ignored; `,` or `.` is the decimal
 * separator (not both); `,5` -> `0.5`; superfluous leading zeros are dropped. The result is
 * validated with the contract's `nullableQuantitySchema` (non-negative, <= 16 + 8 digits).
 */
export function parseQuantityInput(raw: string): ParsedQuantity {
  const compact = raw.replace(/[\s\u00a0\u202f]/g, '');
  if (compact === '') return { ok: true, value: null };
  if (compact.includes(',') && compact.includes('.')) return { ok: false };
  const dotted = compact.replace(',', '.');
  if ((dotted.match(/\./g) ?? []).length > 1 || dotted.endsWith('.')) return { ok: false };
  if (!/^\d*\.?\d+$|^\d+$/.test(dotted)) return { ok: false };
  const [intRaw = '', frac] = dotted.split('.');
  const int = intRaw.replace(/^0+(?=\d)/, '') || '0';
  const candidate = frac === undefined ? int : `${int}.${frac}`;
  const parsed = nullableQuantitySchema.safeParse(candidate);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
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
