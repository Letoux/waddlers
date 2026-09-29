export interface RateLimitOptions {
  /** Attempts allowed inside the window; the next one is blocked. */
  maxFailures: number;
  windowMs: number;
  /** Soft cap on tracked keys (memory); only non-blocking keys are ever evicted. */
  maxKeys?: number;
  now?: () => number;
}

/**
 * In-memory fixed-window counter per key. Attempts are RESERVED synchronously before any
 * `await` (concurrent requests cannot all slip under the budget) and refunded on success.
 * Single-instance only (D13): per process, reset on restart.
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

  /** Counts one attempt (synchronous). */
  record(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry && entry.resetAt > now) {
      entry.count += 1;
      return;
    }
    this.entries.delete(key);
    if (this.entries.size >= this.maxKeys) this.evict(now);
    this.entries.set(key, { count: 1, resetAt: now + this.options.windowMs });
  }

  /** Gives back one attempt (a reserved attempt that succeeded). */
  refund(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) this.entries.delete(key);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Eviction policy (memory bound, soft cap). Expired windows go first; then only keys still
   * UNDER their budget, oldest first (their loss forgives at most `maxFailures - 1` attempts).
   * A key at its budget (blocking) is never evicted, so an attacker cannot flush a lock by
   * flooding other keys; because reaching the budget costs `maxFailures` attempts per key, the
   * map can only exceed the soft cap proportionally to real attack effort.
   */
  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size < this.maxKeys) break;
      if (entry.count < this.options.maxFailures) this.entries.delete(key);
    }
  }
}

export interface BackoffOptions {
  freeAttempts: number;
  baseMs: number;
  capMs: number;
  /** A key idle for this long starts over. */
  idleResetMs: number;
  maxKeys?: number;
  now?: () => number;
}

/**
 * Progressive delay per key (used when the client IP is unknown, so only the username is
 * available): the first `freeAttempts` are free, then each attempt is followed by a wait that
 * doubles up to a small cap. Bounded lock-out for a victim, hard ceiling on guessing rate.
 */
export class BackoffLimiter {
  private readonly entries = new Map<
    string,
    { count: number; lastAt: number; blockedUntil: number }
  >();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(private readonly options: BackoffOptions) {
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Reserves an attempt (synchronous). Returns 0 if allowed, else ms to wait (not counted). */
  tryAcquire(key: string): number {
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry && now - entry.lastAt > this.options.idleResetMs) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (entry && now < entry.blockedUntil) return entry.blockedUntil - now;
    if (!entry && this.entries.size >= this.maxKeys) this.evict(now);
    const count = (entry?.count ?? 0) + 1;
    const excess = count - this.options.freeAttempts;
    const delay =
      excess >= 0
        ? Math.min(this.options.capMs, this.options.baseMs * 2 ** Math.min(excess, 20))
        : 0;
    this.entries.set(key, { count, lastAt: now, blockedUntil: delay > 0 ? now + delay : 0 });
    return 0;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Eviction policy (soft cap): entries idle past `idleResetMs` expire naturally first; then
   * only entries still under their free attempts are dropped, oldest first. Entries that reached
   * a backoff level KEEP it (never evicted early): otherwise flooding the map with junk usernames
   * would reset the delay of the username being attacked. Reaching a level costs
   * `freeAttempts` requests per key inside the idle window, so growth beyond the soft cap tracks
   * real attack effort (bounded by the request rate x 15 min); acceptable for one instance (D13).
   */
  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAt > this.options.idleResetMs) this.entries.delete(key);
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size < this.maxKeys) break;
      if (entry.count < this.options.freeAttempts) this.entries.delete(key);
    }
  }
}

export type Reservation =
  | { allowed: false; retryAfterMs: number }
  | {
      allowed: true;
      /** Call when the attempt turned out to be legitimate. */ succeed: () => void;
    };

/**
 * Login/changePassword throttling.
 * - Known client IP: 5 attempts per (username, IP) and 20 per username per 15 minutes, hard
 *   block afterwards (the per-username cap holds even if forwarded-IP headers are spoofed).
 * - A verified device cookie switches to a per-device budget (5 attempts, then that device only
 *   is locked out for 15 minutes) and skips both shared paths below.
 * - Unknown IP (no trusted proxy header configured): every client looks alike, so a pair limit
 *   would let anonymous failures lock a user out for everyone. Only a per-username progressive
 *   delay applies (5 free attempts, then 2 s doubling to 60 s).
 * `acquire` reserves the attempt synchronously; a blocked request is not counted.
 */
export class LoginRateLimiter {
  private readonly perPair: FailureLimiter;
  private readonly perUser: FailureLimiter;
  private readonly backoff: BackoffLimiter;
  private readonly perDevice: FailureLimiter;

  constructor(options: { now?: () => number } = {}) {
    const now = options.now ? { now: options.now } : {};
    const windowMs = 15 * 60_000;
    this.perPair = new FailureLimiter({ windowMs, maxFailures: 5, ...now });
    this.perUser = new FailureLimiter({ windowMs, maxFailures: 20, ...now });
    // Per device: 5 attempts, then only that device is locked out for the rest of the window.
    this.perDevice = new FailureLimiter({ windowMs, maxFailures: 5, ...now });
    this.backoff = new BackoffLimiter({
      freeAttempts: 5,
      baseMs: 2_000,
      capMs: 60_000,
      idleResetMs: windowMs,
      ...now,
    });
  }

  /**
   * `deviceId` is the id of a VERIFIED device cookie for this username (see device.ts). It
   * bypasses the shared budgets entirely and uses its own, so a legitimate browser keeps
   * working while an attacker exhausts the shared per-username budget.
   */
  acquire(username: string, ip: string, deviceId?: string): Reservation {
    const user = username.trim().toLowerCase();
    if (deviceId) {
      const key = `${user}|${deviceId}`;
      const wait = this.perDevice.blockedFor(key);
      if (wait > 0) return { allowed: false, retryAfterMs: wait };
      this.perDevice.record(key);
      return { allowed: true, succeed: () => this.perDevice.reset(key) };
    }
    if (ip === 'unknown') {
      const wait = this.backoff.tryAcquire(user);
      if (wait > 0) return { allowed: false, retryAfterMs: wait };
      return { allowed: true, succeed: () => this.backoff.reset(user) };
    }
    const pair = `${user}|${ip}`;
    const wait = Math.max(this.perPair.blockedFor(pair), this.perUser.blockedFor(user));
    if (wait > 0) return { allowed: false, retryAfterMs: wait };
    this.perPair.record(pair);
    this.perUser.record(user);
    return {
      allowed: true,
      succeed: () => {
        this.perPair.reset(pair);
        this.perUser.refund(user);
      },
    };
  }
}
