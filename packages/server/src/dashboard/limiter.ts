export interface DashboardLimiterOptions {
  /** Requests of one user allowed to run at the same time. */
  maxConcurrent: number;
  /** Sustained rate per user (token bucket, capacity = one minute of it). */
  ratePerMinute: number;
  /** Soft cap on tracked users (memory); only idle users with a full bucket are evicted. */
  maxKeys?: number;
  now?: () => number;
}

export type Admission =
  { allowed: true; release: () => void } | { allowed: false; retryAfterMs: number };

export const DASHBOARD_MAX_CONCURRENT = 2;
export const DASHBOARD_RATE_PER_MINUTE = 30;

interface Entry {
  tokens: number;
  updatedAt: number;
  inFlight: number;
}

/**
 * Per-user admission for the heavy dashboard procedures (summary, history; `max` on 25 years x 50
 * positions costs about 0.6 s of CPU): at most `maxConcurrent` in flight, and a token bucket of
 * `ratePerMinute`. Keyed by the authenticated USER id (never by space or IP), so one user cannot
 * slow another, whatever the spaces they share. The decision is synchronous (no await between the
 * check and the reservation), so concurrent requests cannot all slip under the cap. In-memory,
 * single instance (D13): reset on restart, like the auth limiters. No response is cached here.
 */
export class DashboardLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(private readonly options: DashboardLimiterOptions) {
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  acquire(userId: string): Admission {
    const now = this.now();
    const entry = this.entryFor(userId, now);
    if (entry.inFlight >= this.options.maxConcurrent) {
      // A request is running: it is expected to finish within about a second.
      return { allowed: false, retryAfterMs: 1_000 };
    }
    if (entry.tokens < 1) {
      const perMs = this.options.ratePerMinute / 60_000;
      return { allowed: false, retryAfterMs: Math.ceil((1 - entry.tokens) / perMs) };
    }
    entry.tokens -= 1;
    entry.inFlight += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        entry.inFlight -= 1;
      },
    };
  }

  private entryFor(userId: string, now: number): Entry {
    const capacity = this.options.ratePerMinute;
    let entry = this.entries.get(userId);
    if (entry === undefined) {
      if (this.entries.size >= this.maxKeys) this.evict(now);
      entry = { tokens: capacity, updatedAt: now, inFlight: 0 };
      this.entries.set(userId, entry);
      return entry;
    }
    entry.tokens = Math.min(capacity, entry.tokens + ((now - entry.updatedAt) * capacity) / 60_000);
    entry.updatedAt = now;
    return entry;
  }

  /** Drops users with nothing running and a full bucket (forgetting them changes nothing for them). */
  private evict(now: number): void {
    const capacity = this.options.ratePerMinute;
    for (const [key, entry] of this.entries) {
      const tokens = entry.tokens + ((now - entry.updatedAt) * capacity) / 60_000;
      if (entry.inFlight === 0 && tokens >= capacity) this.entries.delete(key);
    }
  }
}

export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
