import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
/** Database or transaction handle: what repositories accept. */
export type DbExecutor = Pick<
  Database,
  'select' | 'selectDistinctOn' | 'insert' | 'update' | 'delete'
>;
export type PoolState = { sql: postgres.Sql; db: Database };

/**
 * Builds a pool. No `server-only` import so the admin CLI/worker can use it under plain Node;
 * the web app goes through `getDb()` (client.ts).
 */
export function createDatabase(url: string, options: { max?: number } = {}): PoolState {
  const sql = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: 5,
    idle_timeout: 30,
    // Never forward server NOTICE output (may include object names) to stdout.
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema }) };
}
