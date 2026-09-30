import { describe, expect, it, vi } from 'vitest';
import { CallGuard, guardMarketDataProvider, type GuardOptions, type UsageStore } from './guard';
import { redactSecrets, safeErrorMessage } from './redact';
import {
  fail,
  ok,
  type ListingRef,
  type MarketDataProvider,
  type MarketLogger,
  type ProviderResult,
  type QuoteBatch,
} from './types';

const listing: ListingRef = {
  id: 'l1',
  symbol: 'AI',
  mic: 'XPAR',
  currency: 'EUR',
  timezone: 'Europe/Paris',
  providerSymbol: null,
};

/** In-memory quota with the same contract as DbUsageStore. */
class MemoryUsage implements UsageStore {
  readonly counts = new Map<string, number>();
  async reserve(provider: string, day: string, budget: number) {
    const key = `${provider}|${day}`;
    const n = this.counts.get(key) ?? 0;
    if (n >= budget) return false;
    this.counts.set(key, n + 1);
    return true;
  }
}

function guard(overrides: Partial<GuardOptions> = {}) {
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger: MarketLogger = {
    info: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
  };
  const sleeps: number[] = [];
  const g = new CallGuard({
    provider: 'fake',
    concurrency: 2,
    timeoutMs: 50,
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    dailyBudget: 100,
    usage: new MemoryUsage(),
    logger,
    clock: () => new Date('2026-09-30T10:00:00Z'),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...overrides,
  });
  return { g, logs, sleeps };
}

const batch: QuoteBatch = { quotes: [], rejected: [] };
const good = (): ProviderResult<QuoteBatch> => ok('fake', batch, new Date('2026-09-30T09:00:00Z'));

