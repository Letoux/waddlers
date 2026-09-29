import { describe, expect, it } from 'vitest';
import { Decimal } from './decimal';
import { buildValueSeries, downsample, type FxHistory, type HistoryPosition } from './history';
import type { PricePoint } from './performance';
import { addDays } from './plain-date';

const D = (s: string) => new Decimal(s);
const closes = (rows: [string, string | null][]): PricePoint[] =>
  rows.map(([date, c]) => ({ date, close: c === null ? null : D(c) }));
const position = (
  id: string,
  quantity: string | null,
  currency: string,
  rows: [string, string | null][],
): HistoryPosition => ({
  id,
  quantity: quantity === null ? null : D(quantity),
  currency,
  closes: closes(rows),
});
const fxOf = (entries: Record<string, [string, string][]>): FxHistory =>
  new Map(
    Object.entries(entries).map(([ccy, rows]) => [
      ccy,
      rows.map(([date, rate]) => ({ date, rate: D(rate) })),
    ]),
  );
const vals = (r: ReturnType<typeof buildValueSeries>) =>
  r.points.map((p) => [p.date, p.value?.toFixed() ?? null]);

describe('downsample', () => {
  const seq = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('returns a copy unchanged when within the bound', () => {
    const input = seq(400);
    const out = downsample(input, 400);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(downsample([], 400)).toEqual([]);
  });

  it.each([401, 402, 1000, 1305, 5000])('bounds %i points to 400, keeping first/last', (n) => {
    const out = downsample(seq(n), 400);
    expect(out).toHaveLength(400);
    expect(out[0]).toBe(0);
    expect(out[399]).toBe(n - 1);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i] as number).toBeGreaterThan(out[i - 1] as number); // strictly increasing, no dupes
    }
  });

  it('is deterministic and supports tiny bounds', () => {
    expect(downsample(seq(1000), 400)).toEqual(downsample(seq(1000), 400));
    expect(downsample(seq(10), 2)).toEqual([0, 9]);
    expect(downsample(seq(10), 3)).toEqual([0, 4, 9]);
  });

  it('rejects invalid bounds', () => {
    expect(() => downsample([1, 2, 3], 1)).toThrow(RangeError);
    expect(() => downsample([1, 2, 3], 2.5)).toThrow(RangeError);
  });
});

