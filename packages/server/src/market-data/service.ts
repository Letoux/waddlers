import { addDays, compareDates, type PlainDate } from '@waddlers/domain';
import type { Database } from '../db/create';
import { describeError } from '../errors';
import { normalizeCurrency } from '@waddlers/domain';
import { backoffMs, type MarketDataConfig } from './config';
import { localDate, utcDate } from './dates';
import { FX_LIMIT, toPositiveDecimalString } from './normalize';
import {
  barDateBounds,
  loadListingRefs,
  readBars,
  readFetchState,
  readFetchStates,
  readQuotes,
  recordFailures,
  recordSuccess,
  recordSuccesses,
  upsertBars,
  upsertFxRates,
  upsertQuotes,
  fxLatestPerCurrency,
  type StoredBar,
  type StoredQuote,
} from './repository';
import {
  silentLogger,
  type Clock,
  type FxProvider,
  type ListingRef,
  type MarketDataProvider,
  type MarketLogger,
  type ProviderErrorCode,
} from './types';

/** Start of "full history" requests: earlier than any listing, so `reachedStart` is decided by the provider. */
export const FULL_HISTORY_FROM: PlainDate = '1970-01-01';
/** ECB publishes since 1999-01-04. */
const EARLIEST_FX_DATE: PlainDate = '1999-01-04';
/** Default FX horizon when nothing else needs older rates. */
const DEFAULT_FX_LOOKBACK_DAYS = 400;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export type Freshness = 'fresh' | 'stale' | 'unavailable';

/**
 * What every read returns: the value (or null, NEVER a placeholder 0), how old it is
 * (`fetchedAt` = when we stored it, `asOf` = provider validity time) and where it came from.
 */
export interface Served<T> {
  data: T | null;
  freshness: Freshness;
  /**
   * Provider validity instant. For date-precision data (history, FX) it is UTC midnight of
   * `asOfDate`: format `asOfDate` (a plain calendar date), never this instant in a local timezone.
   */
  asOf: Date | null;
  /** Calendar date of the data for history/FX (no timezone shift possible); null for quotes. */
  asOfDate: PlainDate | null;
  source: string | null;
  fetchedAt: Date | null;
}

export interface ServedQuote {
  price: string;
  currency: string;
}
export interface ServedHistory {
  bars: StoredBar[];
  /** Date of the first stored close once the full history is stored; null = unknown (D14). */
  historyCompleteFrom: PlainDate | null;
}
export interface ServedFx {
  rates: { currency: string; date: PlainDate; ratePerEur: string }[];
}

export type RefreshOutcome = 'refreshed' | 'skipped_fresh' | 'skipped_backoff' | 'failed';

export interface RefreshOptions {
  /** Treat stored data younger than this as fresh (default: the TTL). */
  maxAgeMs?: number;
}

export interface MarketDataDeps {
  db: Database;
  provider: MarketDataProvider;
  fx: FxProvider;
  config: MarketDataConfig;
  clock?: Clock;
  logger?: MarketLogger;
  /** Called after listings got new data (e.g. to recompute `listing_metrics`). Errors are logged, never thrown. */
  onListingsUpdated?: (listingIds: string[]) => Promise<void>;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The single entry point to market data: nothing else calls a provider (CLAUDE.md section 4).
 * Reads NEVER trigger a synchronous provider call for data that exists in Postgres:
 * fresh -> return; stale -> return + background refresh; missing -> one bounded blocking fetch.
 * Refreshes are single-flight per key, safe to repeat, and never bump `fetched_at` on failure.
 */
export class MarketDataService {
  private readonly db: Database;
  private readonly provider: MarketDataProvider;
  private readonly fx: FxProvider;
  private readonly config: MarketDataConfig;
  private readonly clock: Clock;
  private readonly log: MarketLogger;
  private readonly inflight = new Map<string, Promise<RefreshOutcome>>();
  private readonly background = new Set<Promise<unknown>>();

