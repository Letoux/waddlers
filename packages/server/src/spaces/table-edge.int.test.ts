import type { MoneyCell, PositionsListOutput } from '@waddlers/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  seedEntries,
  seedFx,
  type EntrySpec,
} from '../../test/table-fixtures';

/** Edge cases of the table query (S6 review F12 b-g, F11). */

const NOW = new Date('2026-09-30T12:00:00Z');
const { rpc, loginAs } = createApp({ now: () => NOW });
let cookie: string;
let spaceId: string;

beforeAll(useTestEnv);
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});

beforeEach(async () => {
  await resetAuthTables();
  const userId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  await ensureExchanges();
  await seedFx(DEFAULT_FX);
  spaceId = await createSpaceRow('PEA', [{ userId, role: 'viewer' }]);
});

async function list(input: Record<string, unknown> = {}) {
  const res = await rpc('positions.list', { spaceId, ...input }, { cookie });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as PositionsListOutput;
}
const names = (o: PositionsListOutput) => o.rows.map((r) => r.instrument.name);

describe('a quantity of 0 is a value of 0, never a null', () => {
  beforeEach(async () => {
    await seedEntries(spaceId, [
      { name: 'A Five', symbol: 'A5', quantity: '5', metrics: { price: '10' } }, // 50
      { name: 'B Two', symbol: 'B2', quantity: '2', metrics: { price: '100' } }, // 200
      { name: 'Z Zero', symbol: 'Z0', quantity: '0', metrics: { price: '10' } }, // 0
      { name: 'M Watch', symbol: 'MW', quantity: null, metrics: { price: '10' } }, // null
      { name: 'N NoPrice', symbol: 'NP', quantity: '3', metrics: { price: null } }, // null
    ]);
  });

  it.each([
    ['asc', ['Z Zero', 'A Five', 'B Two', 'M Watch', 'N NoPrice']],
    ['desc', ['B Two', 'A Five', 'Z Zero', 'M Watch', 'N NoPrice']],
  ] as const)(
    'tracked value %s: "0" sits with the numbers, before the nulls',
    async (dir, expected) => {
      const out = await list({
        columns: ['tracked_value_eur'],
        sort: { columnId: 'tracked_value_eur', direction: dir },
      });
      expect(names(out)).toEqual(expected);
      const zero = out.rows.find((r) => r.instrument.name === 'Z Zero')!;
      expect(zero.values.tracked_value_eur).toMatchObject({ amount: '0', reason: null });
      const watch = out.rows.find((r) => r.instrument.name === 'M Watch')!;
      expect(watch.values.tracked_value_eur).toMatchObject({
        amount: null,
        reason: 'watchlist',
        isStale: false,
      });
    },
  );

  it('quantity sorts 0 before the watchlist null in both directions', async () => {
    for (const dir of ['asc', 'desc'] as const) {
      const out = await list({ sort: { columnId: 'quantity', direction: dir } });
      const qty = out.rows.map((r) => r.quantity);
      expect(qty.at(-1), dir).toBe(null); // the watchlist entry, last either way
      expect(qty, dir).toContain('0');
    }
    const asc = await list({ sort: { columnId: 'quantity', direction: 'asc' } });
    expect(asc.rows[0]!.quantity).toBe('0');
  });
});

describe('tiebreak and text ordering', () => {
  it('duplicate names: the order is name, then position id, for the default and a tied sort', async () => {
    const specs: EntrySpec[] = ['x1', 'x2', 'x3', 'x4'].map((symbol) => ({
      name: 'Dup',
      symbol,
      metrics: { price: '10' },
    }));
    const ids = await seedEntries(spaceId, [...specs, { name: 'Aaa', symbol: 'AAA' }]);
    const dupIds = ids.slice(0, 4).sort();
    for (const sort of [undefined, { columnId: 'price_eur', direction: 'desc' }]) {
      const out = await list(sort ? { sort } : {});
      const dups = out.rows.filter((r) => r.instrument.name === 'Dup').map((r) => r.id);
      expect(dups, JSON.stringify(sort)).toEqual(dupIds);
    }
  });

  it('accented text sorts with its base letter (Électricité between Echo and Foxtrot), both ways', async () => {
    await seedEntries(spaceId, [
      { name: 'Foxtrot', symbol: 'F' },
      { name: 'Électricité de France', symbol: 'EDF' },
      { name: 'Echo', symbol: 'E' },
      { name: 'Zulu', symbol: 'Z' },
    ]);
    const asc = ['Echo', 'Électricité de France', 'Foxtrot', 'Zulu'];
    expect(names(await list())).toEqual(asc);
    expect(names(await list({ sort: { columnId: 'name', direction: 'asc' } }))).toEqual(asc);
    expect(names(await list({ sort: { columnId: 'name', direction: 'desc' } }))).toEqual(
      [...asc].reverse(),
    );
  });

  it('instrument type sorts by its French label: Action before ETF (the wire ids sort the other way)', async () => {
    await seedEntries(spaceId, [
      { name: 'The Fund', symbol: 'FND', type: 'etf' },
      { name: 'The Stock', symbol: 'STK', type: 'stock' },
    ]);
    const asc = await list({
      columns: ['instrument_type'],
      sort: { columnId: 'instrument_type', direction: 'asc' },
    });
    expect(asc.rows.map((r) => r.values.instrument_type)).toEqual(['stock', 'etf']); // Action, ETF
    const desc = await list({ sort: { columnId: 'instrument_type', direction: 'desc' } });
    expect(names(desc)).toEqual(['The Fund', 'The Stock']);
  });
});

