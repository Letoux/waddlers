import 'server-only';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from '../env';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

type PoolState = { sql: postgres.Sql; db: Database };

// In development, HMR re-evaluates this module; keep the pool on globalThis so reloads do
// not leak connections. Never in production (single module instance).
const globalForDb = globalThis as typeof globalThis & { __waddlersDb?: PoolState };
const cacheOnGlobal = process.env.NODE_ENV !== 'production';

let state: PoolState | undefined = cacheOnGlobal ? globalForDb.__waddlersDb : undefined;

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
    if (cacheOnGlobal) globalForDb.__waddlersDb = state;
  }
  return state.db;
}

/** Closes the pool; the next getDb() call recreates it. For tests, workers and shutdown. */
export async function closeDb(): Promise<void> {
  const current = state;
  state = undefined;
  if (cacheOnGlobal) delete globalForDb.__waddlersDb;
  await current?.sql.end({ timeout: 5 });
}
