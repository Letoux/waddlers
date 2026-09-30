'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PositionsListOutput } from '@waddlers/contracts';
import { toast } from 'react-toastify';
import { orpc } from '@/lib/orpc';
import { spaceFailureKind, writeFailureMessage } from './errors';

/** Positions of a space. Always refetched on mount (no stale list after a navigation). */
export function usePositionsQuery(spaceId: string) {
  return useQuery(orpc.positions.list.queryOptions({ input: { spaceId }, staleTime: 0 }));
}

function useRefreshAfterWrite(spaceId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.positions.list.key({ input: { spaceId } }) }),
      queryClient.invalidateQueries({ queryKey: orpc.spaces.list.key() }),
    ]);
}

/**
 * Optimistic quantity update with rollback. FORBIDDEN and generic failures toast a French
 * message; NOT_FOUND (position/space gone) refreshes quietly.
 */
export function useSetQuantity(spaceId: string, onSaved?: (message: string) => void) {
  const queryClient = useQueryClient();
  const refresh = useRefreshAfterWrite(spaceId);
  const listKey = orpc.positions.list.queryKey({ input: { spaceId } });
  return useMutation(
    orpc.positions.setQuantity.mutationOptions({
      onMutate: async ({ positionId, quantity }) => {
        await queryClient.cancelQueries({ queryKey: listKey });
        const previous = queryClient.getQueryData<PositionsListOutput>(listKey);
        if (previous) {
          queryClient.setQueryData<PositionsListOutput>(listKey, {
            ...previous,
            rows: previous.rows.map((r) => (r.id === positionId ? { ...r, quantity } : r)),
          });
        }
        return { previous };
      },
      onError: (error, _vars, context) => {
        if (context?.previous) queryClient.setQueryData(listKey, context.previous);
        if (spaceFailureKind(error) !== 'not_found') toast.error(writeFailureMessage(error));
      },
      onSuccess: () => {
        toast.success('Quantité mise à jour.');
        onSaved?.('Quantité mise à jour.');
      },
      onSettled: () => refresh(),
    }),
  );
}

export function useRemovePosition(spaceId: string) {
  const refresh = useRefreshAfterWrite(spaceId);
  return useMutation(
    orpc.positions.remove.mutationOptions({
      onSuccess: () => toast.success('Titre retiré de l’espace.'),
      onError: (error) => {
        if (spaceFailureKind(error) !== 'not_found') toast.error(writeFailureMessage(error));
      },
      // Not awaited: the row disappears on refetch, and the caller's callbacks (close the
      // dialog, move focus) must run while the row's component is still mounted.
      onSettled: () => {
        void refresh();
      },
    }),
  );
}
