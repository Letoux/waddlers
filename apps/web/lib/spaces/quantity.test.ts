import { describe, expect, it } from 'vitest';
import {
  formatQuantity,
  parseQuantityInput,
  QUANTITY_AMBIGUOUS_MESSAGE,
  QUANTITY_INVALID_MESSAGE,
  quantityToEditText,
} from './quantity';

const ok = (value: string | null) => ({ ok: true, value });
const bad = (message = QUANTITY_INVALID_MESSAGE) => ({ ok: false, message });
const NNBSP = '\u202f';

describe('parseQuantityInput', () => {
  it.each([
    ['10', ok('10')],
    ['10,5', ok('10.5')],
    ['10.5', ok('10.5')],
    ['  12,25 ', ok('12.25')],
    ['1 234,5', ok('1234.5')],
    ['1 234 567', ok('1234567')],
    ['12 345', ok('12345')],
    [`1\u00a0234${NNBSP}567`, ok('1234567')],
    [',5', ok('0.5')],
    ['007', ok('7')],
    ['00,5', ok('0.5')],
    ['0', ok('0')],
    ['0,00000001', ok('0.00000001')],
    ['1,12345678', ok('1.12345678')],
    ['9999999999999999,12345678', ok('9999999999999999.12345678')],
    ['0.123', ok('0.123')], // unambiguous: no thousands group can start with 0
    ['1,234', ok('1.234')], // the comma is the French decimal separator
    ['', ok(null)],
    ['   ', ok(null)],
  ])('accepts %j', (input, expected) => {
    expect(parseQuantityInput(input)).toEqual(expected);
  });

  it.each([
    ['5,0', '5'],
    ['5,00', '5'],
    ['5.0', '5'],
    ['2,50', '2.5'],
    ['0,000', '0'],
    ['1 000,10', '1000.1'],
    ['1,123456780', '1.12345678'], // 9 digits, the last one a zero: canonical form fits
  ])('canonicalises %j to %j (unchanged values are no-ops)', (input, value) => {
    expect(parseQuantityInput(input)).toEqual(ok(value));
  });

  it.each([
    '1,123456789', // 9 decimals
    '10000000000000000', // 17 integer digits
    '-1',
    '+1',
    '1e3',
    '1,2,3',
    '1.2.3',
    '1.234,5',
    '5,',
    '5.',
    'abc',
    '1,5 kg',
    'NaN',
    ',',
    '1 2 3', // spaces are only thousands separators
    '1 23',
    '1 2345',
    '1 234 56',
    '1, 5',
    '1 ,5',
  ])('rejects %j when not a valid grouped/decimal number', (input) => {
    expect(parseQuantityInput(input)).toEqual(bad());
  });

  it.each(['1.234', '12.345', '999.999', '1 000.123'])(
    'rejects the ambiguous %j with a French hint',
    (input) => {
      expect(parseQuantityInput(input)).toEqual(bad(QUANTITY_AMBIGUOUS_MESSAGE));
    },
  );

  it('keeps big values exact (no float round trip)', () => {
    expect(parseQuantityInput('9007199254740993,1')).toEqual(ok('9007199254740993.1'));
  });
});

describe('formatQuantity', () => {
  it('formats fr-FR without float math', () => {
    expect(formatQuantity('12')).toBe('12');
    expect(formatQuantity('3.5')).toBe('3,5');
    expect(formatQuantity('1234.5')).toBe('1\u202f234,5');
    expect(formatQuantity('1234567')).toBe('1\u202f234\u202f567');
    expect(formatQuantity('0.00000001')).toBe('0,00000001');
    expect(formatQuantity('9007199254740993.12345678')).toBe(
      '9\u202f007\u202f199\u202f254\u202f740\u202f993,12345678',
    );
  });

  it('renders null and garbage as the unavailable dash, and 0 as 0', () => {
    expect(formatQuantity(null)).toBe('—');
    expect(formatQuantity('abc')).toBe('—');
    expect(formatQuantity('0')).toBe('0');
  });
});

describe('quantityToEditText', () => {
  it('uses a decimal comma and no grouping', () => {
    expect(quantityToEditText('1234.5')).toBe('1234,5');
    expect(quantityToEditText(null)).toBe('');
  });
  it('round trips through the parser', () => {
    expect(parseQuantityInput(quantityToEditText('25.5'))).toEqual(ok('25.5'));
  });
});
