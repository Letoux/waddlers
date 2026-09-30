import {
  POSITIONS_LIST_MAX,
  type PositionsListOutput,
  type SpacesListOutput,
} from '@waddlers/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeCurrency } from '@waddlers/domain';
import { createUser } from '../admin';
import { getDb } from '../db/client';
import {
  exchanges,
  instruments,
  listingProviderIds,
  listings,
  spaceMembers,
  spacePositions,
  spaces,
  users,
} from '../db/schema';
import { pgErrorCode } from '../db/errors';
import { requireSpaceAccess } from './access';
import { deletePosition, updatePositionQuantity } from './repository';
import { removeSpacePosition, setPositionQuantity } from './service';
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

const failsWith = async (code: string, run: () => Promise<unknown>) => {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(pgErrorCode(caught)).toBe(code);
};

const list = async (spaceId: string, page?: { offset?: number; limit?: number }) =>
  (await rpc('positions.list', { spaceId, ...(page ? { page } : {}) }, { cookie }))
    .json as unknown as PositionsListOutput;

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
    const { rows, total, hasMore } = await list(a);
    expect(total).toBe(3);
    expect(hasMore).toBe(false);
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

  it('caps the default page and reports hasMore', async () => {
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
    const { rows, total, hasMore } = await list(a); // no `page`: same as the S3 behaviour
    expect(rows).toHaveLength(POSITIONS_LIST_MAX);
    expect(total).toBe(n);
    expect(hasMore).toBe(true);
    const tail = await list(a, { offset: POSITIONS_LIST_MAX });
    expect(tail.rows).toHaveLength(5);
    expect(tail.hasMore).toBe(false);
    expect(tail.total).toBe(n);
  });
});

describe('positions.list pagination', () => {
  async function fiveRows() {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'viewer' }]);
    for (const r of [ref.ai, ref.shel, ref.cw8, ref.msft]) await createPositionRow(a, r, '1');
    return a;
  }

  it('orders by instrument name case-insensitively (not by byte order)', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'viewer' }]);
    await getDb()
      .update(instruments)
      .set({ name: 'air liquide' })
      .where(eq(instruments.id, ref.ai.instrumentId));
    for (const r of [ref.shel, ref.ai, ref.msft, ref.cw8]) await createPositionRow(a, r, '1');
    // Byte order would put every capitalised name before 'air liquide'.
    expect((await list(a)).rows.map((r) => r.instrument.name)).toEqual([
      'air liquide',
      'Microsoft',
      'Shell',
      'World ETF',
    ]);
  });

  it('pages with offset and limit; total is the whole space; hasMore = offset + rows < total', async () => {
    const a = await fiveRows();
    const all = (await list(a)).rows.map((r) => r.id);
    const p1 = await list(a, { offset: 0, limit: 3 });
    expect(p1.rows.map((r) => r.id)).toEqual(all.slice(0, 3));
    expect([p1.total, p1.hasMore]).toEqual([4, true]);
    const p2 = await list(a, { offset: 3, limit: 3 });
    expect(p2.rows.map((r) => r.id)).toEqual(all.slice(3));
    expect([p2.total, p2.hasMore]).toEqual([4, false]);
    const exact = await list(a, { offset: 0, limit: 4 });
    expect([exact.rows.length, exact.hasMore]).toEqual([4, false]);
    const beyond = await list(a, { offset: 10, limit: 3 });
    expect([beyond.rows.length, beyond.total, beyond.hasMore]).toEqual([0, 4, false]);
  });

  it('defaults (offset 0, limit MAX, also for a partial page) match the old behaviour', async () => {
    const a = await fiveRows();
    const plain = await list(a);
    expect(await list(a, {})).toEqual(plain);
    expect(await list(a, { offset: 0 })).toEqual(plain);
    expect(await list(a, { limit: POSITIONS_LIST_MAX })).toEqual(plain);
    expect(plain.hasMore).toBe(false);
  });

  it.each([
    [{ offset: -1 }],
    [{ limit: 0 }],
    [{ limit: POSITIONS_LIST_MAX + 1 }],
    [{ offset: 1.5 }],
    [{ limit: '5' }],
  ])('rejects the invalid page %j with BAD_REQUEST', async (page) => {
    const a = await fiveRows();
    const res = await rpc('positions.list', { spaceId: a, page }, { cookie });
    expect(res.status).toBe(400);
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
    const past = new Date('2020-01-01T00:00:00Z');
    await getDb().update(spacePositions).set({ updatedAt: past }).where(eq(spacePositions.id, id));
    const input = { spaceId: a, positionId: id, quantity: '7' };
    expect((await rpc('positions.setQuantity', input, { cookie })).status).toBe(200);
    const [once] = await getDb().select().from(spacePositions).where(eq(spacePositions.id, id));
    expect(once!.updatedAt.getTime()).toBeGreaterThan(past.getTime());
    expect((await rpc('positions.setQuantity', input, { cookie })).status).toBe(200);
    const [twice] = await getDb().select().from(spacePositions).where(eq(spacePositions.id, id));
    expect(twice?.quantity).toBe('7.00000000');
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

  it('listings are unique per (exchange, symbol)', async () => {
    await failsWith('23505', () =>
      getDb().insert(listings).values({
        instrumentId: ref.ai.instrumentId,
        exchangeMic: 'XPAR',
        symbol: 'AI',
        currency: 'EUR',
      }),
    );
  });

  it('provider ids are unique per (listing, provider) and per (provider, provider_symbol)', async () => {
    await getDb()
      .insert(listingProviderIds)
      .values({ listingId: ref.ai.listingId, provider: 'eodhd', providerSymbol: 'AI.PA' });
    await failsWith('23505', () =>
      getDb()
        .insert(listingProviderIds)
        .values({ listingId: ref.ai.listingId, provider: 'eodhd', providerSymbol: 'OTHER.PA' }),
    );
    await failsWith('23505', () =>
      getDb()
        .insert(listingProviderIds)
        .values({ listingId: ref.cw8.listingId, provider: 'eodhd', providerSymbol: 'AI.PA' }),
    );
  });

  it('rejects blank or oversized names and minor-unit reference currencies (migration 0003)', async () => {
    await failsWith('23514', () => createSpaceRow('   ', []));
    await failsWith('23514', () => createSpaceRow('x'.repeat(65), []));
    await createSpaceRow('x'.repeat(64), []);
    await failsWith('23514', () =>
      getDb().insert(instruments).values({ name: '   ', type: 'stock' }),
    );
    for (const referenceCurrency of ['GBX', 'ZAC', 'ILA', 'eur', 'EU']) {
      await failsWith('23514', () =>
        getDb()
          .insert(spaces)
          .values({ name: `ccy ${referenceCurrency}`, referenceCurrency }),
      );
    }
    await getDb().insert(spaces).values({ name: 'usd space', referenceCurrency: 'USD' });
  });
});

