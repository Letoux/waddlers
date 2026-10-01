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
  historyToWire,
  positionNames,
  spaceAsOf,
  summaryChange,
} from './compute';
import {
  readFxRange,
  readHeldCloses,
  readSpacePositions,
  type CloseRow,
  type FxRow,
  type SpacePositionData,
} from './repository';

/**
 * Dashboard services (S5). They read PostgreSQL only: a request never reaches a provider, the
 * worker keeps the tables fresh (docs/ai/BACKEND.md "Dashboard (S5)"). Each procedure reads in
 * ONE read-only REPEATABLE READ transaction (positions, closes and FX describe one snapshot), and
 * computes AFTER it committed: the connection goes back to the pool before any CPU-heavy work.
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

interface HistoryInputs {
  /** Newest end-price date of the held positions (the series end); `null` = nothing to plot. */
  to: PlainDate | null;
  closes: CloseRow[];
  fxRows: FxRow[];
}

/** DB reads of the history path (inside the transaction; no computation). */
async function readHistoryInputs(
  tx: DbExecutor,
  space: AuthorizedSpace,
  positions: readonly SpacePositionData[],
  period: Period,
  fx: { mode: FxMode; fxToleranceDays: number },
): Promise<HistoryInputs> {
  const to = spaceAsOf(positions);
  if (to === null) return { to, closes: [], fxRows: [] };
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
  return { to, closes, fxRows };
}

export async function getSummary(
  db: Database,
  space: AuthorizedSpace,
  period: Period,
  deps: DashboardDeps,
): Promise<DashboardSummaryOutput> {
  const fx = { mode: 'historical', fxToleranceDays: deps.fxToleranceDays } as const;
  const { positions, inputs } = await db.transaction(async (tx) => {
    const positions = await readSpacePositions(tx, space);
    return { positions, inputs: await readHistoryInputs(tx, space, positions, period, fx) };
  }, readOnly);
  // The historical FX read covers `[asOf - 7 days, asOf]` for every period, so the total reads the
  // very same rows as the terminal point of the series (D23): one input, two views.
  const value = computeCurrentValue(positions, inputs.fxRows, deps.now(), deps.fxToleranceDays);
  const series =
    inputs.to === null
      ? undefined
      : computeHistory(positions, inputs.closes, inputs.fxRows, period, inputs.to, fx).series;
  const names = positionNames(positions);
  return {
    period,
    ...value,
    change: summaryChange(value, series),
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
}

export async function getHistory(
  db: Database,
  space: AuthorizedSpace,
  period: Period,
  fxMode: FxMode,
  deps: DashboardDeps,
): Promise<DashboardHistoryOutput> {
  const fx = { mode: fxMode, fxToleranceDays: deps.fxToleranceDays };
  const { positions, inputs } = await db.transaction(async (tx) => {
    const positions = await readSpacePositions(tx, space);
    return { positions, inputs: await readHistoryInputs(tx, space, positions, period, fx) };
  }, readOnly);
  const result =
    inputs.to === null
      ? null
      : computeHistory(positions, inputs.closes, inputs.fxRows, period, inputs.to, fx);
  return {
    ...historyToWire(
      positions,
      result,
      period,
      inputs.to,
      fxMode,
      deps.now(),
      deps.fxToleranceDays,
    ),
    basis: 'current_quantities_past_prices' as const,
    label: DASHBOARD_HISTORY_LABEL,
  };
}

export async function getMovers(
  db: Database,
  space: AuthorizedSpace,
  period: Period,
): Promise<DashboardMoversOutput> {
  // Same transaction style as the others (one snapshot, read only), although it is one statement.
  const positions = await db.transaction((tx) => readSpacePositions(tx, space), readOnly);
  return { period, ...computeMoverLists(positions, period) };
}
