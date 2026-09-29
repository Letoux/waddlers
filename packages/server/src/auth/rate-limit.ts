export interface RateLimitOptions {
  /** Failures allowed inside the window before blocking. */
  maxFailures: number;
  windowMs: number;
  /** Hard cap on tracked keys (memory bound); oldest entries are evicted first. */
  maxKeys?: number;
  now?: () => number;
}

/**
 * In-memory failure limiter (fixed window per key). Single-instance only (D13): counters are
 * per process and reset on restart. Multi-instance deployments need a shared store.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(private readonly options: RateLimitOptions) {
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds until the key may retry, or 0 when not blocked. */
  blockedFor(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const now = this.now();
    if (entry.resetAt <= now) {
      this.entries.delete(key);
      return 0;
    }
    return entry.count >= this.options.maxFailures ? entry.resetAt - now : 0;
  }

  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry && entry.resetAt > now) {
      entry.count += 1;
      return;
    }
    this.entries.delete(key); // re-insert to refresh Map (insertion) order
    if (this.entries.size >= this.maxKeys) this.evict(now);
    this.entries.set(key, { count: 1, resetAt: now + this.options.windowMs });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Login throttling: a tight budget per (username, ip) and a looser one per username alone, so
 * rotating spoofed client-IP headers cannot bypass the limit. Blocked attempts do not extend
 * the window. Successful login clears the (username, ip) counter only.
 */
export class LoginRateLimiter {
  private readonly perPair: FailureLimiter;
  private readonly perUser: FailureLimiter;

  constructor(options: { now?: () => number } = {}) {
    const base = { windowMs: 15 * 60_000, ...(options.now ? { now: options.now } : {}) };
    this.perPair = new FailureLimiter({ ...base, maxFailures: 5 });
    this.perUser = new FailureLimiter({ ...base, maxFailures: 20 });
  }

  private keys(username: string, ip: string) {
    const user = username.trim().toLowerCase();
    return { pair: `${user}|${ip}`, user };
  }

  /** Milliseconds to wait, 0 if the attempt may proceed. */
  check(username: string, ip: string): number {
    const { pair, user } = this.keys(username, ip);
    return Math.max(this.perPair.blockedFor(pair), this.perUser.blockedFor(user));
  }

  recordFailure(username: string, ip: string): void {
    const { pair, user } = this.keys(username, ip);
    this.perPair.recordFailure(pair);
    this.perUser.recordFailure(user);
  }

  recordSuccess(username: string, ip: string): void {
    this.perPair.reset(this.keys(username, ip).pair);
  }
}
