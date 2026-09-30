import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertSafeDatabase } from '../../test-support/safe-database';
import { ACCOUNT_KEYS, E2E_DATABASE_URL, type AccountKey } from './env';
import { SCENARIO_SPACES, spaceName } from './spaces';

// Playwright runs from apps/web; walk up to the workspace root (where the pnpm scripts live).
function findRepoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found');
    dir = parent;
  }
  return dir;
}

function run(
  cwd: string,
  args: string[],
  input?: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'pnpm',
      args,
      {
        cwd,
        env: {
          ...process.env,
          // Both URLs point at the throwaway test database; the root .env (dev data) never wins.
          DATABASE_URL: E2E_DATABASE_URL,
          DATABASE_MIGRATE_URL: E2E_DATABASE_URL,
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`pnpm ${args.slice(0, 3).join(' ')} failed: ${stderr}`));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input ?? '');
  });
}

/**
 * Migrates the throwaway test database and creates one fresh user per scenario for this run.
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

  const ids: Record<string, string> = {};
  // Per-scenario spaces, memberships and positions (through the admin CLI, like an operator).
  await Promise.all(
    (Object.keys(SCENARIO_SPACES) as AccountKey[]).map(async (key) => {
      const account = accounts[key];
      if (!account) throw new Error(`No account for ${key}`);
      for (const space of SCENARIO_SPACES[key] ?? []) {
        const name = spaceName(suffix, key, space.label);
        const created = await run(root, ['admin', '--', 'space:create', name]);
        const id = /\(([0-9a-f-]{36})\)/.exec(created)?.[1];
        if (!id) throw new Error(`space:create printed no id for ${name}`);
        ids[name] = id;
        if (space.role) {
          await run(root, ['admin', '--', 'space:grant', name, account.username, space.role]);
        }
        for (const position of space.positions) {
          const args = ['admin', '--', 'position:add', name, position.listing];
          await run(root, position.quantity ? [...args, position.quantity] : args);
        }
      }
    }),
  );
  process.env['E2E_RUN_ID'] = suffix;

  process.env['E2E_SPACE_IDS'] = JSON.stringify(ids);
}
