import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:3000';

async function loadRoute() {
  vi.resetModules();
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('MARKET_DATA_PROVIDER', 'fake');
  // Unreachable DB: liveness (health) must not depend on it; nothing may hang or leak.
  vi.stubEnv('DATABASE_URL', 'postgres://nobody:pw@127.0.0.1:1/none');
  return import('./route');
}

function post(path: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/rpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({}),
  });
}

describe('/api/rpc route', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    const { closeDb } = await import('@waddlers/server');
    await closeDb();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('exports only POST as a method handler', async () => {
    const route = await loadRoute();
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].filter(
      (m) => m in route,
    );
    expect(methods).toEqual(['POST']);
  });

  it('rejects a foreign Origin with 403', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      post('health', { 'x-csrf-token': 'orpc', origin: 'https://evil.example' }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves health for the same origin with the CSRF header', async () => {
    const { POST } = await loadRoute();
    const res = await POST(post('health', { 'x-csrf-token': 'orpc', origin: ORIGIN }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { json } = (await res.json()) as { json: { status: string } };
    expect(['ok', 'degraded']).toContain(json.status);
  });

  it('returns 404 for an unknown procedure', async () => {
    const { POST } = await loadRoute();
    const res = await POST(post('nope', { 'x-csrf-token': 'orpc' }));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
