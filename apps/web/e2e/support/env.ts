/** Throwaway database (compose profile `test`, port 5433). Never the dev database. */
export const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ??
  'postgres://waddlers:waddlers-test@localhost:5433/waddlers_test';

export const E2E_PORT = 3100;
