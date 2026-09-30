import { addDays } from '@waddlers/domain';
import { purgeAllExpiredSessions } from '../auth/sessions';
import type { Database } from '../db/create';
import { isRefreshWindow } from './market-hours';
import { earliestBarDate, findListingRef, heldListingIds, loadListingRefs } from './repository';
import type { MarketDataRuntime } from './runtime';
import type { ListingRef } from './types';
import type { RefreshOutcome } from './service';

/** Refresh quotes only when the stored one is older than this share of the TTL (tick jitter). */
const QUOTE_TICK_MAX_AGE_SHARE = 0.9;

export interface JobContext {
  db: Database;
  runtime: MarketDataRuntime;
  /** Set on shutdown: loops stop between listings. */
  signal?: AbortSignal;
}

export type OutcomeCounts = Record<RefreshOutcome, number>;

function count(outcomes: Iterable<RefreshOutcome>): OutcomeCounts {
  const counts: OutcomeCounts = { refreshed: 0, skipped_fresh: 0, skipped_backoff: 0, failed: 0 };
  for (const o of outcomes) counts[o] += 1;
  return counts;
}

async function heldRefs(ctx: JobContext): Promise<ListingRef[]> {
  const ids = await heldListingIds(ctx.db);
  return loadListingRefs(ctx.db, { provider: ctx.runtime.provider.name, ids });
}

/**
 * Quote refresh (every 15 min): HELD listings only (present in a space position) whose
 * exchange is inside its refresh window. Metrics of refreshed listings are recomputed by the
 * service hook. Safe to repeat: fresh quotes and listings in backoff are skipped.
 */
export async function refreshHeldQuotes(
  ctx: JobContext,
  options: { now?: Date; ignoreHours?: boolean; maxAgeMs?: number } = {},
): Promise<{ held: number; inWindow: number; outcomes: OutcomeCounts }> {
  const now = options.now ?? ctx.runtime.clock();
  const refs = await heldRefs(ctx);
  const inWindow = options.ignoreHours
    ? refs
    : refs.filter((r) => isRefreshWindow(now, { mic: r.mic, timezone: r.timezone }));
  const maxAgeMs =
    options.maxAgeMs ?? Math.floor(ctx.runtime.config.quoteTtlMs * QUOTE_TICK_MAX_AGE_SHARE);
  const outcomes = await ctx.runtime.service.refreshQuotes(inWindow, { maxAgeMs });
  return { held: refs.length, inWindow: inWindow.length, outcomes: count(outcomes.values()) };
}

export interface NightlyResult {
  history: OutcomeCounts;
  fx: RefreshOutcome;
  metrics: number;
  purgedSessions: number;
}

/**
 * Nightly job: incremental history for held listings, then FX (reaching back to the oldest
 * stored close), then metrics for every held listing, then the global expired-session purge.
 */
export async function runNightly(
  ctx: JobContext,
  options: { maxAgeMs?: number } = {},
): Promise<NightlyResult> {
  const refs = await heldRefs(ctx);
  const history = await refreshHistoryFor(ctx, refs, options);
  const fx = await refreshFxFor(
    ctx,
    refs.map((r) => r.id),
    options,
  );
  const { computed } = await ctx.runtime.recomputeMetrics(refs.map((r) => r.id));
  const purgedSessions = await purgeAllExpiredSessions(ctx.db, ctx.runtime.clock());
  return { history, fx, metrics: computed, purgedSessions };
}

export async function refreshHistoryFor(
  ctx: JobContext,
  refs: readonly ListingRef[],
  options: { maxAgeMs?: number } = {},
): Promise<OutcomeCounts> {
  const outcomes: RefreshOutcome[] = [];
  for (const ref of refs) {
    if (ctx.signal?.aborted) break;
    outcomes.push(
      await ctx.runtime.service.refreshHistory(ref, {
        ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
      }),
    );
  }
  return count(outcomes);
}

/** FX must reach back to the oldest close of the given listings (13 months at least). */
export async function refreshFxFor(
  ctx: JobContext,
  listingIds: readonly string[],
  options: { maxAgeMs?: number } = {},
): Promise<RefreshOutcome> {
  const earliest = await earliestBarDate(ctx.db, listingIds);
  const needFrom = earliest ? addDays(earliest, -10) : undefined;
  return ctx.runtime.service.refreshFx({
    ...(needFrom ? { needFrom } : {}),
    ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
  });
}

export type MarketScope = 'quotes' | 'history' | 'fx' | 'metrics';

export interface RefreshReport {
  quotes?: OutcomeCounts;
  history?: OutcomeCounts;
  fx?: RefreshOutcome;
  metrics?: number;
  listings: number;
}

/**
 * Operator refresh (`market:refresh`). Forces past the TTLs (maxAge 0) but still honors the
 * backoff/negative cache and the daily quota. Targets one listing or every held listing.
 */
export async function refreshMarket(
  ctx: JobContext,
  options: { scopes: readonly MarketScope[]; listing?: { symbol: string; mic: string } },
): Promise<RefreshReport> {
  let refs: ListingRef[];
  if (options.listing) {
    const ref = await findListingRef(
      ctx.db,
      ctx.runtime.provider.name,
      options.listing.symbol,
      options.listing.mic,
    );
    if (!ref) throw new Error('Unknown listing');
    refs = [ref];
  } else refs = await heldRefs(ctx);

  const report: RefreshReport = { listings: refs.length };
  const want = new Set(options.scopes);
  if (want.has('history')) report.history = await refreshHistoryFor(ctx, refs, { maxAgeMs: 0 });
  if (want.has('fx'))
    report.fx = await refreshFxFor(
      ctx,
      refs.map((r) => r.id),
      { maxAgeMs: 0 },
    );
  if (want.has('quotes')) {
    const outcomes = await ctx.runtime.service.refreshQuotes(refs, { maxAgeMs: 0 });
    report.quotes = count(outcomes.values());
  }
  if (want.has('metrics')) {
    report.metrics = (await ctx.runtime.recomputeMetrics(refs.map((r) => r.id))).computed;
  }
  return report;
}
