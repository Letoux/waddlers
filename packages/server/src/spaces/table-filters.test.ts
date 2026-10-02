import {
  BETWEEN_FILTER_COLUMN_IDS,
  IN_FILTER_COLUMN_IDS,
  TABLE_COLUMNS,
  compareDecimalStrings,
  defaultTableConfig,
  filterSchema,
  filtersSchema,
  positionsListInputSchema,
  positionsSearchSchema,
  tableConfigSaveInputSchema,
  type Filter,
} from '@waddlers/contracts';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { columnSql } from './table-columns';
import { FX_FILTER_COLUMNS, filterPredicates, filtersNeedFx } from './table-filters';
import { sql } from 'drizzle-orm';

const SPACE = '11111111-1111-4111-8111-111111111111';
const ctx = { period: '1m' as const, fxRate: sql`1::numeric` };
const dialect = new PgDialect();
const render = (filters: Filter[]) =>
  filterPredicates(filters, ctx).map((p) => dialect.sqlToQuery(p));

describe('ill-formed text (audit F1: lone UTF-16 surrogates)', () => {
  const lone = ['\uD800', 'a\uDC00b', '\uD83D', 'ok\uDBFF'];
  it('refuses a lone surrogate in an `in` value, accepts a real surrogate pair', () => {
    for (const v of lone) {
      expect(
        filterSchema.safeParse({ kind: 'in', columnId: 'sector', values: [v] }).success,
        JSON.stringify(v),
      ).toBe(false);
    }
    expect(
      filterSchema.safeParse({ kind: 'in', columnId: 'sector', values: ['Santé 😀'] }).success,
    ).toBe(true);
  });
  it('applies the same rule to the search input', () => {
    for (const v of lone) expect(positionsSearchSchema.safeParse(v).success).toBe(false);
    expect(positionsSearchSchema.safeParse('hermès 😀').success).toBe(true);
    expect(positionsSearchSchema.safeParse('a\u0000b').success).toBe(false);
  });
  it('is refused inside a saved config too', () => {
    const cfg = {
      ...defaultTableConfig(),
      filters: [{ kind: 'in', columnId: 'sector', values: ['\uD800'] }],
    };
    expect(tableConfigSaveInputSchema.safeParse({ spaceId: SPACE, config: cfg }).success).toBe(
      false,
    );
  });
});