describe('buildValueSeries (D6)', () => {
  const fx = fxOf({
    USD: [
      ['2026-06-01', '1.25'],
      ['2026-06-02', '1'],
      ['2026-06-03', '2'],
    ],
  });

  it('computes Σ current quantity × close × same-day FX, in EUR', () => {
    const r = buildValueSeries({
      positions: [
        position('eu', '10', 'EUR', [
          ['2026-06-01', '10'],
          ['2026-06-02', '11'],
          ['2026-06-03', '12'],
        ]),
        position('us', '2', 'USD', [
          ['2026-06-01', '125'],
          ['2026-06-02', '100'],
          ['2026-06-03', '200'],
        ]),
      ],
      fx,
      from: '2026-06-01',
      to: '2026-06-03',
    });
    // d1: 100 + 2*100 = 300 ; d2: 110 + 200 = 310 ; d3: 120 + 200 = 320
    expect(vals(r)).toEqual([
      ['2026-06-01', '300'],
      ['2026-06-02', '310'],
      ['2026-06-03', '320'],
    ]);
  });

  it('derives the headline and per-point evolution from the same series', () => {
    const r = buildValueSeries({
      positions: [
        position('eu', '10', 'EUR', [
          ['2026-06-01', '10'],
          ['2026-06-02', '11'],
          ['2026-06-03', '12'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-03',
    });
    expect(r.headline).toMatchObject({
      fromDate: '2026-06-01',
      toDate: '2026-06-03',
      startValue: expect.anything(),
    });
    expect(r.headline?.change.toFixed()).toBe('20');
    expect(r.headline?.changePct?.toFixed()).toBe('20');
    expect(r.points.map((p) => p.evolutionPct?.toFixed())).toEqual(['0', '10', '20']);
    expect(r.points.at(-1)?.value?.toFixed()).toBe(r.headline?.endValue.toFixed());
  });

  it('forward-fills closes and FX within tolerance', () => {
    const r = buildValueSeries({
      positions: [
        position('a', '1', 'EUR', [
          ['2026-06-01', '10'],
          ['2026-06-05', '20'],
        ]),
        position('b', '1', 'EUR', [
          ['2026-06-01', '1'],
          ['2026-06-02', '2'],
          ['2026-06-03', '3'],
          ['2026-06-04', '4'],
          ['2026-06-05', '5'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-05',
    });
    // a is held at 10 on days 2..4 (holiday on its exchange)
    expect(vals(r).map(([, v]) => v)).toEqual(['11', '12', '13', '14', '25']);
  });

  it('marks a day null when a position exceeds the tolerance, never a partial sum', () => {
    const r = buildValueSeries({
      positions: [
        position('a', '1', 'EUR', [['2026-06-01', '10']]),
        position('b', '1', 'EUR', [
          ['2026-06-01', '1'],
          ['2026-06-11', '2'],
          ['2026-06-12', '3'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-30',
      toleranceDays: 10,
    });
    // 06-11: a is 10 days old -> ok ; 06-12: 11 days old -> missing
    expect(vals(r)).toEqual([
      ['2026-06-01', '11'],
      ['2026-06-11', '12'],
      ['2026-06-12', null],
    ]);
    expect(r.points[2]?.missing).toEqual(['a']);
    expect(r.points[2]?.evolutionPct).toBeNull();
    expect(r.headline?.toDate).toBe('2026-06-11');
  });

  it('marks days null when FX is unavailable (no rate, or none within tolerance)', () => {
    const r = buildValueSeries({
      positions: [
        position('us', '1', 'USD', [
          ['2026-06-01', '100'],
          ['2026-06-02', '100'],
        ]),
      ],
      fx: fxOf({ USD: [['2026-06-02', '2']] }),
      from: '2026-06-01',
      to: '2026-06-02',
    });
    expect(vals(r)).toEqual([
      ['2026-06-01', null], // FX only starts on 06-02: never look forward
      ['2026-06-02', '50'],
    ]);
    expect(r.headline).toBeNull(); // only one complete point
  });

  it('handles minor units (GBX) with same-day FX', () => {
    const r = buildValueSeries({
      positions: [position('uk', '10', 'GBX', [['2026-06-01', '1000']])],
      fx: fxOf({ GBP: [['2026-06-01', '0.8']] }),
      from: '2026-06-01',
      to: '2026-06-01',
    });
    expect(vals(r)).toEqual([['2026-06-01', '125']]); // 10 × 10 GBP / 0.8
  });

  it('excludes watchlist quantities and honours the [from, to] range', () => {
    const r = buildValueSeries({
      positions: [
        position('w', null, 'EUR', [['2026-06-02', '999']]),
        position('h', '1', 'EUR', [
          ['2026-05-30', '1'],
          ['2026-06-01', '2'],
          ['2026-06-02', '3'],
          ['2026-06-09', '9'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-05',
    });
    expect(vals(r)).toEqual([
      ['2026-06-01', '2'],
      ['2026-06-02', '3'],
    ]);
  });

  it('returns an empty series and null headline when nothing can be plotted', () => {
    const empty = buildValueSeries({
      positions: [],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-02',
    });
    expect(empty).toEqual({ points: [], headline: null, totalPoints: 0 });
    const watch = buildValueSeries({
      positions: [position('w', null, 'EUR', [['2026-06-01', '1']])],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-02',
    });
    expect(watch.points).toEqual([]);
  });

  it('gives a null headline % when the start value is 0', () => {
    const r = buildValueSeries({
      positions: [
        position('a', '0', 'EUR', [
          ['2026-06-01', '5'],
          ['2026-06-02', '6'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-02',
    });
    expect(r.headline?.change.toFixed()).toBe('0');
    expect(r.headline?.changePct).toBeNull();
    expect(r.points.every((p) => p.evolutionPct === null)).toBe(true);
  });

  it('downsamples to <= 400 points, keeping first and last, headline from full series', () => {
    const rows: [string, string][] = Array.from({ length: 1000 }, (_, i) => [
      addDays('2020-01-01', i),
      String(100 + i),
    ]);
    const r = buildValueSeries({
      positions: [position('a', '1', 'EUR', rows)],
      fx: new Map(),
      from: '2020-01-01',
      to: addDays('2020-01-01', 999),
    });
    expect(r.totalPoints).toBe(1000);
    expect(r.points).toHaveLength(400);
    expect(r.points[0]?.date).toBe('2020-01-01');
    expect(r.points.at(-1)?.date).toBe(addDays('2020-01-01', 999));
    expect(r.headline?.startValue.toFixed()).toBe('100');
    expect(r.headline?.endValue.toFixed()).toBe('1099');
    expect(r.points.at(-1)?.evolutionPct?.toFixed()).toBe('999');
    const again = buildValueSeries({
      positions: [position('a', '1', 'EUR', rows)],
      fx: new Map(),
      from: '2020-01-01',
      to: addDays('2020-01-01', 999),
    });
    expect(again.points.map((p) => p.date)).toEqual(r.points.map((p) => p.date));
  });

  it('ignores null closes and non-positive FX points', () => {
    const r = buildValueSeries({
      positions: [
        position('us', '1', 'USD', [
          ['2026-06-01', '10'],
          ['2026-06-02', null],
        ]),
      ],
      fx: fxOf({
        USD: [
          ['2026-06-01', '0'],
          ['2026-06-01', '2'],
        ],
      }),
      from: '2026-06-01',
      to: '2026-06-02',
    });
    expect(vals(r)).toEqual([['2026-06-01', '5']]);
  });
});
