import { implement } from '@orpc/server';
import { contract } from '@waddlers/contracts';
import { sql } from 'drizzle-orm';
import { getDb } from './db/client';
import { logError, type ErrorLogger } from './errors';

const os = implement(contract);

export type DbCheck = () => Promise<void>;

const DB_CHECK_TIMEOUT_MS = 2_000;

export const checkDatabase: DbCheck = async () => {
  await getDb().execute(sql`select 1`);
};

async function withTimeout(check: DbCheck): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('db check timeout'), { name: 'DbCheckTimeout' })),
          DB_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RouterDeps {
  checkDb?: DbCheck;
  now?: () => Date;
  /** Server-side error logger (sanitised by default). Injectable for tests. */
  log?: ErrorLogger;
}

export function createRouter({
  checkDb = checkDatabase,
  now = () => new Date(),
  log = logError,
}: RouterDeps = {}) {
  return os.router({
    health: os.health.handler(async () => {
      let db: 'ok' | 'unavailable' = 'ok';
      try {
        await withTimeout(checkDb);
      } catch (error) {
        // Detail stays in the server log; the response only says "unavailable".
        log('Health check: database unavailable', error);
        db = 'unavailable';
      }
      return {
        status: db === 'ok' ? ('ok' as const) : ('degraded' as const),
        db,
        time: now().toISOString(),
      };
    }),
  });
}

export type AppRouter = ReturnType<typeof createRouter>;
