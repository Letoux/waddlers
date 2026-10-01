import { Decimal, buildValueSeries, parseDecimal, type Period } from '@waddlers/domain';
import { describe, expect, it } from 'vitest';
import {
  computeCurrentValue,
  computeHistory,
  historyToWire,
  quotedCurrencies,
  summaryChange,
  wire,
} from './compute';
import type { CloseRow, FxRow, SpacePositionData } from './repository';

/** D23: the value card delta describes the same value as `total`. */

const NOW = new Date('2026-09-30T12:00:00Z');
const HIST = { mode: 'historical', fxToleranceDays: 7 } as const;
const CURRENT = { mode: 'current', fxToleranceDays: 7 } as const;
const PERF = { value: null, baseDate: null };
const NO_PERF = { '1w': PERF, '1m': PERF, '6m': PERF, '1y': PERF, '5y': PERF, max: PERF };

function pos(
  id: string,
  quantity: string | null,
  currency: string,
  price: string | null,
  asOfDate = '2026-09-30',
): SpacePositionData {
  return {
    id,
    quantity,
    instrumentId: `i-${id}`,
    name: id.toUpperCase(),
    listingId: `l-${id}`,
    symbol: id.toUpperCase(),
    exchangeMic: 'XPAR',
    exchangeName: 'Euronext Paris',
    currency,
    metrics: price === null ? null : { price, priceCurrency: currency, asOfDate, perf: NO_PERF },
  };
}
const closes = (id: string, rows: [string, string][]): CloseRow[] =>
  rows.map(([date, close]) => ({ listingId: `l-${id}`, date, close }));
const fx = (currency: string, ratePerEur: string, date: string): FxRow => ({
  currency,
  ratePerEur,
  date,
});

/** What `getSummary` does after its reads: total, series, change (same function for chart and card). */
function summaryOf(
  positions: SpacePositionData[],
  rows: CloseRow[],
  fxRows: FxRow[],
  period: Period = '1m',
) {
  const value = computeCurrentValue(positions, fxRows, NOW, 7);
  const { series } = computeHistory(positions, rows, fxRows, period, '2026-09-30', HIST);
  return { value, series, change: summaryChange(value, series) };
}

const AI_CLOSES = closes('ai', [
  ['2026-09-01', '90'],
  ['2026-09-15', '95'],
  ['2026-09-29', '99'],
]);

