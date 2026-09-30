import { asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/create';
import { listingMetrics, listings, marketDataFetchState, providerUsage } from '../db/schema';
import { refreshMarket, type MarketScope, type RefreshReport } from '../market-data/jobs';
import type { MarketDataRuntime } from '../market-data/runtime';
import { AdminError } from './errors';
import { parseListingRef } from './spaces';

export const MARKET_SCOPES: readonly MarketScope[] = ['quotes', 'history', 'fx', 'metrics'];

/** `--quotes --history` ... -> scopes; no flag = everything. Unknown flags are rejected. */
export function parseMarketFlags(flags: readonly string[]): MarketScope[] {
  const scopes = new Set<MarketScope>();
  for (const flag of flags) {
    const name = flag.replace(/^--/, '') as MarketScope;
    if (!flag.startsWith('--') || !MARKET_SCOPES.includes(name)) {
      throw new AdminError(`Unknown option: ${flag.slice(0, 20)}`);
    }
    scopes.add(name);
  }
  return scopes.size === 0 ? [...MARKET_SCOPES] : MARKET_SCOPES.filter((s) => scopes.has(s));
}

export async function marketRefresh(
  db: Database,
  runtime: MarketDataRuntime,
  input: { scopes: readonly MarketScope[]; listing?: string },
): Promise<RefreshReport> {
  const listing = input.listing ? parseListingRef(input.listing) : undefined;
  try {
    return await refreshMarket(
      { db, runtime },
      {
        scopes: input.scopes,
        ...(listing ? { listing: { symbol: listing.symbol, mic: listing.mic } } : {}),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Unknown listing') {
      throw new AdminError('Unknown listing (reference data is not loaded for it)');
    }
    throw error;
  }
}

export interface MarketStatus {
  now: Date;
  states: {
    kind: string;
    total: number;
    failing: number;
    oldestSuccess: Date | null;
    newestSuccess: Date | null;
  }[];
  failing: {
    listing: string | null;
    kind: string;
    failureCount: number;
    nextRetryAt: Date | null;
    lastErrorCode: string | null;
  }[];
  usage: { provider: string; day: string; calls: number }[];
  metrics: { rows: number; latestComputedAt: Date | null };
}

/** Operator summary: cache/backoff state per kind, failing entries, and the last days of provider usage. */
export async function marketStatus(db: Database, now: Date): Promise<MarketStatus> {
  const states = await db
    .select({
      kind: marketDataFetchState.kind,
      total: sql<number>`count(*)`.mapWith(Number),
      failing:
        sql<number>`count(*) filter (where ${marketDataFetchState.failureCount} > 0)`.mapWith(
          Number,
        ),
      oldestSuccess: sql<Date | null>`min(${marketDataFetchState.lastSuccessAt})`.mapWith((v) =>
        v ? new Date(v as string) : null,
      ),
      newestSuccess: sql<Date | null>`max(${marketDataFetchState.lastSuccessAt})`.mapWith((v) =>
        v ? new Date(v as string) : null,
      ),
    })
    .from(marketDataFetchState)
    .groupBy(marketDataFetchState.kind)
    .orderBy(asc(marketDataFetchState.kind));
  const failing = await db
    .select({
      listing: sql<
        string | null
      >`case when ${listings.id} is null then null else ${listings.symbol} || '.' || ${listings.exchangeMic} end`,
      kind: marketDataFetchState.kind,
      failureCount: marketDataFetchState.failureCount,
      nextRetryAt: marketDataFetchState.nextRetryAt,
      lastErrorCode: marketDataFetchState.lastErrorCode,
    })
    .from(marketDataFetchState)
    .leftJoin(listings, eq(listings.id, marketDataFetchState.listingId))
    .where(sql`${marketDataFetchState.failureCount} > 0`)
    .orderBy(desc(marketDataFetchState.failureCount))
    .limit(20);
  const since = new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  const usage = await db
    .select()
    .from(providerUsage)
    .where(gte(providerUsage.day, since))
    .orderBy(desc(providerUsage.day), asc(providerUsage.provider));
  const [metrics] = await db
    .select({
      rows: sql<number>`count(*)`.mapWith(Number),
      latest: sql<Date | null>`max(${listingMetrics.computedAt})`.mapWith((v) =>
        v ? new Date(v as string) : null,
      ),
    })
    .from(listingMetrics);
  return {
    now,
    states,
    failing,
    usage,
    metrics: { rows: metrics?.rows ?? 0, latestComputedAt: metrics?.latest ?? null },
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : '-');

export function formatMarketStatus(status: MarketStatus): string[] {
  const lines = [`Market data status at ${status.now.toISOString()}`];
  lines.push('Fetch state (kind: entries, failing, newest success):');
  if (status.states.length === 0) lines.push('  (none yet)');
  for (const s of status.states) {
    lines.push(
      `  ${s.kind}: ${s.total} entries, ${s.failing} failing, newest success ${iso(s.newestSuccess)}`,
    );
  }
  if (status.failing.length > 0) {
    lines.push('Failing (backoff active until next retry):');
    for (const f of status.failing) {
      lines.push(
        `  ${f.listing ?? 'fx'} [${f.kind}] failures=${f.failureCount} code=${f.lastErrorCode ?? '-'} next retry ${iso(f.nextRetryAt)}`,
      );
    }
  }
  lines.push('Provider usage (calls per UTC day, last 7 days):');
  if (status.usage.length === 0) lines.push('  (none)');
  for (const u of status.usage) lines.push(`  ${u.day} ${u.provider}: ${u.calls}`);
  lines.push(
    `listing_metrics: ${status.metrics.rows} rows, latest computed ${iso(status.metrics.latestComputedAt)}`,
  );
  return lines;
}

export function formatRefreshReport(report: RefreshReport): string[] {
  const lines = [`Refreshed market data for ${report.listings} listing(s).`];
  const counts = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
  if (report.history) lines.push(`  history: ${counts(report.history)}`);
  if (report.fx) lines.push(`  fx: ${report.fx}`);
  if (report.quotes) lines.push(`  quotes: ${counts(report.quotes)}`);
  if (report.metrics !== undefined) lines.push(`  metrics: ${report.metrics} row(s) computed`);
  return lines;
}
