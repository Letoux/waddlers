import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '@waddlers/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createRpcHandler } from './rpc-handler';

const now = () => new Date('2026-01-02T03:04:05.000Z');
const ORIGIN = 'http://localhost:3000';

function request(method = 'POST', headers: Record<string, string> = {}) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(`${ORIGIN}/api/rpc/health`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(hasBody ? { body: JSON.stringify({}) } : {}),
  });
}

async function call(
  checkDb: () => Promise<void>,
  headers: Record<string, string> = { 'x-csrf-token': 'orpc' },
  allowedOrigin: () => string = () => ORIGIN,
) {
  const handle = createRpcHandler({ checkDb, now, log: () => {}, allowedOrigin });
  const result = await handle(request('POST', headers));
  if (!result.matched) throw new Error('route not matched');
  return {
    status: result.response.status,
    headers: result.response.headers,
    body: (await result.response.json()) as { json: unknown },
  };
}

describe('health via RPC handler', () => {
  it('reports ok when the DB check passes', async () => {
    const { status, body, headers } = await call(async () => {});
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(body.json).toEqual({ status: 'ok', db: 'ok', time: '2026-01-02T03:04:05.000Z' });
  });

  it('reports db unavailable without leaking the failure detail', async () => {
    const { status, body } = await call(async () => {
      throw new Error('connect ECONNREFUSED postgres://u:secret@10.0.0.1:5432/db');
    });
    expect(status).toBe(200);
    expect(body.json).toEqual({
      status: 'degraded',
      db: 'unavailable',
      time: '2026-01-02T03:04:05.000Z',
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|ECONNREFUSED/);
  });

  it('rejects requests without the CSRF header', async () => {
    const { status, headers } = await call(async () => {}, {});
    expect(status).toBe(403);
    expect(headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a cross-origin Origin header (oRPC-encoded) but allows the configured one', async () => {
    const csrf = { 'x-csrf-token': 'orpc' };
    const foreign = await call(async () => {}, { ...csrf, origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('cache-control')).toBe('no-store');
    expect(foreign.body).toEqual({ json: expect.objectContaining({ code: 'FORBIDDEN' }) });
    expect((await call(async () => {}, { ...csrf, origin: ORIGIN })).status).toBe(200);
  });
});

describe('unexpected failures', () => {
  it('maps errors outside the health try/catch to a neutral 500 and logs once', async () => {
    const log = vi.fn();
    const handle = createRpcHandler({
      log,
      allowedOrigin: () => ORIGIN,
      now: () => {
        throw new Error('relation "x" at postgres://u:pw@h');
      },
      checkDb: async () => {},
    });
    const result = await handle(request('POST', { 'x-csrf-token': 'orpc' }));
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
    const result = await handle(request(method, { 'x-csrf-token': 'orpc' }));
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
      checkDb: async () => {},
      now,
      log: () => {},
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

  it('resolves health()', async () => {
    await expect(client().health()).resolves.toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('decodes a foreign origin as a typed FORBIDDEN ORPCError', async () => {
    const error = await client({ origin: 'https://evil.example' })
      .health()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});

describe('health timeout', () => {
  it('reports degraded after 2000 ms when the check never resolves, leaving no timers', async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const handle = createRpcHandler({
        checkDb: () => new Promise<void>(() => {}),
        now,
        log,
        allowedOrigin: () => ORIGIN,
      });
      const pending = handle(request('POST', { 'x-csrf-token': 'orpc' }));
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
        allowedOrigin: () => ORIGIN,
      });
      const result = await handle(request('POST', { 'x-csrf-token': 'orpc' }));
      if (!result.matched) throw new Error('route not matched');
      expect(result.response.status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
