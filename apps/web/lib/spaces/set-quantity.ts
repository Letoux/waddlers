import type { MutationKey, MutationOptions, QueryClient, QueryKey } from '@tanstack/react-query';
import type { MoneyCell, PositionsListOutput, TableCell } from '@waddlers/contracts';
import { RECALCULATING_REASON } from '@/lib/table/cells';
import { spaceFailureKind, writeFailureMessage } from './errors';

export type QuantityVars = { spaceId: string; positionId: string; quantity: string | null };

/** Tag put in the `meta` of every write on a space, to count writes in flight. */
export type WriteMeta = { spaceWrite: string; positionId: string };

export const writeMeta = (spaceId: string, positionId: string): WriteMeta => ({
  spaceWrite: spaceId,
  positionId,
});

/**
 * Writes in flight for a space (quantity edits and removals), or for one position of it.
 * Inside `onError`/`onSettled` the calling mutation is still counted, so `1` means "alone".
 */
export function pendingWrites(queryClient: QueryClient, spaceId: string, positionId?: string) {
  return queryClient.isMutating({
    predicate: (m) => {
      const meta = m.meta as Partial<WriteMeta> | undefined;
      return (
        meta?.spaceWrite === spaceId && (positionId === undefined || meta.positionId === positionId)
      );
    },
  });
}

/**
 * What a failed edit falls back to, per query client and position, while edits of that position
 * are in flight: the last quantity known to be stored server-side (with two overlapping edits the
 * "previous" value seen by the second one is the first one's unsaved value) and the tracked-value
 * cell each cached page showed before the first edit (`tracked`; emptied once an edit succeeded,
 * since the value of the confirmed quantity is then unknown until the refetch).
 */
type Snapshot = { quantity: string | null; tracked: Map<string, TableCell | undefined> };
const confirmed = new WeakMap<QueryClient, Map<string, Snapshot>>();
const confirmedFor = (qc: QueryClient) => {
  let map = confirmed.get(qc);
  if (!map) confirmed.set(qc, (map = new Map()));
  return map;
};

/** Valeur suivie of a row being edited: unknown until the refetch. Never computed client-side. */
const RECALCULATING: MoneyCell = {
  kind: 'money',
  amount: null,
  currency: 'EUR',
  asOf: null,
  isStale: false,
  reason: RECALCULATING_REASON,
};

type Row = PositionsListOutput['rows'][number];
const TRACKED = 'tracked_value_eur';
const entryId = (key: QueryKey) => JSON.stringify(key);

/**
 * `listKey` is a PREFIX: the table keeps one cache entry per (period, search, sort, page,
 * columns) of the space, and a row can sit in any of them. Reads and writes go through every
 * matching entry. The quantity lives in `row.quantity` only.
 */
function eachEntry(
  qc: QueryClient,
  listKey: QueryKey,
  fn: (key: QueryKey, data: PositionsListOutput) => PositionsListOutput | void,
) {
  for (const [key, data] of qc.getQueriesData<PositionsListOutput>({ queryKey: listKey })) {
    if (!data) continue;
    const next = fn(key, data);
    if (next) qc.setQueryData<PositionsListOutput>(key, next);
  }
}

function findRow(qc: QueryClient, listKey: QueryKey, positionId: string): Row | undefined {
  for (const [, list] of qc.getQueriesData<PositionsListOutput>({ queryKey: listKey })) {
    const found = list?.rows.find((r) => r.id === positionId);
    if (found) return found;
  }
  return undefined;
}

const rowQuantity = (qc: QueryClient, listKey: QueryKey, positionId: string) =>
  findRow(qc, listKey, positionId)?.quantity;

function mapRow(data: PositionsListOutput, positionId: string, fn: (r: Row) => Row) {
  return { ...data, rows: data.rows.map((r) => (r.id === positionId ? fn(r) : r)) };
}

function snapshotRow(qc: QueryClient, listKey: QueryKey, positionId: string): Snapshot | undefined {
  const quantity = rowQuantity(qc, listKey, positionId);
  if (quantity === undefined) return undefined;
  const tracked = new Map<string, TableCell | undefined>();
  eachEntry(qc, listKey, (key, data) => {
    const row = data.rows.find((r) => r.id === positionId);
    if (row) tracked.set(entryId(key), row.values[TRACKED]);
  });
  return { quantity, tracked };
}