  constructor(private readonly deps: MarketDataDeps) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.fx = deps.fx;
    this.config = deps.config;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.logger ?? silentLogger;
  }

  /** Resolves when every background refresh started so far has settled (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  private track<T>(promise: Promise<T>): void {
    this.background.add(promise);
    void promise.finally(() => this.background.delete(promise));
  }

  private logFailure(message: string, error: unknown): void {
    // describeError never includes the message text (drivers embed parameters/URLs there).
    this.log.error(message, { error: describeError(error) });
  }

  // ---- reads (SWR) --------------------------------------------------------------------

  async getQuote(listingId: string): Promise<Served<ServedQuote>> {
    const now = this.clock();
    const stored = (await readQuotes(this.db, [listingId])).get(listingId);
    if (stored) {
      const fresh = now.getTime() - stored.fetchedAt.getTime() < this.config.quoteTtlMs;
      if (!fresh) this.startBackgroundQuoteRefresh(listingId);
      return this.servedQuote(stored, fresh ? 'fresh' : 'stale');
    }
    await this.blocking(() => this.refreshQuotesById([listingId]).then((m) => m.get(listingId)));
    const after = (await readQuotes(this.db, [listingId])).get(listingId);
    return after ? this.servedQuote(after, 'fresh') : unavailable();
  }

  async getDailyHistory(listingId: string): Promise<Served<ServedHistory>> {
    const now = this.clock();
    const read = async () => {
      const [bars, state] = await Promise.all([
        readBars(this.db, listingId),
        readFetchState(this.db, listingId, 'history'),
      ]);
      return { bars, state };
    };
    const stored = await read();
    if (stored.bars.length > 0) {
      const last = stored.bars[stored.bars.length - 1]!;
      const fetchedAt = stored.state?.lastSuccessAt ?? last.fetchedAt;
      const fresh = now.getTime() - fetchedAt.getTime() < this.config.historyTtlMs;
      if (!fresh) this.startBackground(() => this.refreshHistoryById(listingId));
      return this.servedHistory(
        stored.bars,
        stored.state?.historyCompleteFrom ?? null,
        fetchedAt,
        fresh,
      );
    }
    await this.blocking(() => this.refreshHistoryById(listingId));
    const after = await read();
    if (after.bars.length === 0) return unavailable();
    const fetchedAt = after.state?.lastSuccessAt ?? after.bars[after.bars.length - 1]!.fetchedAt;
    return this.servedHistory(
      after.bars,
      after.state?.historyCompleteFrom ?? null,
      fetchedAt,
      true,
    );
  }

  async getLatestFx(): Promise<Served<ServedFx>> {
    const now = this.clock();
    const [rates, state] = await Promise.all([
      fxLatestPerCurrency(this.db),
      readFetchState(this.db, null, 'fx'),
    ]);
    if (rates.length > 0) {
      const fetchedAt = state?.lastSuccessAt ?? rates[0]!.fetchedAt;
      const fresh = now.getTime() - fetchedAt.getTime() < this.config.fxTtlMs;
      if (!fresh) this.startBackground(() => this.refreshFx());
      return servedFx(rates, fetchedAt, fresh ? 'fresh' : 'stale');
    }
    await this.blocking(() => this.refreshFx());
    const after = await fxLatestPerCurrency(this.db);
    if (after.length === 0) return unavailable();
    return servedFx(
      after,
      (await readFetchState(this.db, null, 'fx'))?.lastSuccessAt ?? after[0]!.fetchedAt,
      'fresh',
    );
  }

  private servedQuote(q: StoredQuote, freshness: Freshness): Served<ServedQuote> {
    return {
      data: { price: q.price, currency: q.currency },
      freshness,
      asOf: q.asOf,
      asOfDate: null,
      source: q.source,
      fetchedAt: q.fetchedAt,
    };
  }

  private servedHistory(
    bars: StoredBar[],
    historyCompleteFrom: PlainDate | null,
    fetchedAt: Date,
    fresh: boolean,
  ): Served<ServedHistory> {
    const last = bars[bars.length - 1]!;
    return {
      data: { bars, historyCompleteFrom },
      freshness: fresh ? 'fresh' : 'stale',
      // Validity of the series = its last trading day (date precision).
      asOf: new Date(`${last.date}T00:00:00Z`),
      asOfDate: last.date,
      source: last.source,
      fetchedAt,
    };
  }

  /** One bounded wait for a missing value; the refresh keeps running (and persists) after it. */
  private async blocking(start: () => Promise<unknown>): Promise<void> {
    const work = start().catch((error: unknown) => {
      this.logFailure('market-data blocking refresh failed', error);
    });
    this.track(work);
    await withTimeout(work, this.config.blockingFetchMs);
  }

