import { Readable, Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { ensureReferenceData } from '../../test/space-fixtures';
import { runAdminCli, type CliIo } from './cli';
import { createUser } from './index';
import { seedDevWorkspace } from './seed';

beforeAll(useTestEnv);
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});
beforeEach(resetAuthTables);

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  const sink = (into: string[]) =>
    new Writable({ write: (chunk, _e, done) => (into.push(String(chunk)), done()) });
  const io: CliIo = {
    out: sink(out),
    err: sink(err),
    interactive: false,
    readSecret: async () => Readable.from([]).toString(),
  };
  return { io, out: () => out.join(''), err: () => err.join('') };
}

async function run(...argv: string[]) {
  const c = cli();
  const code = await runAdminCli(argv, getDb(), c.io);
  return { code, out: c.out(), err: c.err() };
}

describe('space admin commands', () => {
  it('space:create / space:list / space:rename', async () => {
    const created = await run('space:create', 'PEA');
    expect(created.code).toBe(0);
    expect(created.out).toMatch(/Space created: PEA \([0-9a-f-]{36}\)/);
    const [row] = await getDb().select().from(spaces);
    expect(row).toMatchObject({ name: 'PEA', referenceCurrency: 'EUR' });

    const dup = await run('space:create', 'pea');
    expect(dup.code).toBe(1);
    expect(dup.err).toContain('already exists');

    expect((await run('space:list')).out).toContain(`${row!.id}  PEA  members=0  positions=0`);

    expect((await run('space:rename', 'pea', 'Actions FR')).code).toBe(0);
    expect((await getDb().select().from(spaces))[0]?.name).toBe('Actions FR');
    await run('space:create', 'Other');
    const clash = await run('space:rename', 'Other', 'ACTIONS FR');
    expect(clash.code).toBe(1);
    expect((await run('space:rename', 'ghost', 'x')).err).toContain('Space not found');
    // renaming to a different case of itself is allowed
    expect((await run('space:rename', 'Actions FR', 'actions fr')).code).toBe(0);
  });

  it('space:grant is an upsert, space:revoke is idempotent, and access follows', async () => {
    await createUser(getDb(), { username: 'alice', password: PASSWORD });
    await run('space:create', 'PEA');
    expect((await run('space:grant', 'PEA', 'alice', 'viewer')).out).toContain('Granted');
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    const spaceId = (await getDb().select().from(spaces))[0]!.id;
    expect((await rpc('spaces.get', { spaceId }, { cookie })).json).toMatchObject({
      role: 'viewer',
    });

    expect((await run('space:grant', 'PEA', 'ALICE', 'owner')).out).toContain('Updated');
    expect(await getDb().select().from(spaceMembers)).toHaveLength(1);
    expect((await rpc('spaces.get', { spaceId }, { cookie })).json).toMatchObject({
      role: 'owner',
    });

    expect((await run('space:revoke', 'PEA', 'alice')).out).toContain('Revoked');
    expect((await rpc('spaces.get', { spaceId }, { cookie })).status).toBe(404);
    const again = await run('space:revoke', 'PEA', 'alice');
    expect(again.code).toBe(0);
    expect(again.out).toContain('had no access');
  });

  it('space:grant rejects unknown roles, spaces and users', async () => {
    await createUser(getDb(), { username: 'alice', password: PASSWORD });
    await run('space:create', 'PEA');
    expect((await run('space:grant', 'PEA', 'alice', 'admin')).err).toContain('Invalid role');
    expect((await run('space:grant', 'nope', 'alice', 'viewer')).err).toContain('Space not found');
    expect((await run('space:grant', 'PEA', 'ghost', 'viewer')).err).toContain('User not found');
    expect(await getDb().select().from(spaceMembers)).toHaveLength(0);
  });

  it('position:add tracks a listing, with or without quantity, and refuses duplicates', async () => {
    await ensureReferenceData();
    await run('space:create', 'PEA');
    expect((await run('position:add', 'PEA', 'AI.XPAR', '10.5')).code).toBe(0);
    expect((await run('position:add', 'PEA', 'MSFT.xnas')).out).toContain('watchlist');
    const rows = await getDb().select().from(spacePositions);
    expect(rows.map((r) => r.quantity).sort()).toEqual(['10.50000000', null]);

    const dup = await run('position:add', 'PEA', 'AI.XPAR', '3');
    expect(dup.code).toBe(1);
    expect(dup.err).toContain('already exists');
    expect((await getDb().select().from(spacePositions)).length).toBe(2);
    expect((await run('space:list')).out).toContain('positions=2');

    expect((await run('position:add', 'PEA', 'NOPE.XPAR')).err).toContain('Unknown listing');
    expect((await run('position:add', 'ghost', 'AI.XPAR')).err).toContain('Space not found');
    expect((await run('position:add', 'PEA', 'CW8.XPAR', '1e3')).err).toContain('Invalid quantity');
    expect((await run('position:add', 'PEA', 'CW8.XPAR', '-1')).code).toBe(1);
    expect((await getDb().select().from(spacePositions)).length).toBe(2);
  });

  it('position:add refuses a second listing of an instrument already tracked', async () => {
    const ref = await ensureReferenceData();
    await getDb().insert(exchanges).values({
      mic: 'XETR',
      name: 'Xetra',
      timezone: 'Europe/Berlin',
      country: 'DE',
    });
    await getDb().insert(listings).values({
      instrumentId: ref.ai.instrumentId,
      exchangeMic: 'XETR',
      symbol: 'AIL',
      currency: 'EUR',
    });
    await run('space:create', 'PEA');
    expect((await run('position:add', 'PEA', 'AI.XPAR', '1')).code).toBe(0);
    const other = await run('position:add', 'PEA', 'AIL.XETR', '1');
    expect(other.code).toBe(1);
    expect(other.err).toContain('another listing');
  });
});

