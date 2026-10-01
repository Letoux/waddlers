import { PERIODS, addDays, parseDecimal, targetBaseDate, type Period } from '@waddlers/domain';
import { DASHBOARD_PERIODS, dashboardPeriodSchema } from '@waddlers/contracts';
import { describe, expect, it } from 'vitest';
import {
  computeCurrentValue,
  computeHistory,
  computeMoverLists,
  foreignCurrencies,
} from './compute';
import type { CloseRow, FxRow, SpacePositionData } from './repository';

const NOW = new Date('2026-09-30T12:00:00Z');
const HIST = { mode: 'historical', fxToleranceDays: 7 } as const;
const PERF_NONE = { value: null, baseDate: null };
const PERF = (over: Partial<Record<Period, { value: string; baseDate: string }>> = {}) => ({
  '1w': PERF_NONE,
  '1m': PERF_NONE,
  '6m': PERF_NONE,
  '1y': PERF_NONE,
  '5y': PERF_NONE,
  max: PERF_NONE,
  ...over,
});

function pos(
  id: string,
  name: string,
  quantity: string | null,
  currency: string,
  price: string | null,
  asOfDate: string | null = '2026-09-30',
  perf: ReturnType<typeof PERF> = PERF(),
): SpacePositionData {
  return {
    id,
    quantity,
    instrumentId: `i-${id}`,
    name,
    listingId: `l-${id}`,
    symbol: id.toUpperCase(),
    exchangeMic: 'XPAR',
    exchangeName: 'Euronext Paris',
    currency,
    metrics: price === null ? null : { price, priceCurrency: currency, asOfDate, perf },
  };
}

const fx = (currency: string, ratePerEur: string, date = '2026-09-30'): FxRow => ({
  currency,
  ratePerEur,
  date,
});

// EUR 10 x 100 = 1000; USD 5 x 250 / 1.25 = 1000; GBX 200 x 2500p = 200 x 25 GBP / 0.85.
const ai = pos('ai', 'Air Liquide', '10', 'EUR', '100');
const msft = pos('msft', 'Microsoft', '5', 'USD', '250');
const shel = pos('shel', 'Shell', '200', 'GBX', '2500');
const RATES = [fx('USD', '1.25'), fx('GBP', '0.85')];

describe('the periods of the contract are the domain periods', () => {
  it('has the same six ids, and rejects anything else', () => {
    expect([...DASHBOARD_PERIODS]).toEqual([...PERIODS]);
    expect(dashboardPeriodSchema.safeParse('2y').success).toBe(false);
    expect(dashboardPeriodSchema.safeParse('').success).toBe(false);
    expect(dashboardPeriodSchema.safeParse('MAX').success).toBe(false);
  });
});