  private startBackground(start: () => Promise<unknown>): void {
    this.track(
      start().catch((error: unknown) =>
        this.logFailure('market-data background refresh failed', error),
      ),
    );
  }

  private startBackgroundQuoteRefresh(listingId: string): void {
    this.startBackground(() => this.refreshQuotesById([listingId]));
  }

  // ---- refreshes (single-flight, idempotent) ------------------------------------------

  async refreshQuotesById(ids: readonly string[], options: RefreshOptions = {}) {
    const refs = await loadListingRefs(this.db, { provider: this.provider.name, ids });
    return this.refreshQuotes(refs, options);
  }

  /**
   * One provider call for all listings that are neither fresh, in backoff, nor already being
   * fetched. Listings already in flight are joined, not fetched twice.
   */
  async refreshQuotes(
    refs: readonly ListingRef[],
    options: RefreshOptions = {},
  ): Promise<Map<string, RefreshOutcome>> {
    // Registration must be synchronous (no await before inflight.set) or two callers could both start.
    const key = (id: string) => `quote:${id}`;
    const mine = refs.filter((r) => !this.inflight.has(key(r.id)));
    const batch = mine.length > 0 ? this.runQuoteBatch(mine, options) : null;
    const promises = new Map<string, Promise<RefreshOutcome>>();
    for (const ref of refs) {
      const existing = this.inflight.get(key(ref.id));
      if (existing) {
        promises.set(ref.id, existing);
        continue;
      }
      const p = batch!
        .then((m) => m.get(ref.id) ?? ('failed' as const))
        .finally(() => this.inflight.delete(key(ref.id)));
      this.inflight.set(key(ref.id), p);
      promises.set(ref.id, p);
    }
    const outcomes = new Map<string, RefreshOutcome>();
    for (const [id, p] of promises) outcomes.set(id, await p);
    return outcomes;
  }