describe('CallGuard retry policy', () => {
  it.each(['timeout', 'network', 'rate_limited', 'upstream_error'] as const)(
    'retries the transient error %s and returns the eventual success',
    async (code) => {
      const { g, sleeps } = guard();
      const call = vi
        .fn()
        .mockResolvedValueOnce(fail('fake', code, 'boom'))
        .mockResolvedValueOnce(good());
      const result = await g.run('op', call);
      expect(result.ok).toBe(true);
      expect(call).toHaveBeenCalledTimes(2);
      // Full jitter: random 0.5 * min(max, base * 2^0).
      expect(sleeps).toEqual([50]);
    },
  );

  it.each(['unauthorized', 'not_found', 'bad_payload', 'unsupported', 'quota_exceeded'] as const)(
    'does not retry the permanent error %s',
    async (code) => {
      const { g } = guard();
      const call = vi.fn().mockResolvedValue(fail('fake', code, 'nope'));
      const result = await g.run('op', call);
      expect(result).toMatchObject({ ok: false, code });
      expect(call).toHaveBeenCalledTimes(1);
    },
  );

  it('gives up after maxAttempts with the last transient error', async () => {
    const { g, sleeps } = guard();
    const call = vi.fn().mockResolvedValue(fail('fake', 'upstream_error', '503'));
    const result = await g.run('op', call);
    expect(result).toMatchObject({ ok: false, code: 'upstream_error' });
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([50, 100]); // exponential ceiling, jittered
  });

  it('turns a throwing adapter into a failure result, never a throw', async () => {
    const { g } = guard({ maxAttempts: 1 });
    const result = await g.run('op', () => Promise.reject(new Error('kaboom')));
    expect(result).toMatchObject({ ok: false, code: 'network' });
  });

  it('classifies NotConfiguredError as non-retryable not_configured', async () => {
    const { NotConfiguredError } = await import('./types');
    const { g } = guard();
    const call = vi.fn(() => {
      throw new NotConfiguredError('eodhd');
    });
    const result = await g.run('op', call);
    expect(result).toMatchObject({ ok: false, code: 'not_configured' });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('CallGuard timeout', () => {
  it('aborts the signal and reports timeout when the adapter hangs', async () => {
    const { g } = guard({ maxAttempts: 1, timeoutMs: 20 });
    let aborted = false;
    const result = await g.run(
      'op',
      (options) =>
        new Promise<ProviderResult<QuoteBatch>>(() => {
          options.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    );
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('retries a timeout (transient)', async () => {
    const { g } = guard({ timeoutMs: 20 });
    let n = 0;
    const result = await g.run('op', () => {
      n += 1;
      return n === 1 ? new Promise<never>(() => {}) : Promise.resolve(good());
    });
    expect(result.ok).toBe(true);
    expect(n).toBe(2);
  });
});

describe('CallGuard concurrency', () => {
  it('never runs more calls at once than the cap, and still completes them all', async () => {
    const { g } = guard({ concurrency: 2, timeoutMs: 5000 });
    let active = 0;
    let peak = 0;
    const call = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return good();
    };
    const results = await Promise.all(Array.from({ length: 12 }, () => g.run('op', call)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
  });
});

describe('CallGuard quota', () => {
  it('refuses calls over the daily budget without calling the provider', async () => {
    const usage = new MemoryUsage();
    const { g } = guard({ dailyBudget: 2, usage });
    const call = vi.fn().mockResolvedValue(good());
    expect((await g.run('op', call)).ok).toBe(true);
    expect((await g.run('op', call)).ok).toBe(true);
    const refused = await g.run('op', call);
    expect(refused).toMatchObject({ ok: false, code: 'local_quota' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('counts every attempt, retries included', async () => {
    const usage = new MemoryUsage();
    const { g } = guard({ usage });
    await g.run('op', () => Promise.resolve(fail('fake', 'network', 'x')));
    expect(usage.counts.get('fake|2026-09-30')).toBe(3);
  });

  it('refuses when the usage store itself fails (cannot prove budget)', async () => {
    const { g } = guard({
      usage: { reserve: () => Promise.reject(new Error('db down')) },
    });
    const call = vi.fn().mockResolvedValue(good());
    expect(await g.run('op', call)).toMatchObject({ ok: false, code: 'local_quota' });
    expect(call).not.toHaveBeenCalled();
  });
});

describe('secret redaction', () => {
  const SECRET = 'supersecret123';

  it('scrubs api_token from provider messages before they reach results and logs', async () => {
    const { g, logs } = guard({ maxAttempts: 1, secrets: [SECRET] });
    const url = `https://eodhd.com/api/real-time/AI.PA?api_token=${SECRET}&fmt=json`;
    const result = await g.run('op', () =>
      Promise.resolve(fail('fake', 'upstream_error', `GET ${url} -> 500`)),
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify(result)).toContain('api_token=[REDACTED]');
  });

  it('scrubs a thrown error that embeds the secret (even outside a query string)', async () => {
    const { g, logs } = guard({ maxAttempts: 1, secrets: [SECRET] });
    const result = await g.run('op', () =>
      Promise.reject(new Error(`fetch failed for https://x/y?api_token=${SECRET} using ${SECRET}`)),
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it('redacts through the guarded provider wrapper too', async () => {
    const { g } = guard({ maxAttempts: 1 });
    const raw: MarketDataProvider = {
      name: 'fake',
      getQuotes: () => Promise.resolve(fail('fake', 'unauthorized', 'bad api_token=secret')),
      getDailyHistory: () => Promise.reject(new Error('never')),
    };
    const result = await guardMarketDataProvider(raw, g).getQuotes([listing]);
    expect(result).toMatchObject({ ok: false, message: 'bad api_token=[REDACTED]' });
  });

  it('redacts the percent-encoded and base64 forms of a configured secret', () => {
    const secret = 'p@ss/w+rd=1&x';
    const b64 = Buffer.from(secret).toString('base64');
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    for (const leaked of [
      encodeURIComponent(secret),
      b64,
      b64.replace(/=+$/, ''),
      b64url,
      secret,
    ]) {
      const out = redactSecrets(`GET /x?v=${leaked} failed`, [secret]);
      expect(out).not.toContain(leaked);
      expect(out).toContain('[REDACTED]');
    }
  });

  it('redacts param values after a percent-encoded equals sign and Basic credentials', () => {
    expect(redactSecrets('u?api_token%3Dabc123&x=1')).toBe('u?api_token%3D[REDACTED]&x=1');
    expect(redactSecrets('u?apikey%3dabc123')).toBe('u?apikey%3d[REDACTED]');
    const out = redactSecrets('Authorization: Basic dXNlcjpwYXNz next');
    expect(out).not.toContain('dXNlcjpwYXNz');
    expect(redactSecrets('basic   dXNlcjpwYXNz==')).not.toContain('dXNlcjpwYXNz');
    expect(redactSecrets('nothing to see')).toBe('nothing to see');
  });

  it('redactSecrets handles bearer tokens, header style and short secrets', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-123')).not.toContain('abc.def-123');
    expect(redactSecrets('a=1&apikey=zzz&b=2')).toBe('a=1&apikey=[REDACTED]&b=2');
    expect(redactSecrets('abc', ['abc'])).toBe('abc'); // < 4 chars: not shredded
    expect(safeErrorMessage(new Error('x api_token=secret'))).toBe('Error: x api_token=[REDACTED]');
  });
});