describe('filter schema', () => {
  it('accepts an `in` filter on each enum column with its domain', () => {
    for (const f of [
      { kind: 'in', columnId: 'instrument_type', values: ['stock', 'etf'] },
      { kind: 'in', columnId: 'sector', values: ['Énergie', "L'industrie"] },
      { kind: 'in', columnId: 'currency', values: ['EUR', 'GBX'] },
      { kind: 'in', columnId: 'exchange', values: ['XPAR', 'XNAS'] },
    ]) {
      expect(filterSchema.safeParse(f).success, JSON.stringify(f)).toBe(true);
    }
  });

  it('refuses values outside the closed or formatted domains', () => {
    const bad = (columnId: string, values: string[]) =>
      filterSchema.safeParse({ kind: 'in', columnId, values }).success;
    expect(bad('instrument_type', ['bond'])).toBe(false);
    expect(bad('currency', ['eur'])).toBe(false);
    expect(bad('currency', ['EURO'])).toBe(false);
    expect(bad('exchange', ['xpar'])).toBe(false);
    expect(bad('exchange', ['XPAR; drop'])).toBe(false);
    expect(bad('sector', [''])).toBe(false);
    expect(bad('sector', ['a\u0000b'])).toBe(false);
    expect(bad('sector', ['x'.repeat(101)])).toBe(false);
    expect(bad('sector', [])).toBe(false);
    expect(
      bad(
        'sector',
        Array.from({ length: 51 }, (_, i) => `s${i}`),
      ),
    ).toBe(false);
  });

  it('accepts `between` on each numeric column, with one or both bounds', () => {
    for (const columnId of BETWEEN_FILTER_COLUMN_IDS) {
      expect(filterSchema.safeParse({ kind: 'between', columnId, min: '-10.5' }).success).toBe(
        true,
      );
      expect(filterSchema.safeParse({ kind: 'between', columnId, max: '0' }).success).toBe(true);
      expect(
        filterSchema.safeParse({ kind: 'between', columnId, min: '1', max: '1' }).success,
      ).toBe(true);
    }
  });

  it('refuses a missing bound, min > max, and non plain-decimal bounds', () => {
    const between = (extra: object) =>
      filterSchema.safeParse({ kind: 'between', columnId: 'perf_1y', ...extra }).success;
    expect(between({})).toBe(false);
    expect(between({ min: '10', max: '9.99999999' })).toBe(false);
    expect(between({ min: '-5', max: '-6' })).toBe(false);
    for (const bad of [
      '1e3',
      '1E3',
      '+1',
      '.5',
      '5.',
      '01',
      '1,5',
      'NaN',
      'Infinity',
      ' 1',
      '1.123456789',
      '1'.repeat(16),
    ]) {
      expect(between({ min: bad }), bad).toBe(false);
    }
    expect(between({ min: 10 })).toBe(false);
  });

  it('compares decimal strings exactly (sign, scale, no float)', () => {
    expect(compareDecimalStrings('0.1', '0.10')).toBe(0);
    expect(compareDecimalStrings('-0', '0')).toBe(0);
    expect(compareDecimalStrings('-1', '0.5')).toBe(-1);
    expect(compareDecimalStrings('123456789012345.12345678', '123456789012345.12345677')).toBe(1);
  });

  it('refuses unknown and non-filterable columns, among them every pending_s8 fundamental', () => {
    expect(filterSchema.safeParse({ kind: 'between', columnId: 'nope', min: '1' }).success).toBe(
      false,
    );
    expect(filterSchema.safeParse({ kind: 'in', columnId: 'perf_1y', values: ['x'] }).success).toBe(
      false,
    );
    expect(filterSchema.safeParse({ kind: 'between', columnId: 'sector', min: '1' }).success).toBe(
      false,
    );
    const nonFilterable = TABLE_COLUMNS.filter((c) => c.filterable === false);
    expect(nonFilterable.length).toBeGreaterThan(10);
    for (const c of nonFilterable) {
      for (const kind of ['in', 'between'] as const) {
        const f =
          kind === 'in'
            ? { kind, columnId: c.id, values: ['x'] }
            : { kind, columnId: c.id, min: '1' };
        expect(filterSchema.safeParse(f).success, `${kind} ${c.id}`).toBe(false);
      }
    }
    for (const id of [
      'market_cap',
      'market_cap_eur',
      'enterprise_value',
      'ev_to_market_cap',
      'net_debt',
      'debt_ratio',
      'dividend_yield',
    ]) {
      expect(TABLE_COLUMNS.find((c) => c.id === id)?.filterable).toBe(false);
    }
  });

  it('bounds the list (20) and refuses two filters on one column', () => {
    const one = (columnId: string): Filter => ({ kind: 'between', columnId, min: '1' }) as Filter;
    expect(filtersSchema.safeParse([one('perf_1y'), one('perf_5y')]).success).toBe(true);
    expect(filtersSchema.safeParse([one('perf_1y'), one('perf_1y')]).success).toBe(false);
    expect(filtersSchema.safeParse(Array.from({ length: 21 }, () => one('perf_1y'))).success).toBe(
      false,
    );
  });

  it('positions.list input takes `filters` next to search and sort', () => {
    const ok = positionsListInputSchema.safeParse({
      spaceId: SPACE,
      search: 'a',
      filters: [{ kind: 'between', columnId: 'price_eur', min: '1.5' }],
    });
    expect(ok.success).toBe(true);
    expect(
      positionsListInputSchema.safeParse({ spaceId: SPACE, filters: [{ kind: 'x' }] }).success,
    ).toBe(false);
  });
});

