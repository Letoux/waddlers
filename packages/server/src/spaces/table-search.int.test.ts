import type { PositionsListOutput } from '@waddlers/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../admin';
import { getDb } from '../db/client';
import { recomputeListingMetrics } from '../market-data/metrics';
import { recordSuccess, upsertBars, upsertFxRates } from '../market-data/repository';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { testConfig } from '../../test/market-fixtures';
import { createPositionRow, createSpaceRow, ensureReferenceData } from '../../test/space-fixtures';
import {
  DEFAULT_FX,
  ensureExchanges,
  SORT_DATASET,
  seedEntries,
  seedFx,
} from '../../test/table-fixtures';

const NOW = new Date('2026-09-30T12:00:00Z');
const { rpc, loginAs } = createApp({ now: () => NOW });
let cookie: string;
let userId: string;
let spaceId: string;

beforeAll(useTestEnv);
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});

beforeEach(async () => {
  await resetAuthTables();
  userId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  await ensureExchanges();
  await seedFx(DEFAULT_FX);
  spaceId = await createSpaceRow('PEA', [{ userId, role: 'viewer' }]);
});

async function found(search: string): Promise<string[]> {
  const res = await rpc('positions.list', { spaceId, search }, { cookie });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = res.json as unknown as PositionsListOutput;
  expect(out.total).toBe(out.rows.length);
  return out.rows.map((r) => r.instrument.name).sort();
}

describe('search per field (case-insensitive substring)', () => {
  beforeEach(async () => {
    await seedEntries(spaceId, SORT_DATASET, NOW);
  });

  it.each([
    ['name', 'alph', ['Alpha']],
    ['name, upper case', 'CHARLIE', ['Charlie']],
    ['symbol', 'bbb', ['bravo']],
    ['symbol, mixed case', 'eEe', ['Echo']],
    ['isin', 'fr0000120073', ['Alpha']],
    ['sector', 'TECHNO', ['foxtrot', 'hotel']],
    ['currency', 'usd', ['Charlie', 'foxtrot']],
    ['exchange name', 'nasdaq', ['Charlie', 'foxtrot']],
    ['exchange mic', 'xlon', ['Echo']],
    ['phrase with a space', 'stock exch', ['Echo']],
    [
      'several fields at once',
      'a',
      ['Alpha', 'Charlie', 'Echo', 'Golf', 'bravo', 'delta', 'foxtrot', 'hotel'],
    ],
  ])('%s: %s', async (_field, term, expected) => {
    expect(await found(term)).toEqual([...expected].sort());
  });

  it('a stored ETF sector is not searchable (not applicable, specs 24)', async () => {
    // delta is an ETF whose row stores sector "Finance": only the two stocks match.
    expect(await found('finance')).toEqual(['Charlie', 'Echo']);
  });

  it('blank search = no search; nothing matching = empty with total 0', async () => {
    expect(await found('   ')).toHaveLength(SORT_DATASET.length);
    expect(await found('no such thing')).toEqual([]);
  });

  it('search composes with sort and pagination', async () => {
    const res = await rpc(
      'positions.list',
      {
        spaceId,
        search: 'usd',
        sort: { columnId: 'price_eur', direction: 'desc' },
        page: { offset: 0, limit: 1 },
      },
      { cookie },
    );
    const out = res.json as unknown as PositionsListOutput;
    expect(out).toMatchObject({ total: 2, hasMore: true });
    expect(out.rows.map((r) => r.instrument.name)).toEqual(['Charlie']); // 160 EUR; foxtrot has no price
  });
});

describe('LIKE wildcards are literal', () => {
  beforeEach(async () => {
    await seedEntries(spaceId, [
      { name: 'Rate 50% Fund', symbol: 'R50' },
      { name: 'Rate 500 Fund', symbol: 'R500' },
      { name: 'under_score', symbol: 'US1' },
      { name: 'underXscore', symbol: 'US2' },
      { name: 'back\\slash', symbol: 'BS1' },
      { name: 'backXslash', symbol: 'BS2' },
      { name: 'Plain', symbol: 'PLN' },
    ]);
  });

  it.each([
    ['50%', ['Rate 50% Fund']],
    ['%', ['Rate 50% Fund']],
    ['_', ['under_score']],
    ['x_s', []],
    ['under_s', ['under_score']],
    ['\\', ['back\\slash']],
    ['k\\s', ['back\\slash']],
    ['%%', []],
    ['\\%', []],
    // Full-width look-alikes are folded to ASCII by unaccent: they must be escaped AFTER folding.
    ['％', ['Rate 50% Fund']], // = literal "%", not "match everything"
    ['＿', ['under_score']], // = literal "_"
    ['＼', ['back\\slash']], // = literal "\\"
    ['50％', ['Rate 50% Fund']], // = "50%", not "50" followed by anything
    ['％％', []],
    ['ｕｎｄｅｒ＿ｓ', ['under_score']],
    ["'; drop table spaces; --", []],
  ])('search %j', async (term, expected) => {
    expect(await found(term)).toEqual(expected);
  });
});

