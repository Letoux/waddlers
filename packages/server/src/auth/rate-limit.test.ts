import { describe, expect, it } from 'vitest';
import { BackoffLimiter, FailureLimiter, LoginRateLimiter } from './rate-limit';

function clock(start = 1_000_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

describe('FailureLimiter', () => {
  it('blocks after the budget, reports the wait, and recovers when the window ends', () => {
    const c = clock();
    const limiter = new FailureLimiter({ maxFailures: 3, windowMs: 60_000, now: c.now });
    for (let i = 0; i < 2; i++) limiter.record('k');
    expect(limiter.blockedFor('k')).toBe(0);
    limiter.record('k');
    expect(limiter.blockedFor('k')).toBe(60_000);
    c.advance(45_000);
    expect(limiter.blockedFor('k')).toBe(15_000);
    c.advance(15_000);
    expect(limiter.blockedFor('k')).toBe(0);
  });

  it('never evicts a blocking key, evicting non-blocking ones first', () => {
    const c = clock();
    const limiter = new FailureLimiter({
      maxFailures: 2,
      windowMs: 60_000,
      maxKeys: 3,
      now: c.now,
    });
    limiter.record('blocked');
    limiter.record('blocked'); // blocking, and the OLDEST key
    limiter.record('a');
    limiter.record('b');
    limiter.record('c'); // over the cap: evicts 'a' (oldest non-blocking), not 'blocked'
    expect(limiter.blockedFor('blocked')).toBeGreaterThan(0);
    limiter.record('d');
    limiter.record('e');
    expect(limiter.blockedFor('blocked')).toBeGreaterThan(0);
  });

  it('refund gives an attempt back', () => {
    const limiter = new FailureLimiter({ maxFailures: 1, windowMs: 60_000, now: clock().now });
    limiter.record('k');
    limiter.refund('k');
    expect(limiter.blockedFor('k')).toBe(0);
  });
});

describe('BackoffLimiter', () => {
  const options = { freeAttempts: 3, baseMs: 1_000, capMs: 8_000, idleResetMs: 60_000 };

  it('is free for the first attempts, then doubles the wait up to the cap', () => {
    const c = clock();
    const limiter = new BackoffLimiter({ ...options, now: c.now });
    expect(limiter.tryAcquire('u')).toBe(0);
    expect(limiter.tryAcquire('u')).toBe(0);
    expect(limiter.tryAcquire('u')).toBe(0); // 3rd is allowed but starts a 1 s wait
    expect(limiter.tryAcquire('u')).toBe(1_000);
    c.advance(1_000);
    expect(limiter.tryAcquire('u')).toBe(0); // 4th, next wait 2 s
    expect(limiter.tryAcquire('u')).toBe(2_000);
    c.advance(2_000);
    expect(limiter.tryAcquire('u')).toBe(0);
    c.advance(4_000);
    expect(limiter.tryAcquire('u')).toBe(0);
    expect(limiter.tryAcquire('u')).toBe(8_000); // capped
    c.advance(8_000);
    expect(limiter.tryAcquire('u')).toBe(0);
    expect(limiter.tryAcquire('u')).toBe(8_000);
  });

  it('resets on success and after an idle period; keys are independent', () => {
    const c = clock();
    const limiter = new BackoffLimiter({ ...options, now: c.now });
    for (let i = 0; i < 3; i++) limiter.tryAcquire('u');
    expect(limiter.tryAcquire('u')).toBeGreaterThan(0);
    expect(limiter.tryAcquire('other')).toBe(0);
    limiter.reset('u');
    expect(limiter.tryAcquire('u')).toBe(0);
    for (let i = 0; i < 3; i++) limiter.tryAcquire('u');
    c.advance(61_000);
    expect(limiter.tryAcquire('u')).toBe(0);
  });

  it('does not evict a blocking key', () => {
    const c = clock();
    const limiter = new BackoffLimiter({ ...options, maxKeys: 2, now: c.now });
    for (let i = 0; i < 3; i++) limiter.tryAcquire('blocked');
    limiter.tryAcquire('a');
    limiter.tryAcquire('b');
    limiter.tryAcquire('c');
    expect(limiter.tryAcquire('blocked')).toBeGreaterThan(0);
  });
});

describe('LoginRateLimiter (known IP)', () => {
  it('reserves synchronously: at most 5 of many concurrent attempts are allowed', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    const results = Array.from({ length: 40 }, () => limiter.acquire('alice', '1.1.1.1'));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const blocked = results.find((r) => !r.allowed);
    expect(blocked && !blocked.allowed && blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('is case-insensitive per username, and IPs/users have separate pair budgets', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 5; i++) limiter.acquire(i % 2 ? 'alice' : 'ALICE', '1.1.1.1');
    expect(limiter.acquire('alice', '1.1.1.1').allowed).toBe(false);
    expect(limiter.acquire('alice', '2.2.2.2').allowed).toBe(true);
    expect(limiter.acquire('bob', '1.1.1.1').allowed).toBe(true);
  });

  it('caps a username across rotating IPs (spoofed client-IP headers)', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 20; i++) limiter.acquire('alice', `10.0.0.${i}`);
    expect(limiter.acquire('alice', '10.9.9.9').allowed).toBe(false);
  });

  it('a successful attempt is refunded (pair cleared, user count given back)', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 4; i++) limiter.acquire('alice', '1.1.1.1');
    const fifth = limiter.acquire('alice', '1.1.1.1');
    if (!fifth.allowed) throw new Error('expected allowed');
    fifth.succeed();
    for (let i = 0; i < 5; i++) expect(limiter.acquire('alice', '1.1.1.1').allowed).toBe(true);
  });

  it('blocked attempts are not counted and do not extend the window', () => {
    const c = clock();
    const limiter = new LoginRateLimiter({ now: c.now });
    for (let i = 0; i < 5; i++) limiter.acquire('alice', '1.1.1.1');
    for (let i = 0; i < 50; i++) limiter.acquire('alice', '1.1.1.1');
    c.advance(15 * 60_000);
    expect(limiter.acquire('alice', '1.1.1.1').allowed).toBe(true);
  });
});

describe('LoginRateLimiter (unknown IP)', () => {
  it('does not let anonymous failures for one user lock out a different user', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 50; i++) limiter.acquire('alice', 'unknown');
    expect(limiter.acquire('bob', 'unknown').allowed).toBe(true);
  });

  it('uses a bounded progressive delay per username instead of a hard block', () => {
    const c = clock();
    const limiter = new LoginRateLimiter({ now: c.now });
    const allowed = Array.from({ length: 30 }, () => limiter.acquire('alice', 'unknown')).filter(
      (r) => r.allowed,
    );
    expect(allowed).toHaveLength(5); // concurrent burst: 5 free attempts, rest delayed
    const delayed = limiter.acquire('alice', 'unknown');
    expect(!delayed.allowed && delayed.retryAfterMs).toBeLessThanOrEqual(2_000);
    c.advance(2_000);
    expect(limiter.acquire('alice', 'unknown').allowed).toBe(true); // recovers quickly
  });

  it('success clears the delay', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    let last;
    for (let i = 0; i < 5; i++) last = limiter.acquire('alice', 'unknown');
    if (!last?.allowed) throw new Error('expected allowed');
    last.succeed();
    expect(limiter.acquire('alice', 'unknown').allowed).toBe(true);
  });
});
