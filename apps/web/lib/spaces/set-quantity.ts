import type { MutationKey, MutationOptions, QueryClient, QueryKey } from '@tanstack/react-query';
import type { PositionsListOutput } from '@waddlers/contracts';
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

// Last quantity known to be stored server-side, per query client and position, while edits of
// that position are in flight. It is what a failed edit falls back to: with two overlapping
// edits the "previous" value seen by the second one is the first one's unsaved value.
const confirmed = new WeakMap<QueryClient, Map<string, string | null>>();
const confirmedFor = (qc: QueryClient) => {
  let map = confirmed.get(qc);
  if (!map) confirmed.set(qc, (map = new Map()));
  return map;
};

function rowQuantity(qc: QueryClient, listKey: QueryKey, positionId: string) {
  const list = qc.getQueryData<PositionsListOutput>(listKey);
  return list?.rows.find((r) => r.id === positionId)?.quantity;
}

/** Updates one row only; every other row keeps whatever the cache holds now. */
function setRowQuantity(
  qc: QueryClient,
  listKey: QueryKey,
  positionId: string,
  quantity: string | null,
) {
  qc.setQueryData<PositionsListOutput>(listKey, (old) =>
    old
      ? { ...old, rows: old.rows.map((r) => (r.id === positionId ? { ...r, quantity } : r)) }
      : old,
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
 * - A failure rolls back that row only, and only when it still shows this edit's value and no
 *   other edit of the position is in flight; the fallback is the last confirmed value.
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
        const current = rowQuantity(qc, listKey, vars.positionId);
        if (current !== undefined) known.set(key(vars), current);
      }
      setRowQuantity(qc, listKey, vars.positionId, vars.quantity);
    },
    onError: (error, vars) => {
      const alone = pendingWrites(qc, vars.spaceId, vars.positionId) <= 1;
      const fallback = confirmedFor(qc).get(key(vars));
      if (alone && fallback !== undefined) {
        if (rowQuantity(qc, listKey, vars.positionId) === vars.quantity) {
          setRowQuantity(qc, listKey, vars.positionId, fallback);
        }
      }
      if (spaceFailureKind(error) !== 'not_found') notify.error(writeFailureMessage(error));
    },
    onSuccess: (_data, vars) => {
      confirmedFor(qc).set(key(vars), vars.quantity);
      notify.success('Quantité mise à jour.');
      deps.onSaved?.();
    },
    onSettled: (_data, _error, vars) => {
      if (pendingWrites(qc, vars.spaceId, vars.positionId) <= 1) confirmedFor(qc).delete(key(vars));
      if (pendingWrites(qc, vars.spaceId) <= 1) deps.invalidate();
    },
  };
}