describe('accent-, case- and apostrophe-insensitive (F2)', () => {
  beforeEach(async () => {
    await seedEntries(spaceId, [
      { name: 'Société Générale', symbol: 'GLE', sector: 'Finance' },
      { name: 'Sanofi', symbol: 'SAN', sector: 'Santé' },
      { name: 'L’Oréal', symbol: 'OR' }, // typographic apostrophe stored in the data
      { name: "Dell'Anno", symbol: 'DEL' }, // straight apostrophe stored in the data
      { name: 'Hermès International', symbol: 'RMS' },
      { name: 'Shell', symbol: 'SHEL', mic: 'XLON', currency: 'GBX' },
      { name: 'Plain', symbol: 'PLN' },
    ]);
  });

  it.each([
    ['societe', ['Société Générale']],
    ['SOCIETE GENERALE', ['Société Générale']],
    ['Société', ['Société Générale']], // accented term against accented data
    ['SANTE', ['Sanofi']], // sector, accent folded from the term side
    ['santé', ['Sanofi']],
    ["l'oreal", ['L’Oréal']], // straight term, typographic data
    ['l’oreal', ['L’Oréal']], // typographic term, accented data
    ['L‘Oréal', ['L’Oréal']], // left single quotation mark
    ['dell’anno', ["Dell'Anno"]], // typographic term, straight data
    ['hermes', ['Hermès International']],
    ['HERMÈS', ['Hermès International']],
    ['x%', []],
  ])('search %j', async (term, expected) => {
    expect(await found(term)).toEqual(expected);
  });

  it('the major currency finds minor-unit listings (GBP finds GBX, F11); GBX itself still works', async () => {
    expect(await found('gbp')).toEqual(['Shell']);
    expect(await found('GBX')).toEqual(['Shell']);
    expect(await found('eur')).toEqual(
      [
        'Hermès International',
        "Dell'Anno",
        'L’Oréal',
        'Plain',
        'Sanofi',
        'Société Générale',
      ].sort(),
    );
  });
});

describe('GBX through the real metrics pipeline (price_eur)', () => {
  it('2000 GBX at 0.8 GBP per EUR is 25 EUR; the position is worth 10 x 25', async () => {
    const ref = await ensureReferenceData();
    await createPositionRow(spaceId, ref.shel, '10');
    await upsertBars(
      getDb(),
      { id: ref.shel.listingId, currency: 'GBX' },
      [
        ['2026-08-28', '1800'],
        ['2026-09-30', '2000'],
      ].map(([date, close]) => ({ date: date!, close: close!, adjClose: null })),
      { source: 'fake', fetchedAt: NOW },
    );
    await recordSuccess(getDb(), ref.shel.listingId, 'history', NOW, {
      historyCompleteFrom: '2026-08-28',
    });
    await upsertFxRates(
      getDb(),
      ['2026-08-28', '2026-09-30'].map((date) => ({ date, currency: 'GBP', ratePerEur: '0.8' })),
      { source: 'fake', fetchedAt: NOW },
    );
    await recomputeListingMetrics(getDb(), { now: NOW, config: testConfig });
    const res = await rpc(
      'positions.list',
      {
        spaceId,
        columns: ['price', 'price_eur', 'fx_rate', 'tracked_value_eur', 'perf_period'],
        period: '1m',
      },
      { cookie },
    );
    const [row] = (res.json as unknown as PositionsListOutput).rows;
    expect(row!.values).toMatchObject({
      price: { amount: '2000', currency: 'GBX', asOf: '2026-09-30', isStale: false },
      price_eur: { amount: '25', currency: 'EUR', isStale: false },
      fx_rate: { eurPerUnit: '0.0125', rateDate: '2026-09-30' },
      tracked_value_eur: { amount: '250', currency: 'EUR' },
      perf_period: { value: '11.11111111', baseDate: '2026-08-28' },
    });
  });
});
