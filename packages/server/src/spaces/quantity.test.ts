import {
  nullableQuantitySchema,
  quantitySchema,
  setQuantityInputSchema,
} from '@waddlers/contracts';
import { describe, expect, it } from 'vitest';
import { canonicalQuantity } from './service';

describe('quantitySchema', () => {
  it.each([
    '0',
    '1',
    '25',
    '12.5',
    '0.00000001',
    '0.5',
    '100.00',
    '1234567890123456',
    '1234567890123456.12345678',
  ])('accepts %s', (value) => {
    expect(quantitySchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['negative', '-1'],
    ['negative zero', '-0'],
    ['explicit plus', '+1'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['exponent', '1e3'],
    ['uppercase exponent', '1E3'],
    ['thousands space', '1 000'],
    ['thousands comma', '1,000'],
    ['decimal comma', '1,5'],
    ['underscore', '1_000'],
    ['too many decimals', '0.123456789'],
    ['too large (17 integer digits)', '12345678901234567'],
    ['empty', ''],
    ['blank', ' '],
    ['padded', ' 1 '],
    ['trailing newline', '1\n'],
    ['leading dot', '.5'],
    ['trailing dot', '1.'],
    ['leading zeros', '007'],
    ['hex', '0x10'],
    ['text', 'abc'],
  ])('rejects %s (%j)', (_label, value) => {
    expect(quantitySchema.safeParse(value).success).toBe(false);
  });

  it('never accepts a JavaScript number', () => {
    expect(quantitySchema.safeParse(5).success).toBe(false);
    expect(nullableQuantitySchema.safeParse(0).success).toBe(false);
  });

  it('allows null (watchlist) but not undefined', () => {
    expect(nullableQuantitySchema.safeParse(null).success).toBe(true);
    expect(nullableQuantitySchema.safeParse(undefined).success).toBe(false);
    const base = { spaceId: crypto.randomUUID(), positionId: crypto.randomUUID() };
    expect(setQuantityInputSchema.safeParse(base).success).toBe(false);
    expect(setQuantityInputSchema.safeParse({ ...base, quantity: null }).success).toBe(true);
  });
});

describe('canonicalQuantity', () => {
  it.each([
    ['12.50000000', '12.5'],
    ['12.00000000', '12'],
    ['0.00000000', '0'],
    ['0.10000000', '0.1'],
    ['100', '100'],
    ['1234567890123456.12345678', '1234567890123456.12345678'],
  ])('%s -> %s', (input, expected) => {
    expect(canonicalQuantity(input)).toBe(expected);
  });
  it('keeps null as null (never 0)', () => {
    expect(canonicalQuantity(null)).toBeNull();
  });
});
