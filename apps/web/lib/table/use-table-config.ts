'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ORPCError } from '@orpc/client';
import type { TableConfigOutput, TableConfigV1 } from '@waddlers/contracts';
import { orpc, rpc, rpcKeepalive } from '@/lib/orpc';
import { TableConfigSession } from './config-session';
import { registerSaveEntry } from './save-registry';
import { saveWithRetry } from './save-policy';

export const CONFIG_RESET_OK = 'Configuration réinitialisée.';
export const CONFIG_RESET_ERROR = 'Impossible de réinitialiser la configuration.';

/**
 * The user's own table view of a space (specs 16, 19, D27). `tableConfig.get` is read once per
 * session (only this client writes it; the cache is cleared at logout). An edit updates the cache
 * at once (optimistic), the FULL config is saved 500 ms after the last edit, one request at a time.
 * A failed save toasts and restores the last config the server confirmed FOR THIS SPACE: the
 * session (and its `confirmed` config) is rebuilt when `spaceId` changes. The logic lives in
 * `TableConfigSession`; this hook only wires it to React Query.
 */
export function useTableConfig(spaceId: string, initial?: TableConfigOutput) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => orpc.tableConfig.get.queryOptions({ input: { spaceId } }).queryKey,
    [spaceId],
  );
  const query = useQuery(
    orpc.tableConfig.get.queryOptions({
      input: { spaceId },
      staleTime: Infinity,
      ...(initial ? { initialData: initial } : {}),
    }),
  );

  const session = useMemo(
    () =>
      new TableConfigSession({
        store: {
          get: () => queryClient.getQueryData<TableConfigOutput>(queryKey),
          set: (value) => queryClient.setQueryData<TableConfigOutput>(queryKey, value),
        },
        save: (config, { keepalive }) =>
          saveWithRetry(() =>
            (keepalive ? rpcKeepalive : rpc).tableConfig.save({ spaceId, config }),
          ),
        reset: () => rpc.tableConfig.reset({ spaceId }),
        notifyError: (message) => void toast.error(message),
      }),
    [spaceId, queryClient, queryKey],
  );
  if (query.data) session.seed(query.data.config);

  // Leaving the page (or the space) must not lose the last edit; logout flushes through the registry.
  useEffect(() => {
    const flush = () => void session.flush();
    const onHide = () => void session.flush({ keepalive: true });
    window.addEventListener('pagehide', onHide);
    const unregister = registerSaveEntry({
      flush: () => session.flush(),
      halt: () => session.halt(),
    });
    return () => {
      window.removeEventListener('pagehide', onHide);
      unregister();
      flush();
    };
  }, [session]);

  const update = useCallback(
    (edit: (config: TableConfigV1) => TableConfigV1) => session.update(edit),
    [session],
  );

  const reset = useMutation({
    mutationFn: () => session.reset(),
    onSuccess: () => void toast.success(CONFIG_RESET_OK),
    onError: (error) => {
      if (error instanceof ORPCError && error.code === 'UNAUTHORIZED') return;
      toast.error(CONFIG_RESET_ERROR);
    },
  });

  return {
    query,
    config: query.data?.config,
    isDefault: query.data?.isDefault ?? true,
    update,
    reset: () => reset.mutate(),
    resetting: reset.isPending,
  };
}
