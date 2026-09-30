import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { E2E_DATABASE_URL } from './env';

// Playwright runs from apps/web; walk up to the workspace root (where the pnpm scripts live).
export function findRepoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found');
    dir = parent;
  }
  return dir;
}

export function run(
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
