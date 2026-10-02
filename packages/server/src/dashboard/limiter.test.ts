import { describe, expect, it } from 'vitest';
import { DashboardLimiter, retryAfterSeconds } from './limiter';

function make(over: Partial<ConstructorParameters<typeof DashboardLimiter>[0]> = {}) {
  let t = 0;
  const limiter = new DashboardLimiter({
    maxConcurrent: 2,
    ratePerMinute: 30,
    now: () => t,
    ...over,
  });
  return { limiter, advance: (ms: number) => (t += ms) };
}

describe('DashboardLimiter', () => {
  it('admits two concurrent requests per user and refuses the third, until one finishes', () => {
    const { limiter } = make();
    const a = limiter.acquire('u1', 'summary');
    const b = limiter.acquire('u1', 'summary');
    expect(a.allowed && b.allowed).toBe(true);
    expect(limiter.acquire('u1', 'summary')).toEqual({ allowed: false, retryAfterMs: 1000 });
    if (a.allowed) a.release();
    expect(limiter.acquire('u1', 'summary').allowed).toBe(true);
  });

  it('release is idempotent (a double release cannot open extra slots)', () => {
    const { limiter } = make();
    const a = limiter.acquire('u1', 'summary');
    const b = limiter.acquire('u1', 'summary');
    if (a.allowed) {
      a.release();
      a.release();
    }
    expect(limiter.acquire('u1', 'summary').allowed).toBe(true); // one slot back
    expect(limiter.acquire('u1', 'summary').allowed).toBe(false); // b + the new one
    expect(b.allowed).toBe(true);
  });

  it('a token bucket of 30 per minute refuses the 31st request with the wait for the next token', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 30; i += 1) {
      const r = limiter.acquire('u1', 'summary');
      expect(r.allowed).toBe(true);
      if (r.allowed) r.release();
    }
    const refused = limiter.acquire('u1', 'summary');
    expect(refused).toEqual({ allowed: false, retryAfterMs: 2000 });
    expect(retryAfterSeconds(2000)).toBe(2);
    advance(1999);
    expect(limiter.acquire('u1', 'summary').allowed).toBe(false);
    advance(1);
    expect(limiter.acquire('u1', 'summary').allowed).toBe(true);
  });

  it('caps in-flight per procedure: a full summary does not block a history, the bucket stays shared', () => {
    const { limiter } = make({ ratePerMinute: 4 });
    limiter.acquire('u1', 'summary');
    limiter.acquire('u1', 'summary');
    expect(limiter.acquire('u1', 'summary').allowed).toBe(false);
    expect(limiter.acquire('u1', 'history').allowed).toBe(true);
    expect(limiter.acquire('u1', 'history').allowed).toBe(true);
    expect(limiter.acquire('u1', 'history').allowed).toBe(false); // history cap
    // 4 tokens spent in total across both procedures: one bucket per user.
    const r = limiter.acquire('u1', 'other');
    expect(r.allowed).toBe(false);
    expect(r.allowed ? 0 : r.retryAfterMs).toBeGreaterThan(1000);
  });

  it('never affects another user', () => {
    const { limiter } = make();
    limiter.acquire('u1', 'summary');
    limiter.acquire('u1', 'summary');
    expect(limiter.acquire('u1', 'summary').allowed).toBe(false);
    expect(limiter.acquire('u2', 'summary').allowed).toBe(true);
  });

  it('a refused request does not consume a token or a slot', () => {
    const { limiter } = make({ ratePerMinute: 3 });
    const a = limiter.acquire('u1', 'summary');
    const b = limiter.acquire('u1', 'summary');
    for (let i = 0; i < 5; i += 1) expect(limiter.acquire('u1', 'summary').allowed).toBe(false);
    if (a.allowed) a.release();
    if (b.allowed) b.release();
    expect(limiter.acquire('u1', 'summary').allowed).toBe(true); // the third token is still there
    expect(limiter.acquire('u1', 'summary').allowed).toBe(false);
  });

  it('evicts idle users with a full bucket when the soft cap is reached, never a running one', () => {
    const { limiter } = make({ maxKeys: 2 });
    const busy = limiter.acquire('busy', 'summary');
    const idle = limiter.acquire('idle', 'summary');
    if (idle.allowed) idle.release();
    limiter.acquire('third', 'summary'); // cap reached: nothing is evictable (idle has spent a token)
    expect(busy.allowed).toBe(true);
    expect(limiter.acquire('busy', 'summary').allowed).toBe(true); // still tracked, 1 in flight + this
    expect(limiter.acquire('busy', 'summary').allowed).toBe(false);
  });
});

describe('per-procedure policy (positions.list: in-flight cap, no rate)', () => {
  const policy = { maxConcurrent: 4, rated: false } as const;

  it('caps at 4 in flight with its own cap and releases a slot on finish', () => {
    const { limiter } = make();
    const held = Array.from({ length: 4 }, () => limiter.acquire('u1', 'positions.list', policy));
    expect(held.every((a) => a.allowed)).toBe(true);
    expect(limiter.acquire('u1', 'positions.list', policy)).toEqual({
      allowed: false,
      retryAfterMs: 1000,
    });
    const first = held[0];
    if (first?.allowed) first.release();
    expect(limiter.acquire('u1', 'positions.list', policy).allowed).toBe(true);
  });

  it('has no rate limit: hundreds of sequential calls pass, and the shared bucket is untouched', () => {
    const { limiter } = make({ ratePerMinute: 3 });
    for (let i = 0; i < 300; i += 1) {
      const a = limiter.acquire('u1', 'positions.list', policy);
      expect(a.allowed).toBe(true);
      if (a.allowed) a.release();
    }
    // The dashboard bucket (3) is still full: three summaries pass, the fourth is rate-limited.
    for (let i = 0; i < 3; i += 1) {
      const a = limiter.acquire('u1', 'summary');
      expect(a.allowed).toBe(true);
      if (a.allowed) a.release();
    }
    expect(limiter.acquire('u1', 'summary').allowed).toBe(false);
  });

  it('is counted per user and per procedure (a busy table does not block the dashboard)', () => {
    const { limiter } = make();
    for (let i = 0; i < 4; i += 1) limiter.acquire('u1', 'positions.list', policy);
    expect(limiter.acquire('u2', 'positions.list', policy).allowed).toBe(true);
    expect(limiter.acquire('u1', 'summary').allowed).toBe(true);
  });
});

describe('burst (tableConfig.save: 30/min, burst 10)', () => {
  const opts = { ratePerMinute: 30, burst: 10, maxConcurrent: 2 };
  it('admits `burst` calls at once, then refills at the sustained rate (one per 2 s)', () => {
    const { limiter, advance } = make(opts);
    for (let i = 0; i < 10; i += 1) {
      const a = limiter.acquire('u1', 'tableConfig.save');
      expect(a.allowed, `call ${i}`).toBe(true);
      if (a.allowed) a.release();
    }
    expect(limiter.acquire('u1', 'tableConfig.save')).toEqual({
      allowed: false,
      retryAfterMs: 2000,
    });
    advance(2000);
    expect(limiter.acquire('u1', 'tableConfig.save').allowed).toBe(true);
  });
  it('never refills past the burst, even after a long idle time', () => {
    const { limiter, advance } = make(opts);
    advance(3_600_000);
    let admitted = 0;
    for (let i = 0; i < 30; i += 1) {
      const a = limiter.acquire('u1', 'tableConfig.save');
      if (a.allowed) {
        admitted += 1;
        a.release();
      }
    }
    expect(admitted).toBe(10);
  });
});
