import {
  COLUMN_GROUPS,
  DEFAULT_TABLE_COLUMNS,
  SORTABLE_COLUMN_IDS,
  TABLE_COLUMNS,
  TABLE_COLUMNS_BY_ID,
  TABLE_COLUMN_IDS,
  positionsListInputSchema,
  sortableColumnIdSchema,
} from '@waddlers/contracts';
import { PERIODS } from '@waddlers/domain';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildValues, type TableRowData } from './table-cells';
import { sql } from 'drizzle-orm';
import { columnSql, escapeLike, SORT_SQL } from './table-columns';

/** Specs 17, section by section, word for word (plus the three non-§17 columns: Performance période is in §17's prose, Quantité and Valeur suivie are `tracking`). */
const SPECS_17: Record<string, string[]> = {
  identification: [
    'Société',
    'Code',
    "Type d'instrument",
    'Place de cotation retenue',
    'Logique de choix de la place',
    'Devise',
    "Secteur d'activité",
  ],
  description: ['Activité & positionnement concurrentiel'],
  price: ['Cours dans la devise locale', 'Taux de change → EUR', 'Cours en EUR', 'Date du cours'],
  valuation: [
    'Capitalisation dans la devise locale',
    'Capitalisation en EUR',
    "Valeur d'entreprise",
    'VE / Capitalisation',
  ],
  debt: ['Dette nette', "Taux d'endettement", "Nature du ratio d'endettement"],
  shareholders: ['Principaux actionnaires'],
  dividends: ['Dividende annuel', 'Rendement du dividende'],
  performance: [
    'Performance 1 semaine',
    'Performance 1 mois',
    'Performance 6 mois',
    'Performance 12 mois',
    'Performance 60 mois',
    'Performance Max',
    'Performance période',
  ],
  tracking: ['Quantité', 'Valeur suivie (EUR)'],
};

describe('column registry (contracts)', () => {
  it('labels are the specs 17 bullets verbatim (read from specs.md, not retyped)', () => {
    const specs = readFileSync(path.resolve(__dirname, '../../../../specs.md'), 'utf8');
    const section = specs.slice(
      specs.indexOf('# 17. Liste des colonnes disponibles'),
      specs.indexOf('# 18. Tableau par défaut'),
    );
    const bullets = new Set(
      section
        .split('\n')
        .filter((l) => l.startsWith('* '))
        .map((l) => l.slice(2).trim()),
    );
    const extras = new Set(['Performance période', 'Quantité', 'Valeur suivie (EUR)']);
    for (const c of TABLE_COLUMNS) {
      if (!extras.has(c.label)) expect(bullets, c.label).toContain(c.label);
    }
    expect(bullets.size).toBe(TABLE_COLUMNS.length - extras.size);
    // Compact forms (specs 18) live in shortLabel, never in label.
    expect(TABLE_COLUMNS_BY_ID.get('price_eur')).toMatchObject({
      label: 'Cours en EUR',
      shortLabel: 'Cours EUR',
    });
  });

  it('declares every specs 17 column, in its section', () => {
    for (const [group, labels] of Object.entries(SPECS_17)) {
      const actual = TABLE_COLUMNS.filter((c) => c.group === group).map((c) => c.label);
      expect(new Set(actual), group).toEqual(new Set(labels));
    }
    expect(TABLE_COLUMNS).toHaveLength(Object.values(SPECS_17).flat().length);
    expect(COLUMN_GROUPS.map((g) => g.id)).toEqual(Object.keys(SPECS_17));
  });

  it('has unique ids and labels', () => {
    expect(new Set(TABLE_COLUMN_IDS).size).toBe(TABLE_COLUMN_IDS.length);
    expect(new Set(TABLE_COLUMNS.map((c) => c.label)).size).toBe(TABLE_COLUMNS.length);
  });

  it('D24: default columns are exactly this ordered set', () => {
    expect(DEFAULT_TABLE_COLUMNS).toEqual([
      'name',
      'symbol',
      'price_eur',
      'quantity',
      'tracked_value_eur',
      'market_cap_eur',
      'sector',
      'dividend_yield',
      'perf_period',
      'perf_1y',
      'perf_5y',
    ]);
    const labels = DEFAULT_TABLE_COLUMNS.map((id) => {
      const c = TABLE_COLUMNS_BY_ID.get(id)!;
      return c.shortLabel ?? c.label;
    });
    expect(labels).toEqual([
      'Société',
      'Code',
      'Cours EUR',
      'Quantité',
      'Valeur suivie (EUR)',
      'Capitalisation EUR',
      'Secteur',
      'Rendement du dividende',
      'Performance période',
      'Perf. 12 mois',
      'Perf. 60 mois',
    ]);
  });

  it('pending_s8 columns are never sortable', () => {
    const pending = TABLE_COLUMNS.filter((c) => c.availability === 'pending_s8');
    expect(pending.length).toBeGreaterThanOrEqual(9);
    for (const c of pending) expect(c.sortable, c.id).toBe(false);
    expect(pending.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'market_cap',
        'market_cap_eur',
        'enterprise_value',
        'ev_to_market_cap',
        'net_debt',
        'debt_ratio',
        'debt_ratio_kind',
        'main_holders',
        'dividend_annual',
        'dividend_yield',
      ]),
    );
  });

  it('the sort whitelist rejects pending, unsortable and unknown ids', () => {
    for (const id of [
      'market_cap_eur',
      'description',
      'price',
      'fx_rate',
      'nope',
      '',
      'name; drop',
    ]) {
      expect(sortableColumnIdSchema.safeParse(id).success, id).toBe(false);
    }
    for (const id of SORTABLE_COLUMN_IDS)
      expect(sortableColumnIdSchema.safeParse(id).success).toBe(true);
  });

  it('page limit is capped at 200 and search/sort are validated', () => {
    const base = { spaceId: '8d0f7780-8536-4f9a-8d3a-c3c4b09ef6c1' };
    expect(positionsListInputSchema.safeParse({ ...base, page: { limit: 201 } }).success).toBe(
      false,
    );
    expect(positionsListInputSchema.safeParse({ ...base, page: { limit: 200 } }).success).toBe(
      true,
    );
    expect(positionsListInputSchema.safeParse({ ...base, search: 'a\u0000b' }).success).toBe(false);
    expect(positionsListInputSchema.safeParse({ ...base, search: 'x'.repeat(101) }).success).toBe(
      false,
    );
    expect(
      positionsListInputSchema.safeParse({ ...base, sort: { columnId: 'name', direction: 'up' } })
        .success,
    ).toBe(false);
  });
});

