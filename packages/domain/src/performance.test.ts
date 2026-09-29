import { describe, expect, it } from 'vitest';
import { Decimal } from './decimal';
import {
  cleanSeries,
  closeOnOrBefore,
  computePerformance,
  findBasePrice,
  type PricePoint,
} from './performance';

const pt = (date: string, close: string | null): PricePoint => ({
  date,
  close: close === null ? null : new Decimal(close),
});
const D = (s: string) => new Decimal(s);

// 2026-06-18 is a Thursday. 2026-06-13/14 weekend.
const series: PricePoint[] = [
  pt('2025-06-16', '100'), // Monday
  pt('2025-12-17', '80'),
  pt('2025-12-18', '90'),
  pt('2026-05-15', '110'), // Friday
  pt('2026-06-10', '120'),
  pt('2026-06-11', '125'),
  pt('2026-06-12', '130'), // Friday
  pt('2026-06-15', '128'),
  pt('2026-06-18', '140'),
];

describe('cleanSeries', () => {
  it('sorts, drops null closes and lets the last duplicate win', () => {
    const out = cleanSeries([
      pt('2026-01-03', '3'),
      pt('2026-01-01', '1'),
      pt('2026-01-02', null),
      pt('2026-01-03', '33'),
    ]);
    expect(out.map((p) => [p.date, p.close.toFixed()])).toEqual([
      ['2026-01-01', '1'],
      ['2026-01-03', '33'],
    ]);
  });

  it('rejects malformed dates', () => {
    expect(() => cleanSeries([pt('2026-02-30', '1')])).toThrow(RangeError);
  });
});

describe('findBasePrice', () => {
  it('uses the close on the target date when it is a trading day', () => {
    const r = findBasePrice(series, '2026-06-11');
    expect(r).toMatchObject({ ok: true, date: '2026-06-11' });
  });

  it('falls back to the nearest earlier trading day (weekend)', () => {
    const r = findBasePrice(series, '2026-06-14'); // Sunday -> Friday 12th
    expect(r).toMatchObject({ ok: true, date: '2026-06-12' });
    expect(r.ok && r.close.toFixed()).toBe('130');
  });

  it('never looks forward (holiday gap picks the earlier day)', () => {
    const r = findBasePrice(series, '2026-06-17'); // 06-16/17 missing
    expect(r).toMatchObject({ ok: true, date: '2026-06-15' });
  });

  it('accepts a gap exactly at the tolerance and rejects one day beyond', () => {
    // last point before 2026-05-25 is 2026-05-15 -> gap 10
    expect(findBasePrice(series, '2026-05-25')).toMatchObject({ ok: true, date: '2026-05-15' });
    expect(findBasePrice(series, '2026-05-26')).toEqual({
      ok: false,
      reason: 'gap_exceeds_tolerance',
      date: '2026-05-15',
    });
  });

  it('honours a custom tolerance', () => {
    expect(findBasePrice(series, '2026-05-18', { toleranceDays: 3 }).ok).toBe(true);
    expect(findBasePrice(series, '2026-05-19', { toleranceDays: 3 }).ok).toBe(false);
    expect(findBasePrice(series, '2026-05-15', { toleranceDays: 0 }).ok).toBe(true);
    expect(findBasePrice(series, '2026-05-16', { toleranceDays: 0 }).ok).toBe(false);
  });

  it('fails when history starts after the target', () => {
    expect(findBasePrice(series, '2025-06-15')).toEqual({
      ok: false,
      reason: 'history_starts_after_target',
      date: null,
    });
  });

  it('fails on an empty or all-null series', () => {
    expect(findBasePrice([], '2026-06-18')).toMatchObject({ ok: false, reason: 'empty_series' });
    expect(findBasePrice([pt('2026-06-01', null)], '2026-06-18')).toMatchObject({
      ok: false,
      reason: 'empty_series',
    });
  });

  it.each(['0', '-5'])('fails on a non-positive base (%s)', (close) => {
    expect(findBasePrice([pt('2026-06-01', close)], '2026-06-02')).toEqual({
      ok: false,
      reason: 'non_positive_base',
      date: '2026-06-01',
    });
  });

  it('skips null closes when searching backwards', () => {
    const s = [pt('2026-06-01', '10'), pt('2026-06-02', null)];
    expect(findBasePrice(s, '2026-06-03')).toMatchObject({ ok: true, date: '2026-06-01' });
  });

  it('does not depend on input order', () => {
    const shuffled = [...series].reverse();
    expect(findBasePrice(shuffled, '2026-06-14')).toMatchObject({ ok: true, date: '2026-06-12' });
  });
});

describe('closeOnOrBefore', () => {
  it('respects tolerance', () => {
    expect(closeOnOrBefore(series, '2026-06-14')?.date).toBe('2026-06-12');
    expect(closeOnOrBefore(series, '2026-05-26')).toBeNull();
    expect(closeOnOrBefore(series, '2025-01-01')).toBeNull();
  });
});

