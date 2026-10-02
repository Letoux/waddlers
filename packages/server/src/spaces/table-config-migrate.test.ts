import {
  DEFAULT_TABLE_COLUMNS,
  TABLE_COLUMN_IDS,
  defaultTableConfig,
  tableConfigSaveInputSchema,
  tableConfigV1Schema,
} from '@waddlers/contracts';
import { describe, expect, it } from 'vitest';
import { migrateTableConfig } from './table-config-migrate';

const SPACE = '11111111-1111-4111-8111-111111111111';
const visibleIds = (c: ReturnType<typeof migrateTableConfig>) =>
  c.columns.filter((x) => x.visible).map((x) => x.id);

describe('defaultTableConfig (D24)', () => {
  it('shows the D24 columns in order, then every other registry column hidden, once each', () => {
    const c = defaultTableConfig();
    expect(visibleIds(c)).toEqual([...DEFAULT_TABLE_COLUMNS]);
    expect(c.columns.map((x) => x.id).sort()).toEqual([...TABLE_COLUMN_IDS].sort());
    expect(tableConfigV1Schema.safeParse(c).success).toBe(true);
  });
});

describe('migrateTableConfig', () => {
  it('keeps a valid config as is (order, visibility, sort, filters, density, page size)', () => {
    const saved = {
      ...defaultTableConfig(),
      columns: [
        { id: 'symbol', visible: true },
        { id: 'name', visible: true },
        ...TABLE_COLUMN_IDS.filter((i) => i !== 'name' && i !== 'symbol').map((id) => ({
          id,
          visible: false,
        })),
      ],
      sort: { columnId: 'perf_1y', direction: 'desc' },
      filters: [{ kind: 'between', columnId: 'perf_1y', min: '10' }],
      density: 'compact',
      pageSize: 100,
    };
    expect(migrateTableConfig(saved)).toEqual(saved);
  });

  it('drops unknown and duplicate column ids, keeps the order of the rest', () => {
    const out = migrateTableConfig({
      columns: [
        { id: 'symbol', visible: true },
        { id: 'removed_column', visible: true },
        { id: 'name', visible: true },
        { id: 'symbol', visible: false },
        { id: 42, visible: true },
        null,
      ],
    });
    expect(out.columns.map((c) => c.id).slice(0, 2)).toEqual(['symbol', 'name']);
    expect(out.columns.map((c) => c.id)).not.toContain('removed_column');
    expect(out.columns.filter((c) => c.id === 'symbol')).toHaveLength(1);
    expect(out.columns.find((c) => c.id === 'symbol')?.visible).toBe(true);
    expect(out.columns).toHaveLength(TABLE_COLUMN_IDS.length);
  });

  it('appends registry columns unknown to the stored config as HIDDEN, in registry order', () => {
    const out = migrateTableConfig({ columns: [{ id: 'name', visible: true }] });
    expect(visibleIds(out)).toEqual(['name']);
    expect(out.columns.slice(1).map((c) => c.id)).toEqual(
      TABLE_COLUMN_IDS.filter((i) => i !== 'name'),
    );
    expect(out.columns.slice(1).every((c) => !c.visible)).toBe(true);
  });

  it('falls back to the D24 default columns when nothing visible is left', () => {
    const defaults = defaultTableConfig().columns;
    expect(migrateTableConfig({ columns: [] }).columns).toEqual(defaults);
    expect(migrateTableConfig({ columns: [{ id: 'gone', visible: true }] }).columns).toEqual(
      defaults,
    );
    expect(migrateTableConfig({ columns: [{ id: 'name', visible: false }] }).columns).toEqual(
      defaults,
    );
  });

  it('drops an invalid sort (unknown or non-sortable column, bad direction)', () => {
    const base = { columns: [{ id: 'name', visible: true }] };
    expect(
      migrateTableConfig({ ...base, sort: { columnId: 'gone', direction: 'asc' } }).sort,
    ).toBeUndefined();
    expect(
      migrateTableConfig({ ...base, sort: { columnId: 'price', direction: 'asc' } }).sort,
    ).toBeUndefined();
    expect(
      migrateTableConfig({ ...base, sort: { columnId: 'name', direction: 'up' } }).sort,
    ).toBeUndefined();
    expect(
      migrateTableConfig({ ...base, sort: { columnId: 'name', direction: 'asc' } }).sort,
    ).toEqual({
      columnId: 'name',
      direction: 'asc',
    });
  });

  it('drops invalid filters (now non-filterable column, broken bound, duplicate) and keeps the valid ones', () => {
    const out = migrateTableConfig({
      columns: [{ id: 'name', visible: true }],
      filters: [
        { kind: 'between', columnId: 'dividend_yield', min: '1' },
        { kind: 'between', columnId: 'perf_1y', min: '9', max: '1' },
        { kind: 'in', columnId: 'currency', values: ['EUR'] },
        { kind: 'in', columnId: 'currency', values: ['USD'] },
        'garbage',
      ],
    });
    expect(out.filters).toEqual([{ kind: 'in', columnId: 'currency', values: ['EUR'] }]);
  });

  it('fills density and page size from the defaults when absent or invalid', () => {
    const out = migrateTableConfig({
      columns: [{ id: 'name', visible: true }],
      density: 'huge',
      pageSize: 77,
    });
    expect(out.density).toBe('comfortable');
    expect(out.pageSize).toBe(50);
  });

  it('never throws, whatever is stored, and always returns a valid V1', () => {
    for (const raw of [
      null,
      undefined,
      3,
      'x',
      [],
      {},
      { columns: 'x' },
      { columns: [[]], filters: {} },
    ]) {
      const out = migrateTableConfig(raw);
      expect(tableConfigV1Schema.safeParse(out).success).toBe(true);
    }
  });
});

