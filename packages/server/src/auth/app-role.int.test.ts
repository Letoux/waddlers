import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createUser, disableUser } from '../admin';
import { closeDb, getDb } from '../db/client';
import { setupAppRole } from '../db/roles';
import { resetEnvCache } from '../env';
import { users } from '../db/schema';
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
    await getDb().delete(users); // DML only: no truncate
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
});