  private async runQuoteBatch(
    refs: readonly ListingRef[],
    options: RefreshOptions,
  ): Promise<Map<string, RefreshOutcome>> {
    const outcomes = new Map<string, RefreshOutcome>();
    let providerOk = false;
    try {
      const now = this.clock();
      const ids = refs.map((r) => r.id);
      const [stored, states] = await Promise.all([
        readQuotes(this.db, ids),
        readFetchStates(this.db, ids, 'quote'),
      ]);
      const maxAge = options.maxAgeMs ?? this.config.quoteTtlMs;
      const todo: ListingRef[] = [];
      for (const ref of refs) {
        const q = stored.get(ref.id);
        const st = states.get(ref.id);
        if (q && now.getTime() - q.fetchedAt.getTime() < maxAge)
          outcomes.set(ref.id, 'skipped_fresh');
        else if (st?.nextRetryAt && st.nextRetryAt.getTime() > now.getTime())
          outcomes.set(ref.id, 'skipped_backoff');
        else todo.push(ref);
      }
      if (todo.length === 0) return outcomes;

      const result = await this.provider.getQuotes(todo);
      const at = this.clock();
      if (!result.ok) {
        await this.failMany(
          'quote',
          at,
          todo.map((r) => ({ listingId: r.id, code: result.code })),
        );
        for (const ref of todo) outcomes.set(ref.id, 'failed');
        return outcomes;
      }
      providerOk = true;
      const byId = new Map(todo.map((r) => [r.id, r]));
      const valid = result.data.quotes.flatMap((q) => {
        const ref = byId.get(q.listingId);
        // Defence in depth (adapters already normalize): never store a quote in another
        // currency, from the future, or with a price that would round/overflow the column.
        const price = toPositiveDecimalString(q.price);
        return ref !== undefined &&
          price !== null &&
          q.currency === ref.currency &&
          q.asOf.getTime() <= at.getTime() + MAX_FUTURE_SKEW_MS
          ? [{ ...q, price }]
          : [];
      });
      await upsertQuotes(this.db, valid, { source: result.source, fetchedAt: at });
      const good = new Set(valid.map((q) => q.listingId));
      await recordSuccesses(this.db, [...good], 'quote', at);
      for (const id of good) outcomes.set(id, 'refreshed');
      const rejected = new Map(result.data.rejected.map((r) => [r.listingId, r.code]));
      const bad = todo.filter((ref) => !good.has(ref.id));
      await this.failMany(
        'quote',
        at,
        bad.map((ref) => ({ listingId: ref.id, code: rejected.get(ref.id) ?? 'not_found' })),
      );
      for (const ref of bad) outcomes.set(ref.id, 'failed');
      await this.notify([...good]);
    } catch (error) {
      this.logFailure('market-data quote refresh failed', error);
      // After a successful provider call a persist error is deterministic for this payload:
      // back off instead of re-fetching (and re-paying for) it on every tick.
      if (providerOk)
        await this.failManyBestEffort(
          'quote',
          refs
            .filter((r) => !outcomes.has(r.id))
            .map((r) => ({ listingId: r.id, code: 'bad_payload' })),
        );
      for (const ref of refs) if (!outcomes.has(ref.id)) outcomes.set(ref.id, 'failed');
    }
    return outcomes;
  }

  async refreshHistoryById(
    listingId: string,
    options: RefreshOptions = {},
  ): Promise<RefreshOutcome> {
    const [ref] = await loadListingRefs(this.db, {
      provider: this.provider.name,
      ids: [listingId],
    });
    return ref ? this.refreshHistory(ref, options) : 'failed';
  }

  /**
   * Full backfill when nothing successful is stored, otherwise incremental: re-pull the last
   * `incrementalOverlapDays` days (late corrections; upserts make it idempotent).
   */
  refreshHistory(ref: ListingRef, options: RefreshOptions = {}): Promise<RefreshOutcome> {
    return this.singleFlight(`history:${ref.id}`, () => this.runHistory(ref, options));
  }