/** Optimistic edit: the quantity, and the tracked value shown as pending where it is displayed. */
function applyEdit(
  qc: QueryClient,
  listKey: QueryKey,
  positionId: string,
  quantity: string | null,
) {
  eachEntry(qc, listKey, (_key, data) =>
    mapRow(data, positionId, (r) => ({
      ...r,
      quantity,
      values: TRACKED in r.values ? { ...r.values, [TRACKED]: RECALCULATING } : r.values,
    })),
  );
}

/**
 * Rollback: restores BOTH the quantity and (where known) the tracked-value cell, per cache entry
 * (F-FE5): an entry that no longer shows this edit's value (a refetch landed, or it arrived after
 * the edit) is left alone, whatever the other entries show.
 */
function restoreRow(
  qc: QueryClient,
  listKey: QueryKey,
  positionId: string,
  snap: Snapshot,
  editedQuantity: string | null,
) {
  eachEntry(qc, listKey, (key, data) =>
    mapRow(data, positionId, (r) => {
      if (r.quantity !== editedQuantity) return r;
      const id = entryId(key);
      const values =
        snap.tracked.has(id) && snap.tracked.get(id) !== undefined
          ? { ...r.values, [TRACKED]: snap.tracked.get(id) as TableCell }
          : r.values;
      return { ...r, quantity: snap.quantity, values };
    }),
  );
}

export type SetQuantityDeps = {
  queryClient: QueryClient;
  spaceId: string;
  listKey: QueryKey;
  mutationKey: MutationKey;
  mutationFn: (vars: QuantityVars) => Promise<unknown>;
  notify: { success: (message: string) => void; error: (message: string) => void };
  /** Refetch positions and the space list (called only when no other write is in flight). */
  invalidate: () => void;
  onSaved?: () => void;
};

/**
 * Optimistic quantity edit.
 * - Edits of one position are serialized (`scope`), so the last edit wins on the server.
 * - A failure rolls back that row only, in each cache entry that still shows this edit's value,
 *   and only when no other edit of the position is in flight; the fallback is the last confirmed value.
 * - Refetching happens only when no other write of the space is in flight, so a refetch cannot
 *   overwrite an optimistic value that is still being saved.
 */
export function setQuantityMutationOptions(
  deps: SetQuantityDeps & { positionId: string },
): MutationOptions<unknown, Error, QuantityVars, void> {
  const { queryClient: qc, listKey, positionId, notify } = deps;
  const key = (vars: QuantityVars) => `${vars.spaceId}:${vars.positionId}`;
  return {
    mutationKey: deps.mutationKey,
    mutationFn: deps.mutationFn,
    scope: { id: `qty:${positionId}` },
    meta: writeMeta(deps.spaceId, positionId) as unknown as Record<string, unknown>,
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: listKey });
      const known = confirmedFor(qc);
      if (!known.has(key(vars))) {
        const snap = snapshotRow(qc, listKey, vars.positionId);
        if (snap) known.set(key(vars), snap);
      }
      applyEdit(qc, listKey, vars.positionId, vars.quantity);
    },
    onError: (error, vars) => {
      const alone = pendingWrites(qc, vars.spaceId, vars.positionId) <= 1;
      const fallback = confirmedFor(qc).get(key(vars));
      if (alone && fallback !== undefined) {
        restoreRow(qc, listKey, vars.positionId, fallback, vars.quantity);
      }
      if (spaceFailureKind(error) !== 'not_found') notify.error(writeFailureMessage(error));
    },
    onSuccess: (_data, vars) => {
      confirmedFor(qc).set(key(vars), { quantity: vars.quantity, tracked: new Map() });
      notify.success('Quantité mise à jour.');
      deps.onSaved?.();
    },
    onSettled: (_data, _error, vars) => {
      if (pendingWrites(qc, vars.spaceId, vars.positionId) <= 1) confirmedFor(qc).delete(key(vars));
      if (pendingWrites(qc, vars.spaceId) <= 1) deps.invalidate();
    },
  };
}
