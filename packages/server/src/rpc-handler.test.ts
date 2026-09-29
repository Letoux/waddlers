import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '@waddlers/contracts';
import { describe, expect, it, vi } from 'vitest';
import { checkRequestOrigin, createRpcHandler, MAX_BODY_BYTES } from './rpc-handler';

const now = () => new Date('2026-01-02T03:04:05.000Z');
const ORIGIN = 'http://localhost:3000';
const CSRF = { 'x-csrf-token': 'orpc' };
const SESSION_COOKIE = '__Host-wd_session=' + 'a'.repeat(43);

const session = {
  sessionId: 's1',
  user: { id: '00000000-0000-4000-8000-000000000001', username: 'alice' },
  lastSeenAt: now(),
  expiresAt: now(),
};
const authenticate = async () => session;

function request(method = 'POST', headers: Record<string, string> = {}, procedure = 'health') {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(`${ORIGIN}/api/rpc/${procedure}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(hasBody ? { body: JSON.stringify({}) } : {}),
  });
}

async function call(
  headers: Record<string, string> = CSRF,
  options: {
    procedure?: string;
    checkDb?: () => Promise<void>;
    allowedOrigin?: () => string;
  } = {},
) {
  const handle = createRpcHandler({
    checkDb: options.checkDb ?? (async () => {}),
    now,
    log: () => {},
    authenticate,
    allowedOrigin: options.allowedOrigin ?? (() => ORIGIN),
  });
  const result = await handle(request('POST', headers, options.procedure));
  if (!result.matched) throw new Error('route not matched');
  return {
    status: result.response.status,
    headers: result.response.headers,
    body: (await result.response.json()) as { json: unknown },
  };
}

describe('health (public, liveness only)', () => {
  it('answers without a session and discloses no dependency state', async () => {
    const handle = createRpcHandler({ now, log: () => {}, allowedOrigin: () => ORIGIN });
    const result = await handle(request('POST', CSRF));
    if (!result.matched) throw new Error('route not matched');
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(((await result.response.json()) as { json: unknown }).json).toEqual({
      status: 'ok',
      time: '2026-01-02T03:04:05.000Z',
    });
  });
});

describe('systemStatus (authenticated)', () => {
  it('reports ok when the DB check passes', async () => {
    const { status, body } = await call(CSRF, { procedure: 'systemStatus' });
    expect(status).toBe(200);
    expect(body.json).toEqual({ status: 'ok', db: 'ok', time: '2026-01-02T03:04:05.000Z' });
  });

  it('reports db unavailable without leaking the failure detail', async () => {
    const { status, body } = await call(CSRF, {
      procedure: 'systemStatus',
      checkDb: async () => {
        throw new Error('connect ECONNREFUSED postgres://u:secret@10.0.0.1:5432/db');
      },
    });
    expect(status).toBe(200);
    expect(body.json).toEqual({
      status: 'degraded',
      db: 'unavailable',
      time: '2026-01-02T03:04:05.000Z',
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|ECONNREFUSED/);
  });

  it('throttles the "database unavailable" log line', async () => {
    const log = vi.fn();
    let clock = 1_000_000;
    const handle = createRpcHandler({
      checkDb: async () => {
        throw new Error('down');
      },
      now: () => new Date(clock),
      log,
      authenticate,
      allowedOrigin: () => ORIGIN,
    });
    const hit = () => handle(request('POST', CSRF, 'systemStatus'));
    await hit();
    await hit();
    expect(log).toHaveBeenCalledTimes(1);
    clock += 30_000;
    await hit();
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('CSRF and Origin invariants', () => {
  it('rejects requests without the CSRF header', async () => {
    const { status, headers } = await call({});
    expect(status).toBe(403);
    expect(headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a cross-origin Origin header (oRPC-encoded) but allows the configured one', async () => {
    const foreign = await call({ ...CSRF, origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('cache-control')).toBe('no-store');
    expect(foreign.body).toEqual({ json: expect.objectContaining({ code: 'FORBIDDEN' }) });
    expect((await call({ ...CSRF, origin: ORIGIN })).status).toBe(200);
  });

  it('rejects Sec-Fetch-Site other than same-origin, even with a matching Origin', async () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await call({ ...CSRF, origin: ORIGIN, 'sec-fetch-site': site });
      expect(res.status, site).toBe(403);
    }
    expect((await call({ ...CSRF, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it('fails closed: session cookie with neither Origin nor Sec-Fetch-Site is rejected', async () => {
    const res = await call({ ...CSRF, cookie: SESSION_COOKIE }, { procedure: 'auth/me' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ json: expect.objectContaining({ code: 'FORBIDDEN' }) });
  });

  it('accepts a session cookie when Origin or Sec-Fetch-Site proves same-origin', async () => {
    const withOrigin = await call(
      { ...CSRF, cookie: SESSION_COOKIE, origin: ORIGIN },
      { procedure: 'auth/me' },
    );
    expect(withOrigin.status).toBe(200);
    const withFetchSite = await call(
      { ...CSRF, cookie: SESSION_COOKIE, 'sec-fetch-site': 'same-origin' },
      { procedure: 'auth/me' },
    );
    expect(withFetchSite.status).toBe(200);
  });

  it('does not require Origin for cookie-less requests (curl, login scripts)', () => {
    expect(checkRequestOrigin(request('POST', CSRF), ORIGIN)).toBe(true);
    // An unrelated cookie is not ambient authority for us.
    expect(checkRequestOrigin(request('POST', { ...CSRF, cookie: 'theme=dark' }), ORIGIN)).toBe(
      true,
    );
  });

  it('never enables CORS: no Access-Control-* headers, OPTIONS preflight is refused', async () => {
    const ok = await call({ ...CSRF, origin: ORIGIN });
    const denied = await call({ ...CSRF, origin: 'https://evil.example' });
    for (const res of [ok, denied]) {
      expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
    const handle = createRpcHandler({ allowedOrigin: () => ORIGIN, log: () => {} });
    const preflight = await handle(
      request('OPTIONS', {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-csrf-token',
      }),
    );
    if (!preflight.matched) throw new Error('route not matched');
    expect(preflight.response.status).toBe(405);
    expect(preflight.response.headers.get('access-control-allow-origin')).toBeNull();
    expect(preflight.response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('body size limit', () => {
  it('answers 413 for a body over the limit (declared or streamed) before reaching auth', async () => {
    const handle = createRpcHandler({ allowedOrigin: () => ORIGIN, log: () => {} });
    const big = JSON.stringify({ username: 'a', password: 'x'.repeat(MAX_BODY_BYTES + 1) });
    const result = await handle(
      new Request(`${ORIGIN}/api/rpc/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...CSRF },
        body: big,
      }),
    );
    if (!result.matched) throw new Error('route not matched');
    expect(result.response.status).toBe(413);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts a normal-sized login payload up to the auth layer', async () => {
    const handle = createRpcHandler({
      allowedOrigin: () => ORIGIN,
      log: () => {},
      authenticate: async () => null,
    });
    const result = await handle(
      new Request(`${ORIGIN}/api/rpc/auth/me`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...CSRF },
        body: JSON.stringify({}),
      }),
    );
    if (!result.matched) throw new Error('route not matched');
    expect(result.response.status).toBe(401);
  });
});

