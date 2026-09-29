import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadHeaders(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  const { default: config } = await import('./next.config');
  const rules = await config.headers!();
  return {
    config,
    headers: Object.fromEntries((rules[0]?.headers ?? []).map((h) => [h.key, h.value])),
  };
}

describe('next.config security headers', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('production: no framing, nosniff, referrer policy, HSTS, no eval, no X-Powered-By', async () => {
    const { config, headers } = await loadHeaders('production');
    expect(config.poweredByHeader).toBe(false);
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
    expect(headers['Content-Security-Policy']).not.toContain('unsafe-eval');
    expect(headers['Content-Security-Policy']).not.toMatch(/connect-src[^;]*ws:/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Strict-Transport-Security']).toMatch(/max-age=\d+/);
  });

  it('development: allows HMR (eval, websockets) and never sends HSTS', async () => {
    const { headers } = await loadHeaders('development');
    expect(headers['Content-Security-Policy']).toContain("'unsafe-eval'");
    expect(headers['Content-Security-Policy']).toMatch(/connect-src[^;]*ws:/);
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });
});
