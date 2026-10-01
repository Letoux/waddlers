/**
 * Canonical decimal string of a `numeric(24,8)` value: PostgreSQL pads the scale
 * (`12.50000000`); the API returns `12.5`. Pure string work, no float, no exponent.
 */
export function canonicalQuantity(value: string | null): string | null {
  if (value === null) return null;
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}
