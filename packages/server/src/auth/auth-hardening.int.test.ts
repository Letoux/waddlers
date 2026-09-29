import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, disableUser } from '../admin';
import { getDb } from '../db/client';
import { sessions, users } from '../db/schema';
import { createServerClient } from '../server-client';
import {
  cookieJar,
  cookieValue,
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { SESSION_COOKIE_NAME } from './cookie';
import { DEVICE_COOKIE_NAME } from './device';
import { LoginRateLimiter } from './rate-limit';
import { rotateSession } from './sessions';

const DAY = 24 * 60 * 60 * 1000;
const NEW_PASSWORD = 'another long passphrase 42';

beforeAll(useTestEnv);
afterAll(releaseTestEnv);
beforeEach(async () => {
  await resetAuthTables();
  await createUser(getDb(), { username: 'alice', password: PASSWORD });
});

const sessionRows = () => getDb().select().from(sessions);
const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

describe('rate limits under concurrency', () => {
  it('login: parallel wrong-password attempts cannot exceed the budget', async () => {
    const { rpc } = createApp({ loginLimiter: new LoginRateLimiter() });
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        rpc('auth.login', { username: 'alice', password: 'nope-nope-nope' }),
      ),
    );
    const statuses = results.map((r) => r.status);
    // Only reserved attempts reach password verification (401); the rest are refused (429).
    expect(count(statuses, 401)).toBe(5);
    expect(count(statuses, 429)).toBe(35);
    const throttled = results.find((r) => r.status === 429)!;
    expect(throttled.json).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      defined: true,
      data: { retryAfterSeconds: expect.any(Number) },
    });
    expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await sessionRows()).toHaveLength(0);
  });

  it('login with the right password is refunded and does not eat the budget', async () => {
    const { rpc } = createApp({ loginLimiter: new LoginRateLimiter() });
    for (let i = 0; i < 12; i++) {
      expect((await rpc('auth.login', { username: 'alice', password: PASSWORD })).status).toBe(200);
    }
  });

  it('login without a known client IP: one user cannot be locked out by anonymous failures, delay is bounded', async () => {
    await createUser(getDb(), { username: 'bob', password: PASSWORD });
    const { rpc } = createApp({
      loginLimiter: new LoginRateLimiter(),
      clientIp: () => 'unknown',
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rpc('auth.login', { username: 'alice', password: 'nope-nope-nope' }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(count(statuses, 401)).toBe(5);
    expect(count(statuses, 429)).toBe(15);
    const wait = Number(results.find((r) => r.status === 429)!.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    // Another user is unaffected by alice's failures.
    expect((await rpc('auth.login', { username: 'bob', password: PASSWORD })).status).toBe(200);
  });

  it('changePassword: parallel wrong-current-password attempts cannot exceed the budget', async () => {
    const { rpc, loginAs } = createApp({ passwordLimiter: new LoginRateLimiter() });
    const cookie = await loginAs('alice');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        rpc(
          'auth.changePassword',
          { currentPassword: `guess number ${i} xx`, newPassword: NEW_PASSWORD },
          { cookie },
        ),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(count(statuses, 400)).toBe(5);
    expect(count(statuses, 429)).toBe(25);
    const throttled = results.find((r) => r.status === 429)!;
    expect(throttled.json).toMatchObject({ code: 'TOO_MANY_REQUESTS', defined: true });
    expect(throttled.headers.get('retry-after')).toBeTruthy();
  });
});

describe('changePassword and rotation of a dead session', () => {
  it('rotateSession returns null for a revoked, expired, or disabled-user session', async () => {
    const { loginAs } = createApp();
    await loginAs('alice');
    const [row] = await sessionRows();
    const db = getDb();
    expect(await rotateSession(db, row!.id, new Date())).not.toBeNull();
    expect(await rotateSession(db, '00000000-0000-4000-8000-00000000dead', new Date())).toBeNull();
    expect(await rotateSession(db, row!.id, new Date(Date.now() + 40 * DAY))).toBeNull(); // expired
    await db.update(users).set({ disabledAt: new Date() });
    expect(await rotateSession(db, row!.id, new Date())).toBeNull();
  });

  it('a session revoked mid-request aborts changePassword and rolls the new password back', async () => {
    // authenticate() resolved a session that is revoked by the time the transaction runs.
    const [user] = await getDb().select().from(users);
    const { rpc } = createApp({
      authenticate: async () => ({
        sessionId: '00000000-0000-4000-8000-00000000dead',
        user: { id: user!.id, username: user!.username },
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + DAY),
      }),
    });
    const res = await rpc('auth.changePassword', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(res.setCookies).toEqual([]);
    const login = createApp();
    expect((await login.rpc('auth.login', { username: 'alice', password: PASSWORD })).status).toBe(
      200,
    );
    expect(
      (await login.rpc('auth.login', { username: 'alice', password: NEW_PASSWORD })).status,
    ).toBe(401);
  });
});

describe('server-side client is read-only for session mutation', () => {
  it('login, logout and changePassword fail loudly and change nothing', async () => {
    const { loginAs } = createApp();
    const cookie = await loginAs('alice');
    const client = createServerClient({ headers: new Headers({ cookie }) }, { log: () => {} });
    await expect(
      client.auth.login({ username: 'alice', password: PASSWORD }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    await expect(client.auth.logout()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    await expect(
      client.auth.changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    // Nothing was committed: same single session, same password.
    expect(await sessionRows()).toHaveLength(1);
    await expect(client.auth.me()).resolves.toMatchObject({ user: { username: 'alice' } });
    const { rpc } = createApp();
    expect((await rpc('auth.login', { username: 'alice', password: PASSWORD })).status).toBe(200);
  });
});

describe('one session Set-Cookie per response', () => {
  const staleLastSeen = () =>
    getDb()
      .update(sessions)
      .set({ lastSeenAt: new Date(Date.now() - 2 * DAY) });
  const sessionCookies = (cookies: string[]) =>
    cookies.filter((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));

  it('a sliding refresh followed by logout yields only the clearing cookie', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    await staleLastSeen();
    const res = await rpc('auth.logout', undefined, { cookie });
    expect(res.status).toBe(200);
    const cookies = sessionCookies(res.setCookies);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^__Host-wd_session=;.*Max-Age=0/);
  });

  it('a sliding refresh followed by changePassword yields only the rotated cookie', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    await staleLastSeen();
    const res = await rpc(
      'auth.changePassword',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { cookie },
    );
    expect(res.status).toBe(200);
    const cookies = sessionCookies(res.setCookies);
    expect(cookies).toHaveLength(1);
    expect(cookieValue(cookies[0]!)).not.toBe(cookie);
    expect((await rpc('auth.me', undefined, { cookie: cookieValue(cookies[0]!) })).status).toBe(
      200,
    );
  });
});

describe('expiry housekeeping', () => {
  it('login purges only that user’s expired sessions', async () => {
    await createUser(getDb(), { username: 'bob', password: PASSWORD });
    const { loginAs } = createApp();
    await loginAs('alice');
    await loginAs('alice');
    await loginAs('bob');
    const past = new Date(Date.now() - 1000);
    const rows = await sessionRows();
    const [aliceUser] = await getDb().select().from(users).where(eq(users.username, 'alice'));
    const aliceIds = rows.filter((r) => r.userId === aliceUser!.id).map((r) => r.id);
    // Expire one of alice's sessions and bob's session.
    await getDb().update(sessions).set({ expiresAt: past }).where(eq(sessions.id, aliceIds[0]!));
    const bob = rows.find((r) => r.userId !== aliceUser!.id)!;
    await getDb().update(sessions).set({ expiresAt: past }).where(eq(sessions.id, bob.id));

    await loginAs('alice'); // triggers purge for alice only

    const after = await sessionRows();
    expect(after.find((r) => r.id === aliceIds[0])).toBeUndefined();
    expect(after.find((r) => r.id === bob.id)).toBeDefined(); // bob's stale row untouched
    expect(after.filter((r) => r.userId === aliceUser!.id)).toHaveLength(2);
  });

  it('an expired session is never refreshed, even when it is also stale', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    const lastSeen = new Date(Date.now() - 40 * DAY);
    const expiresAt = new Date(Date.now() - 10 * DAY);
    await getDb().update(sessions).set({ lastSeenAt: lastSeen, expiresAt });
    const res = await rpc('auth.me', undefined, { cookie });
    expect(res.status).toBe(401);
    expect(res.setCookies).toEqual([]);
    const [row] = await sessionRows();
    expect(row!.expiresAt.getTime()).toBe(expiresAt.getTime());
    expect(row!.lastSeenAt.getTime()).toBe(lastSeen.getTime());
  });
});

describe('disabled users', () => {
  it('disableUser kills the session immediately (regression for admin path)', async () => {
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    await disableUser(getDb(), { username: 'alice' });
    expect((await rpc('auth.me', undefined, { cookie })).status).toBe(401);
  });
});

describe('device cookie (unknown client IP)', () => {
  const wrong = { username: 'alice', password: 'nope-nope-nope' };
  const right = { username: 'alice', password: PASSWORD };

  function app() {
    return createApp({ loginLimiter: new LoginRateLimiter(), clientIp: () => 'unknown' });
  }
  const deviceCookie = (cookies: string[]) =>
    cookies.find((c) => c.startsWith(`${DEVICE_COOKIE_NAME}=`));
  async function hammer(rpc: ReturnType<typeof createApp>['rpc'], n = 30) {
    const results = await Promise.all(Array.from({ length: n }, () => rpc('auth.login', wrong)));
    return results.map((r) => r.status);
  }

  it('login sets a hardened device cookie, and reuses the same device id next time', async () => {
    const { rpc } = app();
    const first = await rpc('auth.login', right);
    const cookie = deviceCookie(first.setCookies)!;
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=31536000']) {
      expect(cookie).toContain(attr);
    }
    const again = await rpc('auth.login', right, { cookie: cookieValue(cookie) });
    expect(cookieValue(deviceCookie(again.setCookies)!)).toBe(cookieValue(cookie));
    // Failed logins never issue one.
    expect(deviceCookie((await rpc('auth.login', wrong)).setCookies)).toBeUndefined();
  });

  it('the victim (with a device cookie) can log in while an attacker hammers the username', async () => {
    const { rpc } = app();
    const device = cookieValue(deviceCookie((await rpc('auth.login', right)).setCookies)!);
    const statuses = await hammer(rpc);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(20);
    // A browser without the device cookie is delayed...
    expect((await rpc('auth.login', right)).status).toBe(429);
    // ...but the victim's usual browser gets in, repeatedly.
    for (let i = 0; i < 3; i++) {
      expect((await rpc('auth.login', right, { cookie: device })).status).toBe(200);
    }
  });

  it('forged, tampered and other-username device cookies are treated as absent', async () => {
    await createUser(getDb(), { username: 'bob', password: PASSWORD });
    const { rpc } = app();
    const bobsDevice = cookieValue(
      deviceCookie((await rpc('auth.login', { username: 'bob', password: PASSWORD })).setCookies)!,
    );
    const aliceDevice = cookieValue(deviceCookie((await rpc('auth.login', right)).setCookies)!);
    await hammer(rpc); // alice's shared budget is exhausted
    const tampered = `${aliceDevice.slice(0, -2)}${aliceDevice.endsWith('AA') ? 'BB' : 'AA'}`;
    const forged = `${DEVICE_COOKIE_NAME}=v1.AAAAAAAAAAAAAAAAAAAAAA.${'A'.repeat(43)}`;
    for (const cookie of [bobsDevice, tampered, forged, `${DEVICE_COOKIE_NAME}=garbage`]) {
      const res = await rpc('auth.login', right, { cookie });
      expect(res.status, cookie).toBe(429);
    }
    expect((await rpc('auth.login', right, { cookie: aliceDevice })).status).toBe(200);
  });

  it('a device is locked out on its own after 5 failures, other devices are not', async () => {
    const { rpc } = app();
    const deviceA = cookieValue(deviceCookie((await rpc('auth.login', right)).setCookies)!);
    // A second browser: obtain its cookie by a fresh login without the first one.
    const deviceB = cookieValue(deviceCookie((await rpc('auth.login', right)).setCookies)!);
    expect(deviceB).not.toBe(deviceA);
    for (let i = 0; i < 5; i++) {
      expect((await rpc('auth.login', wrong, { cookie: deviceA })).status).toBe(401);
    }
    const locked = await rpc('auth.login', right, { cookie: deviceA });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBe(15 * 60);
    expect(locked.setCookies).toEqual([]);
    expect((await rpc('auth.login', right, { cookie: deviceB })).status).toBe(200);
    // The failed device never touched the shared budget.
    expect((await rpc('auth.login', right)).status).toBe(200);
  });

  it('session and device cookies coexist in the cookie jar', async () => {
    const { rpc } = app();
    const login = await rpc('auth.login', right);
    const jar = cookieJar(login.setCookies);
    expect(jar).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(jar).toContain(`${DEVICE_COOKIE_NAME}=`);
    expect((await rpc('auth.me', undefined, { cookie: jar })).status).toBe(200);
  });
});