describe('column registry (SQL mapping)', () => {
  const ctx = (period: (typeof PERIODS)[number]) => ({ period, fxRate: sql`1::numeric` });
  const AVAILABLE = TABLE_COLUMNS.filter((c) => c.availability === 'available').map((c) => c.id);

  it('maps exactly the available columns (one mapping for sort and filters)', () => {
    expect(Object.keys(columnSql(ctx('1m'))).sort()).toEqual([...AVAILABLE].sort());
  });

  it('SORT_SQL derives from it: exactly the sortable columns, for every period', () => {
    for (const period of PERIODS) {
      expect(Object.keys(SORT_SQL(ctx(period))).sort()).toEqual([...SORTABLE_COLUMN_IDS].sort());
      for (const id of SORTABLE_COLUMN_IDS) {
        expect(SORT_SQL(ctx(period))[id], `${id}/${period}`).toBeDefined();
      }
    }
  });

  it('escapeLike makes %, _ and backslash literal', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
    expect(escapeLike('plain')).toBe('plain');
  });
});

const row = (over: Partial<TableRowData> = {}): TableRowData => ({
  quantity: '10',
  selectionReason: null,
  instrumentName: 'Air Liquide',
  instrumentType: 'stock',
  sector: null,
  description: null,
  symbol: 'AI',
  exchangeName: 'Euronext Paris',
  currency: 'EUR',
  metrics: null,
  ...over,
});

describe('pending columns are always null', () => {
  it('returns null for every pending_s8 column, whatever the row holds', () => {
    const pending = TABLE_COLUMNS.filter((c) => c.availability === 'pending_s8').map((c) => c.id);
    const values = buildValues(row({ sector: 'Industrie' }), pending, '1m', '2026-09-30');
    for (const id of pending) expect(values[id], id).toBeNull();
    expect(Object.keys(values)).toHaveLength(pending.length);
  });
});