describe('the writer role is re-checked inside the write (no check-then-act window)', () => {
  it('revocation or downgrade between requireSpaceAccess and the write prevents the write', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'editor' }]);
    const p1 = await createPositionRow(a, ref.ai, '5');
    const p2 = await createPositionRow(a, ref.msft, '6');
    const ctx = { db: getDb(), userId };
    const access = await requireSpaceAccess(ctx, a, 'editor');

    // Downgraded to viewer after the access check.
    await getDb().update(spaceMembers).set({ role: 'viewer' }).where(eq(spaceMembers.spaceId, a));
    expect(await updatePositionQuantity(getDb(), access, p1, '99')).toBeUndefined();
    expect(await deletePosition(getDb(), access, p2)).toBe(false);

    // Revoked entirely.
    await getDb().delete(spaceMembers).where(eq(spaceMembers.spaceId, a));
    expect(await updatePositionQuantity(getDb(), access, p1, '99')).toBeUndefined();
    expect(await deletePosition(getDb(), access, p2)).toBe(false);

    const rows = await getDb().select().from(spacePositions).where(eq(spacePositions.spaceId, a));
    expect(rows.map((r) => r.quantity).sort()).toEqual(['5.00000000', '6.00000000']);
  });

  it('the service answers NOT_FOUND when the guard blocks the write', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'editor' }]);
    const p1 = await createPositionRow(a, ref.ai, '5');
    const access = await requireSpaceAccess({ db: getDb(), userId }, a, 'editor');
    await getDb().delete(spaceMembers).where(eq(spaceMembers.spaceId, a));
    await expect(setPositionQuantity(getDb(), access, p1, '1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(removeSpacePosition(getDb(), access, p1)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a still-valid writer is unaffected', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'owner' }]);
    const p1 = await createPositionRow(a, ref.ai, '5');
    const access = await requireSpaceAccess({ db: getDb(), userId }, a, 'editor');
    expect((await updatePositionQuantity(getDb(), access, p1, '8'))?.quantity).toBe('8.00000000');
    expect(await deletePosition(getDb(), access, p1)).toBe(true);
  });
});

describe('requireSpaceAccess id normalisation', () => {
  it('mints the lower-case id even when the client sent upper case, and access still works', async () => {
    const a = await createSpaceRow('Alpha', [{ userId, role: 'viewer' }]);
    const access = await requireSpaceAccess({ db: getDb(), userId }, a.toUpperCase(), 'viewer');
    expect(access.id).toBe(a.toLowerCase());
    const res = await rpc('spaces.get', { spaceId: a.toUpperCase() }, { cookie });
    expect(res.status).toBe(200);
    expect((res.json as unknown as { id: string }).id).toBe(a.toLowerCase());
  });
});

describe('listings.currency CHECK stays in sync with the domain minor units', () => {
  // Every 3-letter mixed-case code the domain treats as a minor unit, other than the all-caps ones.
  function domainLowerCaseMinorUnits(): string[] {
    const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const found: string[] = [];
    for (const a of letters)
      for (const b of letters)
        for (const c of letters) {
          const code = `${a}${b}${c}`;
          if (/^[A-Z]{3}$/.test(code)) continue;
          if (normalizeCurrency(code)?.isMinorUnit) found.push(code);
        }
    return found.sort();
  }

  it('accepts exactly the domain mixed-case minor units (and all-caps codes), nothing else', async () => {
    const codes = domainLowerCaseMinorUnits();
    expect(codes).toEqual(['GBp', 'ZAc']);
    const insert = (currency: string, symbol: string) =>
      getDb().insert(listings).values({
        instrumentId: ref.ai.instrumentId,
        exchangeMic: 'XPAR',
        symbol,
        currency,
      });
    for (const [i, code] of [...codes, 'GBX', 'USD'].entries()) await insert(code, `OK${i}`);
    for (const [i, code] of ['gbx', 'Gbp', 'usd', 'ZAC ', 'GB', 'GBPX'].entries()) {
      await failsWith('23514', () => insert(code, `BAD${i}`));
    }
  });
});
