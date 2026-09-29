import { describe, expect, it, vi } from 'vitest';
import { createRpcHandler } from './rpc-handler';

const now = () => new Date('2026-01-02T03:04:05.000Z');

function healthRequest(headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/rpc/health', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({}),
  });
}

async function call(
  checkDb: () => Promise<void>,
  headers: Record<string, string> = { 'x-csrf-token': 'orpc' },
  allowedOrigin?: () => string,
) {
  const handle = createRpcHandler({
    checkDb,
    now,
    log: () => {},
    ...(allowedOrigin ? { allowedOrigin } : {}),
  });
  const result = await handle(healthRequest(headers));
  if (!result.matched) throw new Error('route not matched');
  return {
    status: result.response.status,
    body: (await result.response.json()) as { json: unknown },
  };
}

describe('health via RPC handler', () => {
  it('reports ok when the DB check passes', async () => {
    const { status, body } = await call(async () => {});
    expect(status).toBe(200);
    expect(body.json).toEqual({ status: 'ok', db: 'ok', time: '2026-01-02T03:04:05.000Z' });
  });

  it('reports db unavailable without leaking the failure detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, body } = await call(async () => {
      throw new Error('connect ECONNREFUSED postgres://u:secret@10.0.0.1:5432/db');
    });
    spy.mockRestore();
    expect(status).toBe(200);
    expect(body.json).toEqual({
      status: 'degraded',
      db: 'unavailable',
      time: '2026-01-02T03:04:05.000Z',
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|ECONNREFUSED/);
  });

  it('rejects requests without the CSRF header', async () => {
    const { status } = await call(async () => {}, {});
    expect(status).toBe(403);
  });

  it('rejects a cross-origin Origin header but allows the configured one', async () => {
    const csrf = { 'x-csrf-token': 'orpc' };
    const origin = () => 'http://localhost:3000';
    expect(
      (await call(async () => {}, { ...csrf, origin: 'https://evil.example' }, origin)).status,
    ).toBe(403);
    expect(
      (await call(async () => {}, { ...csrf, origin: 'http://localhost:3000' }, origin)).status,
    ).toBe(200);
  });
});
