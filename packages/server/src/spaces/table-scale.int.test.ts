import { TABLE_COLUMN_IDS, type PositionsListOutput } from '@waddlers/contracts';
import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../admin';
import { getDb } from '../db/client';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { createSpaceRow } from '../../test/space-fixtures';
import {
  DEFAULT_FX,
  ensureExchanges,
  generateEntries,
  seedEntries,
  seedFx,
} from '../../test/table-fixtures';

/**
 * Scale budget (specs 38, D19): a 5 000-position space, plus a second one of the same size so the
 * reference tables are not tiny, must page, sort and search server-side in under 300 ms per page
 * (median of 3, in-process HTTP handler incl. auth). Seeding takes a few seconds.
 */
const POSITIONS = 5000;
/** Per-page budget; `TABLE_SCALE_BUDGET_MS` overrides it on a slower machine or a loaded CI runner. */
const BUDGET_MS = Number(process.env.TABLE_SCALE_BUDGET_MS) || 300;
const NOW = new Date('2026-09-30T12:00:00Z');
const { rpc, loginAs } = createApp({ now: () => NOW });
let cookie: string;
let spaceId: string;

beforeAll(async () => {
  useTestEnv();
  await resetAuthTables();
  const userId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  await ensureExchanges();
  await seedFx(DEFAULT_FX);
  spaceId = await createSpaceRow('Gros PEA', [{ userId, role: 'viewer' }]);
  const other = await createSpaceRow('Autre', [{ userId, role: 'viewer' }]);
  await seedEntries(spaceId, generateEntries(POSITIONS, 1), NOW);
  await seedEntries(other, generateEntries(POSITIONS, 2), NOW);
  await getDb().execute(sql`analyze`);
}, 120_000);
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});

async function timed(
  input: Record<string, unknown>,
): Promise<{ ms: number; out: PositionsListOutput }> {
  const runs: { ms: number; out: PositionsListOutput }[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const res = await rpc(
      'positions.list',
      { spaceId, page: { offset: 0, limit: 50 }, ...input },
      { cookie },
    );
    const ms = performance.now() - start;
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    runs.push({ ms, out: res.json as unknown as PositionsListOutput });
  }
  runs.sort((a, b) => a.ms - b.ms);
  return runs[1]!;
}

describe(`${POSITIONS}-position space (budget ${BUDGET_MS} ms per page)`, () => {
  const scenarios: [string, Record<string, unknown>][] = [
    ['default order', {}],
    ['sort name desc', { sort: { columnId: 'name', direction: 'desc' } }],
    [
      'sort perf_period desc (1y)',
      { period: '1y', sort: { columnId: 'perf_period', direction: 'desc' } },
    ],
    ['sort price_eur asc', { sort: { columnId: 'price_eur', direction: 'asc' } }],
    ['sort tracked_value_eur desc', { sort: { columnId: 'tracked_value_eur', direction: 'desc' } }],
    [
      'sort sector asc, deep page',
      { sort: { columnId: 'sector', direction: 'asc' }, page: { offset: 4950, limit: 50 } },
    ],
    ['search name (many hits)', { search: 'societe 1-' }],
    ['search accented term (unaccent)', { search: 'SOCIÉTÉ 1-' }],
    ['search major currency (gbp finds gbx)', { search: 'gbp' }],
    [
      'search sector + sort perf_1y',
      { search: 'techno', sort: { columnId: 'perf_1y', direction: 'desc' } },
    ],
    ['search symbol (one hit)', { search: 'T1X4242' }],
    ['search ISIN prefix', { search: 'zz0000' }],
    ['search no hit', { search: 'qqqqqq' }],
    [
      '3 combined filters (S7): perf_1y range + currency + sector',
      {
        filters: [
          { kind: 'between', columnId: 'perf_1y', min: '10', max: '60' },
          { kind: 'in', columnId: 'currency', values: ['EUR', 'USD'] },
          { kind: 'in', columnId: 'sector', values: ['Energie', 'Finance', 'Technologie'] },
        ],
      },
    ],
    [
      '3 filters incl. price_eur + search + sort tracked_value_eur',
      {
        search: 'societe',
        sort: { columnId: 'tracked_value_eur', direction: 'desc' },
        filters: [
          { kind: 'between', columnId: 'price_eur', min: '20', max: '400' },
          { kind: 'between', columnId: 'perf_period', min: '0' },
          { kind: 'in', columnId: 'exchange', values: ['XPAR', 'XNAS'] },
        ],
      },
    ],
    ['all columns, limit 200', { columns: TABLE_COLUMN_IDS, page: { offset: 0, limit: 200 } }],
  ];

  it.each(scenarios)('%s', async (name, input) => {
    const { ms, out } = await timed(input);
    console.info(
      `[table-scale] ${name}: ${ms.toFixed(0)} ms (total ${out.total}, rows ${out.rows.length})`,
    );
    expect(out.total).toBeLessThanOrEqual(POSITIONS);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('filters shrink total and keep it consistent with the rows (deep page)', async () => {
    const filters = [
      { kind: 'between', columnId: 'perf_1y', min: '10', max: '60' },
      { kind: 'in', columnId: 'currency', values: ['EUR', 'USD'] },
    ];
    const first = await timed({ filters, page: { offset: 0, limit: 200 } });
    expect(first.out.total).toBeGreaterThan(100);
    expect(first.out.total).toBeLessThan(POSITIONS);
    const last = await timed({ filters, page: { offset: first.out.total - 1, limit: 50 } });
    expect(last.out.rows).toHaveLength(1);
    expect(last.out.hasMore).toBe(false);
  });

  it('positions.facets on a 5 000-position space is fast', async () => {
    const start = performance.now();
    const res = await rpc('positions.facets', { spaceId }, { cookie });
    const ms = performance.now() - start;
    console.info(`[table-scale] facets: ${ms.toFixed(0)} ms`);
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('listing_metrics keeps only its primary key (the partial indexes were dropped, EXPLAIN in BACKEND.md)', async () => {
    const rows = await getDb().execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'listing_metrics'`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(['listing_metrics_pkey']); // 0005 dropped the partial ones
  });

  it('the whole space is reachable by pages (200 per page): 25 pages, no duplicate', async () => {
    const seen = new Set<string>();
    for (let offset = 0; offset < POSITIONS; offset += 200) {
      const res = await rpc(
        'positions.list',
        { spaceId, sort: { columnId: 'perf_1y', direction: 'desc' }, page: { offset, limit: 200 } },
        { cookie },
      );
      for (const r of (res.json as unknown as PositionsListOutput).rows) seen.add(r.id);
    }
    expect(seen.size).toBe(POSITIONS);
  });
});
