import { sql } from 'drizzle-orm';
import { vi } from 'vitest';
import { closeDb, getDb } from '../src/db/client';
import { resetEnvCache } from '../src/env';
import { createRpcHandler } from '../src/rpc-handler';
import type { RouterDeps } from '../src/router';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'correct horse battery staple';
export const TEST_AUTH_SECRET = 'test-auth-secret-0123456789abcdef0123456789';

export function useTestEnv(): void {
  vi.stubEnv('DATABASE_URL', process.env.DATABASE_URL_TEST);
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('MARKET_DATA_PROVIDER', 'fake');
  vi.stubEnv('AUTH_SECRET', TEST_AUTH_SECRET);
  resetEnvCache();
}

export async function releaseTestEnv(): Promise<void> {
  await closeDb();
  vi.unstubAllEnvs();
  resetEnvCache();
}

/** users -> sessions cascade. Tests share one database and run serially. */
export async function resetAuthTables(): Promise<void> {
  await getDb().execute(sql`truncate table users cascade`);
}

export interface RpcResult {
  status: number;
  json: { code?: string; message?: string; status?: number; data?: unknown } & Record<
    string,
    unknown
  >;
  /** Raw Set-Cookie header values. */
  setCookies: string[];
  headers: Headers;
}

/** `name=value; name2=value2` for the Set-Cookie headers of a response (like a browser jar). */
export function cookieJar(setCookies: string[]): string {
  return setCookies.map(cookieValue).join('; ');
}

export function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

/** Drives the real RPC handler like a browser would (CSRF header + same-origin Origin). */
export function createApp(deps: RouterDeps = {}) {
  const handle = createRpcHandler({
    log: () => {},
    allowedOrigin: () => ORIGIN,
    clientIp: () => '203.0.113.1',
    authSecret: () => TEST_AUTH_SECRET,
    ...deps,
  });

  async function rpc(
    procedure: string,
    input: unknown = undefined,
    options: { cookie?: string; headers?: Record<string, string>; browser?: boolean } = {},
  ): Promise<RpcResult> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-csrf-token': 'orpc',
      ...(options.browser === false ? {} : { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    };
    const result = await handle(
      new Request(`${ORIGIN}/api/rpc/${procedure.replace('.', '/')}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ json: input }),
      }),
    );
    if (!result.matched) throw new Error('route not matched');
    const body = (await result.response.json()) as { json?: unknown };
    return {
      status: result.response.status,
      json: (body.json ?? {}) as RpcResult['json'],
      setCookies: result.response.headers.getSetCookie(),
      headers: result.response.headers,
    };
  }

  /** Logs in and returns the cookie to send back (`name=value`). */
  async function loginAs(username: string, password = PASSWORD): Promise<string> {
    const res = await rpc('auth.login', { username, password });
    const setCookie = res.setCookies[0];
    if (res.status !== 200 || !setCookie) throw new Error(`login failed: ${res.status}`);
    return cookieValue(setCookie);
  }

  return { rpc, loginAs };
}