describe('computeCurrentValue', () => {
  it('sums EUR, USD (with FX) and GBX exactly, as a decimal string in EUR', () => {
    const v = computeCurrentValue([ai, msft, shel], RATES, NOW, 7);
    // 1000 + 1000 + 200 x 25 / 0.85 = 5882.352941176470588235... (rounded once, half-even, 8 dp)
    expect(v.total).toEqual({ amount: '7882.35294118', currency: 'EUR' });
    expect(v.isComplete).toBe(true);
    expect(v.missing).toEqual([]);
    expect([v.heldCount, v.valuedCount, v.watchlistCount]).toEqual([3, 3, 0]);
    expect(v.fxRates).toEqual([
      { currency: 'GBP', ratePerEur: '0.85', date: '2026-09-30', quotedCurrencies: ['GBX'] },
      { currency: 'USD', ratePerEur: '1.25', date: '2026-09-30', quotedCurrencies: ['USD'] },
    ]);
  });

  it('a missing FX rate gives a partial total with missing[], never 0 and never rate 1', () => {
    const v = computeCurrentValue([ai, msft], [], NOW, 7);
    expect(v.total.amount).toBe('1000');
    expect(v.isComplete).toBe(false);
    expect(v.missing).toEqual([{ positionId: 'msft', name: 'Microsoft', reason: 'fx_missing' }]);
    expect(v.valuedCount).toBe(1);
  });

  it('a missing price (no metrics row, or no price) is reported, not valued as 0', () => {
    const noRow = pos('new', 'Newco', '3', 'EUR', null);
    const v = computeCurrentValue([ai, noRow], [], NOW, 7);
    expect(v.total.amount).toBe('1000');
    expect(v.missing).toEqual([{ positionId: 'new', name: 'Newco', reason: 'price_missing' }]);
  });

  it('nothing valued: total amount is null, not 0', () => {
    const v = computeCurrentValue([pos('new', 'Newco', '3', 'EUR', null)], [], NOW, 7);
    expect(v.total).toEqual({ amount: null, currency: 'EUR' });
    expect(v.isComplete).toBe(false);
    expect(v.freshness.oldestPriceDate).toBeNull();
  });

  it('an empty space has a null total, is complete and has no freshness', () => {
    const v = computeCurrentValue([], [], NOW, 7);
    expect(v.total.amount).toBeNull();
    expect(v.isComplete).toBe(true);
    expect([v.heldCount, v.valuedCount, v.watchlistCount]).toEqual([0, 0, 0]);
    expect(v.freshness).toMatchObject({ oldestPriceDate: null, fxAsOf: null, isStale: false });
  });

  it('excludes watchlist entries (null quantity) from the value without calling them missing', () => {
    const watch = pos('cw8', 'World ETF', null, 'EUR', '80');
    const v = computeCurrentValue([ai, watch], [], NOW, 7);
    expect(v.total.amount).toBe('1000');
    expect(v.isComplete).toBe(true);
    expect(v.missing).toEqual([]);
    expect([v.heldCount, v.valuedCount, v.watchlistCount]).toEqual([1, 1, 1]);
  });

  it('a quantity of 0 is a real 0 value (not missing)', () => {
    const v = computeCurrentValue([pos('z', 'Zero', '0', 'EUR', '10')], [], NOW, 7);
    expect(v.total.amount).toBe('0');
    expect(v.valuedCount).toBe(1);
  });

  it('ignores an FX rate older than the tolerance or dated after the space as-of', () => {
    const old = computeCurrentValue([msft], [fx('USD', '1.25', '2026-09-20')], NOW, 7);
    expect(old.missing[0]?.reason).toBe('fx_missing');
    const future = computeCurrentValue([msft], [fx('USD', '1.25', '2026-10-01')], NOW, 7);
    expect(future.missing[0]?.reason).toBe('fx_missing');
  });

  it('uses the newest rate on or before the as-of date within tolerance', () => {
    const v = computeCurrentValue(
      [msft],
      [fx('USD', '2', '2026-09-26'), fx('USD', '1.25', '2026-09-28')],
      NOW,
      7,
    );
    expect(v.total.amount).toBe('1000');
    expect(v.freshness.fxAsOf).toBe('2026-09-28');
  });

  it('flags a stale price (older than 5 days) with oldestPriceDate = the oldest input date', () => {
    const stale = pos('old', 'Old Corp', '1', 'EUR', '50', '2026-09-20');
    const v = computeCurrentValue([ai, stale], [], NOW, 7);
    expect(v.freshness.oldestPriceDate).toBe('2026-09-20');
    expect(v.freshness.isStale).toBe(true);
    expect(v.freshness.stalePositions).toEqual([
      { positionId: 'old', name: 'Old Corp', asOf: '2026-09-20' },
    ]);
    // The stale value is still counted (labelled, not hidden) and never 0.
    expect(v.total.amount).toBe('1050');
  });

  // 2026-09-30 is a Wednesday: Friday 09-25 is 5 days old (weekend + nothing), Thursday 09-24 is 6.
  it.each([
    ['2026-09-25', false],
    ['2026-09-24', true],
  ])(
    'a price dated %s is stale: %s (5-day boundary, versus the current UTC date)',
    (date, stale) => {
      const p = pos('p', 'Price', '1', 'EUR', '10', date);
      expect(computeCurrentValue([p], [], NOW, 7).freshness.isStale).toBe(stale);
    },
  );

  it.each([
    ['2026-09-23', false], // 7 days before NOW
    ['2026-09-22', true], // 8 days before NOW
  ])('an FX rate dated %s is stale: %s (7-day boundary), flagged on its own', (date, stale) => {
    // Fresh price (Friday 09-25, 5 days old), rate used within 7 days of the as-of date.
    const usd = pos('u', 'Usd', '1', 'USD', '10', '2026-09-25');
    const v = computeCurrentValue([usd], [fx('USD', '1.25', date)], NOW, 7);
    expect(v.missing).toEqual([]);
    expect(v.freshness.stalePositions).toEqual([]);
    expect(v.freshness.staleFx).toEqual(stale ? [{ currency: 'USD', date }] : []);
    expect(v.freshness.isStale).toBe(stale);
  });

  it('a watchlist entry in a foreign currency needs no FX and does not appear in fxRates', () => {
    const watchUsd = pos('w', 'Watch Inc', null, 'USD', '10');
    expect(foreignCurrencies([ai, watchUsd])).toEqual([]);
    const v = computeCurrentValue([ai, watchUsd], [fx('USD', '1.25')], NOW, 7);
    expect(v.fxRates).toEqual([]);
    expect(v.freshness.fxAsOf).toBeNull();
    expect(v.total.amount).toBe('1000');
  });

  it('lists the foreign currencies to read once, sorted, majors only', () => {
    expect(foreignCurrencies([ai, msft, shel, msft])).toEqual(['GBP', 'USD']);
  });
});

