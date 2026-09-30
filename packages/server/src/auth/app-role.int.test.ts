import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSpace, createUser, disableUser, grantSpace, addPosition } from '../admin';
import { seedDevWorkspace } from '../admin/seed';
import { closeDb, getDb } from '../db/client';
import { setupAppRole } from '../db/roles';
import { resetEnvCache } from '../env';
import {
  fxDaily,
  listingMetrics,
  marketDataFetchState,
  priceDaily,
  providerUsage,
  quoteLatest,
  spaces,
  users,
} from '../db/schema';
import { runNightly, refreshHeldQuotes } from '../market-data/jobs';
import { createMarketDataRuntime } from '../market-data/runtime';
import { marketDataEnvSchema } from '../env';
import { createApp, ORIGIN, PASSWORD, TEST_AUTH_SECRET } from '../../test/auth-harness';

const ROLE = 'waddlers_app_it';
const ROLE_PASSWORD = 'it-role-password-0123456789';

/** The whole auth flow with the runtime connection = the DML-only application role. */
describe('auth flow as the DML-only app role', () => {
  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL_TEST!;
    await setupAppRole(ownerUrl, { role: ROLE, password: ROLE_PASSWORD });
    const appUrl = new URL(ownerUrl);
    appUrl.username = ROLE;
    appUrl.password = ROLE_PASSWORD;
    await closeDb();
    vi.stubEnv('DATABASE_URL', appUrl.toString());
    vi.stubEnv('APP_ORIGIN', ORIGIN);
    vi.stubEnv('MARKET_DATA_PROVIDER', 'fake');
    vi.stubEnv('AUTH_SECRET', TEST_AUTH_SECRET);
    resetEnvCache();
  });
  afterAll(async () => {
    for (const table of [
      priceDaily,
      quoteLatest,
      fxDaily,
      marketDataFetchState,
      providerUsage,
      listingMetrics,
    ]) {
      await getDb().delete(table);
    }
    await getDb().delete(spaces); // DML only: no truncate (cascades members/positions)
    await getDb().delete(users);
    await closeDb();
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it('createUser -> login -> me -> changePassword -> disableUser', async () => {
    const rows = await getDb().execute<{ current_user: string }>(sql`select current_user`);
    expect(rows[0]?.current_user).toBe(ROLE);

    await createUser(getDb(), { username: 'roleuser', password: PASSWORD });
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('roleuser');
    expect((await rpc('auth.me', undefined, { cookie })).json).toMatchObject({
      user: { username: 'roleuser' },
    });
    const changed = await rpc(
      'auth.changePassword',
      { currentPassword: PASSWORD, newPassword: 'a brand new passphrase 1' },
      { cookie },
    );
    expect(changed.status).toBe(200);
    const rotated = changed.setCookies[0]!.split(';')[0]!;
    expect((await rpc('auth.me', undefined, { cookie: rotated })).status).toBe(200);
    expect((await disableUser(getDb(), { username: 'roleuser' })).revokedSessions).toBe(1);
    expect((await rpc('auth.me', undefined, { cookie: rotated })).status).toBe(401);
    expect(
      (await rpc('auth.login', { username: 'roleuser', password: 'a brand new passphrase 1' }))
        .status,
    ).toBe(401);
  });

  it('spaces and positions: seed, admin commands and the space procedures run with DML only', async () => {
    await createUser(getDb(), { username: 'spaceuser', password: PASSWORD });
    const seeded = await seedDevWorkspace(getDb(), {
      NODE_ENV: 'development',
      APP_ORIGIN: ORIGIN,
      DATABASE_URL: 'postgres://localhost/x',
      SEED_USER_USERNAME: 'spaceuser',
    });
    expect(seeded.spaces).toHaveLength(3);
    await createSpace(getDb(), { name: 'Extra' });
    await grantSpace(getDb(), { space: 'Extra', username: 'spaceuser', role: 'editor' });
    await addPosition(getDb(), { space: 'Extra', listing: 'AI.XPAR', quantity: '2.5' });

    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('spaceuser');
    const list = (await rpc('spaces.list', undefined, { cookie })).json as unknown as {
      spaces: { id: string; name: string }[];
    };
    const extra = list.spaces.find((s) => s.name === 'Extra')!;
    expect((await rpc('spaces.setActive', { spaceId: extra.id }, { cookie })).status).toBe(200);
    const positions = (await rpc('positions.list', { spaceId: extra.id }, { cookie }))
      .json as unknown as {
      rows: { id: string; quantity: string }[];
    };
    const row = positions.rows[0]!;
    expect(row.quantity).toBe('2.5');
    expect(
      (
        await rpc(
          'positions.setQuantity',
          { spaceId: extra.id, positionId: row.id, quantity: '3.25' },
          { cookie },
        )
      ).json,
    ).toEqual({ positionId: row.id, quantity: '3.25' });
    expect(
      (await rpc('positions.remove', { spaceId: extra.id, positionId: row.id }, { cookie })).status,
    ).toBe(200);
  });

  it('market data: quotes, nightly job, metrics and the session purge run with DML only', async () => {
    const seeded = await seedDevWorkspace(getDb(), {
      NODE_ENV: 'development',
      APP_ORIGIN: ORIGIN,
      DATABASE_URL: 'postgres://localhost/x',
      SEED_USER_USERNAME: 'spaceuser',
    });
    expect(seeded.spaces.length).toBeGreaterThan(0);
    const runtime = createMarketDataRuntime(
      getDb(),
      marketDataEnvSchema.parse({ FX_PROVIDER: 'fake' }),
      {
        clock: () => new Date('2026-09-30T13:00:00Z'),
      },
    );
    const quotes = await refreshHeldQuotes({ db: getDb(), runtime });
    expect(quotes.outcomes.failed).toBe(0);
    expect(quotes.outcomes.refreshed).toBeGreaterThan(0);
    const nightly = await runNightly({ db: getDb(), runtime });
    expect(nightly.history.failed).toBe(0);
    expect(nightly.fx).toBe('refreshed');
    expect(nightly.metrics).toBeGreaterThan(0);
    expect((await getDb().select().from(listingMetrics)).length).toBe(nightly.metrics);
    expect((await getDb().select().from(providerUsage))[0]?.calls).toBeGreaterThan(0);
  });
});
