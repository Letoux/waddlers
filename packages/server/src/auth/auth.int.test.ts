import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, disableUser } from '../admin';
import { getDb } from '../db/client';
import { sessions, users } from '../db/schema';
import { createServerClient } from '../server-client';
import {
  cookieValue,
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { SESSION_TTL_MS } from './cookie';
import { LoginRateLimiter } from './rate-limit';
import { hashSessionToken } from './token';

const DAY = 24 * 60 * 60 * 1000;

beforeAll(useTestEnv);
afterAll(releaseTestEnv);
beforeEach(async () => {
  await resetAuthTables();
  await createUser(getDb(), { username: 'alice', password: PASSWORD });
});

const tokenOf = (cookie: string) => cookie.split('=')[1] ?? '';
const sessionRows = () => getDb().select().from(sessions);

describe('auth.login', () => {
  it('sets a hardened session cookie and stores only the token hash', async () => {
    const { rpc } = createApp();
    const res = await rpc('auth.login', { username: 'alice', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ user: { id: expect.any(String), username: 'alice' } });
    expect(JSON.stringify(res.json)).not.toMatch(/hash|password|argon/i);
    expect(res.headers.get('cache-control')).toBe('no-store');

    // Session cookie + device cookie (device.ts).
    expect(res.setCookies).toHaveLength(2);
    const cookie = res.setCookies.find((c) => c.startsWith('__Host-wd_session='))!;
    expect(res.setCookies.some((c) => c.startsWith('__Host-wd_device='))).toBe(true);
    expect(cookie).toMatch(/^__Host-wd_session=[A-Za-z0-9_-]{43};/);
    for (const attr of [
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${SESSION_TTL_MS / 1000}`,
    ]) {
      expect(cookie).toContain(attr);
    }
    expect(cookie).not.toMatch(/domain=/i);

    const [row] = await sessionRows();
    expect(row?.tokenHash).toBe(hashSessionToken(tokenOf(cookieValue(cookie))));
    expect(row?.tokenHash).not.toContain(tokenOf(cookieValue(cookie)));
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeCloseTo(SESSION_TTL_MS, -4);
  });

  it('is case-insensitive on the username (citext) and trims it', async () => {
    const { rpc } = createApp();
    const res = await rpc('auth.login', { username: '  ALICE ', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ user: { username: 'alice' } });
  });

  it('answers wrong password, unknown user and disabled user identically', async () => {
    await createUser(getDb(), { username: 'bob', password: PASSWORD });
    await disableUser(getDb(), { username: 'bob' });
    const { rpc } = createApp({ loginLimiter: new LoginRateLimiter() });
    const attempts = [
      { username: 'alice', password: 'wrong password entirely' },
      { username: 'nobody', password: PASSWORD },
      { username: 'bob', password: PASSWORD },
    ];
    const results = [];
    for (const attempt of attempts) results.push(await rpc('auth.login', attempt));
    for (const res of results) {
      expect(res.status).toBe(401);
      expect(res.json).toMatchObject({ code: 'UNAUTHORIZED', message: 'Identifiants invalides' });
      expect(res.setCookies).toEqual([]);
    }
    expect(new Set(results.map((r) => JSON.stringify(r.json))).size).toBe(1);
    expect(await sessionRows()).toHaveLength(0);
  });

  it('rejects malformed input with BAD_REQUEST', async () => {
    const { rpc } = createApp();
    expect((await rpc('auth.login', { username: '', password: 'x' })).status).toBe(400);
    expect((await rpc('auth.login', { username: 'alice' })).status).toBe(400);
  });

  it('replaces a presented session instead of reusing it (fixation)', async () => {
    const { rpc, loginAs } = createApp();
    const first = await loginAs('alice');
    const res = await rpc(
      'auth.login',
      { username: 'alice', password: PASSWORD },
      { cookie: first },
    );
    const second = cookieValue(res.setCookies[0]!);
    expect(second).not.toBe(first);
    expect((await rpc('auth.me', undefined, { cookie: first })).status).toBe(401);
    expect((await rpc('auth.me', undefined, { cookie: second })).status).toBe(200);
  });

  it('throttles after repeated failures (even for the right password), per username + IP', async () => {
    const { rpc } = createApp({ loginLimiter: new LoginRateLimiter() });
    for (let i = 0; i < 5; i++) {
      expect(
        (await rpc('auth.login', { username: 'alice', password: 'nope-nope-nope' })).status,
      ).toBe(401);
    }
    const blocked = await rpc('auth.login', { username: 'alice', password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.json).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(blocked.setCookies).toEqual([]);
    expect(await sessionRows()).toHaveLength(0);
    // A different client IP has its own budget.
    const other = createApp({
      loginLimiter: new LoginRateLimiter(),
      clientIp: () => '198.51.100.7',
    });
    expect((await other.rpc('auth.login', { username: 'alice', password: PASSWORD })).status).toBe(
      200,
    );
  });
});

describe('auth.me and session lifecycle', () => {
  it('returns the user with a valid cookie and 401 without one', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    const me = await rpc('auth.me', undefined, { cookie });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ user: { username: 'alice' } });
    const anonymous = await rpc('auth.me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.json).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(
      (await rpc('auth.me', undefined, { cookie: `${cookie}x`.replace(/.$/, 'A') })).status,
    ).toBe(401);
  });

  it('rejects an expired session', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await rpc('auth.me', undefined, { cookie })).status).toBe(401);
  });

  it('rejects the session of a disabled user', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    await getDb().update(users).set({ disabledAt: new Date() }).where(eq(users.username, 'alice'));
    expect((await rpc('auth.me', undefined, { cookie })).status).toBe(401);
  });

  it('slides the expiry at most once a day and re-issues the cookie only then', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    const staleSeen = new Date(Date.now() - 2 * DAY);
    await getDb()
      .update(sessions)
      .set({ lastSeenAt: staleSeen, expiresAt: new Date(Date.now() + 10 * DAY) });

    const refreshed = await rpc('auth.me', undefined, { cookie });
    expect(refreshed.status).toBe(200);
    expect(refreshed.setCookies).toHaveLength(1);
    expect(cookieValue(refreshed.setCookies[0]!)).toBe(cookie); // same token, new Max-Age
    const [row] = await sessionRows();
    expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 60_000);
    expect(row!.lastSeenAt.getTime()).toBeGreaterThan(staleSeen.getTime() + DAY);

    // Immediately again: no write, no Set-Cookie.
    const again = await rpc('auth.me', undefined, { cookie });
    expect(again.setCookies).toEqual([]);
    const [after] = await sessionRows();
    expect(after!.expiresAt.getTime()).toBe(row!.expiresAt.getTime());
    expect(after!.lastSeenAt.getTime()).toBe(row!.lastSeenAt.getTime());
  });

  it('does not refresh when there is nothing to write (fresh session)', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    expect((await rpc('auth.me', undefined, { cookie })).setCookies).toEqual([]);
  });

  it('logout deletes the session, clears the cookie and invalidates the token', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    const other = await loginAs('alice'); // a second session must survive
    const out = await rpc('auth.logout', undefined, { cookie });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ ok: true });
    expect(out.setCookies[0]).toMatch(/^__Host-wd_session=;.*Max-Age=0/);
    expect(await sessionRows()).toHaveLength(1);
    expect((await rpc('auth.me', undefined, { cookie })).status).toBe(401);
    expect((await rpc('auth.me', undefined, { cookie: other })).status).toBe(200);
  });

  it('cascades: deleting a user removes their sessions', async () => {
    const { loginAs } = createApp();
    await loginAs('alice');
    await getDb().delete(users).where(eq(users.username, 'alice'));
    expect(await sessionRows()).toHaveLength(0);
  });
});

describe('auth.changePassword', () => {
  const NEW_PASSWORD = 'another long passphrase 42';

  it('with a wrong current password fails without touching sessions or the password', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    const other = await loginAs('alice');
    const res = await rpc(
      'auth.changePassword',
      { currentPassword: 'not my password!!', newPassword: NEW_PASSWORD },
      { cookie },
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: 'INVALID_CURRENT_PASSWORD' });
    expect(res.setCookies).toEqual([]);
    expect((await rpc('auth.me', undefined, { cookie: other })).status).toBe(200);
    expect((await rpc('auth.login', { username: 'alice', password: PASSWORD })).status).toBe(200);
  });

  it('rejects a weak or unchanged new password (validation)', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    const weak = await rpc(
      'auth.changePassword',
      { currentPassword: PASSWORD, newPassword: 'short' },
      { cookie },
    );
    expect(weak.status).toBe(400);
    expect(weak.json).toMatchObject({ code: 'BAD_REQUEST' });
    const same = await rpc(
      'auth.changePassword',
      { currentPassword: PASSWORD, newPassword: PASSWORD },
      { cookie },
    );
    expect(same.status).toBe(400);
  });

  it('on success changes the password, revokes other sessions and rotates the current one', async () => {
    const { rpc, loginAs } = createApp();
    const current = await loginAs('alice');
    const other = await loginAs('alice');
    const res = await rpc(
      'auth.changePassword',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { cookie: current },
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ user: { username: 'alice' } });
    const rotated = cookieValue(res.setCookies[0]!);
    expect(rotated).not.toBe(current);

    expect(await sessionRows()).toHaveLength(1);
    expect((await rpc('auth.me', undefined, { cookie: other })).status).toBe(401);
    expect((await rpc('auth.me', undefined, { cookie: current })).status).toBe(401);
    expect((await rpc('auth.me', undefined, { cookie: rotated })).status).toBe(200);

    expect((await rpc('auth.login', { username: 'alice', password: PASSWORD })).status).toBe(401);
    expect((await rpc('auth.login', { username: 'alice', password: NEW_PASSWORD })).status).toBe(
      200,
    );
  });

  it('throttles repeated wrong current passwords (stolen-session guessing)', async () => {
    const { rpc, loginAs } = createApp({ passwordLimiter: new LoginRateLimiter() });
    const cookie = await loginAs('alice');
    for (let i = 0; i < 5; i++) {
      const res = await rpc(
        'auth.changePassword',
        { currentPassword: `guess number ${i} xx`, newPassword: NEW_PASSWORD },
        { cookie },
      );
      expect(res.json).toMatchObject({ code: 'INVALID_CURRENT_PASSWORD' });
    }
    const blocked = await rpc(
      'auth.changePassword',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { cookie },
    );
    expect(blocked.status).toBe(429);
  });
});

describe('CSRF with a real session cookie', () => {
  it('rejects a cookie-bearing request that carries neither Origin nor Sec-Fetch-Site', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    const res = await rpc('auth.logout', undefined, { cookie, browser: false });
    expect(res.status).toBe(403);
    // The rejected request had no effect.
    expect(await sessionRows()).toHaveLength(1);
  });

  it('rejects cross-site requests carrying the cookie, including logout', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    for (const headers of [
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      const res = await rpc('auth.logout', undefined, { cookie, browser: false, headers });
      expect(res.status).toBe(403);
    }
    expect(await sessionRows()).toHaveLength(1);
  });
});

describe('server-side client (SSR/RSC)', () => {
  it('resolves the user from request headers and rejects anonymous callers', async () => {
    const { loginAs } = createApp();
    const cookie = await loginAs('alice');
    const authed = createServerClient({ headers: new Headers({ cookie }) });
    await expect(authed.auth.me()).resolves.toMatchObject({ user: { username: 'alice' } });
    const anonymous = createServerClient({ headers: new Headers() });
    await expect(anonymous.auth.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('never writes on read: sliding expiry is not advanced without a cookie to re-issue', async () => {
    const { loginAs } = createApp();
    const cookie = await loginAs('alice');
    const stale = new Date(Date.now() - 2 * DAY);
    await getDb().update(sessions).set({ lastSeenAt: stale });
    const client = createServerClient({ headers: new Headers({ cookie }) });
    await client.auth.me();
    const [row] = await getDb()
      .select()
      .from(sessions)
      .where(and(eq(sessions.lastSeenAt, stale)));
    expect(row).toBeDefined();
  });
});