  private async runHistory(ref: ListingRef, options: RefreshOptions): Promise<RefreshOutcome> {
    let providerOk = false;
    try {
      const now = this.clock();
      const state = await readFetchState(this.db, ref.id, 'history');
      const maxAge = options.maxAgeMs ?? this.config.historyTtlMs;
      if (state?.lastSuccessAt && now.getTime() - state.lastSuccessAt.getTime() < maxAge)
        return 'skipped_fresh';
      if (state?.nextRetryAt && state.nextRetryAt.getTime() > now.getTime())
        return 'skipped_backoff';

      const bounds = await barDateBounds(this.db, ref.id);
      const full = bounds.last === null || state?.lastSuccessAt == null;
      const to = localDate(now, ref.timezone);
      const from = full
        ? FULL_HISTORY_FROM
        : addDays(bounds.last!, -this.config.incrementalOverlapDays);
      const result = await this.provider.getDailyHistory(ref, from, to);
      const at = this.clock();
      if (!result.ok) {
        await this.fail(ref.id, 'history', at, result.code);
        return 'failed';
      }
      providerOk = true;
      // Same rule as the quote path: never store bars quoted in another currency than the listing.
      if (!sameQuotedCurrency(result.data.currency, ref.currency)) {
        await this.fail(ref.id, 'history', at, 'bad_payload');
        return 'failed';
      }
      // Defence in depth: adapters already normalize. Row-level drop, never a whole-batch failure:
      // no future day, and no close/adj_close that would round or overflow the column.
      const bars = result.data.bars.flatMap((b) => {
        const close = toPositiveDecimalString(b.close);
        if (close === null || compareDates(b.date, to) > 0) return [];
        return [{ ...b, close, adjClose: toPositiveDecimalString(b.adjClose) }];
      });
      if (full && bars.length === 0) {
        await this.fail(ref.id, 'history', at, 'not_found');
        return 'failed';
      }
      await this.db.transaction(async (tx) => {
        await upsertBars(tx, ref, bars, { source: result.source, fetchedAt: at });
        // Complete only when the provider says the series starts at ITS earliest data.
        const bounds = full && result.data.reachedStart ? await barDateBounds(tx, ref.id) : null;
        await recordSuccess(tx, ref.id, 'history', at, {
          historyCompleteFrom: bounds?.first ?? null,
        });
      });
      await this.notify([ref.id]);
      return 'refreshed';
    } catch (error) {
      this.logFailure('market-data history refresh failed', error);
      if (providerOk)
        await this.failManyBestEffort('history', [{ listingId: ref.id, code: 'bad_payload' }]);
      return 'failed';
    }
  }

  /**
   * FX: (re)fills EUR-based rates from `needFrom` (default: ~13 months back). A backfill happens
   * when stored rates do not reach back to `needFrom`, otherwise only a short overlap is pulled.
   */
  refreshFx(options: RefreshOptions & { needFrom?: PlainDate } = {}): Promise<RefreshOutcome> {
    return this.singleFlight('fx', () => this.runFx(options));
  }

  private async runFx(options: RefreshOptions & { needFrom?: PlainDate }): Promise<RefreshOutcome> {
    let providerOk = false;
    try {
      const now = this.clock();
      const today = utcDate(now);
      let needFrom = options.needFrom ?? addDays(today, -DEFAULT_FX_LOOKBACK_DAYS);
      if (compareDates(needFrom, EARLIEST_FX_DATE) < 0) needFrom = EARLIEST_FX_DATE;
      const state = await readFetchState(this.db, null, 'fx');
      const coversNeed =
        state?.historyCompleteFrom != null &&
        compareDates(state.historyCompleteFrom, needFrom) <= 0;
      const maxAge = options.maxAgeMs ?? this.config.fxTtlMs;
      if (
        coversNeed &&
        state?.lastSuccessAt &&
        now.getTime() - state.lastSuccessAt.getTime() < maxAge
      )
        return 'skipped_fresh';
      if (state?.nextRetryAt && state.nextRetryAt.getTime() > now.getTime())
        return 'skipped_backoff';

      let from = needFrom;
      if (coversNeed) {
        const latest = (await fxLatestPerCurrency(this.db)).reduce<PlainDate | null>(
          (max, r) => (max === null || compareDates(r.date, max) > 0 ? r.date : max),
          null,
        );
        if (latest !== null) from = addDays(latest, -this.config.incrementalOverlapDays);
      }
      const result = await this.fx.getDailyRates(from, today);
      const at = this.clock();
      if (!result.ok) {
        await this.fail(null, 'fx', at, result.code);
        return 'failed';
      }
      providerOk = true;
      // Row-level defence in depth: a rate that would round/overflow numeric(20,10) is dropped.
      const rates = result.data.rates.flatMap((r) => {
        const ratePerEur = toPositiveDecimalString(r.ratePerEur, FX_LIMIT);
        return ratePerEur === null ? [] : [{ ...r, ratePerEur }];
      });
      if (rates.length === 0) {
        await this.fail(null, 'fx', at, 'not_found');
        return 'failed';
      }
      await this.db.transaction(async (tx) => {
        await upsertFxRates(tx, rates, { source: result.source, fetchedAt: at });
        // A backfill (from == needFrom) proves coverage from there on.
        await recordSuccess(tx, null, 'fx', at, {
          historyCompleteFrom: from === needFrom ? needFrom : null,
        });
      });
      return 'refreshed';
    } catch (error) {
      this.logFailure('market-data FX refresh failed', error);
      if (providerOk)
        await this.failManyBestEffort('fx', [{ listingId: null, code: 'bad_payload' }]);
      return 'failed';
    }
  }

