import { runMigrations } from '../src/db/migrate';

/** Vitest globalSetup: migrate the test database once before all integration tests. */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    // Fail loudly rather than skip: a silently skipped integration suite hides CI misconfiguration.
    throw new Error('DATABASE_URL_TEST is not set; integration tests need a PostgreSQL database.');
  }
  await runMigrations(url);
}
