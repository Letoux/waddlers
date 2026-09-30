import { describe, expect, it } from 'vitest';
import { Decimal as DecimalBase } from 'decimal.js';
import { Decimal } from './decimal';
import { buildValueSeries, downsample, type FxHistory, type HistoryPosition } from './history';
import { computePerformance, type PricePoint } from './performance';
import { targetBaseDate } from './period';
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

  it('picks documented indices and supports tiny bounds', () => {
    const out = downsample(seq(1000), 400);
    // index i -> floor(i * 999 / 399)
    expect([out[1], out[2], out[200], out[398]]).toEqual([2, 5, 500, 996]);
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

  it('marks a middle day null when a position exceeds the tolerance, never a partial sum', () => {
    const r = buildValueSeries({
      positions: [
        position('a', '1', 'EUR', [
          ['2026-06-01', '10'],
          ['2026-06-20', '30'],
        ]),
        position('b', '1', 'EUR', [
          ['2026-06-01', '1'],
          ['2026-06-11', '2'],
          ['2026-06-12', '3'],
          ['2026-06-20', '5'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-30',
      toleranceDays: 10,
    });
    // 06-11: a is 10 days old -> ok ; 06-12: 11 days old -> missing (gap kept)
    expect(vals(r)).toEqual([
      ['2026-06-01', '11'],
      ['2026-06-11', '12'],
      ['2026-06-12', null],
      ['2026-06-20', '35'],
    ]);
    expect(r.points[2]?.missing).toEqual(['a']);
    expect(r.points[2]?.evolutionPct).toBeNull();
    expect(r.headline?.toDate).toBe('2026-06-20');
  });

  it('trims leading and trailing null points so endpoints equal the headline (D20)', () => {
    const r = buildValueSeries({
      positions: [
        position('old', '1', 'EUR', [
          ['2026-06-01', '10'],
          ['2026-06-02', '10'],
          ['2026-06-03', '10'],
          ['2026-06-04', '10'],
          ['2026-06-05', '10'],
          ['2026-06-08', '10'],
        ]),
        // recent listing: nothing before 06-03; delisted-like gap after 06-04
        position('new', '1', 'EUR', [
          ['2026-06-03', '1'],
          ['2026-06-04', '2'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-08',
      toleranceDays: 1,
    });
    expect(vals(r)).toEqual([
      ['2026-06-03', '11'],
      ['2026-06-04', '12'],
      ['2026-06-05', '12'], // carried 1 day; 06-08 is 4 days after its last close -> trimmed
    ]);
    expect(r.headline).toMatchObject({ fromDate: '2026-06-03', toDate: '2026-06-05' });
    expect(r.points[0]?.value?.toFixed()).toBe(r.headline?.startValue.toFixed());
    expect(r.points.at(-1)?.value?.toFixed()).toBe(r.headline?.endValue.toFixed());
  });

  it('marks days null when FX is unavailable and trims the leading one', () => {
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
    // FX only starts on 06-02: never look forward, so 06-01 is null and trimmed
    expect(vals(r)).toEqual([['2026-06-02', '50']]);
    expect(r.headline).toBeNull(); // only one complete point
    expect(r.points[0]?.evolutionPct).toBeNull(); // no headline -> no evolution
  });

  it('carries FX forward up to the tolerance and no further', () => {
    const args = (to: string) => ({
      positions: [
        position('us', '1', 'USD', [
          ['2026-06-01', '100'],
          [to, '100'],
        ]),
      ],
      fx: fxOf({ USD: [['2026-06-01', '2']] }),
      from: '2026-06-01',
      to,
      toleranceDays: 10,
    });
    expect(vals(buildValueSeries(args('2026-06-11'))).at(-1)).toEqual(['2026-06-11', '50']);
    // 11 days after the last rate: FX missing -> trailing null trimmed away
    expect(vals(buildValueSeries(args('2026-06-12')))).toEqual([['2026-06-01', '50']]);
  });

  it('treats a close <= 0 as missing: carried forward within tolerance, never a 0 value', () => {
    const rows: [string, string][] = [
      ['2026-06-01', '10'],
      ['2026-06-02', '0'],
      ['2026-06-03', '-4'],
      ['2026-06-04', '12'],
    ];
    const r = buildValueSeries({
      positions: [position('a', '3', 'EUR', rows)],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-04',
    });
    expect(vals(r)).toEqual([
      ['2026-06-01', '30'],
      ['2026-06-04', '36'],
    ]);
    // beyond tolerance the position is missing instead
    const gap = buildValueSeries({
      positions: [
        position('a', '1', 'EUR', [
          ['2026-06-01', '10'],
          ['2026-06-05', '0'],
          ['2026-06-09', '8'],
        ]),
        position('b', '1', 'EUR', [
          ['2026-06-01', '1'],
          ['2026-06-05', '1'],
          ['2026-06-09', '1'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-09',
      toleranceDays: 2,
    });
    expect(vals(gap)).toEqual([
      ['2026-06-01', '11'],
      ['2026-06-05', null],
      ['2026-06-09', '9'],
    ]);
    expect(gap.points[1]?.missing).toEqual(['a']);
  });

  it.each(['-1', 'NaN', 'Infinity'])('handles invalid quantity %s like valuation', (q) => {
    const r = buildValueSeries({
      positions: [
        position('bad', q, 'EUR', [
          ['2026-06-01', '10'],
          ['2026-06-02', '11'],
        ]),
        position('ok', '1', 'EUR', [
          ['2026-06-01', '1'],
          ['2026-06-02', '2'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-02',
    });
    expect(r.points).toEqual([]);
    expect(r.headline).toBeNull();
    expect(r.invalidPositions).toEqual([{ positionId: 'bad', reason: 'quantity_invalid' }]);
  });

  it('starts the headline at the period target like computePerformance (weekend target)', () => {
    const rows: [string, string][] = [
      ['2026-06-05', '100'], // Friday
      ['2026-06-08', '104'],
      ['2026-06-12', '110'],
      ['2026-06-15', '105'],
    ];
    const asOf = '2026-06-14'; // Sunday
    const target = targetBaseDate('1w', asOf) as string; // Sunday 2026-06-07
    const r = buildValueSeries({
      positions: [position('a', '2', 'EUR', rows)],
      fx: new Map(),
      from: target,
      to: '2026-06-15',
    });
    const perf = computePerformance({
      series: closes(rows),
      period: '1w',
      asOf,
      end: D('105'),
    });
    // base is Friday 06-05 (100) in both; the series carries it to the Sunday target date
    expect(perf.baseDate).toBe('2026-06-05');
    expect(r.headline?.fromDate).toBe(target);
    expect(r.headline?.startValue.toFixed()).toBe('200');
    expect(r.headline?.changePct?.toFixed()).toBe(perf.value?.toFixed());
    // label with the real trading day, not the Sunday target
    expect(r.headline?.baseDate).toBe('2026-06-05');
    expect(r.points[0]).toMatchObject({ date: target, dataDate: '2026-06-05' });
    expect(r.points[1]?.dataDate).toBe('2026-06-08');
  });

  it('starts later (fromDate stated) when a recent listing has no complete point at the target', () => {
    const r = buildValueSeries({
      positions: [
        position('old', '1', 'EUR', [
          ['2026-06-01', '10'],
          ['2026-06-10', '10'],
          ['2026-06-11', '10'],
        ]),
        position('new', '1', 'EUR', [
          ['2026-06-10', '5'],
          ['2026-06-11', '6'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-11',
    });
    expect(r.headline?.fromDate).toBe('2026-06-10');
    expect(r.points[0]?.date).toBe('2026-06-10');
    expect(r.headline?.startValue.toFixed()).toBe('15');
  });

  it('ignores points after `to` and rejects from > to', () => {
    const r = buildValueSeries({
      positions: [
        position('a', '1', 'EUR', [
          ['2026-06-01', '1'],
          ['2026-06-02', '2'],
          ['2026-06-03', '999'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-02',
    });
    expect(vals(r)).toEqual([
      ['2026-06-01', '1'],
      ['2026-06-02', '2'],
    ]);
    expect(() =>
      buildValueSeries({ positions: [], fx: new Map(), from: '2026-06-03', to: '2026-06-02' }),
    ).toThrow(RangeError);
  });

  it('supports a non-EUR reference and ZAc positions', () => {
    const r = buildValueSeries({
      positions: [
        position('za', '10', 'ZAc', [['2026-06-01', '2000']]), // 10 x 20 ZAR
        position('eu', '1', 'EUR', [['2026-06-01', '1']]),
      ],
      fx: fxOf({
        ZAR: [['2026-06-01', '20']],
        USD: [['2026-06-01', '1.25']],
      }),
      from: '2026-06-01',
      to: '2026-06-01',
      referenceCurrency: 'USD',
    });
    // (200 ZAR = 10 EUR) + 1 EUR = 11 EUR = 13.75 USD
    expect(vals(r)).toEqual([['2026-06-01', '13.75']]);
    expect(() =>
      buildValueSeries({
        positions: [],
        fx: new Map(),
        from: '2026-06-01',
        to: '2026-06-01',
        referenceCurrency: 'GBX',
      }),
    ).toThrow(RangeError);
  });

  it('validates tolerance and FX dates, and applies one duplicate rule to FX', () => {
    const base = { positions: [], from: '2026-06-01', to: '2026-06-02' };
    expect(() => buildValueSeries({ ...base, fx: new Map(), toleranceDays: -1 })).toThrow(
      RangeError,
    );
    expect(() => buildValueSeries({ ...base, fx: new Map(), toleranceDays: 1.5 })).toThrow(
      RangeError,
    );
    expect(() => buildValueSeries({ ...base, fx: fxOf({ USD: [['2026-02-30', '1']] }) })).toThrow(
      RangeError,
    );
    // last occurrence wins; a trailing invalid value drops the date
    const withDup = (rows: [string, string][]) =>
      vals(
        buildValueSeries({
          positions: [position('us', '1', 'USD', [['2026-06-01', '100']])],
          fx: fxOf({ USD: rows }),
          from: '2026-06-01',
          to: '2026-06-01',
        }),
      );
    expect(
      withDup([
        ['2026-06-01', '4'],
        ['2026-06-01', '2'],
      ]),
    ).toEqual([['2026-06-01', '50']]);
    expect(
      withDup([
        ['2026-06-01', '4'],
        ['2026-06-01', '0'],
      ]),
    ).toEqual([]);
  });

  it('re-wraps foreign decimal quantities and closes', () => {
    const Foreign = DecimalBase.clone({ precision: 3, rounding: DecimalBase.ROUND_DOWN });
    const r = buildValueSeries({
      positions: [
        {
          id: 'a',
          quantity: new Foreign('1234.5678') as unknown as Decimal,
          currency: 'EUR',
          closes: [{ date: '2026-06-01', close: new Foreign('1.1') as unknown as Decimal }],
        },
      ],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-01',
    });
    expect(r.points[0]?.value?.toFixed()).toBe('1358.02458');
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

  it('a downsampled series has exactly the values, headline and evolution of the full one on the kept dates', () => {
    const dates: string[] = [];
    for (let d = '2020-01-01'; d <= '2026-06-30'; d = addDays(d, 1)) dates.push(d);
    const series = (base: number) =>
      dates.map((d, i): [string, string] => [d, (base + ((i * 7) % 23) + i / 1000).toFixed(3)]);
    const input = (maxPoints: number) => ({
      positions: [
        position('fr', '3', 'EUR', series(50)),
        position('us', '2.5', 'USD', series(80)),
        position('uk', '11', 'GBX', series(1500)),
      ],
      fx: fxOf({
        USD: dates.map((d, i): [string, string] => [d, (1.05 + (i % 50) / 500).toFixed(4)]),
        GBP: dates.map((d, i): [string, string] => [d, (0.8 + (i % 30) / 400).toFixed(4)]),
      }),
      from: '2020-01-01',
      to: '2026-06-30',
      maxPoints,
    });
    const full = buildValueSeries(input(10_000));
    const small = buildValueSeries(input(400));
    expect(full.points.length).toBe(full.totalPoints);
    expect(small.points.length).toBe(400);
    expect(small.totalPoints).toBe(full.totalPoints);
    const byDate = new Map(full.points.map((p) => [p.date, p]));
    for (const p of small.points) {
      const f = byDate.get(p.date)!;
      expect(p.value?.toFixed()).toBe(f.value?.toFixed());
      expect(p.evolutionPct?.toFixed()).toBe(f.evolutionPct?.toFixed());
      expect(p.dataDate).toBe(f.dataDate);
      expect(p.fx.map((x) => [x.currency, x.rate.toFixed(), x.date])).toEqual(
        f.fx.map((x) => [x.currency, x.rate.toFixed(), x.date]),
      );
    }
    expect(small.headline?.change.toFixed()).toBe(full.headline?.change.toFixed());
    expect(small.headline?.changePct?.toFixed()).toBe(full.headline?.changePct?.toFixed());
  });

  it('reports the FX rate applied to each point (major currency, forward-filled date, none for EUR)', () => {
    const r = buildValueSeries({
      positions: [
        position('uk', '10', 'GBX', [
          ['2026-06-01', '1000'],
          ['2026-06-03', '1000'],
        ]),
        position('us', '1', 'USD', [['2026-06-01', '10']]),
        position('fr', '1', 'EUR', [['2026-06-01', '5']]),
      ],
      fx: fxOf({
        GBP: [
          ['2026-06-01', '0.8'],
          ['2026-06-03', '0.5'],
        ],
        USD: [['2026-06-01', '2']],
        CHF: [['2026-06-01', '1.1']],
      }),
      from: '2026-06-01',
      to: '2026-06-03',
    });
    const applied = (i: number) =>
      r.points[i]?.fx.map((f) => [f.currency, f.rate.toFixed(), f.date]);
    // Held currencies only (CHF is not held), GBX reported as GBP, USD forward-filled from 06-01.
    expect(applied(0)).toEqual([
      ['GBP', '0.8', '2026-06-01'],
      ['USD', '2', '2026-06-01'],
    ]);
    expect(applied(1)).toEqual([
      ['GBP', '0.5', '2026-06-03'],
      ['USD', '2', '2026-06-01'],
    ]);
  });

  it('omits a currency without a usable rate from the applied rates (and the day is null)', () => {
    const r = buildValueSeries({
      positions: [position('us', '1', 'USD', [['2026-06-01', '10']])],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-01',
    });
    expect(r.points).toEqual([]);
    const gap = buildValueSeries({
      positions: [
        position('us', '1', 'USD', [
          ['2026-06-01', '10'],
          ['2026-06-02', '10'],
        ]),
      ],
      fx: fxOf({ USD: [['2026-06-02', '2']] }),
      from: '2026-06-01',
      to: '2026-06-02',
    });
    expect(gap.points).toHaveLength(1);
    expect(gap.points[0]?.fx.map((f) => f.currency)).toEqual(['USD']);
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
    expect(empty).toEqual({
      points: [],
      headline: null,
      totalPoints: 0,
      invalidPositions: [],
      leadingMissing: [],
    });
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

  it('keeps chart endpoints equal to the headline with >400 points and leading/trailing nulls', () => {
    const start = '2020-01-01';
    const rows: [string, string][] = Array.from({ length: 1200 }, (_, i) => [
      addDays(start, i),
      String(100 + i),
    ]);
    // a second, recently listed position only trades on days 300..899
    const recent = rows.slice(300, 900);
    const r = buildValueSeries({
      positions: [position('a', '1', 'EUR', rows), position('b', '1', 'EUR', recent)],
      fx: new Map(),
      from: start,
      to: addDays(start, 1199),
      toleranceDays: 1,
    });
    // complete from day 300 to day 900 (b carried one day past its last close)
    expect(r.headline?.fromDate).toBe(addDays(start, 300));
    expect(r.headline?.toDate).toBe(addDays(start, 900));
    expect(r.totalPoints).toBe(601);
    expect(r.points).toHaveLength(400);
    expect(r.points[0]?.date).toBe(r.headline?.fromDate);
    expect(r.points.at(-1)?.date).toBe(r.headline?.toDate);
    expect(r.points[0]?.value?.toFixed()).toBe(r.headline?.startValue.toFixed());
    expect(r.points.at(-1)?.value?.toFixed()).toBe(r.headline?.endValue.toFixed());
    expect(r.points.every((p) => p.value !== null)).toBe(true);
  });

  it('uses the previous valid close when a 0 close falls on the target date, like computePerformance', () => {
    const rows: [string, string][] = [
      ['2026-06-05', '100'],
      ['2026-06-11', '0'], // target date (1w from 2026-06-18)
      ['2026-06-12', '110'],
      ['2026-06-18', '140'],
    ];
    const target = targetBaseDate('1w', '2026-06-18') as string;
    expect(target).toBe('2026-06-11');
    const r = buildValueSeries({
      positions: [position('a', '1', 'EUR', rows)],
      fx: new Map(),
      from: target,
      to: '2026-06-18',
    });
    const perf = computePerformance({
      series: closes(rows),
      period: '1w',
      asOf: '2026-06-18',
      end: D('140'),
    });
    expect(perf.baseDate).toBe('2026-06-05');
    expect(perf.value?.toFixed()).toBe('40');
    expect(r.headline?.baseDate).toBe('2026-06-05');
    expect(r.headline?.startValue.toFixed()).toBe('100');
    expect(r.headline?.changePct?.toFixed()).toBe('40');
  });

  it('uses the most recent close date among positions as the headline baseDate', () => {
    const r = buildValueSeries({
      positions: [
        position('a', '1', 'EUR', [
          ['2026-06-03', '10'],
          ['2026-06-10', '11'],
        ]),
        position('b', '1', 'EUR', [
          ['2026-06-04', '1'],
          ['2026-06-10', '2'],
        ]),
      ],
      fx: new Map(),
      from: '2026-06-06',
      to: '2026-06-10',
    });
    expect(r.headline).toMatchObject({ fromDate: '2026-06-06', baseDate: '2026-06-04' });
    expect(r.points.at(-1)?.dataDate).toBe('2026-06-10');
  });

  it('exposes leadingMissing when trimming leaves an empty or single-point series', () => {
    const old = position('old', '1', 'EUR', [
      ['2026-06-01', '10'],
      ['2026-06-09', '10'],
    ]);
    // recent listing trading on the last day only: single complete point
    const single = buildValueSeries({
      positions: [old, position('new', '1', 'EUR', [['2026-06-09', '5']])],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-09',
    });
    expect(single.points).toHaveLength(1);
    expect(single.headline).toBeNull();
    expect(single.leadingMissing).toEqual(['new']);
    // nothing ever complete: empty series
    const none = buildValueSeries({
      positions: [old, position('never', '1', 'EUR', [])],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-09',
    });
    expect(none.points).toEqual([]);
    expect(none.leadingMissing).toEqual(['never']);
    // FX missing at the start is reported too
    const fxLate = buildValueSeries({
      positions: [position('us', '1', 'USD', [['2026-06-01', '1']])],
      fx: fxOf({ USD: [['2026-06-02', '2']] }),
      from: '2026-06-01',
      to: '2026-06-01',
    });
    expect(fxLate.leadingMissing).toEqual(['us']);
    // nothing trimmed: empty
    const full = buildValueSeries({
      positions: [old],
      fx: new Map(),
      from: '2026-06-01',
      to: '2026-06-09',
    });
    expect(full.leadingMissing).toEqual([]);
  });
});
