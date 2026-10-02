import postgres from 'postgres';
import { runMigrations } from '../src/db/migrate';

/** Suffix of the database owned by the integration suite (never shared with e2e or dev runs). */
const INTEGRATION_DB_SUFFIX = '_int';

/**
 * Vitest globalSetup: migrate the test database once before all integration tests.
 *
 * ISOLATION INVARIANT: the integration tests TRUNCATE shared tables and assume nothing else writes
 * to their database. Playwright's global setup (db:seed, market:refresh, new users) defaults to the
 * same `waddlers_test`; running concurrently they would wipe or extend each other's rows,
 * which shows up as flaky counts ("3 metrics rows instead of 2",
 * "refreshed instead of skipped_fresh") and as TRUNCATE lock waits that look like a hang.
 * So the suite works on its own database `<name>_int` (created on demand next to the configured
 * one) and exports it to the test workers through DATABASE_URL_TEST. Two concurrent
 * `test:integration` runs still share `<name>_int`: do not overlap them. Creating it needs a role
 * with CREATEDB (or a pre-created database).
 */
export default async function setup(): Promise<void> {
  const base = process.env.DATABASE_URL_TEST;
  if (!base) {
    // Fail loudly rather than skip: a silently skipped integration suite hides CI misconfiguration.
    throw new Error('DATABASE_URL_TEST is not set; integration tests need a PostgreSQL database.');
  }
  const url = new URL(base);
  const baseName = decodeURIComponent(url.pathname.slice(1));
  const dbName = baseName.endsWith(INTEGRATION_DB_SUFFIX)
    ? baseName
    : `${baseName}${INTEGRATION_DB_SUFFIX}`;
  if (!/^[a-z0-9_]+$/i.test(dbName)) throw new Error('Unsupported test database name.');

  if (dbName !== baseName) {
    const admin = new URL(base);
    admin.pathname = '/postgres';
    const sql = postgres(admin.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      // Serialize concurrent first runs: CREATE DATABASE is not idempotent.
      await sql`select pg_advisory_lock(727001)`;
      const [exists] = await sql`select 1 as ok from pg_database where datname = ${dbName}`;
      if (!exists) await sql.unsafe(`create database "${dbName}"`);
      await sql`select pg_advisory_unlock(727001)`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL_TEST = url.toString();
  }
  await runMigrations(process.env.DATABASE_URL_TEST!);
}
