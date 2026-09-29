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

  it('keeps backoff levels on eviction: only entries under their free attempts are dropped', () => {
    const c = clock();
    const limiter = new BackoffLimiter({ ...options, maxKeys: 2, now: c.now });
    for (let i = 0; i < 3; i++) limiter.tryAcquire('victim'); // reached the first level
    c.advance(1_000); // its delay elapsed: it is no longer "blocking" but keeps its level
    limiter.tryAcquire('junk1');
    limiter.tryAcquire('junk2');
    limiter.tryAcquire('junk3'); // flooding with junk keys must not reset 'victim'
    limiter.tryAcquire('junk4');
    // 'victim' still escalates from its retained level (4th attempt => 2 s), not from scratch.
    expect(limiter.tryAcquire('victim')).toBe(0);
    expect(limiter.tryAcquire('victim')).toBe(2_000);
  });

  it('expired (idle) entries are reclaimed', () => {
    const c = clock();
    const limiter = new BackoffLimiter({ ...options, maxKeys: 1, now: c.now });
    for (let i = 0; i < 3; i++) limiter.tryAcquire('old');
    c.advance(61_000);
    limiter.tryAcquire('new'); // triggers eviction; 'old' is idle-expired
    expect(limiter.tryAcquire('old')).toBe(0);
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

describe('LoginRateLimiter (device budget)', () => {
  it('a device has its own budget: 5 attempts, then only that device is locked out for 15 min', () => {
    const c = clock();
    const limiter = new LoginRateLimiter({ now: c.now });
    for (let i = 0; i < 5; i++)
      expect(limiter.acquire('alice', 'unknown', 'dev-1').allowed).toBe(true);
    const locked = limiter.acquire('alice', 'unknown', 'dev-1');
    expect(!locked.allowed && locked.retryAfterMs).toBe(15 * 60_000);
    expect(limiter.acquire('alice', 'unknown', 'dev-2').allowed).toBe(true); // another device
    c.advance(15 * 60_000);
    expect(limiter.acquire('alice', 'unknown', 'dev-1').allowed).toBe(true);
  });

  it('is independent of the shared budgets in both directions', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 100; i++) limiter.acquire('alice', 'unknown'); // attacker at the cap
    for (let i = 0; i < 100; i++) limiter.acquire('alice', '9.9.9.9');
    expect(limiter.acquire('alice', 'unknown', 'dev-1').allowed).toBe(true);
    expect(limiter.acquire('alice', '9.9.9.9', 'dev-1').allowed).toBe(true);
    for (let i = 0; i < 10; i++) limiter.acquire('bob', 'unknown', 'dev-b'); // device lock ...
    expect(limiter.acquire('bob', 'unknown').allowed).toBe(true); // ... does not lock the shared path
  });

  it('success clears the device counter', () => {
    const limiter = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 4; i++) limiter.acquire('alice', 'unknown', 'dev-1');
    const ok = limiter.acquire('alice', 'unknown', 'dev-1');
    if (!ok.allowed) throw new Error('expected allowed');
    ok.succeed();
    for (let i = 0; i < 5; i++)
      expect(limiter.acquire('alice', 'unknown', 'dev-1').allowed).toBe(true);
  });
});
