import { randomBytes } from 'node:crypto';
import { assertSafeDatabase } from '../../test-support/safe-database';
import { findRepoRoot, run } from './cli';
import { ACCOUNT_KEYS, E2E_DATABASE_URL } from './env';

/**
 * Migrates the throwaway test database and creates one fresh user per S2 scenario for this run.
 * Space scenarios create their own user, spaces and positions inside the test (support/fixtures.ts),
 * so they can be repeated or retried.
 * Passwords are random and only live in this process tree's environment (E2E_ACCOUNTS).
 */
export default async function globalSetup() {
  assertSafeDatabase(E2E_DATABASE_URL, !!process.env['CI']);
  const root = findRepoRoot();
  await run(root, ['db:migrate']);

  const suffix = randomBytes(4).toString('hex');
  const accounts: Record<string, { username: string; password: string }> = {};
  for (const key of ACCOUNT_KEYS) {
    accounts[key] = {
      username: `e2e-${key}-${suffix}`.slice(0, 64),
      password: `pw-${randomBytes(12).toString('hex')}`,
    };
  }
  await Promise.all(
    Object.values(accounts).map(({ username, password }) =>
      run(root, ['admin', '--', 'user:create', username], `${password}\n`),
    ),
  );
  process.env['E2E_ACCOUNTS'] = JSON.stringify(accounts);

  // Reference data (exchanges, instruments, listings) comes from the dev seed, pointed at the
  // throwaway database. ALLOW_DEV_SEED skips the localhost/APP_ORIGIN guard; the safe-database
  // check above already refuses non-test or remote databases.
  await run(root, ['db:seed'], undefined, {
    ALLOW_DEV_SEED: '1',
    SEED_USER_PASSWORD: `pw-${randomBytes(12).toString('hex')}`,
    NODE_ENV: 'development',
  });
  await seedMarketData(root);
}

/**
 * Market data for the dashboard scenarios: the fake providers (never the network) fill prices,
 * history, FX and metrics for the listings the scenarios hold. CW8.XPAR is deliberately NOT
 * refreshed: a position on it has no price (partial total scenario).
 */
export const E2E_PRICED_LISTINGS = ['AI.XPAR', 'MC.XPAR', 'SAP.XETR', 'MSFT.XNAS', 'SHEL.XLON'];

export async function seedMarketData(root: string) {
  for (const listing of E2E_PRICED_LISTINGS) {
    await run(root, ['admin', '--', 'market:refresh', listing], undefined, {
      MARKET_DATA_PROVIDER: 'fake',
      FX_PROVIDER: 'fake',
    });
  }
}