describe('FX-date staleness (rate older than 7 days vs today)', () => {
  const entries: EntrySpec[] = [
    // Fresh price (09-29) so only the rate can make the EUR cells stale.
    {
      name: 'Usd Co',
      symbol: 'USD1',
      mic: 'XNAS',
      currency: 'USD',
      quantity: '2',
      metrics: { price: '125', asOfDate: '2026-09-29' },
    },
  ];

  it('a rate dated 8 days ago (still inside the window of the price date) makes EUR cells stale, not the price', async () => {
    await seedFx([{ currency: 'USD', rate: '1.25', date: '2026-09-22' }]);
    await seedEntries(spaceId, entries);
    const [row] = (await list({ columns: ['price', 'price_eur', 'fx_rate', 'tracked_value_eur'] }))
      .rows;
    expect((row!.values.price as MoneyCell).isStale).toBe(false);
    expect(row!.values.price_eur).toMatchObject({ amount: '100', isStale: true });
    expect(row!.values.tracked_value_eur).toMatchObject({ amount: '200', isStale: true });
    expect(row!.values.fx_rate).toMatchObject({ rateDate: '2026-09-22', isStale: true });
  });

  it('a rate dated 7 days ago is not stale (boundary)', async () => {
    await seedFx([{ currency: 'USD', rate: '1.25', date: '2026-09-23' }]);
    await seedEntries(spaceId, entries);
    const [row] = (await list({ columns: ['price_eur', 'fx_rate'] })).rows;
    expect(row!.values.price_eur).toMatchObject({ isStale: false });
    expect(row!.values.fx_rate).toMatchObject({ isStale: false });
  });
});

describe('description preview (security P3)', () => {
  const long = 'é'.repeat(281);
  beforeEach(async () => {
    await seedEntries(spaceId, [
      { name: 'Long', symbol: 'L', description: long },
      { name: 'Exact', symbol: 'E', description: 'a'.repeat(280) },
      { name: 'Short', symbol: 'S', description: 'Une activité.' },
      { name: 'None', symbol: 'N', description: null },
    ]);
  });
  const row = (o: PositionsListOutput, name: string) =>
    o.rows.find((r) => r.instrument.name === name)!;

  it('is returned when requested, cut at 280 characters with a flag', async () => {
    const out = await list({ columns: ['name', 'description'] });
    expect(row(out, 'Long').values.description).toBe('é'.repeat(280));
    expect(row(out, 'Long').descriptionTruncated).toBe(true);
    expect(row(out, 'Exact').values.description).toBe('a'.repeat(280));
    expect(row(out, 'Exact').descriptionTruncated).toBe(false);
    expect(row(out, 'Short')).toMatchObject({
      values: { description: 'Une activité.' },
      descriptionTruncated: false,
    });
    expect(row(out, 'None')).toMatchObject({
      values: { description: null },
      descriptionTruncated: false,
    });
  });

  it('is not read at all when not requested', async () => {
    const out = await list({ columns: ['name'] });
    for (const r of out.rows) {
      expect(r.values).not.toHaveProperty('description');
      expect(r.descriptionTruncated).toBe(false);
    }
  });
});

describe('columns input', () => {
  beforeEach(async () => {
    await seedEntries(spaceId, [{ name: 'Alpha', symbol: 'AAA' }]);
  });

  it('an empty list returns rows with empty values (not the defaults)', async () => {
    const out = await list({ columns: [] });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.values).toEqual({});
  });

  it('duplicate ids are accepted and answered once', async () => {
    const out = await list({ columns: ['name', 'symbol', 'name'] });
    expect(Object.keys(out.rows[0]!.values).sort()).toEqual(['name', 'symbol']);
  });
});
