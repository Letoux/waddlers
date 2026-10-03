/** Throwaway database (compose profile `test`, port 5433). Never the dev database. */
export const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ??
  'postgres://waddlers:waddlers-test@localhost:5433/waddlers_test';

/** Overridable so two worktrees can run their E2E suites side by side (distinct ports and DBs). */
const portFromEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${name} must be an integer port between 1024 and 65535`);
  }
  return port;
};

export const E2E_PORT = portFromEnv('E2E_PORT', 3100);
/** Second server wired to an unreachable database (error-boundary scenario). */
export const E2E_DB_DOWN_PORT = portFromEnv('E2E_DB_DOWN_PORT', 3101);
export const E2E_DB_DOWN_URL = 'postgres://nobody:nopass@127.0.0.1:1/none';

/** Test-only secret (>= 32 bytes) for the signed device cookie. Not a real secret. */
export const E2E_AUTH_SECRET = 'e2e-only-secret-at-least-32-bytes-long!!';

/**
 * One dedicated account per scenario: no shared user, so the login rate limit, session revocation
 * of changePassword or a retry can never leak between tests. Created in global setup.
 */
export const ACCOUNT_KEYS = [
  'redirect',
  'next-kept',
  'next-query',
  'external-next',
  'bad-credentials',
  'empty-submit',
  'login-logout',
  'logout-expired',
  'password',
  'password-retry',
  'throttle',
  'rsc-anonymous',
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];