/** Weekday closes over `years` years ending 2026-09-30: close(i) = 100 + i / 100. */
function weekdayCloses(listingId: string, from: string, to: string, offset = 0): CloseRow[] {
  const rows: CloseRow[] = [];
  let i = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    rows.push({ listingId, date: d, close: (100 + offset + i / 100).toFixed(2) });
    i += 1;
  }
  return rows;
}

describe('computeHistory', () => {
  const held = pos('ai', 'Air Liquide', '10', 'EUR', '100');

  it('each period starts at its target (or the first close for max), headline = series endpoints', () => {
    const closes = weekdayCloses('l-ai', '2020-01-01', '2026-09-30');
    const byDate = new Map(closes.map((c) => [c.date, c.close]));
    // The end price (D21) of the listing equals its last close: the terminal point (D23) coincides.
    const held = pos('ai', 'Air Liquide', '10', 'EUR', byDate.get('2026-09-30') ?? null);
    const expectedFrom: Record<Period, string> = {
      '1w': '2026-09-23',
      '1m': '2026-08-30',
      '6m': '2026-03-30',
      '1y': '2025-09-30',
      '5y': '2021-09-30',
      max: '2020-01-01',
    };
    for (const period of PERIODS) {
      const { series, from } = computeHistory([held], closes, [], period, '2026-09-30', HIST);
      const target = targetBaseDate(period, '2026-09-30');
      expect(from, period).toBe(target ?? '2020-01-01');
      const h = series.headline!;
      expect(h.fromDate, period).toBe(period === 'max' ? '2020-01-01' : expectedFrom[period]);
      expect(h.toDate).toBe('2026-09-30');
      // Values are quantity x close of the exact base/end trading days: hand-checkable.
      const startClose = parseDecimal(byDate.get(h.baseDate) ?? null)!;
      const endClose = parseDecimal(byDate.get('2026-09-30') ?? null)!;
      expect(h.startValue.toFixed(), period).toBe(startClose.times(10).toFixed());
      expect(h.endValue.toFixed()).toBe(endClose.times(10).toFixed());
      expect(h.change.toFixed()).toBe(endClose.minus(startClose).times(10).toFixed());
      // Chart endpoints equal the headline endpoints; at most 400 points.
      const first = series.points[0]!;
      const last = series.points[series.points.length - 1]!;
      expect(first.date).toBe(h.fromDate);
      expect(last.date).toBe(h.toDate);
      expect(first.value!.toFixed()).toBe(h.startValue.toFixed());
      expect(last.value!.toFixed()).toBe(h.endValue.toFixed());
      expect(series.points.length).toBeLessThanOrEqual(400);
    }
  });

  it('a recently listed position trims the start (D20) and is named in leadingMissing', () => {
    const recent = pos('new', 'Newco', '1', 'EUR', '50');
    const closes = [
      ...weekdayCloses('l-ai', '2026-07-01', '2026-09-30'),
      { listingId: 'l-new', date: '2026-09-15', close: '50.00' },
      { listingId: 'l-new', date: '2026-09-30', close: '55.00' },
    ];
    const { series } = computeHistory([held, recent], closes, [], '1m', '2026-09-30', HIST);
    expect(series.leadingMissing).toEqual(['new']);
    expect(series.points[0]?.date).toBe('2026-09-15');
    expect(series.headline?.fromDate).toBe('2026-09-15');
    // No point before the creation of Newco, and no partial sum on the trimmed days.
    expect(series.points.every((p) => p.date >= '2026-09-15')).toBe(true);
  });

  it('a missing FX rate makes every day null: empty series, never a partial sum', () => {
    const usd = pos('msft', 'Microsoft', '5', 'USD', '250');
    const closes = weekdayCloses('l-msft', '2026-08-01', '2026-09-30');
    const { series } = computeHistory([held, usd], [...closes], [], '1m', '2026-09-30', HIST);
    expect(series.points).toEqual([]);
    expect(series.headline).toBeNull();
    expect(series.leadingMissing).toContain('msft');
  });

  it('watchlist positions never enter the series', () => {
    const watch = pos('cw8', 'World ETF', null, 'EUR', '80');
    const closes = weekdayCloses('l-ai', '2026-07-01', '2026-09-30');
    const withWatch = computeHistory([held, watch], closes, [], '1m', '2026-09-30', HIST);
    const without = computeHistory([held], closes, [], '1m', '2026-09-30', HIST);
    expect(withWatch.series.points).toEqual(without.series.points);
  });
});

