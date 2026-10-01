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
    const a = limiter.acquire('u1');
    const b = limiter.acquire('u1');
    expect(a.allowed && b.allowed).toBe(true);
    expect(limiter.acquire('u1')).toEqual({ allowed: false, retryAfterMs: 1000 });
    if (a.allowed) a.release();
    expect(limiter.acquire('u1').allowed).toBe(true);
  });

  it('release is idempotent (a double release cannot open extra slots)', () => {
    const { limiter } = make();
    const a = limiter.acquire('u1');
    const b = limiter.acquire('u1');
    if (a.allowed) {
      a.release();
      a.release();
    }
    expect(limiter.acquire('u1').allowed).toBe(true); // one slot back
    expect(limiter.acquire('u1').allowed).toBe(false); // b + the new one
    expect(b.allowed).toBe(true);
  });

  it('a token bucket of 30 per minute refuses the 31st request with the wait for the next token', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 30; i += 1) {
      const r = limiter.acquire('u1');
      expect(r.allowed).toBe(true);
      if (r.allowed) r.release();
    }
    const refused = limiter.acquire('u1');
    expect(refused).toEqual({ allowed: false, retryAfterMs: 2000 });
    expect(retryAfterSeconds(2000)).toBe(2);
    advance(1999);
    expect(limiter.acquire('u1').allowed).toBe(false);
    advance(1);
    expect(limiter.acquire('u1').allowed).toBe(true);
  });

  it('never affects another user', () => {
    const { limiter } = make();
    limiter.acquire('u1');
    limiter.acquire('u1');
    expect(limiter.acquire('u1').allowed).toBe(false);
    expect(limiter.acquire('u2').allowed).toBe(true);
  });

  it('a refused request does not consume a token or a slot', () => {
    const { limiter } = make({ ratePerMinute: 3 });
    const a = limiter.acquire('u1');
    const b = limiter.acquire('u1');
    for (let i = 0; i < 5; i += 1) expect(limiter.acquire('u1').allowed).toBe(false);
    if (a.allowed) a.release();
    if (b.allowed) b.release();
    expect(limiter.acquire('u1').allowed).toBe(true); // the third token is still there
    expect(limiter.acquire('u1').allowed).toBe(false);
  });

  it('evicts idle users with a full bucket when the soft cap is reached, never a running one', () => {
    const { limiter } = make({ maxKeys: 2 });
    const busy = limiter.acquire('busy');
    const idle = limiter.acquire('idle');
    if (idle.allowed) idle.release();
    limiter.acquire('third'); // cap reached: nothing is evictable (idle has spent a token)
    expect(busy.allowed).toBe(true);
    expect(limiter.acquire('busy').allowed).toBe(true); // still tracked, 1 in flight + this
    expect(limiter.acquire('busy').allowed).toBe(false);
  });
});
