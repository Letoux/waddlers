import {
  POSITIONS_LIST_MAX,
  type PositionsListOutput,
  type SpacesListOutput,
} from '@waddlers/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../admin';
import { getDb } from '../db/client';
import {
  exchanges,
  instruments,
  listings,
  spaceMembers,
  spacePositions,
  spaces,
  users,
} from '../db/schema';
import { pgErrorCode } from '../db/errors';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { createPositionRow, createSpaceRow, ensureReferenceData } from '../../test/space-fixtures';

const { rpc, loginAs } = createApp();
let userId: string;
let cookie: string;
let ref: Awaited<ReturnType<typeof ensureReferenceData>>;

beforeAll(async () => {
  useTestEnv();
});
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});
beforeEach(async () => {
  await resetAuthTables();
  userId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  ref = await ensureReferenceData();
});

const list = async (spaceId: string) =>
  (await rpc('positions.list', { spaceId }, { cookie })).json as unknown as PositionsListOutput;

describe('spaces.list / spaces.get / spaces.setActive', () => {
  it('lists own spaces by name with role and position count, and a default active space', async () => {
    const b = await createSpaceRow('beta', [{ userId, role: 'viewer' }]);
    const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
    await createSpaceRow('Hidden', []);
    await createPositionRow(a, ref.ai, '1');
    await createPositionRow(a, ref.msft, null);
    const res = await rpc('spaces.list', undefined, { cookie });
    const body = res.json as unknown as SpacesListOutput;
    expect(body.spaces).toEqual([
      { id: a, name: 'Alpha', referenceCurrency: 'EUR', role: 'owner', positionCount: 2 },
      { id: b, name: 'beta', referenceCurrency: 'EUR', role: 'viewer', positionCount: 0 },
    ]);
    expect(body.activeSpaceId).toBe(a);
  });

  it('setActive persists the last space; list honours it, falls back once access is gone', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
    const b = await createSpaceRow('Beta', [{ userId, role: 'viewer' }]);
    expect((await rpc('spaces.setActive', { spaceId: b }, { cookie })).json).toEqual({
      activeSpaceId: b,
    });
    const first = (await rpc('spaces.list', undefined, { cookie }))
      .json as unknown as SpacesListOutput;
    expect(first.activeSpaceId).toBe(b);
    await getDb().delete(spaceMembers).where(eq(spaceMembers.spaceId, b));
    const second = (await rpc('spaces.list', undefined, { cookie }))
      .json as unknown as SpacesListOutput;
    expect(second.activeSpaceId).toBe(a);
  });

  it('a denied setActive does not change the stored preference', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
    const other = await createSpaceRow('Other', []);
    await rpc('spaces.setActive', { spaceId: a }, { cookie });
    expect((await rpc('spaces.setActive', { spaceId: other }, { cookie })).status).toBe(404);
    const [u] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(u?.lastSpaceId).toBe(a);
  });

  it('deleting the space clears last_space_id (on delete set null)', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
    await rpc('spaces.setActive', { spaceId: a }, { cookie });
    await getDb().delete(spaces).where(eq(spaces.id, a));
    const [u] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(u?.lastSpaceId).toBeNull();
  });

  it('get returns the summary with the caller role', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'editor' }]);
    await createPositionRow(a, ref.ai, '1');
    expect((await rpc('spaces.get', { spaceId: a }, { cookie })).json).toEqual({
      id: a,
      name: 'Alpha',
      referenceCurrency: 'EUR',
      role: 'editor',
      positionCount: 1,
    });
  });
});

