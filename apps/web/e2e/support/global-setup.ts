import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { E2E_DATABASE_URL } from './env';

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
const repoRoot = findRepoRoot();

function run(args: string[], input?: string) {
  execFileSync('pnpm', args, {
    cwd: repoRoot,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    env: {
      ...process.env,
      // Both URLs point at the throwaway test database; the root .env (dev data) never wins.
      DATABASE_URL: E2E_DATABASE_URL,
      DATABASE_MIGRATE_URL: E2E_DATABASE_URL,
    },
  });
}

/**
 * Migrates the throwaway test database and creates fresh users for this run (so a password
 * change in one run can never break the next). Passwords are random and only live in this
 * process tree's environment.
 */
export default function globalSetup() {
  const dbName = new URL(E2E_DATABASE_URL).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run E2E setup against database "${dbName}" (name must contain "test").`,
    );
  }

  run(['db:migrate']);

  const suffix = randomBytes(4).toString('hex');
  for (const [key, prefix] of [
    ['E2E_USER', 'e2e-main'],
    ['E2E_PW_USER', 'e2e-pw'],
  ] as const) {
    const username = `${prefix}-${suffix}`;
    const password = `pw-${randomBytes(12).toString('hex')}`;
    run(['admin', '--', 'user:create', username], `${password}\n`);
    process.env[`${key}_NAME`] = username;
    process.env[`${key}_PASSWORD`] = password;
  }
}
