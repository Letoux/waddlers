import { describe, expect, it } from 'vitest';
import {
  UNAVAILABLE,
  daysBetween,
  formatAxisDate,
  formatEur,
  formatEurCompact,
  formatLongDate,
  formatNumericDate,
  formatPct,
  formatSignedEur,
  formatSignedPct,
  fxRateLine,
  signOf,
} from './format';

// Intl fr-FR uses U+202F between digit groups and U+00A0 before the unit.
const norm = (s: string) => s.replace(/\u202f|\u00a0/g, ' ');

const usdRate = {
  currency: 'USD',
  quotedCurrencies: ['USD'],
  ratePerEur: '1.1',
  eurPerUnit: '0.9',
  rateDate: '2026-09-29',
};

describe('dashboard formatting (fr-FR)', () => {
  it('formats euro amounts', () => {
    expect(norm(formatEur('128450.4'))).toBe('128 450 €');
    expect(norm(formatSignedEur('12430'))).toBe('+12 430 €');
    expect(norm(formatSignedEur('-1200.6'))).toBe('-1 201 €'.replace('-', '-'));
    expect(norm(formatSignedEur('0'))).toBe('0 €');
  });

  it('never turns unavailable values into zero', () => {
    for (const f of [formatEur, formatSignedEur, formatPct, formatSignedPct])
      for (const v of [null, undefined, '', 'abc'] as const) expect(f(v)).toBe(UNAVAILABLE);
    expect(formatLongDate(null)).toBe(UNAVAILABLE);
    expect(formatNumericDate('2026-13-99')).toBe(UNAVAILABLE);
    expect(signOf(null)).toBeNull();
  });

  it('formats signed percentages', () => {
    expect(norm(formatSignedPct('10.66'))).toBe('+10,7 %');
    expect(norm(formatSignedPct('-3.2'))).toBe('-3,2 %');
    expect(norm(formatSignedPct('0'))).toBe('0,0 %');
    expect(norm(formatPct('42'))).toBe('42,0 %');
  });

  it('reads the sign', () => {
    expect(signOf('0.1')).toBe(1);
    expect(signOf('-0.1')).toBe(-1);
    expect(signOf('0')).toBe(0);
  });

  it('formats plain dates without timezone drift', () => {
    expect(formatLongDate('2026-06-18')).toBe('18 juin 2026');
    expect(formatNumericDate('2026-09-29')).toBe('29/09/2026');
    expect(formatAxisDate('2026-09-29', 30)).toBe('29 sept.');
    expect(formatAxisDate('2024-09-29', 1000)).toBe('sept. 2024');
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
  });

  it('compacts axis ticks', () => {
    expect(norm(formatEurCompact(128000))).toMatch(/^128\s?k\s?€$/);
  });

  it('builds FX lines from eurPerUnit (specs 34 direction)', () => {
    const usd = fxRateLine({
      currency: 'USD',
      quotedCurrencies: ['USD'],
      ratePerEur: '1.13542',
      eurPerUnit: '0.88070000',
      rateDate: '2026-09-29',
    });
    expect(norm(usd.text)).toBe('USD/EUR : 0,8807 (taux du 29/09/2026)');
    expect(usd.note).toBeNull();
  });

  it('notes the pence quotation on GBP lines', () => {
    const gbp = fxRateLine({
      currency: 'GBP',
      quotedCurrencies: ['GBX'],
      ratePerEur: '0.87',
      eurPerUnit: '1.14942529',
      rateDate: '2026-09-28',
    });
    expect(norm(gbp.text)).toBe('GBP/EUR : 1,1494 (taux du 28/09/2026)');
    expect(gbp.note).toContain('GBX');
  });

  it('shows no pence note for a GBP position quoted in pounds', () => {
    const gbp = fxRateLine({
      currency: 'GBP',
      quotedCurrencies: ['GBP'],
      ratePerEur: '0.87',
      eurPerUnit: '1.14942529',
      rateDate: '2026-09-28',
    });
    expect(gbp.note).toBeNull();
    expect(fxRateLine({ ...usdRate, quotedCurrencies: [] }).note).toBeNull();
  });
});
