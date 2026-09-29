import 'server-only';
import { getEnv } from '../env';
import { createDatabase, type Database, type PoolState } from './create';

export type { Database } from './create';

// In development, HMR re-evaluates this module; keep the pool on globalThis so reloads do
// not leak connections. Never in production (single module instance).
const globalForDb = globalThis as typeof globalThis & { __waddlersDb?: PoolState };
const cacheOnGlobal = process.env.NODE_ENV !== 'production';

let state: PoolState | undefined = cacheOnGlobal ? globalForDb.__waddlersDb : undefined;

/** Singleton, created on first use (never at import time, so `next build` needs no database). */
export function getDb(): Database {
  if (!state) {
    state = createDatabase(getEnv().DATABASE_URL);
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