  // ---- internals ----------------------------------------------------------------------

  private singleFlight(key: string, run: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Records one failed attempt (negative cache + exponential backoff). */
  private fail(
    listingId: string | null,
    kind: 'quote' | 'history' | 'fx',
    at: Date,
    code: ProviderErrorCode,
  ): Promise<void> {
    return this.failMany(kind, at, [{ listingId, code }]);
  }

  /**
   * Records failed attempts in one statement. Only the LOCAL quota refusal (`local_quota`, raised
   * by our call guard before any request) is not the listing's fault: nothing is recorded and
   * the next call simply asks the quota again. An UPSTREAM `quota_exceeded` (the provider itself
   * refused after a real request) does back off like any other failure.
   */
  private async failMany(
    kind: 'quote' | 'history' | 'fx',
    at: Date,
    entries: readonly { listingId: string | null; code: ProviderErrorCode }[],
  ): Promise<void> {
    const recorded = entries.filter((e) => e.code !== 'local_quota');
    if (recorded.length === 0) return;
    await recordFailures(
      this.db,
      kind,
      at,
      recorded.map((e) => ({ listingId: e.listingId, errorCode: e.code })),
      this.config,
    );
    for (const e of recorded)
      this.log.warn('market-data refresh failed', { kind, code: e.code, listingId: e.listingId });
  }

  /** Backoff after a persist error; never throws (the database may be the very problem). */
  private async failManyBestEffort(
    kind: 'quote' | 'history' | 'fx',
    entries: readonly { listingId: string | null; code: ProviderErrorCode }[],
  ): Promise<void> {
    try {
      await this.failMany(kind, this.clock(), entries);
    } catch (error) {
      this.logFailure('market-data could not record the failure', error);
    }
  }

  private async notify(ids: string[]): Promise<void> {
    if (ids.length === 0 || !this.deps.onListingsUpdated) return;
    try {
      await this.deps.onListingsUpdated(ids);
    } catch (error) {
      this.logFailure('market-data post-refresh hook failed', error);
    }
  }

  /** Exposed for the CLI status: the backoff the n-th consecutive failure would schedule. */
  backoffFor(failureCount: number): number {
    return backoffMs(this.config, failureCount);
  }
}

/**
 * Bars quoted in the listing's currency (or the same minor/major unit spelling: GBX vs GBp).
 * GBP vs GBX differ by a factor 100 and are NOT compatible.
 */
export function sameQuotedCurrency(a: string, b: string): boolean {
  if (a === b) return true;
  const x = normalizeCurrency(a);
  const y = normalizeCurrency(b);
  return x !== null && y !== null && x.currency === y.currency && x.isMinorUnit === y.isMinorUnit;
}

function unavailable<T>(): Served<T> {
  return {
    data: null,
    freshness: 'unavailable',
    asOf: null,
    asOfDate: null,
    source: null,
    fetchedAt: null,
  };
}

function servedFx(
  rates: { currency: string; date: PlainDate; ratePerEur: string; source: string }[],
  fetchedAt: Date,
  freshness: Freshness,
): Served<ServedFx> {
  const latest = rates.reduce(
    (max, r) => (compareDates(r.date, max) > 0 ? r.date : max),
    rates[0]!.date,
  );
  return {
    data: {
      rates: rates.map(({ currency, date, ratePerEur }) => ({ currency, date, ratePerEur })),
    },
    freshness,
    asOf: new Date(`${latest}T00:00:00Z`),
    asOfDate: latest,
    source: rates[0]!.source,
    fetchedAt,
  };
}