describe('summary change = the same value as total (D23)', () => {
  it('a same-day quote above the last close: the series ends with a terminal point = total', () => {
    // Close 99 on 09-29, end price 105 (D21 quote of 09-30): total 1050, chart end 1050.
    const { value, series, change } = summaryOf([pos('ai', '10', 'EUR', '105')], AI_CLOSES, []);
    expect(value.total.amount).toBe('1050');
    expect(series.points.at(-1)).toMatchObject({ date: '2026-09-30', dataDate: '2026-09-30' });
    expect(wire(series.points.at(-1)?.value ?? null)).toBe('1050');
    expect(change).toMatchObject({
      toDate: '2026-09-30',
      endValue: { amount: '1050' },
      startValue: { amount: '900' },
      change: { amount: '150' },
    });
  });

  it('a close dated the as-of day is replaced by the end price, never a second point', () => {
    const c = closes('ai', [
      ['2026-09-01', '90'],
      ['2026-09-30', '100'],
    ]);
    const { series, change } = summaryOf([pos('ai', '10', 'EUR', '101')], c, []);
    expect(series.points.filter((p) => p.date === '2026-09-30')).toHaveLength(1);
    expect(change?.endValue.amount).toBe('1010');
  });

  it('total - change = start value exactly, also with a long FX division (rounded wire amounts)', () => {
    const usd = pos('us', '7', 'USD', '333.33');
    const c = closes('us', [
      ['2026-09-01', '301.17'],
      ['2026-09-29', '330'],
    ]);
    const rates = [fx('USD', '1.1373', '2026-09-01'), fx('USD', '1.1711', '2026-09-30')];
    const { value, change } = summaryOf([usd], c, rates);
    expect(value.isComplete).toBe(true);
    expect(change?.endValue.amount).toBe(value.total.amount);
    const d = (v: string | null) => new Decimal(v as string);
    expect(
      d(value.total.amount)
        .minus(d(change?.change.amount ?? null))
        .toFixed(),
    ).toBe(d(change?.startValue.amount ?? null).toFixed());
    // The scenario really has more than 8 decimals before rounding (the property is not trivial).
    expect(
      parseDecimal('7')!.times('333.33').div('1.1711').toDecimalPlaces(20).decimalPlaces(),
    ).toBeGreaterThan(8);
  });

  it('a position with closes but no metrics row: partial total, so NO change (other set)', () => {
    const noMetrics = pos('nm', '5', 'EUR', null);
    const rows = [
      ...AI_CLOSES,
      ...closes('nm', [
        ['2026-09-01', '10'],
        ['2026-09-29', '12'],
      ]),
    ];
    const { value, series, change } = summaryOf(
      [pos('ai', '10', 'EUR', '105'), noMetrics],
      rows,
      [],
    );
    expect(value.isComplete).toBe(false);
    expect(value.missing).toEqual([{ positionId: 'nm', name: 'NM', reason: 'price_missing' }]);
    expect(value.total.amount).toBe('1050'); // partial: AI only
    expect(change).toBeNull(); // never the delta of AI + NM against a total of AI alone
    // The chart still shows its honest closes-only series (no terminal for an incomplete set).
    expect(series.points.at(-1)?.date).toBe('2026-09-29');
  });

  it.each([
    ['7 days old', '2026-09-23', true],
    ['8 days old', '2026-09-22', false],
    ['10 days old', '2026-09-20', false],
  ])('FX %s: %s -> change only when the total is complete', (_l, rateDate, complete) => {
    const usd = pos('us', '5', 'USD', '250');
    const c = closes('us', [
      ['2026-09-10', '240'],
      ['2026-09-29', '248'],
    ]);
    const { value, change } = summaryOf([usd], c, [
      fx('USD', '1.25', '2026-09-10'),
      fx('USD', '1.25', rateDate),
    ]);
    expect(value.isComplete).toBe(complete);
    if (complete) {
      expect(change?.toDate).toBe('2026-09-30');
      expect(change?.endValue.amount).toBe(value.total.amount);
    } else {
      expect(value.missing[0]?.reason).toBe('fx_missing');
      expect(value.total.amount).toBeNull();
      expect(change).toBeNull();
    }
  });

  it('a suspended listing: the tail trimmed without a terminal carries its REAL toDate', () => {
    // Domain level: the series built from closes only ends on the last complete day (09-05).
    const series = buildValueSeries({
      positions: [
        {
          id: 'a',
          quantity: new Decimal(1),
          currency: 'EUR',
          closes: rowsOf(['2026-09-01', '2026-09-05', '2026-09-30'], '100'),
        },
        {
          id: 's',
          quantity: new Decimal(1),
          currency: 'EUR',
          closes: rowsOf(['2026-09-01', '2026-09-05'], '50'),
        },
      ],
      fx: new Map(),
      from: '2026-09-01',
      to: '2026-09-30',
    });
    const value = computeCurrentValue([pos('a', '1', 'EUR', '100')], [], NOW, 7);
    const change = summaryChange(value, series);
    expect(change?.toDate).toBe('2026-09-05'); // not 2026-09-30: never labelled as current
  });

  it('a suspended listing with an old end price: the total and the terminal value it the same way', () => {
    const positions = [pos('ai', '10', 'EUR', '100'), pos('susp', '2', 'EUR', '50', '2026-09-01')];
    const rows = [
      ...closes('ai', [
        ['2026-08-28', '90'],
        ['2026-09-10', '95'],
        ['2026-09-30', '100'],
      ]),
      ...closes('susp', [
        ['2026-08-28', '48'],
        ['2026-09-01', '50'],
      ]),
    ];
    const { value, series, change } = summaryOf(positions, rows, []);
    expect(value.total.amount).toBe('1100'); // the old price is used and flagged stale, not hidden
    expect(value.freshness.stalePositions.map((p) => p.positionId)).toEqual(['susp']);
    expect(change?.toDate).toBe('2026-09-30');
    expect(change?.endValue.amount).toBe('1100');
    // The days between the tolerance and the end are not valued (trimmed/no data), only the terminal is.
    expect(series.points.at(-1)?.value?.toFixed()).toBe('1100');
  });
});

function rowsOf(dates: string[], close: string) {
  return dates.map((date) => ({ date, close: new Decimal(close) }));
}