describe('registry whitelist vs SQL mapping', () => {
  it('every filterable column has a SQL expression, and only available columns are filterable', () => {
    const mapped = Object.keys(columnSql(ctx));
    for (const c of TABLE_COLUMNS.filter((x) => x.filterable !== false)) {
      expect(c.availability, c.id).toBe('available');
      expect(mapped, c.id).toContain(c.id);
    }
    expect(new Set([...IN_FILTER_COLUMN_IDS, ...BETWEEN_FILTER_COLUMN_IDS]).size).toBe(
      IN_FILTER_COLUMN_IDS.length + BETWEEN_FILTER_COLUMN_IDS.length,
    );
  });

  it('`in` columns are the specs 21 identification set; `between` are numeric (percent or money)', () => {
    expect([...IN_FILTER_COLUMN_IDS].sort()).toEqual([
      'currency',
      'exchange',
      'instrument_type',
      'sector',
    ]);
    for (const id of BETWEEN_FILTER_COLUMN_IDS) {
      const def = TABLE_COLUMNS.find((c) => c.id === id)!;
      expect(['percent', 'money']).toContain(def.dataType);
    }
  });
});

describe('filter SQL builder', () => {
  it('binds every user value as a parameter; the column id never reaches the SQL text', () => {
    const [inQ, betweenQ] = render([
      { kind: 'in', columnId: 'sector', values: ["x'); drop table users; --"] },
      { kind: 'between', columnId: 'perf_period', min: '10', max: '20.5' },
    ]);
    expect(inQ?.sql).not.toContain('drop table');
    expect(inQ?.params).toContain("x'); drop table users; --");
    expect(betweenQ?.params).toEqual(['10', '20.5']);
    expect(betweenQ?.sql).toContain('::numeric');
    expect(betweenQ?.sql).not.toContain('perf_period');
    expect(betweenQ?.sql).toContain('"perf_1m"'); // period 1m resolved by the shared mapping
  });

  it('filters the exchange by MIC and AND-combines nothing for an empty list', () => {
    const [q] = render([{ kind: 'in', columnId: 'exchange', values: ['XPAR'] }]);
    expect(q?.sql).toContain('"mic"');
    expect(filterPredicates(undefined, ctx)).toEqual([]);
    expect(filterPredicates([], ctx)).toEqual([]);
  });

  it('refuses a column that is not whitelisted, or the wrong kind, even past the type system', () => {
    const forged = (f: object) => () => filterPredicates([f as Filter], ctx);
    expect(forged({ kind: 'between', columnId: 'net_debt', min: '1' })).toThrow(/not filterable/);
    expect(forged({ kind: 'between', columnId: 'name; drop', min: '1' })).toThrow(/not filterable/);
    expect(forged({ kind: 'in', columnId: 'perf_1y', values: ['a'] })).toThrow(/not filterable/);
    expect(forged({ kind: 'between', columnId: 'perf_1y' })).toThrow(/bound/);
  });
});

describe('FX join only when needed (review P3-7)', () => {
  const probe = { period: '1m' as const, fxRate: sql`__FX_RATE__` };
  const filterFor = (columnId: string): Filter =>
    (IN_FILTER_COLUMN_IDS as readonly string[]).includes(columnId)
      ? ({ kind: 'in', columnId, values: ['EUR'] } as Filter)
      : ({ kind: 'between', columnId, min: '1' } as Filter);

  it('FX_FILTER_COLUMNS is exactly the filterable columns whose SQL reads the rate', () => {
    const ids = [...IN_FILTER_COLUMN_IDS, ...BETWEEN_FILTER_COLUMN_IDS];
    const reading = ids.filter((id) =>
      filterPredicates([filterFor(id)], probe)
        .map((p) => dialect.sqlToQuery(p).sql)
        .join(' ')
        .includes('__FX_RATE__'),
    );
    expect(new Set(reading)).toEqual(FX_FILTER_COLUMNS);
  });
  it('filtersNeedFx is true only for a money filter', () => {
    expect(filtersNeedFx(undefined)).toBe(false);
    expect(filtersNeedFx([])).toBe(false);
    expect(filtersNeedFx([filterFor('perf_1y'), filterFor('currency')])).toBe(false);
    expect(filtersNeedFx([filterFor('perf_1y'), filterFor('price_eur')])).toBe(true);
    expect(filtersNeedFx([filterFor('tracked_value_eur')])).toBe(true);
  });
});
