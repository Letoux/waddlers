import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from './db/client';
import { resetEnvCache } from './env';
import { createRpcHandler } from './rpc-handler';

async function callHealth() {
  const handle = createRpcHandler({ log: () => {}, allowedOrigin: () => 'http://localhost:3000' });
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

function useEnv(databaseUrl: string | undefined) {
  vi.stubEnv('DATABASE_URL', databaseUrl);
  vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
  vi.stubEnv('MARKET_DATA_PROVIDER', 'fake');
  resetEnvCache();
}

async function reset() {
  await closeDb();
  vi.unstubAllEnvs();
  resetEnvCache();
}

describe('health (real PostgreSQL)', () => {
  beforeEach(() => useEnv(process.env.DATABASE_URL_TEST));
  afterEach(reset);
  afterAll(closeDb);

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
});

describe('health (database unreachable)', () => {
  beforeEach(async () => {
    await closeDb();
    useEnv('postgres://nobody:leaked-pw@127.0.0.1:1/none');
  });
  afterEach(reset);

  it('reports unavailable (no detail) when the database cannot be reached', async () => {
    const response = await callHealth();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).json).toMatchObject({ status: 'degraded', db: 'unavailable' });
    expect(text).not.toMatch(/leaked-pw|ECONNREFUSED|127\.0\.0\.1/);
  });
});
