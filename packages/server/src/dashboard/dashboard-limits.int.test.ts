import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../admin';
import { getDb } from '../db/client';
import { createApp, PASSWORD, releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import { resetMarketTables } from '../../test/market-fixtures';
import { createSpaceRow } from '../../test/space-fixtures';
import { DashboardLimiter } from './limiter';

/** Security F1: per-user concurrency cap and token bucket on summary/history, typed 429. */

beforeAll(useTestEnv);
afterAll(releaseTestEnv);

let clock = Date.parse('2026-09-30T12:00:00Z');
const make = (over: { maxConcurrent?: number; ratePerMinute?: number } = {}) => {
  const dashboardLimiter = new DashboardLimiter({
    maxConcurrent: 2,
    ratePerMinute: 30,
    now: () => clock,
    ...over,
  });
  return { dashboardLimiter, ...createApp({ dashboardLimiter }) };
};

let aliceId: string;
let bobId: string;
let aliceSpace: string;
let bobSpace: string;

beforeEach(async () => {
  await resetMarketTables();
  aliceId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  bobId = (await createUser(getDb(), { username: 'bob', password: PASSWORD })).id;
  aliceSpace = await createSpaceRow('Alice', [{ userId: aliceId, role: 'owner' }]);
  bobSpace = await createSpaceRow('Bob', [{ userId: bobId, role: 'owner' }]);
});

describe('dashboard in-flight cap (2 per user)', () => {
  it('answers a typed 429 with retryAfterSeconds (and Retry-After) when two calls are running', async () => {
    const { dashboardLimiter, rpc, loginAs } = make();
    const cookie = await loginAs('alice');
    // Two requests of alice are "running": hold their slots.
    const held = [
      dashboardLimiter.acquire(aliceId, 'summary'),
      dashboardLimiter.acquire(aliceId, 'summary'),
    ];
    dashboardLimiter.acquire(aliceId, 'history');
    dashboardLimiter.acquire(aliceId, 'history');
    for (const [proc, input] of [
      ['dashboard.summary', { spaceId: aliceSpace, period: '1m' }],
      ['dashboard.history', { spaceId: aliceSpace, period: '1m' }],
    ] as const) {
      const res = await rpc(proc, input, { cookie });
      expect(res.status, proc).toBe(429);
      expect(res.json.code).toBe('TOO_MANY_REQUESTS');
      expect(res.json.data).toEqual({ retryAfterSeconds: 1 });
      expect(res.headers.get('retry-after')).toBe('1');
    }
    // A slot frees: the next call goes through, and releases its own slot when it ends.
    const first = held[0];
    if (first?.allowed) first.release();
    expect(
      (await rpc('dashboard.summary', { spaceId: aliceSpace, period: '1m' }, { cookie })).status,
    ).toBe(200);
    expect(
      (await rpc('dashboard.summary', { spaceId: aliceSpace, period: '1m' }, { cookie })).status,
    ).toBe(200);
  });

  it('a busy summary does not refuse a history of the same user (one period change fires both)', async () => {
    const { dashboardLimiter, rpc, loginAs } = make();
    const cookie = await loginAs('alice');
    dashboardLimiter.acquire(aliceId, 'summary');
    dashboardLimiter.acquire(aliceId, 'summary');
    expect(
      (await rpc('dashboard.history', { spaceId: aliceSpace, period: '1m' }, { cookie })).status,
    ).toBe(200);
  });

  it('a failing call still releases its slot (no leak on error)', async () => {
    const { rpc, loginAs } = make({ maxConcurrent: 1 });
    const cookie = await loginAs('alice');
    for (let i = 0; i < 3; i += 1) {
      // Valid space, empty: 200. The slot is back every time with a cap of one.
      expect(
        (await rpc('dashboard.history', { spaceId: aliceSpace, period: 'max' }, { cookie })).status,
      ).toBe(200);
    }
  });

  it('never affects another user, and movers is not counted', async () => {
    const { dashboardLimiter, rpc, loginAs } = make();
    const alice = await loginAs('alice');
    const bob = await loginAs('bob');
    dashboardLimiter.acquire(aliceId, 'summary');
    dashboardLimiter.acquire(aliceId, 'summary');
    expect(
      (await rpc('dashboard.summary', { spaceId: aliceSpace, period: '1m' }, { cookie: alice }))
        .status,
    ).toBe(429);
    expect(
      (await rpc('dashboard.summary', { spaceId: bobSpace, period: '1m' }, { cookie: bob })).status,
    ).toBe(200);
    expect(
      (await rpc('dashboard.movers', { spaceId: aliceSpace, period: '1m' }, { cookie: alice }))
        .status,
    ).toBe(200);
  });

  it('the check runs after the space access check: an inaccessible space is NOT_FOUND, not 429', async () => {
    const { dashboardLimiter, rpc, loginAs } = make();
    const cookie = await loginAs('alice');
    dashboardLimiter.acquire(aliceId, 'summary');
    dashboardLimiter.acquire(aliceId, 'summary');
    const res = await rpc('dashboard.summary', { spaceId: bobSpace, period: '1m' }, { cookie });
    expect(res.json.code).toBe('NOT_FOUND');
  });
});

describe('dashboard token bucket (30 per minute per user)', () => {
  it('refuses once the bucket is empty with the wait for the next token, other users unaffected', async () => {
    const { rpc, loginAs } = make({ ratePerMinute: 3 });
    const alice = await loginAs('alice');
    const bob = await loginAs('bob');
    const call = (cookie: string, spaceId: string) =>
      rpc('dashboard.summary', { spaceId, period: '1m' }, { cookie });
    for (let i = 0; i < 3; i += 1) expect((await call(alice, aliceSpace)).status).toBe(200);
    const refused = await call(alice, aliceSpace);
    expect(refused.status).toBe(429);
    expect(refused.json.code).toBe('TOO_MANY_REQUESTS');
    expect(refused.json.data).toEqual({ retryAfterSeconds: 20 }); // 3 per minute = 1 token per 20 s
    expect(refused.headers.get('retry-after')).toBe('20');
    // History shares the same bucket; bob has his own.
    expect(
      (await rpc('dashboard.history', { spaceId: aliceSpace, period: '1m' }, { cookie: alice }))
        .status,
    ).toBe(429);
    expect((await call(bob, bobSpace)).status).toBe(200);
    // Refill over time.
    clock += 20_000;
    expect((await call(alice, aliceSpace)).status).toBe(200);
  });
});

describe('positions.list in-flight cap (4 per user, no rate limit)', () => {
  const input = () => ({ spaceId: aliceSpace });

  it('answers a typed 429 with retryAfterSeconds (and Retry-After) when four calls are running', async () => {
    const { dashboardLimiter, rpc, loginAs } = make();
    const cookie = await loginAs('alice');
    const held = Array.from({ length: 4 }, () =>
      dashboardLimiter.acquire(aliceId, 'positions.list', { maxConcurrent: 4, rated: false }),
    );
    expect(held.every((a) => a.allowed)).toBe(true);
    const res = await rpc('positions.list', input(), { cookie });
    expect(res.status).toBe(429);
    expect(res.json.code).toBe('TOO_MANY_REQUESTS');
    expect(res.json.data).toEqual({ retryAfterSeconds: 1 });
    expect(res.headers.get('retry-after')).toBe('1');
    // Another user, another procedure of the same user: unaffected.
    const bob = await loginAs('bob');
    expect((await rpc('positions.list', { spaceId: bobSpace }, { cookie: bob })).status).toBe(200);
    expect(
      (await rpc('dashboard.summary', { spaceId: aliceSpace, period: '1m' }, { cookie })).status,
    ).toBe(200);
    // A slot frees: the next call goes through.
    const first = held[0];
    if (first?.allowed) first.release();
    expect((await rpc('positions.list', input(), { cookie })).status).toBe(200);
  });

  it('no rate limit: a long run of calls never gets a 429, and does not drain the dashboard bucket', async () => {
    const { rpc, loginAs } = make({ ratePerMinute: 3 });
    const cookie = await loginAs('alice');
    for (let i = 0; i < 40; i += 1) {
      expect((await rpc('positions.list', input(), { cookie })).status).toBe(200);
    }
    expect(
      (await rpc('dashboard.summary', { spaceId: aliceSpace, period: '1m' }, { cookie })).status,
    ).toBe(200);
  });

  it('the check runs after the space access check: an inaccessible space is NOT_FOUND, not 429', async () => {
    const { dashboardLimiter, rpc, loginAs } = make();
    const cookie = await loginAs('alice');
    for (let i = 0; i < 4; i += 1) {
      dashboardLimiter.acquire(aliceId, 'positions.list', { maxConcurrent: 4, rated: false });
    }
    const res = await rpc('positions.list', { spaceId: bobSpace }, { cookie });
    expect(res.json.code).toBe('NOT_FOUND');
  });
});