describe('positions.list', () => {
  it('returns instrument, listing, exchange, currency metadata; null quantity stays null', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'viewer' }]);
    await createPositionRow(a, ref.shel, '100.50000000', 'Primary listing, pence.');
    await createPositionRow(a, ref.msft, null);
    await createPositionRow(a, ref.cw8, '0');
    const { rows, total, truncated } = await list(a);
    expect(total).toBe(3);
    expect(truncated).toBe(false);
    const byName = Object.fromEntries(rows.map((r) => [r.instrument.name, r]));
    expect(byName.Shell).toMatchObject({
      quantity: '100.5',
      selectionReason: 'Primary listing, pence.',
      instrument: { type: 'stock', isin: 'GB00BP6MXD84' },
      listing: {
        symbol: 'SHEL',
        exchange: { mic: 'XLON', name: 'London Stock Exchange' },
        currency: 'GBX',
        currencyMajor: 'GBP',
        minorUnitDivisor: 100,
      },
    });
    expect(byName.Microsoft?.quantity).toBeNull();
    expect(byName.Microsoft?.selectionReason).toBeNull();
    expect(byName['World ETF']).toMatchObject({ quantity: '0', instrument: { type: 'etf' } });
    expect(byName['World ETF']?.listing).toMatchObject({
      currencyMajor: 'EUR',
      minorUnitDivisor: 1,
    });
    expect(rows.map((r) => r.instrument.name)).toEqual(['Microsoft', 'Shell', 'World ETF']);
    expect(new Date(rows[0]!.addedAt).toString()).not.toBe('Invalid Date');
  });

  it('caps the list and reports the truncation', async () => {
    const a = await createSpaceRow('Big', [{ userId, role: 'viewer' }]);
    const n = POSITIONS_LIST_MAX + 5;
    await getDb().execute(sql`
      with i as (
        insert into instruments (type, name)
        select 'stock', 'Bulk ' || lpad(g::text, 5, '0') from generate_series(1, ${n}) g
        returning id, name
      ), l as (
        insert into listings (instrument_id, exchange_mic, symbol, currency)
        select id, 'XPAR', 'B' || substr(name, 6), 'EUR' from i
        returning id, instrument_id
      )
      insert into space_positions (space_id, instrument_id, listing_id, quantity)
      select ${a}::uuid, instrument_id, id, 1 from l`);
    const { rows, total, truncated } = await list(a);
    expect(rows).toHaveLength(POSITIONS_LIST_MAX);
    expect(total).toBe(n);
    expect(truncated).toBe(true);
  });
});

describe('positions.setQuantity', () => {
  it.each([
    ['1234567890123456.12345678'],
    ['0.00000001'],
    ['0.1'],
    ['0.2'],
    ['12.5'],
    ['100'],
    ['0'],
    ['9007199254740993'], // above Number.MAX_SAFE_INTEGER: a float round trip would corrupt it
  ])('round-trips %s exactly through the API and the database (no float)', async (quantity) => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
    const id = await createPositionRow(a, ref.ai, '1');
    const res = await rpc(
      'positions.setQuantity',
      { spaceId: a, positionId: id, quantity },
      { cookie },
    );
    expect(res.json).toEqual({ positionId: id, quantity });
    expect((await list(a)).rows[0]?.quantity).toBe(quantity);
    const [stored] = (await getDb().execute(
      sql`select quantity::text as q from space_positions where id = ${id}`,
    )) as unknown as { q: string }[];
    const q = stored!.q;
    const [int = '', frac = ''] = quantity.split('.');
    expect(q).toBe(`${int}.${frac.padEnd(8, '0')}`);
  });

  it('null makes a watchlist entry (not 0) and a number can be restored', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'editor' }]);
    const id = await createPositionRow(a, ref.ai, '5');
    const cleared = await rpc(
      'positions.setQuantity',
      { spaceId: a, positionId: id, quantity: null },
      { cookie },
    );
    expect(cleared.json).toEqual({ positionId: id, quantity: null });
    const [row] = await getDb().select().from(spacePositions).where(eq(spacePositions.id, id));
    expect(row?.quantity).toBeNull();
    expect((await list(a)).rows[0]?.quantity).toBeNull();
  });

  it('is safe to repeat and bumps updated_at', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'editor' }]);
    const id = await createPositionRow(a, ref.ai, '5');
    const input = { spaceId: a, positionId: id, quantity: '7' };
    const [before] = await getDb().select().from(spacePositions).where(eq(spacePositions.id, id));
    expect((await rpc('positions.setQuantity', input, { cookie })).status).toBe(200);
    expect((await rpc('positions.setQuantity', input, { cookie })).status).toBe(200);
    const [after] = await getDb().select().from(spacePositions).where(eq(spacePositions.id, id));
    expect(after?.quantity).toBe('7.00000000');
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it.each(['-1', 'NaN', '1e3', '1 000', '1,5', '0.123456789', '12345678901234567', '', ' 1'])(
    'rejects %j with BAD_REQUEST and stores nothing',
    async (quantity) => {
      const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
      const id = await createPositionRow(a, ref.ai, '5');
      const res = await rpc(
        'positions.setQuantity',
        { spaceId: a, positionId: id, quantity },
        { cookie },
      );
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('BAD_REQUEST');
      expect((await list(a)).rows[0]?.quantity).toBe('5');
    },
  );

  it('rejects numbers and a missing quantity', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
    const id = await createPositionRow(a, ref.ai, '5');
    for (const quantity of [5, undefined]) {
      const res = await rpc(
        'positions.setQuantity',
        { spaceId: a, positionId: id, quantity },
        { cookie },
      );
      expect(res.status).toBe(400);
    }
  });
});

