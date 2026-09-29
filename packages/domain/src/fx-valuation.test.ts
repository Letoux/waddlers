import { describe, expect, it } from 'vitest';
import { Decimal } from './decimal';
import { convert, convertAmount, type FxRates } from './fx';
import { computeSpaceValue, type ValuationPosition } from './valuation';

const D = (s: string) => new Decimal(s);
const rates: FxRates = new Map([
  ['USD', D('1.25')], // 1 EUR = 1.25 USD
  ['GBP', D('0.8')], // 1 EUR = 0.8 GBP
  ['ZAR', D('20')],
  ['JPY', D('160')],
]);

describe('convert (EUR-based, 1 EUR = x CCY)', () => {
  it.each([
    ['250', 'USD', 'EUR', '200'], // divide by rate
    ['100', 'EUR', 'USD', '125'], // multiply by rate
    ['125', 'USD', 'USD', '125'],
    ['100', 'EUR', 'EUR', '100'],
    ['125', 'USD', 'GBP', '80'], // cross via EUR: 100 EUR * 0.8
    ['80', 'GBP', 'USD', '125'],
    ['1600', 'JPY', 'EUR', '10'],
  ])('%s %s -> %s = %s', (amount, from, to, expected) => {
    expect(convert(D(amount), from, to, rates)?.toFixed()).toBe(expected);
  });

  it('is a rate-free identity for EUR -> EUR, even with no rates', () => {
    expect(convert(D('12.34'), 'EUR', 'EUR', new Map())?.toFixed()).toBe('12.34');
  });

  it('normalizes minor units on both sides', () => {
    expect(convert(D('1000'), 'GBX', 'GBP', new Map())?.toFixed()).toBe('10'); // no rate needed
    expect(convert(D('10'), 'GBP', 'GBX', new Map())?.toFixed()).toBe('1000');
    expect(convert(D('1000'), 'GBX', 'EUR', rates)?.toFixed()).toBe('12.5'); // 10 GBP / 0.8
    expect(convert(D('1000'), 'GBp', 'EUR', rates)?.toFixed()).toBe('12.5');
    expect(convert(D('2000'), 'ZAc', 'EUR', rates)?.toFixed()).toBe('1'); // 20 ZAR / 20
    expect(convert(D('1'), 'EUR', 'GBX', rates)?.toFixed()).toBe('80');
  });

  it('never assumes 1 for a missing rate', () => {
    expect(convert(D('100'), 'CHF', 'EUR', rates)).toBeNull();
    expect(convert(D('100'), 'EUR', 'CHF', rates)).toBeNull();
    expect(convertAmount(D('100'), 'CHF', 'EUR', rates)).toEqual({
      ok: false,
      reason: 'rate_missing',
    });
  });

  it('treats zero, negative and non-finite rates as missing', () => {
    for (const bad of ['0', '-1', 'Infinity', 'NaN']) {
      const r: FxRates = new Map([['USD', new Decimal(bad)]]);
      expect(convert(D('1'), 'USD', 'EUR', r)).toBeNull();
    }
  });

  it('reports invalid currency codes and passes null through', () => {
    expect(convertAmount(D('1'), 'usd', 'EUR', rates)).toEqual({
      ok: false,
      reason: 'currency_invalid',
    });
    expect(convert(null, 'USD', 'EUR', rates)).toBeNull();
  });

  it('round-trips within decimal precision', () => {
    const there = convert(D('100'), 'EUR', 'USD', rates) as Decimal;
    expect(convert(there, 'USD', 'EUR', rates)?.toFixed()).toBe('100');
  });
});

const pos = (
  id: string,
  quantity: string | null,
  price: string | null,
  currency = 'EUR',
): ValuationPosition => ({
  id,
  quantity: quantity === null ? null : D(quantity),
  price: price === null ? null : { amount: D(price), currency },
});