describe('history wire (D22/D23)', () => {
  const gbx = pos('shel', '200', 'GBX', '2500', '2026-09-30');
  const shelCloses = closes('shel', [
    ['2026-09-01', '2000'],
    ['2026-09-15', '2250'],
    ['2026-09-29', '2400'],
  ]);

  it('current mode with GBX and a current rate dated before `to`: the real date, no per-point rates', () => {
    const rates = [fx('GBP', '0.8', '2026-09-01'), fx('GBP', '0.8', '2026-09-25')];
    const result = computeHistory([gbx], shelCloses, rates, '1m', '2026-09-30', CURRENT);
    const wireOut = historyToWire([gbx], result, '1m', '2026-09-30', 'current', NOW, 7);
    // 200 x 2500p = 200 x 25 GBP = 5000 GBP / 0.8 = 6250 EUR at the end; start 200 x 20 / 0.8 = 5000.
    expect(wireOut.points.map((p) => [p.date, p.value])).toEqual([
      ['2026-09-01', '5000'],
      ['2026-09-15', '5625'],
      ['2026-09-29', '6000'],
      ['2026-09-30', '6250'],
    ]);
    expect(wireOut.points.every((p) => p.fxRates.length === 0)).toBe(true);
    expect(wireOut.currentFxRates).toEqual([
      {
        currency: 'GBP', // a GBX position reports its GBP rate
        quotedCurrencies: ['GBX'],
        ratePerEur: '0.8',
        eurPerUnit: '1.25',
        rateDate: '2026-09-25',
        isStale: false, // 5 days old
      },
    ]);
    expect(wireOut.seriesEnd).toBe('2026-09-30');
    expect(wireOut.isStale).toBe(false);
  });

  it('flags a rate older than 7 days versus now, and a series end older than 5 days', () => {
    const old = [fx('GBP', '0.8', '2026-09-22')];
    const p = pos('shel', '200', 'GBX', '2500', '2026-09-22');
    const c = closes('shel', [
      ['2026-09-01', '2000'],
      ['2026-09-22', '2500'],
    ]);
    const result = computeHistory([p], c, old, '1m', '2026-09-22', CURRENT);
    const out = historyToWire([p], result, '1m', '2026-09-22', 'current', NOW, 7);
    expect(out.currentFxRates?.[0]).toMatchObject({ rateDate: '2026-09-22', isStale: true });
    expect(out.isStale).toBe(true);
    // The same data in historical mode flags through the rate applied at the end.
    const hist = computeHistory([p], c, old, '1m', '2026-09-22', HIST);
    expect(historyToWire([p], hist, '1m', '2026-09-22', 'historical', NOW, 7).isStale).toBe(true);
  });

  it('an empty space: no series end, not stale', () => {
    const out = historyToWire([], null, '1m', null, 'historical', NOW, 7);
    expect(out).toMatchObject({ seriesEnd: null, isStale: false, points: [] });
  });
});

describe('quotedCurrencies (pence note)', () => {
  const gbp = pos('bp', '1', 'GBP', '10');
  const gbx = pos('shel', '1', 'GBX', '2500');
  const usd = pos('us', '1', 'USD', '10');
  const watchGbx = pos('w', null, 'GBX', '100');

  it('lists the raw currencies a major rate serves: GBX only, GBP only, or both (sorted)', () => {
    expect(quotedCurrencies([gbx, usd])).toEqual(
      new Map([
        ['GBP', ['GBX']],
        ['USD', ['USD']],
      ]),
    );
    expect(quotedCurrencies([gbp]).get('GBP')).toEqual(['GBP']);
    expect(quotedCurrencies([gbx, gbp]).get('GBP')).toEqual(['GBP', 'GBX']);
    expect(quotedCurrencies([gbp, gbx, gbp, gbx]).get('GBP')).toEqual(['GBP', 'GBX']); // distinct
  });

  it('ignores EUR and watchlist entries (no rate is applied for them)', () => {
    expect(quotedCurrencies([pos('ai', '1', 'EUR', '10'), watchGbx])).toEqual(new Map());
  });

  it('is on the summary rates, the current rate and every point rate', () => {
    const rates = [fx('GBP', '0.8', '2026-09-01'), fx('GBP', '0.8', '2026-09-30')];
    const c = closes('shel', [
      ['2026-09-01', '2000'],
      ['2026-09-29', '2400'],
    ]);
    const value = computeCurrentValue([gbx, gbp], rates, NOW, 7);
    expect(value.fxRates).toEqual([
      { currency: 'GBP', ratePerEur: '0.8', date: '2026-09-30', quotedCurrencies: ['GBP', 'GBX'] },
    ]);
    const asOnlyGbx = computeCurrentValue([gbx], rates, NOW, 7);
    expect(asOnlyGbx.fxRates[0]?.quotedCurrencies).toEqual(['GBX']); // pence note applies
    const hist = computeHistory([gbx], c, rates, '1m', '2026-09-30', HIST);
    const out = historyToWire([gbx], hist, '1m', '2026-09-30', 'historical', NOW, 7);
    expect(out.points.every((p) => p.fxRates.every((f) => f.quotedCurrencies[0] === 'GBX'))).toBe(
      true,
    );
    expect(out.points.at(-1)?.fxRates).toHaveLength(1);
  });
});