describe('unexpected failures', () => {
  it('maps errors thrown by a handler to a neutral 500 and logs once', async () => {
    const log = vi.fn();
    const handle = createRpcHandler({
      log,
      allowedOrigin: () => ORIGIN,
      now: () => {
        throw new Error('relation "x" at postgres://u:pw@h');
      },
    });
    const result = await handle(request('POST', CSRF));
    if (!result.matched) throw new Error('route not matched');
    const text = await result.response.text();
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text).json).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
    expect(text).not.toMatch(/relation|postgres|pw/);
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('methods', () => {
  const handle = createRpcHandler({ allowedOrigin: () => ORIGIN, log: () => {} });

  it.each(['GET', 'PUT', 'HEAD', 'DELETE', 'PATCH'])('%s is 405 with no-store', async (method) => {
    const result = await handle(request(method, CSRF));
    if (!result.matched) throw new Error('route not matched');
    expect(result.response.status).toBe(405);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    if (method !== 'HEAD') {
      expect((await result.response.json()) as unknown).toEqual({
        json: expect.objectContaining({ code: 'METHOD_NOT_SUPPORTED', status: 405 }),
      });
    }
  });
});

describe('typed client contract (RPCLink + CSRF plugin, in-process)', () => {
  function client(headers: Record<string, string> = {}) {
    const handle = createRpcHandler({
      now,
      log: () => {},
      authenticate,
      allowedOrigin: () => ORIGIN,
    });
    // Mirrors apps/web/lib/orpc.ts.
    const link = new RPCLink({
      url: `${ORIGIN}/api/rpc`,
      plugins: [new SimpleCsrfProtectionLinkPlugin()],
      fetch: async (input, init) => {
        const req = new Request(input, init);
        for (const [k, v] of Object.entries(headers)) req.headers.set(k, v);
        const result = await handle(req);
        if (!result.matched) throw new Error('route not matched');
        return result.response;
      },
    });
    return createORPCClient(link) as ContractRouterClient<Contract>;
  }

  it('resolves health() and auth.me()', async () => {
    await expect(client().health()).resolves.toMatchObject({ status: 'ok' });
    await expect(client().auth.me()).resolves.toEqual({
      user: { id: session.user.id, username: 'alice' },
    });
  });

  it('decodes a foreign origin as a typed FORBIDDEN ORPCError', async () => {
    const error = await client({ origin: 'https://evil.example' })
      .health()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});

describe('systemStatus timeout', () => {
  it('reports degraded after 2000 ms when the check never resolves, leaving no timers', async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const handle = createRpcHandler({
        checkDb: () => new Promise<void>(() => {}),
        now,
        log,
        authenticate,
        allowedOrigin: () => ORIGIN,
      });
      const pending = handle(request('POST', CSRF, 'systemStatus'));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(log).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      if (!result.matched) throw new Error('route not matched');
      expect(((await result.response.json()) as { json: unknown }).json).toMatchObject({
        status: 'degraded',
        db: 'unavailable',
      });
      expect(log).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a successful check leaves no pending timers', async () => {
    vi.useFakeTimers();
    try {
      const handle = createRpcHandler({
        checkDb: async () => {},
        now,
        log: () => {},
        authenticate,
        allowedOrigin: () => ORIGIN,
      });
      const result = await handle(request('POST', CSRF, 'systemStatus'));
      if (!result.matched) throw new Error('route not matched');
      expect(result.response.status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
