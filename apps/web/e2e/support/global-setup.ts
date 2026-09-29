import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertSafeDatabase } from '../../test-support/safe-database';
import { ACCOUNT_KEYS, E2E_DATABASE_URL } from './env';

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

function run(cwd: string, args: string[], input?: string): Promise<void> {
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
        },
      },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`pnpm ${args.slice(0, 3).join(' ')} failed: ${stderr}`));
        else resolve();
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
}
