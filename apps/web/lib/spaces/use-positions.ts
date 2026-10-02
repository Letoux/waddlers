'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { orpc } from '@/lib/orpc';
import { spaceFailureKind, writeFailureMessage } from './errors';
import { pendingWrites, setQuantityMutationOptions, writeMeta } from './set-quantity';

function useInvalidateSpaceData(spaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: orpc.positions.list.key({ input: { spaceId } }),
    });
    void queryClient.invalidateQueries({ queryKey: orpc.spaces.list.key() });
    // Quantities feed the dashboard total and chart.
    void queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
  };
}

/**
 * Optimistic quantity update of one position (see `setQuantityMutationOptions` for the
 * ordering, rollback and refetch rules). FORBIDDEN and generic failures toast a French message;
 * NOT_FOUND (position/space gone) refreshes quietly.
 */
export function useSetQuantity(spaceId: string, positionId: string, onSaved?: () => void) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSpaceData(spaceId);
  const base = orpc.positions.setQuantity.mutationOptions();
  return useMutation(
    setQuantityMutationOptions({
      queryClient,
      spaceId,
      positionId,
      // Prefix of every `positions.list` entry of the space (any period/search/sort/page).
      listKey: orpc.positions.list.key({ input: { spaceId } }),
      mutationKey: base.mutationKey ?? [],
      mutationFn: (vars) => orpc.positions.setQuantity.call(vars),
      notify: { success: (m) => toast.success(m), error: (m) => toast.error(m) },
      invalidate,
      ...(onSaved ? { onSaved } : {}),
    }),
  );
}

export function useRemovePosition(spaceId: string, positionId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSpaceData(spaceId);
  return useMutation(
    orpc.positions.remove.mutationOptions({
      meta: writeMeta(spaceId, positionId),
      onSuccess: () => toast.success('Titre retiré de l’espace.'),
      onError: (error) => {
        if (spaceFailureKind(error) !== 'not_found') toast.error(writeFailureMessage(error));
      },
      // Not awaited: the row disappears on refetch, and the caller's callbacks (close the
      // dialog, move focus) must run while the row's component is still mounted. Skipped while
      // another write is in flight so a refetch cannot overwrite an optimistic value.
      onSettled: () => {
        if (pendingWrites(queryClient, spaceId) <= 1) invalidate();
      },
    }),
  );
}