describe('computeMoverLists', () => {
  const perf = (value: string) => PERF({ '1m': { value, baseDate: '2026-08-28' } });
  const list = [
    pos('a', 'Alpha', '1', 'EUR', '1', '2026-09-30', perf('10.5')),
    pos('b', 'beta', '1', 'EUR', '1', '2026-09-30', perf('25')),
    pos('c', 'Charlie', null, 'EUR', '1', '2026-09-30', perf('25')),
    pos('d', 'Delta', '1', 'GBX', '1', '2026-09-30', perf('-3')),
    pos('e', 'Echo', '1', 'EUR', '1', '2026-09-30', perf('-40.123456789')),
    pos('f', 'Foxtrot', '1', 'EUR', '1', '2026-09-30', PERF()),
    pos('g', 'Golf', '1', 'EUR', '1', '2026-09-30', perf('0')),
    pos('h', 'Hotel', '1', 'EUR', null),
  ];

  it('orders gainers desc / losers asc, breaks ties by name, excludes null and zero', () => {
    const m = computeMoverLists(list, '1m');
    expect(m.gainers.map((r) => r.positionId)).toEqual(['b', 'c', 'a']);
    expect(m.losers.map((r) => r.positionId)).toEqual(['e', 'd']);
  });

  it('includes watchlist entries (D9) and carries display fields, dates and local currency', () => {
    const c = computeMoverLists(list, '1m').gainers.find((r) => r.positionId === 'c')!;
    expect(c).toMatchObject({
      name: 'Charlie',
      symbol: 'C',
      exchange: { mic: 'XPAR', name: 'Euronext Paris' },
      performancePct: '25',
      baseDate: '2026-08-28',
      asOf: '2026-09-30',
      currency: 'EUR',
    });
    expect(computeMoverLists(list, '1m').losers[1]?.currency).toBe('GBX');
  });

  it('rounds the percentage once to 8 decimals as a string', () => {
    expect(computeMoverLists(list, '1m').losers[0]?.performancePct).toBe('-40.12345679');
  });

  it('caps each list at 5 and uses the requested period only', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      pos(`p${i}`, `P${i}`, '1', 'EUR', '1', '2026-09-30', perf(String(i + 1))),
    );
    expect(computeMoverLists(many, '1m').gainers.map((r) => r.performancePct)).toEqual([
      '9',
      '8',
      '7',
      '6',
      '5',
    ]);
    expect(computeMoverLists(many, '1y')).toEqual({ gainers: [], losers: [] });
  });
});

