import { describeError } from '../errors';
import { refreshHeldQuotes, runNightly, type JobContext } from './jobs';
import type { MarketLogger } from './types';

/**
 * In-process mutual exclusion by job name. SINGLE-INSTANCE ASSUMPTION (D13): this lock does not
 * protect against two worker processes; running more than one worker needs a shared lock
 * (e.g. a Postgres advisory lock) first. Overlapping runs of the same job in one process are
 * skipped, not queued.
 */
export class JobLock {
  private readonly running = new Set<string>();

  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  async run<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.running.has(name)) return { ran: false };
    this.running.add(name);
    try {
      return { ran: true, value: await fn() };
    } finally {
      this.running.delete(name);
    }
  }
}

/** Next occurrence of HH:MM UTC strictly after `now`. */
export function nextDailyRun(now: Date, hourUtc: number, minuteUtc: number): Date {
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, minuteUtc, 0, 0),
  );
  if (candidate.getTime() <= now.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate;
}

export interface WorkerOptions {
  ctx: Omit<JobContext, 'signal'>;
  logger: MarketLogger;
  quoteIntervalMs?: number;
  nightlyAtUtc?: { hour: number; minute: number };
  /** Run both jobs once immediately (catch-up after a restart). Default true. */
  runOnStart?: boolean;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface WorkerHandle {
  /** Stops scheduling, aborts loops between listings, and waits for a running job to end. */
  stop(): Promise<void>;
  lock: JobLock;
}

export function startWorker(options: WorkerOptions): WorkerHandle {
  const { logger } = options;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const quoteEvery = options.quoteIntervalMs ?? 15 * 60_000;
  const nightlyAt = options.nightlyAtUtc ?? { hour: 3, minute: 30 };
  const abort = new AbortController();
  const lock = new JobLock();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<unknown>>();
  const ctx: JobContext = { ...options.ctx, signal: abort.signal };
  const clock = options.ctx.runtime.clock;

  const runJob = (name: string, job: () => Promise<unknown>) => {
    const p = lock
      .run(name, async () => {
        const started = Date.now();
        const result = await job();
        logger.info('worker job finished', { job: name, ms: Date.now() - started, result });
      })
      .then((r) => {
        if (!r.ran)
          logger.warn('worker job skipped: previous run still in progress', { job: name });
      })
      .catch((error: unknown) => {
        logger.error('worker job failed', { job: name, error: describeError(error) });
      });
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };

  const scheduleAt = (delayMs: number, fn: () => void) => {
    const t = setTimer(() => {
      timers.delete(t);
      if (!abort.signal.aborted) fn();
    }, delayMs);
    t.unref?.();
    timers.add(t);
  };

  const quoteLoop = () => {
    void runJob('quotes', () => refreshHeldQuotes(ctx));
    scheduleAt(quoteEvery, quoteLoop);
  };
  const nightlyLoop = () => {
    void runJob('nightly', () => runNightly(ctx));
    scheduleAt(
      nextDailyRun(clock(), nightlyAt.hour, nightlyAt.minute).getTime() - clock().getTime(),
      nightlyLoop,
    );
  };

  if (options.runOnStart ?? true) {
    // Nightly first: history/FX populate what the first quote tick will recompute metrics from.
    void runJob('nightly', () => runNightly(ctx)).then(() => {
      if (!abort.signal.aborted) quoteLoop();
    });
    scheduleAt(
      nextDailyRun(clock(), nightlyAt.hour, nightlyAt.minute).getTime() - clock().getTime(),
      nightlyLoop,
    );
  } else {
    scheduleAt(quoteEvery, quoteLoop);
    scheduleAt(
      nextDailyRun(clock(), nightlyAt.hour, nightlyAt.minute).getTime() - clock().getTime(),
      nightlyLoop,
    );
  }

  return {
    lock,
    async stop() {
      abort.abort();
      for (const t of timers) clearTimer(t);
      timers.clear();
      await ctx.runtime.service.idle();
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