describe('computeSpaceValue (specs §32, D5, D9)', () => {
  it('sums quantity × price × fx with the spec example (25 × 180 €)', () => {
    const v = computeSpaceValue([pos('nvda', '25', '180')], rates);
    expect(v.total?.toFixed()).toBe('4500');
    expect(v).toMatchObject({ isComplete: true, missing: [], currency: 'EUR' });
  });

  it('converts local prices (USD, GBX) into EUR', () => {
    const v = computeSpaceValue(
      [pos('a', '10', '125', 'USD'), pos('b', '100', '1000', 'GBX'), pos('c', '2', '50')],
      rates,
    );
    // 10*100 + 100*12.5 + 2*50
    expect(v.rows.map((r) => r.value?.toFixed())).toEqual(['1000', '1250', '100']);
    expect(v.total?.toFixed()).toBe('2350');
    expect(v.isComplete).toBe(true);
  });

  it('excludes null quantity (watchlist) without flagging it as missing', () => {
    const v = computeSpaceValue([pos('w', null, '10'), pos('h', '2', '10')], rates);
    expect(v.total?.toFixed()).toBe('20');
    expect(v.isComplete).toBe(true);
    expect(v.rows[0]).toEqual({ positionId: 'w', value: null, excluded: true });
  });

  it('excludes a watchlist entry even when its price is missing', () => {
    const v = computeSpaceValue([pos('w', null, null)], rates);
    expect(v.missing).toEqual([]);
    expect(v.isComplete).toBe(true);
    expect(v.total).toBeNull();
  });

  it('yields a partial total when FX is missing, never counting it as 0 or rate 1', () => {
    const v = computeSpaceValue([pos('ok', '1', '100'), pos('chf', '1', '999', 'CHF')], rates);
    expect(v.total?.toFixed()).toBe('100');
    expect(v.isComplete).toBe(false);
    expect(v.missing).toEqual([{ positionId: 'chf', reason: 'fx_missing' }]);
    expect(v.rows[1]).toMatchObject({ value: null, reason: 'fx_missing', excluded: false });
  });

  it('yields a partial total when a price is missing', () => {
    const v = computeSpaceValue([pos('ok', '3', '10'), pos('nop', '5', null)], rates);
    expect(v.total?.toFixed()).toBe('30');
    expect(v.missing).toEqual([{ positionId: 'nop', reason: 'price_missing' }]);
  });

  it('treats a Money with null amount as a missing price', () => {
    const v = computeSpaceValue(
      [{ id: 'x', quantity: D('1'), price: { amount: null, currency: 'EUR' } }],
      rates,
    );
    expect(v.missing).toEqual([{ positionId: 'x', reason: 'price_missing' }]);
  });

  it('total is null (not 0) when nothing could be valued', () => {
    expect(computeSpaceValue([], rates).total).toBeNull();
    const v = computeSpaceValue([pos('a', '1', null)], rates);
    expect(v.total).toBeNull();
    expect(v.isComplete).toBe(false);
  });

  it('values a zero quantity as a real 0', () => {
    const v = computeSpaceValue([pos('z', '0', '10')], rates);
    expect(v.total?.toFixed()).toBe('0');
    expect(v.isComplete).toBe(true);
  });

  it('flags invalid quantity, price and currency', () => {
    const v = computeSpaceValue(
      [pos('q', '-1', '10'), pos('p', '1', '0'), pos('n', '1', '-3'), pos('c', '1', '1', 'usd')],
      rates,
    );
    expect(v.missing).toEqual([
      { positionId: 'q', reason: 'quantity_invalid' },
      { positionId: 'p', reason: 'price_invalid' },
      { positionId: 'n', reason: 'price_invalid' },
      { positionId: 'c', reason: 'currency_invalid' },
    ]);
    expect(v.total).toBeNull();
  });

  it('keeps decimal precision on fractional quantities', () => {
    const v = computeSpaceValue([pos('f', '0.1', '0.2'), pos('g', '0.2', '0.1')], rates);
    expect(v.total?.toFixed()).toBe('0.04');
  });

  it('supports a non-EUR reference currency through the same rules', () => {
    const v = computeSpaceValue([pos('a', '1', '100')], rates, 'USD');
    expect(v.total?.toFixed()).toBe('125');
    expect(v.currency).toBe('USD');
  });
});
