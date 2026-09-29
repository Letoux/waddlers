import { describe, expect, it } from 'vitest';
import { moneyFromStrings, moneyToStrings, normalizeCurrency, normalizeMoney } from './currency';
import { Decimal, decimalToString, parseDecimal } from './decimal';
import { PERIODS, isPeriod, targetBaseDate, type Period } from './period';
import { addDays, addMonths, assertPlainDate, diffDays, isPlainDate } from './plain-date';

describe('Decimal helpers', () => {
  it('has no binary float error', () => {
    expect(new Decimal('0.1').plus('0.2').toFixed()).toBe('0.3');
  });

  it.each([
    ['12.50', '12.5'],
    ['-0.0001', '-0.0001'],
    ['.5', '0.5'],
    ['0', '0'],
    [' 42 ', '42'],
  ])('parses %s', (input, expected) => {
    expect(decimalToString(parseDecimal(input))).toBe(expected);
  });

  it.each([null, undefined, '', '  ', 'abc', 'NaN', 'Infinity', '1e5', '1,5', '1.', '--1'])(
    'parses %j as null, never 0',
    (input) => {
      expect(parseDecimal(input as string | null | undefined)).toBeNull();
    },
  );

  it('serializes without exponent notation', () => {
    expect(decimalToString(new Decimal('0.00000001'))).toBe('0.00000001');
    expect(decimalToString(new Decimal('1e21'))).toBe('1000000000000000000000');
    expect(decimalToString(null)).toBeNull();
  });
});

describe('currency normalization', () => {
  it.each([
    ['GBX', 'GBP', '100'],
    ['GBp', 'GBP', '100'],
    ['ZAc', 'ZAR', '100'],
    ['EUR', 'EUR', '1'],
    ['GBP', 'GBP', '1'],
  ])('%s -> %s (divisor %s)', (code, currency, divisor) => {
    const n = normalizeCurrency(code);
    expect(n?.currency).toBe(currency);
    expect(n?.divisor.toFixed()).toBe(divisor);
  });

  it.each(['', 'eur', 'EURO', 'ZAC', 'ILA', 'gbx', '__proto__', 'toString'])(
    'rejects %j',
    (code) => {
      expect(normalizeCurrency(code)).toBeNull();
    },
  );

  it('converts minor-unit money to the major unit exactly', () => {
    const m = normalizeMoney({ amount: new Decimal('1234.5'), currency: 'GBX' });
    expect(moneyToStrings(m!)).toEqual({ amount: '12.345', currency: 'GBP' });
  });

  it('keeps a null amount null and rejects invalid currency', () => {
    expect(normalizeMoney({ amount: null, currency: 'GBX' })).toEqual({
      amount: null,
      currency: 'GBP',
    });
    expect(normalizeMoney({ amount: new Decimal(1), currency: 'xx' })).toBeNull();
  });

  it('round-trips money strings', () => {
    const m = moneyFromStrings({ amount: '180.25', currency: 'USD' });
    expect(moneyToStrings(m)).toEqual({ amount: '180.25', currency: 'USD' });
    expect(moneyFromStrings({ amount: null, currency: 'USD' }).amount).toBeNull();
    expect(moneyFromStrings({ amount: 'garbage', currency: 'USD' }).amount).toBeNull();
  });
});

describe('plain dates', () => {
  it('validates real calendar dates', () => {
    expect(isPlainDate('2024-02-29')).toBe(true);
    expect(isPlainDate('2023-02-29')).toBe(false);
    expect(isPlainDate('1900-02-29')).toBe(false);
    expect(isPlainDate('2000-02-29')).toBe(true);
    expect(isPlainDate('2026-13-01')).toBe(false);
    expect(isPlainDate('2026-1-1')).toBe(false);
    expect(isPlainDate('2026-06-18T00:00:00Z')).toBe(false);
    expect(() => assertPlainDate('nope')).toThrow(RangeError);
  });

  it.each([
    ['2026-03-01', -1, '2026-02-28'],
    ['2024-03-01', -1, '2024-02-29'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -7, '2026-02-22'],
  ])('addDays(%s, %i) = %s', (d, n, expected) => {
    expect(addDays(d, n)).toBe(expected);
  });

  it.each([
    ['2026-03-31', -1, '2026-02-28'],
    ['2024-03-31', -1, '2024-02-29'],
    ['2026-05-31', -1, '2026-04-30'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2024-02-29', -12, '2023-02-28'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2026-01-15', -1, '2025-12-15'],
    ['2026-01-15', -13, '2024-12-15'],
    ['2026-08-31', -6, '2026-02-28'],
  ])('addMonths(%s, %i) = %s', (d, n, expected) => {
    expect(addMonths(d, n)).toBe(expected);
  });

  it('computes day differences across leap days and DST-like boundaries', () => {
    expect(diffDays('2024-02-28', '2024-03-01')).toBe(2);
    expect(diffDays('2026-03-28', '2026-03-30')).toBe(2);
    expect(diffDays('2026-10-24', '2026-10-26')).toBe(2);
    expect(diffDays('2026-06-10', '2026-06-01')).toBe(-9);
  });
});

describe('periods (specs §11/§31)', () => {
  it('exposes the six periods', () => {
    expect([...PERIODS]).toEqual(['1w', '1m', '6m', '1y', '5y', 'max']);
    expect(isPeriod('6m')).toBe(true);
    expect(isPeriod('3m')).toBe(false);
  });

  it.each<[Period, string, string | null]>([
    ['1w', '2026-06-18', '2026-06-11'],
    ['1w', '2026-03-03', '2026-02-24'],
    ['1m', '2026-06-18', '2026-05-18'],
    ['1m', '2026-03-31', '2026-02-28'],
    ['1m', '2024-03-31', '2024-02-29'],
    ['6m', '2026-08-31', '2026-02-28'],
    ['6m', '2026-06-18', '2025-12-18'],
    ['1y', '2026-06-18', '2025-06-18'],
    ['1y', '2024-02-29', '2023-02-28'],
    ['5y', '2026-06-18', '2021-06-18'],
    ['5y', '2024-02-29', '2019-02-28'],
    ['max', '2026-06-18', null],
  ])('%s from %s -> %s', (period, asOf, expected) => {
    expect(targetBaseDate(period, asOf)).toBe(expected);
  });
});
