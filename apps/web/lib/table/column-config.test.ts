import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLE_COLUMNS, TABLE_COLUMNS_BY_ID } from '@waddlers/contracts';
import { isSortable, resolveVisibleColumns } from './column-config';

describe('resolveVisibleColumns', () => {
  it('defaults to the D24 set in order', () => {
    expect(resolveVisibleColumns().map((c) => c.id)).toEqual([...DEFAULT_TABLE_COLUMNS]);
  });
  it('takes a configured set (S7), dropping unknown and duplicate ids', () => {
    const ids = resolveVisibleColumns(['symbol', 'name', 'symbol', 'bogus' as never]);
    expect(ids.map((c) => c.id)).toEqual(['symbol', 'name']);
  });
  it('an empty configuration falls back to the default', () => {
    expect(resolveVisibleColumns([]).length).toBe(DEFAULT_TABLE_COLUMNS.length);
  });
});

describe('isSortable', () => {
  it('pending columns and the mixed-currency price are never sortable', () => {
    expect(isSortable(TABLE_COLUMNS_BY_ID.get('market_cap_eur')!)).toBe(false);
    expect(isSortable(TABLE_COLUMNS_BY_ID.get('dividend_yield')!)).toBe(false);
    expect(isSortable(TABLE_COLUMNS_BY_ID.get('price')!)).toBe(false);
    expect(isSortable(TABLE_COLUMNS_BY_ID.get('perf_period')!)).toBe(true);
    expect(isSortable(TABLE_COLUMNS_BY_ID.get('price_eur')!)).toBe(true);
  });
});