describe('dev workspace seed', () => {
  const env = () => ({
    NODE_ENV: 'development',
    APP_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: process.env.DATABASE_URL_TEST,
    SEED_USER_PASSWORD: PASSWORD,
    SEED_USER_USERNAME: 'devuser',
  });

  it('creates reference data, three spaces, correct roles, and is idempotent', async () => {
    const first = await seedDevWorkspace(getDb(), env());
    expect(first.user.status).toBe('created');
    expect(first.spaces.map((s) => [s.name, s.access])).toEqual([
      ['PEA', 'owner'],
      ['Actions US', 'viewer'],
      ['Famille', null],
    ]);
    const counts = async () => ({
      exchanges: (await getDb().select().from(exchanges)).length,
      instruments: (await getDb().select().from(instruments)).length,
      listings: (await getDb().select().from(listings)).length,
      providerIds: (await getDb().select().from(listingProviderIds)).length,
      spaces: (await getDb().select().from(spaces)).length,
      members: (await getDb().select().from(spaceMembers)).length,
      positions: (await getDb().select().from(spacePositions)).length,
    });
    const before = await counts();
    expect(before).toMatchObject({ exchanges: 5, spaces: 3, members: 2 });
    expect(before.instruments).toBe(10);
    expect(before.listings).toBe(10);
    expect(before.providerIds).toBe(10);

    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('devuser');
    const list = (await rpc('spaces.list', undefined, { cookie })).json as unknown as {
      spaces: { name: string; role: string; positionCount: number }[];
    };
    expect(list.spaces.map((s) => [s.name, s.role])).toEqual([
      ['Actions US', 'viewer'],
      ['PEA', 'owner'],
    ]);
    const pea = first.spaces.find((s) => s.name === 'PEA')!;
    const positions = (await rpc('positions.list', { spaceId: pea.id }, { cookie }))
      .json as unknown as {
      rows: { quantity: string | null; listing: { currency: string } }[];
    };
    expect(positions.rows.filter((r) => r.quantity === null)).toHaveLength(1);
    expect(positions.rows.some((r) => r.listing.currency === 'GBX')).toBe(true);
    const famille = first.spaces.find((s) => s.name === 'Famille')!;
    expect((await rpc('positions.list', { spaceId: famille.id }, { cookie })).status).toBe(404);
    const us = first.spaces.find((s) => s.name === 'Actions US')!;
    const [usPosition] = await getDb()
      .select()
      .from(spacePositions)
      .where(eq(spacePositions.spaceId, us.id));
    expect(
      (
        await rpc(
          'positions.setQuantity',
          { spaceId: us.id, positionId: usPosition!.id, quantity: '1' },
          { cookie },
        )
      ).status,
    ).toBe(403);

    // Re-run: no duplicates; an edited quantity, role and the password survive.
    await getDb()
      .update(spacePositions)
      .set({ quantity: '123' })
      .where(eq(spacePositions.id, usPosition!.id));
    const [hashBefore] = await getDb().select().from(users);
    const second = await seedDevWorkspace(getDb(), { ...env(), SEED_USER_PASSWORD: undefined });
    expect(second.user.status).toBe('exists');
    expect(await counts()).toEqual(before);
    const [usAfter] = await getDb()
      .select()
      .from(spacePositions)
      .where(eq(spacePositions.id, usPosition!.id));
    expect(usAfter?.quantity).toBe('123.00000000');
    expect((await getDb().select().from(users))[0]?.passwordHash).toBe(hashBefore?.passwordHash);
  });

  it('keeps the production/host guards', async () => {
    await expect(seedDevWorkspace(getDb(), { ...env(), NODE_ENV: 'production' })).rejects.toThrow(
      /production/,
    );
    await expect(
      seedDevWorkspace(getDb(), { ...env(), DATABASE_URL: 'postgres://u:p@db.example.com/x' }),
    ).rejects.toThrow(/DATABASE_URL/);
    expect(await getDb().select().from(spaces)).toHaveLength(0);
  });

  it('never grants anything to a pre-existing user, even one named like SEED_USER_USERNAME', async () => {
    const created = await createUser(getDb(), { username: 'devuser', password: PASSWORD });
    const [before] = await getDb().select().from(users).where(eq(users.id, created.id));
    const result = await seedDevWorkspace(getDb(), { ...env(), SEED_USER_PASSWORD: undefined });
    expect(result.user.status).toBe('exists');
    expect(result.spaces.every((s) => s.access === null)).toBe(true);
    expect(await getDb().select().from(spaceMembers)).toHaveLength(0);
    const [after] = await getDb().select().from(users).where(eq(users.id, created.id));
    expect(after?.passwordHash).toBe(before?.passwordHash);
  });

  it('leaves a pre-existing space of the same name completely untouched', async () => {
    const owner = await createUser(getDb(), { username: 'realowner', password: PASSWORD });
    const [real] = await getDb()
      .insert(spaces)
      .values({ name: 'PEA' })
      .returning({ id: spaces.id });
    await getDb()
      .insert(spaceMembers)
      .values({ spaceId: real!.id, userId: owner.id, role: 'owner' });

    const result = await seedDevWorkspace(getDb(), env());
    const pea = result.spaces.find((s) => s.name === 'PEA')!;
    expect(pea).toMatchObject({ id: real!.id, created: false, access: null });

    // No dev membership, no positions were attached to the real space, nobody else's role changed.
    const members = await getDb()
      .select()
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, real!.id));
    expect(members).toEqual([expect.objectContaining({ userId: owner.id, role: 'owner' })]);
    expect(
      await getDb().select().from(spacePositions).where(eq(spacePositions.spaceId, real!.id)),
    ).toHaveLength(0);
    // The other seeded spaces are still created normally.
    expect(result.spaces.filter((s) => s.created).map((s) => s.name)).toEqual([
      'Actions US',
      'Famille',
    ]);
  });

  it('a re-run does not resurrect deleted positions or revoked memberships', async () => {
    const first = await seedDevWorkspace(getDb(), env());
    const pea = first.spaces.find((s) => s.name === 'PEA')!;
    const us = first.spaces.find((s) => s.name === 'Actions US')!;
    await getDb().delete(spacePositions).where(eq(spacePositions.spaceId, pea.id));
    await getDb().delete(spaceMembers).where(eq(spaceMembers.spaceId, us.id));
    const second = await seedDevWorkspace(getDb(), { ...env(), SEED_USER_PASSWORD: undefined });
    expect(second.spaces.every((s) => !s.created)).toBe(true);
    expect(
      await getDb().select().from(spacePositions).where(eq(spacePositions.spaceId, pea.id)),
    ).toHaveLength(0);
    expect(
      await getDb().select().from(spaceMembers).where(eq(spaceMembers.spaceId, us.id)),
    ).toHaveLength(0);
  });
});
