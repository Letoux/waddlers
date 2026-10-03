import { describe, expect, it } from 'vitest';
import { filtersSchema, type Filter, type PositionsFacetsOutput } from '@waddlers/contracts';
import {
  buildBetweenFilter,
  chipLabel,
  mergeFacetOptions,
  BOUND_INVALID,
  parseBound,
  toggleInValue,
  upsertFilter,
} from './filter-form';

describe('parseBound errors', () => {
  it('F-F3: every invalid bound gets the filter message, never the quantity one', () => {
    for (const raw of ['abc', '1,2,3', '-', '--5', '1e5', '12 x', '1 2 3,4,5']) {
      expect(parseBound(raw)).toEqual({ ok: false, message: BOUND_INVALID });
    }
  });
});

describe('parseBound', () => {
  it('accepts the French comma and the dot', () => {
    expect(parseBound('12,5')).toEqual({ ok: true, value: '12.5' });
    expect(parseBound('12.5')).toEqual({ ok: true, value: '12.5' });
    expect(parseBound(' 0,05 ')).toEqual({ ok: true, value: '0.05' });
  });
  it('keeps the sign, including the typographic minus', () => {
    expect(parseBound('-3,2')).toEqual({ ok: true, value: '-3.2' });
    expect(parseBound('−3,2')).toEqual({ ok: true, value: '-3.2' });
    expect(parseBound('-0')).toEqual({ ok: true, value: '0' });
  });
  it('accepts grouped thousands', () => {
    expect(parseBound('1 234,5')).toEqual({ ok: true, value: '1234.5' });
  });
  it('blank is no bound', () => {
    expect(parseBound('  ')).toEqual({ ok: true, value: null });
  });
  it('rejects garbage, exponents and a bare sign', () => {
    for (const bad of ['abc', '1e5', '--1', '-', ',', '1,2,3', '+5']) {
      expect(parseBound(bad).ok, bad).toBe(false);
    }
  });
});

describe('buildBetweenFilter', () => {
  it('builds a percent range in percent units (10 means 10 %)', () => {
    expect(buildBetweenFilter('perf_1y', '5', '20,5')).toEqual({
      ok: true,
      filter: { kind: 'between', columnId: 'perf_1y', min: '5', max: '20.5' },
    });
  });
  it('allows a single bound', () => {
    expect(buildBetweenFilter('price_eur', '100', '')).toEqual({
      ok: true,
      filter: { kind: 'between', columnId: 'price_eur', min: '100' },
    });
    expect(buildBetweenFilter('perf_1m', '', '-2,5')).toEqual({
      ok: true,
      filter: { kind: 'between', columnId: 'perf_1m', max: '-2.5' },
    });
  });
  it('drops a filter whose bounds are both empty', () => {
    expect(buildBetweenFilter('perf_1y', '', ' ')).toEqual({ ok: true, filter: null });
  });
  it('refuses min > max (exact decimal comparison) and equal is fine', () => {
    expect(buildBetweenFilter('perf_1y', '10', '9,99')).toMatchObject({ ok: false });
    expect(buildBetweenFilter('perf_1y', '-1', '-2')).toMatchObject({ ok: false });
    expect(buildBetweenFilter('perf_1y', '5', '5').ok).toBe(true);
  });
  it('reports which bound is invalid', () => {
    expect(buildBetweenFilter('perf_1y', 'x', '5')).toMatchObject({ ok: false });
    const bad = buildBetweenFilter('perf_1y', '1', 'y');
    expect(bad.ok === false && bad.maxError).toBeTruthy();
  });
  it('produces filters the API contract accepts', () => {
    const r = buildBetweenFilter('tracked_value_eur', '1 000', '25 000,5');
    expect(r.ok && r.filter && filtersSchema.safeParse([r.filter]).success).toBe(true);
  });
});

