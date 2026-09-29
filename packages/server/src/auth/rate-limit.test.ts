import { describe, expect, it } from 'vitest';
import { FailureLimiter, LoginRateLimiter } from './rate-limit';

function clock(start = 1_000_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

describe('FailureLimiter', () => {
  it('blocks after the budget, reports the wait, and recovers when the window ends', () => {
    const c = clock();
    const limiter = new FailureLimiter({ maxFailures: 3, windowMs: 60_000, now: c.now });
    for (let i = 0; i < 2; i++) limiter.recordFailure('k');
    expect(limiter.blockedFor('k')).toBe(0);
    limiter.recordFailure('k');
    expect(limiter.blockedFor('k')).toBe(60_000);
    c.advance(45_000);
    expect(limiter.blockedFor('k')).toBe(15_000);
    c.advance(15_000);
    expect(limiter.blockedFor('k')).toBe(0);
  });

  it('isolates keys and bounds memory', () => {
    const c = clock();
    const limiter = new FailureLimiter({
      maxFailures: 1,
      windowMs: 60_000,
      maxKeys: 3,
      now: c.now,
    });
    limiter.recordFailure('a');
    expect(limiter.blockedFor('b')).toBe(0);
    for (const key of ['b', 'c', 'd']) limiter.recordFailure(key);
    // 'a' (oldest) was evicted to stay within maxKeys.
    expect(limiter.blockedFor('a')).toBe(0);
    expect(limiter.blockedFor('d')).toBeGreaterThan(0);
  });
});

describe('LoginRateLimiter', () => {
  it('trips after 5 failures for the same username and IP, case-insensitively', () => {
    const c = clock();
    const limiter = new LoginRateLimiter({ now: c.now });
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('Alice', '1.1.1.1')).toBe(0);
      limiter.recordFailure(i % 2 ? 'alice' : 'ALICE', '1.1.1.1');
    }
    expect(limiter.check('alice', '1.1.1.1')).toBeGreaterThan(0);
    // Another IP still has its own pair budget, another user is unaffected.
    expect(limiter.check('alice', '2.2.2.2')).toBe(0);
    expect(limiter.check('bob', '1.1.1.1')).toBe(0);
  });

  it('caps a username across rotating IPs (spoofed client-IP headers)', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 20; i++) limiter.recordFailure('alice', `10.0.0.${i}`);
    expect(limiter.check('alice', '10.9.9.9')).toBeGreaterThan(0);
  });

  it('a success clears the pair counter', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 4; i++) limiter.recordFailure('alice', '1.1.1.1');
    limiter.recordSuccess('alice', '1.1.1.1');
    limiter.recordFailure('alice', '1.1.1.1');
    expect(limiter.check('alice', '1.1.1.1')).toBe(0);
  });
});
