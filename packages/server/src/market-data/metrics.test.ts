import { describe, expect, it } from 'vitest';
import { computeMetricsValues, selectEndPrice } from './metrics';

const closes = [
  { date: '2026-09-25', close: '100' },
  { date: '2026-09-28', close: '101' },
  { date: '2026-09-29', close: '102' },
];

describe('selectEndPrice: quote vs close', () => {
  const base = { currency: 'EUR', timezone: 'Europe/Paris', closes };

  it('uses the quote when its local date is newer than the last close', () => {
    const end = selectEndPrice({
      ...base,
      quote: { price: '103', asOf: new Date('2026-09-30T09:00:00Z') },
    });
    expect(end).toMatchObject({ basis: 'quote', asOfDate: '2026-09-30' });
    expect(end?.price.toString()).toBe('103');
  });

  it('ties go to the quote (same local date as the last close)', () => {
    const end = selectEndPrice({
      ...base,
      quote: { price: '102.5', asOf: new Date('2026-09-29T15:00:00Z') },
    });
    expect(end).toMatchObject({ basis: 'quote', asOfDate: '2026-09-29' });
  });

  it('uses the last close when the quote is older than it', () => {
    const end = selectEndPrice({
      ...base,
      quote: { price: '50', asOf: new Date('2026-09-26T15:00:00Z') },
    });
    expect(end).toMatchObject({ basis: 'close', asOfDate: '2026-09-29', priceAsOf: null });
    expect(end?.price.toString()).toBe('102');
  });

  it('decides on the EXCHANGE-local date, not the UTC date', () => {
    // 2026-09-29T22:30Z is already 2026-09-30 in Paris (quote newer) but 2026-09-29 18:30 in New York (tie).
    const asOf = new Date('2026-09-29T22:30:00Z');
    const withClose = (timezone: string, date: string) =>
      selectEndPrice({
        currency: 'EUR',
        timezone,
        closes: [{ date, close: '10' }],
        quote: { price: '11', asOf },
      });
    expect(withClose('Europe/Paris', '2026-09-30')?.basis).toBe('quote');
    expect(
      selectEndPrice({
        currency: 'USD',
        timezone: 'America/New_York',
        closes: [{ date: '2026-09-29', close: '10' }],
        quote: { price: '11', asOf },
      })?.asOfDate,
    ).toBe('2026-09-29');
    expect(withClose('Europe/Paris', '2026-09-30')?.asOfDate).toBe('2026-09-30');
  });

  it('falls back to whichever exists, and to null with neither', () => {
    expect(selectEndPrice({ ...base, quote: null })?.basis).toBe('close');
    expect(
      selectEndPrice({
        ...base,
        closes: [],
        quote: { price: '9', asOf: new Date('2026-09-30T09:00:00Z') },
      })?.basis,
    ).toBe('quote');
    expect(selectEndPrice({ ...base, closes: [], quote: null })).toBeNull();
  });

  it('never uses a zero/invalid price (a bad quote falls back to the close)', () => {
    const end = selectEndPrice({
      ...base,
      quote: { price: '0', asOf: new Date('2026-09-30T09:00:00Z') },
    });
    expect(end?.basis).toBe('close');
    const bad = selectEndPrice({
      ...base,
      closes: [
        { date: '2026-09-29', close: '0' },
        { date: '2026-09-28', close: null },
      ],
      quote: null,
    });
    expect(bad).toBeNull();
  });
});

describe('computeMetricsValues', () => {
  const input = {
    currency: 'GBX',
    timezone: 'Europe/London',
    closes: [{ date: '2026-09-29', close: '2400' }],
    quote: { price: '2450.5', asOf: new Date('2026-09-30T10:00:00Z') },
    historyCompleteFrom: null,
  };

  it('GBX price_eur = pence / 100 / (GBP per EUR), exact and rounded once', () => {
    const v = computeMetricsValues({
      ...input,
      fxRate: (c, d) =>
        c === 'GBP' && d === '2026-09-30' ? { date: '2026-09-29', ratePerEur: '0.86' } : null,
    });
    expect(v.price).toBe('2450.5');
    expect(v.priceEur).toBe('28.49418605'); // 24.505 / 0.86 = 28.4941860465...
    expect(v.priceEurReason).toBeNull();
    expect(v.fxRatePerEur).toBe('0.86');
    expect(v.fxRateDate).toBe('2026-09-29');
  });

  it('a missing rate gives price_eur NULL with a reason, never a rate of 1', () => {
    const v = computeMetricsValues({ ...input, fxRate: () => null });
    expect(v.price).toBe('2450.5');
    expect(v.priceEur).toBeNull();
    expect(v.priceEurReason).toBe('rate_missing');
    expect(v.fxRatePerEur).toBeNull();
  });

  it('EUR needs no rate; an invalid currency code is flagged', () => {
    const eur = computeMetricsValues({ ...input, currency: 'EUR', fxRate: () => null });
    expect(eur.priceEur).toBe('2450.5');
    expect(eur.fxRatePerEur).toBeNull();
    const bad = computeMetricsValues({ ...input, currency: 'XX', fxRate: () => null });
    expect(bad.priceEur).toBeNull();
    expect(bad.priceEurReason).toBe('currency_invalid');
  });

  it('no price at all: everything NULL with reasons (price_missing / end_missing)', () => {
    const v = computeMetricsValues({ ...input, closes: [], quote: null, fxRate: () => null });
    expect(v).toMatchObject({
      price: null,
      priceBasis: null,
      asOfDate: null,
      priceEur: null,
      priceEurReason: 'price_missing',
    });
    expect(v).toMatchObject({
      perf1w: null,
      perf1wReason: 'end_missing',
      perfMax: null,
      perfMaxReason: 'end_missing',
    });
  });

  it('max without history_complete_from is NULL with a reason; with it, a value', () => {
    const series = [
      { date: '2026-01-05', close: '50' },
      { date: '2026-09-29', close: '100' },
    ];
    const args = { ...input, currency: 'EUR', closes: series, quote: null, fxRate: () => null };
    const unknown = computeMetricsValues({ ...args, historyCompleteFrom: null });
    expect(unknown).toMatchObject({
      perfMax: null,
      perfMaxReason: 'history_completeness_unknown',
      perfMaxBaseDate: null,
    });
    const known = computeMetricsValues({ ...args, historyCompleteFrom: '2026-01-05' });
    expect(known).toMatchObject({
      perfMax: '100',
      perfMaxBaseDate: '2026-01-05',
      perfMaxReason: null,
    });
  });
});
