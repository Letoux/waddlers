import {
  DASHBOARD_HISTORY_LABEL,
  type DashboardHistoryOutput,
  type DashboardMoversOutput,
  type DashboardSummaryOutput,
  type FxMode,
} from '@waddlers/contracts';
import { addDays, targetBaseDate, type Period, type PlainDate } from '@waddlers/domain';
import type { Database, DbExecutor } from '../db/create';
import type { AuthorizedSpace } from '../spaces/access';
import {
  HISTORY_TOLERANCE_DAYS,
  computeCurrentValue,
  computeHistory,
  computeMoverLists,
  foreignCurrencies,
  headlineToWire,
  historyToWire,
  positionNames,
  spaceAsOf,
  type HistoryResult,
} from './compute';
import {
  readFxRange,
  readHeldCloses,
  readSpacePositions,
  type SpacePositionData,
} from './repository';

/**
 * Dashboard services (S5). They read PostgreSQL only: a request never reaches a provider, the
 * worker keeps the tables fresh (docs/ai/BACKEND.md "Dashboard (S5)"). Each procedure runs in a
 * read-only REPEATABLE READ transaction so positions, closes and FX describe one snapshot.
 */

export interface DashboardDeps {
  now: () => Date;
  /** FX rate older than this vs the price date is not used (MarketDataConfig.fxToleranceDays). */
  fxToleranceDays: number;
}

const readOnly = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/**
 * FX read of the history path (seam, see `historyFx` in compute.ts). `historical` needs the range
 * (per-day rates); `current` only needs the newest rates, so it reads the tolerance window before `to`.
 */
function readHistoryFx(
  tx: DbExecutor,
  positions: readonly SpacePositionData[],
  fx: { mode: FxMode; fxToleranceDays: number },
  range: { from: PlainDate; to: PlainDate },
) {
  return readFxRange(
    tx,
    foreignCurrencies(positions),
    fx.mode === 'current' ? addDays(range.to, -fx.fxToleranceDays) : range.from,
    range.to,
  );
}

async function historyFor(
  tx: DbExecutor,
  space: AuthorizedSpace,
  positions: readonly SpacePositionData[],
  period: Period,
  fx: { mode: FxMode; fxToleranceDays: number },
): Promise<{ result: HistoryResult | null; asOf: PlainDate | null }> {
  const to = spaceAsOf(positions);
  if (to === null) return { result: null, asOf: null };
  const target = targetBaseDate(period, to);
  const closes = await readHeldCloses(tx, space, {
    // Base price of the period start may sit up to the tolerance before the target.
    from: target === null ? null : addDays(target, -HISTORY_TOLERANCE_DAYS),
    to,
  });
  const first = closes.reduce<PlainDate | null>(
    (min, c) => (min === null || c.date < min ? c.date : min),
    null,
  );
  const fxRows = await readHistoryFx(tx, positions, fx, {
    from: addDays(target ?? first ?? to, -HISTORY_TOLERANCE_DAYS),
    to,
  });
  return { result: computeHistory(positions, closes, fxRows, period, to, fx), asOf: to };
}

export async function getSummary(
  db: Database,
  space: AuthorizedSpace,
  period: Period,
  deps: DashboardDeps,
): Promise<DashboardSummaryOutput> {
  return db.transaction(async (tx) => {
    const positions = await readSpacePositions(tx, space);
    const asOf = spaceAsOf(positions);
    const valueFx =
      asOf === null
        ? []
        : await readFxRange(
            tx,
            foreignCurrencies(positions),
            addDays(asOf, -deps.fxToleranceDays),
            asOf,
          );
    const value = computeCurrentValue(positions, valueFx, deps.now(), deps.fxToleranceDays);
    const { result } = await historyFor(tx, space, positions, period, {
      mode: 'historical',
      fxToleranceDays: deps.fxToleranceDays,
    });
    const names = positionNames(positions);
    const series = result?.series;
    return {
      period,
      ...value,
      change: headlineToWire(series?.headline ?? null),
      leadingMissing: (series?.leadingMissing ?? []).map((positionId) => ({
        positionId,
        name: names.get(positionId) ?? '',
      })),
      invalidPositions: (series?.invalidPositions ?? []).map((x) => ({
        positionId: x.positionId,
        name: names.get(x.positionId) ?? '',
        reason: x.reason,
      })),
    };
  }, readOnly);
}

export async function getHistory(
  db: Database,
  space: AuthorizedSpace,
  period: Period,
  fxMode: FxMode,
  deps: Pick<DashboardDeps, 'fxToleranceDays'>,
): Promise<DashboardHistoryOutput> {
  return db.transaction(async (tx) => {
    const positions = await readSpacePositions(tx, space);
    const { result, asOf } = await historyFor(tx, space, positions, period, {
      mode: fxMode,
      fxToleranceDays: deps.fxToleranceDays,
    });
    return {
      ...historyToWire(positions, result, period, asOf, fxMode),
      basis: 'current_quantities_past_prices' as const,
      label: DASHBOARD_HISTORY_LABEL,
    };
  }, readOnly);
}

export async function getMovers(
  db: Database,
  space: AuthorizedSpace,
  period: Period,
): Promise<DashboardMoversOutput> {
  const positions = await readSpacePositions(db, space);
  return { period, ...computeMoverLists(positions, period) };
}