describe('save input (strict)', () => {
  const ok = { spaceId: SPACE, config: defaultTableConfig() };
  it('accepts the defaults', () => {
    expect(tableConfigSaveInputSchema.safeParse(ok).success).toBe(true);
  });
  it('refuses unknown or duplicate columns, no visible column, bad sort, bad page size', () => {
    const cfg = (patch: object) => ({
      spaceId: SPACE,
      config: { ...defaultTableConfig(), ...patch },
    });
    expect(
      tableConfigSaveInputSchema.safeParse(cfg({ columns: [{ id: 'nope', visible: true }] }))
        .success,
    ).toBe(false);
    expect(
      tableConfigSaveInputSchema.safeParse(
        cfg({
          columns: [
            { id: 'name', visible: true },
            { id: 'name', visible: true },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      tableConfigSaveInputSchema.safeParse(cfg({ columns: [{ id: 'name', visible: false }] }))
        .success,
    ).toBe(false);
    expect(
      tableConfigSaveInputSchema.safeParse(cfg({ sort: { columnId: 'price', direction: 'asc' } }))
        .success,
    ).toBe(false);
    expect(tableConfigSaveInputSchema.safeParse(cfg({ pageSize: 30 })).success).toBe(false);
    expect(tableConfigSaveInputSchema.safeParse(cfg({ density: 'x' })).success).toBe(false);
  });
  it('bounds the size: a config of many long filter values is refused', () => {
    const filters = Array.from({ length: 4 }, (_, i) => ({
      kind: 'in' as const,
      columnId: (['sector', 'currency', 'exchange', 'instrument_type'] as const)[i]!,
      values: Array.from(
        { length: 50 },
        (_, j) => `${'€'.repeat(98)}${String(j).padStart(2, '0')}`,
      ),
    }));
    const big = { spaceId: SPACE, config: { ...defaultTableConfig(), filters: [filters[0]!] } };
    expect(tableConfigSaveInputSchema.safeParse(big).success).toBe(false);
  });
});
