import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from './db/client';
import { resetEnvCache } from './env';
import { createRpcHandler } from './rpc-handler';

async function callHealth() {
  const handle = createRpcHandler({ log: () => {} });
  const result = await handle(
    new Request('http://localhost:3000/api/rpc/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'orpc' },
      body: JSON.stringify({}),
    }),
  );
  if (!result.matched) throw new Error('route not matched');
  return result.response;
}

describe('health (real PostgreSQL)', () => {
  const previous = process.env.DATABASE_URL;

  beforeAll(() => {
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
    process.env.APP_ORIGIN = 'http://localhost:3000';
    process.env.MARKET_DATA_PROVIDER = 'fake';
    resetEnvCache();
  });

  afterAll(async () => {
    await closeDb();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    resetEnvCache();
  });

  it('runs select 1 against the database and reports ok', async () => {
    const response = await callHealth();
    expect(response.status).toBe(200);
    const { json } = (await response.json()) as {
      json: { status: string; db: string; time: string };
    };
    expect(json).toMatchObject({ status: 'ok', db: 'ok' });
    expect(Number.isNaN(Date.parse(json.time))).toBe(false);
  });

  it('has the citext and pg_trgm extensions installed by migrations', async () => {
    const { getDb } = await import('./db/client');
    const { sql } = await import('drizzle-orm');
    const rows = await getDb().execute<{ extname: string }>(
      sql`select extname from pg_extension where extname in ('citext', 'pg_trgm') order by extname`,
    );
    expect(rows.map((r) => r.extname)).toEqual(['citext', 'pg_trgm']);
  });

  it('reports unavailable (no detail) when the database cannot be reached', async () => {
    await closeDb();
    process.env.DATABASE_URL = 'postgres://nobody:leaked-pw@127.0.0.1:1/none';
    resetEnvCache();
    const response = await callHealth();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).json).toMatchObject({ status: 'degraded', db: 'unavailable' });
    expect(text).not.toMatch(/leaked-pw|ECONNREFUSED|127\.0\.0\.1/);
    await closeDb();
  });
});