describe('computePerformance', () => {
  const asOf = '2026-06-18';

  it('1w: (end/base − 1) × 100 with exact decimals', () => {
    // target 2026-06-11 -> 125 ; 140/125 − 1 = 0.12
    const r = computePerformance({ series, period: '1w', asOf, end: D('140') });
    expect(r.value?.toFixed()).toBe('12');
    expect(r.baseDate).toBe('2026-06-11');
  });

  it('1m falls back over a weekend/holiday-free gap to the previous trading day', () => {
    // target 2026-05-18 (Mon), previous point 2026-05-15 (110) gap 3
    const r = computePerformance({ series, period: '1m', asOf, end: D('140') });
    expect(r.baseDate).toBe('2026-05-15');
    expect(r.value?.toFixed()).toBe('27.2727272727272727272727272727272727273');
  });

  it('6m base on 2025-12-18', () => {
    const r = computePerformance({ series, period: '6m', asOf, end: D('135') });
    expect(r.baseDate).toBe('2025-12-18');
    expect(r.value?.toFixed()).toBe('50');
  });

  it('1y base on 2025-06-18 uses the earlier Monday within tolerance', () => {
    const r = computePerformance({ series, period: '1y', asOf, end: D('150') });
    expect(r.baseDate).toBe('2025-06-16');
    expect(r.value?.toFixed()).toBe('50');
  });

  it('5y is unavailable when history is too short', () => {
    const r = computePerformance({ series, period: '5y', asOf, end: D('140') });
    expect(r).toEqual({ value: null, baseDate: null, reason: 'history_starts_after_target' });
  });

  it('returns a negative performance', () => {
    const r = computePerformance({ series, period: '1w', asOf, end: D('100') });
    expect(r.value?.toFixed()).toBe('-20');
  });

  it('reports 0 for an unchanged price (a real value, not unavailable)', () => {
    const r = computePerformance({ series, period: '1w', asOf, end: D('125') });
    expect(r.value?.toFixed()).toBe('0');
  });

  it('is unavailable when the end price is missing or invalid', () => {
    expect(computePerformance({ series, period: '1w', asOf, end: null })).toEqual({
      value: null,
      baseDate: null,
      reason: 'end_missing',
    });
    expect(computePerformance({ series, period: '1w', asOf, end: D('0') }).value).toBeNull();
    expect(computePerformance({ series, period: '1w', asOf, end: D('-1') })).toMatchObject({
      reason: 'end_invalid',
    });
  });

  it('propagates base unavailability with the reason and known base date', () => {
    const r = computePerformance({
      series: [pt('2026-06-11', '0')],
      period: '1w',
      asOf,
      end: D('10'),
    });
    expect(r).toEqual({ value: null, baseDate: '2026-06-11', reason: 'non_positive_base' });
    expect(computePerformance({ series: [], period: '1w', asOf, end: D('10') })).toMatchObject({
      value: null,
      reason: 'empty_series',
    });
  });

  it('applies the tolerance option', () => {
    const r = computePerformance({
      series,
      period: '1m',
      asOf,
      end: D('140'),
      toleranceDays: 2,
    });
    expect(r).toMatchObject({ value: null, reason: 'gap_exceeds_tolerance' });
  });

  describe('max (D14)', () => {
    it('is unavailable without historyCompleteFrom', () => {
      expect(computePerformance({ series, period: 'max', asOf, end: D('140') })).toEqual({
        value: null,
        baseDate: null,
        reason: 'history_completeness_unknown',
      });
      expect(
        computePerformance({
          series,
          period: 'max',
          asOf,
          end: D('140'),
          historyCompleteFrom: null,
        }),
      ).toMatchObject({ reason: 'history_completeness_unknown' });
    });

    it('uses the first datapoint on/after the completeness boundary', () => {
      const r = computePerformance({
        series,
        period: 'max',
        asOf,
        end: D('150'),
        historyCompleteFrom: '2025-06-16',
      });
      expect(r.baseDate).toBe('2025-06-16');
      expect(r.value?.toFixed()).toBe('50');
    });

    it('ignores points before the boundary (incomplete/partial history)', () => {
      const r = computePerformance({
        series,
        period: 'max',
        asOf,
        end: D('180'),
        historyCompleteFrom: '2025-12-01',
      });
      expect(r.baseDate).toBe('2025-12-17');
      expect(r.value?.toFixed()).toBe('125');
    });

    it('fails on a non-positive first point and on a lone as-of datapoint', () => {
      expect(
        computePerformance({
          series: [pt('2026-01-05', '0'), pt('2026-06-18', '5')],
          period: 'max',
          asOf,
          end: D('5'),
          historyCompleteFrom: '2026-01-01',
        }),
      ).toEqual({ value: null, baseDate: '2026-01-05', reason: 'non_positive_base' });
      expect(
        computePerformance({
          series: [pt('2026-06-18', '5')],
          period: 'max',
          asOf,
          end: D('5'),
          historyCompleteFrom: '2026-01-01',
        }),
      ).toEqual({ value: null, baseDate: '2026-06-18', reason: 'insufficient_history' });
    });

    it('is unavailable when no datapoint exists after the boundary', () => {
      expect(
        computePerformance({
          series,
          period: 'max',
          asOf,
          end: D('1'),
          historyCompleteFrom: '2027-01-01',
        }),
      ).toMatchObject({ value: null, reason: 'empty_series' });
    });
  });
});