describe('computeHistory FX modes (D22)', () => {
  // 10 USD shares at a constant 100 USD: only the rate moves the EUR value.
  const usd = pos('us', 'Us Corp', '10', 'USD', '100');
  const flat: CloseRow[] = ['2026-08-28', '2026-09-15', '2026-09-30'].map((date) => ({
    listingId: 'l-us',
    date,
    close: '100',
  }));
  const rate = (date: string, r: string) => fx('USD', r, date);
  const moving = [rate('2026-08-28', '1'), rate('2026-09-15', '1.25'), rate('2026-09-30', '2')];
  const CURRENT = { mode: 'current', fxToleranceDays: 7 } as const;
  const values = (r: ReturnType<typeof computeHistory>) =>
    r.series.points.map((p) => [p.date, p.value?.toFixed() ?? null]);

  it('historical: each point uses its own day rate and the headline follows the series', () => {
    const r = computeHistory([usd], flat, moving, '1m', '2026-09-30', HIST);
    expect(values(r)).toEqual([
      ['2026-08-30', '1000'],
      ['2026-09-15', '800'],
      ['2026-09-30', '500'],
    ]);
    expect(r.series.headline?.change.toFixed()).toBe('-500');
    expect(r.series.headline?.changePct?.toFixed()).toBe('-50');
    expect(r.currentFx).toBeNull();
    // Tooltip rates: the rate applied to the point, with the date of the stored rate.
    expect(r.series.points.map((p) => p.fx.map((f) => [f.rate.toFixed(), f.date]))).toEqual([
      [['1', '2026-08-28']],
      [['1.25', '2026-09-15']],
      [['2', '2026-09-30']],
    ]);
  });

  it('current: every point uses the latest rate, so a rate move no longer changes the series', () => {
    const r = computeHistory([usd], flat, moving, '1m', '2026-09-30', CURRENT);
    expect(values(r)).toEqual([
      ['2026-08-30', '500'],
      ['2026-09-15', '500'],
      ['2026-09-30', '500'],
    ]);
    expect(r.series.headline?.change.toFixed()).toBe('0');
    expect(r.currentFx).toEqual([rate('2026-09-30', '2')]);
  });

  it('a missing historical rate gives a null day (never rate 1); current mode has the rate', () => {
    const late = [rate('2026-09-15', '1.25'), rate('2026-09-30', '2')];
    const hist = computeHistory([usd], flat, late, '1m', '2026-09-30', HIST);
    expect(values(hist)).toEqual([
      ['2026-09-15', '800'],
      ['2026-09-30', '500'],
    ]);
    expect(hist.series.leadingMissing).toEqual(['us']);
    const current = computeHistory([usd], flat, late, '1m', '2026-09-30', CURRENT);
    expect(values(current)[0]).toEqual(['2026-08-30', '500']);
    expect(current.series.leadingMissing).toEqual([]);
  });

  it('current mode with no current rate (too old or none): empty series, never a fallback to 1', () => {
    const old = [rate('2026-08-28', '1')];
    const current = computeHistory([usd], flat, old, '1m', '2026-09-30', CURRENT);
    expect(current.series.points).toEqual([]);
    expect(current.series.headline).toBeNull();
    expect(current.series.leadingMissing).toEqual(['us']);
    expect(current.currentFx).toEqual([]);
    const none = computeHistory([usd], flat, [], '1m', '2026-09-30', CURRENT);
    expect(none.series.points).toEqual([]);
    expect(none.currentFx).toEqual([]);
  });

  it('EUR-only spaces carry no FX in either mode', () => {
    const eurPos = pos('eu', 'Eu Corp', '1', 'EUR', '10');
    const closes: CloseRow[] = flat.map((c) => ({ ...c, listingId: 'l-eu' }));
    for (const mode of [HIST, CURRENT]) {
      const r = computeHistory([eurPos], closes, [], '1m', '2026-09-30', mode);
      expect(r.series.points.every((p) => p.fx.length === 0)).toBe(true);
    }
  });
});
