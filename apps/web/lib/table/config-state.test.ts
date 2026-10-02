import { describe, expect, it } from 'vitest';
import { defaultTableConfig, DEFAULT_TABLE_COLUMNS, type TableConfigV1 } from '@waddlers/contracts';
import { parseSortParam } from './url-state';
import {
  configDensity,
  configPageSize,
  effectiveSort,
  moveColumn,
  toggleColumn,
  visibleColumnIds,
  withSort,
} from './config-state';

const base = () => defaultTableConfig();

describe('config to table state', () => {
  it('visible columns follow the config order and drive the query columns', () => {
    expect(visibleColumnIds(base())).toEqual([...DEFAULT_TABLE_COLUMNS]);
    const moved = moveColumn(base(), 'symbol', -1);
    expect(visibleColumnIds(moved).slice(0, 2)).toEqual(['symbol', 'name']);
  });

  it('density and page size fall back to the defaults', () => {
    const bare = base();
    delete bare.density;
    delete bare.pageSize;
    expect(configDensity(bare)).toBe('comfortable');
    expect(configPageSize(bare)).toBe(50);
    expect(configPageSize({ ...base(), pageSize: 200 })).toBe(200);
  });
});

describe('sort precedence', () => {
  const saved: TableConfigV1 = withSort(base(), { columnId: 'perf_1y', direction: 'desc' });
  it('a valid ?tri= wins over the saved sort', () => {
    const url = parseSortParam('price_eur:asc');
    expect(effectiveSort(saved, url)).toEqual({ columnId: 'price_eur', direction: 'asc' });
  });
  it('without ?tri= (or an invalid one) the saved sort applies', () => {
    expect(effectiveSort(saved, null)).toEqual({ columnId: 'perf_1y', direction: 'desc' });
    expect(effectiveSort(saved, parseSortParam('price:asc'))).toEqual({
      columnId: 'perf_1y',
      direction: 'desc',
    });
  });
  it('no sort anywhere is null; withSort(null) removes the saved sort', () => {
    expect(effectiveSort(base(), null)).toBeNull();
    expect('sort' in withSort(saved, null)).toBe(false);
  });
});

describe('toggleColumn', () => {
  it('shows a hidden column at the end of the visible ones', () => {
    const next = toggleColumn(base(), 'description', true);
    const ids = visibleColumnIds(next);
    expect(ids.at(-1)).toBe('description');
    expect(ids).toHaveLength(DEFAULT_TABLE_COLUMNS.length + 1);
  });
  it('hides a column and keeps the others in order', () => {
    const ids = visibleColumnIds(toggleColumn(base(), 'sector', false));
    expect(ids).not.toContain('sector');
    expect(ids).toEqual(DEFAULT_TABLE_COLUMNS.filter((id) => id !== 'sector'));
  });
  it('refuses to hide the last visible column', () => {
    let config = base();
    for (const id of DEFAULT_TABLE_COLUMNS.slice(1)) config = toggleColumn(config, id, false);
    expect(visibleColumnIds(config)).toEqual(['name']);
    expect(toggleColumn(config, 'name', false)).toBe(config);
  });
  it('refuses to show a pending (S8) column', () => {
    const config = base();
    expect(toggleColumn(config, 'net_debt', true)).toBe(config);
  });
  it('lets the user hide a pending column that is visible by default (D24)', () => {
    const ids = visibleColumnIds(toggleColumn(base(), 'market_cap_eur', false));
    expect(ids).not.toContain('market_cap_eur');
  });
  it('is a no-op for the same visibility', () => {
    const config = base();
    expect(toggleColumn(config, 'name', true)).toBe(config);
  });
});

describe('moveColumn', () => {
  it('moves among visible columns, skipping hidden ones', () => {
    const config = toggleColumn(base(), 'price_eur', false);
    // visible: name, symbol, quantity, ...; moving quantity up goes before symbol's successor
    const up = moveColumn(config, 'quantity', -1);
    expect(visibleColumnIds(up).slice(0, 3)).toEqual(['name', 'quantity', 'symbol']);
  });
  it('first up and last down are no-ops', () => {
    const config = base();
    const ids = visibleColumnIds(config);
    expect(moveColumn(config, ids[0]!, -1)).toBe(config);
    expect(moveColumn(config, ids.at(-1)!, 1)).toBe(config);
  });
});