describe('positions.remove', () => {
  it('removes the position (only that one) and a repeat is NOT_FOUND', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'editor' }]);
    const id = await createPositionRow(a, ref.ai, '5');
    await createPositionRow(a, ref.msft, '1');
    expect(
      (await rpc('positions.remove', { spaceId: a, positionId: id }, { cookie })).json,
    ).toEqual({ ok: true });
    expect((await list(a)).rows.map((r) => r.instrument.name)).toEqual(['Microsoft']);
    expect((await rpc('positions.remove', { spaceId: a, positionId: id }, { cookie })).status).toBe(
      404,
    );
  });
});

describe('database constraints and cascades', () => {
  const failsWith = async (code: string, run: () => Promise<unknown>) => {
    let caught: unknown;
    try {
      await run();
    } catch (error) {
      caught = error;
    }
    expect(pgErrorCode(caught)).toBe(code);
  };

  it('rejects negative and NaN quantities and duplicate instruments per space', async () => {
    const a = await createSpaceRow('Alpha', []);
    await failsWith('23514', () => createPositionRow(a, ref.ai, '-1'));
    await failsWith('23514', () => createPositionRow(a, ref.ai, 'NaN'));
    await createPositionRow(a, ref.ai, '1');
    await failsWith('23505', () => createPositionRow(a, ref.ai, '2'));
    await failsWith('22003', () => createPositionRow(a, ref.msft, '12345678901234567'));
  });

  it('a position listing must belong to its instrument (composite FK)', async () => {
    const a = await createSpaceRow('Alpha', []);
    await failsWith('23503', () =>
      createPositionRow(
        a,
        { instrumentId: ref.ai.instrumentId, listingId: ref.msft.listingId },
        '1',
      ),
    );
  });

  it('rejects an invalid role and duplicate memberships', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
    await failsWith('23514', () =>
      getDb()
        .insert(spaceMembers)
        .values({ spaceId: a, userId, role: 'admin' as 'owner' }),
    );
    await failsWith('23505', () =>
      getDb().insert(spaceMembers).values({ spaceId: a, userId, role: 'viewer' }),
    );
  });

  it('space names are unique case-insensitively', async () => {
    await createSpaceRow('PEA', []);
    await failsWith('23505', () => createSpaceRow('pea', []));
  });

  it('deleting a space cascades members and positions; instruments and listings are restricted', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
    await createPositionRow(a, ref.ai, '1');
    await failsWith('23503', () =>
      getDb().delete(instruments).where(eq(instruments.id, ref.ai.instrumentId)),
    );
    await failsWith('23503', () =>
      getDb().delete(listings).where(eq(listings.id, ref.ai.listingId)),
    );
    await failsWith('23503', () => getDb().delete(exchanges).where(eq(exchanges.mic, 'XPAR')));
    await getDb().delete(spaces).where(eq(spaces.id, a));
    expect(await getDb().select().from(spacePositions)).toHaveLength(0);
    expect(await getDb().select().from(spaceMembers)).toHaveLength(0);
    // Now unreferenced positions no longer block reference data cleanup.
    await getDb().delete(listings).where(eq(listings.id, ref.ai.listingId));
    await getDb().delete(instruments).where(eq(instruments.id, ref.ai.instrumentId));
  });

  it('listings are unique per (exchange, symbol) and provider symbols per provider', async () => {
    await failsWith('23505', () =>
      getDb().insert(listings).values({
        instrumentId: ref.ai.instrumentId,
        exchangeMic: 'XPAR',
        symbol: 'AI',
        currency: 'EUR',
      }),
    );
  });
});
