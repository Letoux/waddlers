import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import postgres from 'postgres';

/** Applies committed migrations. Idempotent: already-applied migrations are skipped. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  // Dedicated single connection, independent of the app singleton and of `server-only`.
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: path.join(import.meta.dirname, '../../drizzle'),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
