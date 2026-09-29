import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from './admin';
import { closeDb, getDb } from './db/client';
import { resetEnvCache } from './env';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../test/auth-harness';

function useUnreachableDb() {
  vi.stubEnv('DATABASE_URL', 'postgres://nobody:leaked-pw@127.0.0.1:1/none');
  vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
  vi.stubEnv('MARKET_DATA_PROVIDER', 'fake');
  resetEnvCache();
}

describe('system status (real PostgreSQL)', () => {
  beforeEach(async () => {
    useTestEnv();
    await resetAuthTables();
    await createUser(getDb(), { username: 'alice', password: PASSWORD });
  });
  afterEach(releaseTestEnv);
  afterAll(closeDb);

  it('requires a session, then runs select 1 and reports ok', async () => {
    const { rpc, loginAs } = createApp();
    expect((await rpc('systemStatus')).status).toBe(401);
    const res = await rpc('systemStatus', undefined, { cookie: await loginAs('alice') });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'ok', db: 'ok' });
    expect(Number.isNaN(Date.parse(res.json['time'] as string))).toBe(false);
  });

  it('has the citext and pg_trgm extensions installed by migrations', async () => {
    const { sql } = await import('drizzle-orm');
    const rows = await getDb().execute<{ extname: string }>(
      sql`select extname from pg_extension where extname in ('citext', 'pg_trgm') order by extname`,
    );
    expect(rows.map((r) => r.extname)).toEqual(['citext', 'pg_trgm']);
  });
});

describe('health and status when the database is unreachable', () => {
  beforeEach(async () => {
    await closeDb();
    useUnreachableDb();
  });
  afterEach(releaseTestEnv);

  it('health stays a pure liveness probe (no DB access, no detail)', async () => {
    const { rpc } = createApp();
    const res = await rpc('health', undefined, { browser: false });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok', time: expect.any(String) });
  });

  it('systemStatus reports unavailable without leaking connection details', async () => {
    const user = { id: '00000000-0000-4000-8000-000000000001', username: 'alice' };
    const { rpc } = createApp({
      authenticate: async () => ({
        sessionId: 's',
        user,
        lastSeenAt: new Date(),
        expiresAt: new Date(),
      }),
    });
    const res = await rpc('systemStatus');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'degraded', db: 'unavailable' });
    expect(JSON.stringify(res.json)).not.toMatch(/leaked-pw|ECONNREFUSED|127\.0\.0\.1/);
  });
});