describe('filter list edits', () => {
  const sector: Filter = { kind: 'in', columnId: 'sector', values: ['Technologie'] };
  it('upsert replaces the filter of the column; null removes it', () => {
    const range: Filter = { kind: 'between', columnId: 'perf_1y', min: '1' };
    const two = upsertFilter([sector], 'perf_1y', range);
    expect(two).toHaveLength(2);
    expect(upsertFilter(two, 'perf_1y', { ...range, min: '2' })).toHaveLength(2);
    expect(upsertFilter(two, 'perf_1y', null)).toEqual([sector]);
  });
  it('ticking adds a value, unticking the last one removes the filter', () => {
    const more = toggleInValue([sector], 'sector', 'Santé', true);
    expect(more[0]).toMatchObject({ values: ['Technologie', 'Santé'] });
    expect(toggleInValue(more, 'sector', 'Santé', false)).toEqual([sector]);
    expect(toggleInValue([sector], 'sector', 'Technologie', false)).toEqual([]);
    expect(toggleInValue([], 'currency', 'USD', true)).toEqual([
      { kind: 'in', columnId: 'currency', values: ['USD'] },
    ]);
  });
});

describe('chipLabel', () => {
  const facets: PositionsFacetsOutput = {
    instrument_type: [{ value: 'etf', label: 'ETF', count: 1 }],
    sector: [],
    currency: [],
    exchange: [{ value: 'XPAR', label: 'Euronext Paris', count: 3 }],
    truncated: { instrument_type: false, sector: false, currency: false, exchange: false },
  };
  it('labels a range with its unit and the French decimal comma', () => {
    expect(
      chipLabel({ kind: 'between', columnId: 'perf_1y', min: '5', max: '20.5' }, undefined, '1m'),
    ).toBe('Perf. 12 mois : 5 % à 20,5 %');
    expect(chipLabel({ kind: 'between', columnId: 'price_eur', min: '100' }, undefined, '1m')).toBe(
      'Cours EUR : ≥ 100 €',
    );
    expect(chipLabel({ kind: 'between', columnId: 'perf_1m', max: '-2.5' }, undefined, '1m')).toBe(
      'Perf. 1 mois : ≤ −2,5 %',
    );
  });
  it('labels an in filter with facet labels, falling back to the value', () => {
    expect(
      chipLabel({ kind: 'in', columnId: 'exchange', values: ['XPAR', 'XNAS'] }, facets, '1m'),
    ).toBe('Place de cotation retenue : Euronext Paris, XNAS');
    expect(
      chipLabel({ kind: 'in', columnId: 'instrument_type', values: ['stock'] }, undefined, '1m'),
    ).toBe("Type d'instrument : Action");
    expect(
      chipLabel({ kind: 'in', columnId: 'currency', values: ['EUR', 'USD'] }, undefined, '1m'),
    ).toBe('Devise : EUR, USD');
  });
});

describe('chipLabel of Performance période', () => {
  const f: Filter = { kind: 'between', columnId: 'perf_period', min: '10' };
  it('shows the period it applies to now', () => {
    expect(chipLabel(f, undefined, '1m')).toBe('Perf. 1 mois (période) : ≥ 10\u00a0%');
    expect(chipLabel(f, undefined, '5y')).toBe('Perf. 5 ans (période) : ≥ 10\u00a0%');
    expect(chipLabel(f, undefined, 'max')).toContain('Perf. Max (période)');
  });
});

describe('mergeFacetOptions', () => {
  const options = [
    { value: 'Santé', label: 'Santé', count: 2 },
    { value: 'Technologie', label: 'Technologie', count: 5 },
  ];
  const LOADED = { loaded: true, truncated: false };
  it('does not claim a value is absent while the facets load, failed, or were truncated', () => {
    const merged = (state: { loaded: boolean; truncated: boolean }) =>
      mergeFacetOptions('sector', options, ['Énergie'], state).at(-1);
    expect(merged({ loaded: false, truncated: false })?.count).toBeNull();
    expect(merged({ loaded: true, truncated: true })?.count).toBeNull();
    expect(merged({ loaded: true, truncated: false })?.count).toBe(0);
  });
  it('keeps the facets untouched when every active value is present', () => {
    expect(mergeFacetOptions('sector', options, ['Santé'], LOADED)).toEqual(options);
  });
  it('appends an active value the facets no longer return, with count 0', () => {
    expect(mergeFacetOptions('sector', options, ['Santé', 'Énergie'], LOADED)).toEqual([
      ...options,
      { value: 'Énergie', label: 'Énergie', count: 0 },
    ]);
  });
  it('labels an absent instrument type in French and works with no facets at all', () => {
    expect(mergeFacetOptions('instrument_type', [], ['etf'], LOADED)).toEqual([
      { value: 'etf', label: 'ETF', count: 0 },
    ]);
  });
});
