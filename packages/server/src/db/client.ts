import 'server-only';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from '../env';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

let state: { sql: postgres.Sql; db: Database } | undefined;

/** Singleton, created on first use (never at import time, so `next build` needs no database). */
export function getDb(): Database {
  if (!state) {
    const sql = postgres(getEnv().DATABASE_URL, {
      max: 10,
      connect_timeout: 5,
      idle_timeout: 30,
      // Never forward server NOTICE output (may include object names) to stdout.
      onnotice: () => {},
    });
    state = { sql, db: drizzle(sql, { schema }) };
  }
  return state.db;
}

/** Closes the pool; the next getDb() call recreates it. For tests, workers and shutdown. */
export async function closeDb(): Promise<void> {
  const current = state;
  state = undefined;
  await current?.sql.end({ timeout: 5 });
}
