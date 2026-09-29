/**
 * Safety guard: only a throwaway database on this machine. The name must contain a `test` word
 * (`waddlers_test`, `test`, `test_x`), and the host must be local unless running in CI (where the
 * Postgres service container is reached through localhost anyway).
 */
export function assertSafeDatabase(url: string, ci: boolean): void {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!/(^|_)test($|_)/.test(dbName)) {
    throw new Error(`Refusing E2E setup: database "${dbName}" is not a test database.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  if (!local && !ci) {
    throw new Error(`Refusing E2E setup: database host "${parsed.hostname}" is not local.`);
  }
}
