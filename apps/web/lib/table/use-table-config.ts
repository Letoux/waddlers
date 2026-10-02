'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import type { TableConfigOutput, TableConfigV1 } from '@waddlers/contracts';
import { orpc } from '@/lib/orpc';
import { spaceFailureKind } from '@/lib/spaces/errors';
import { ConfigSaver } from './config-saver';
import { CONFIG_CONFLICT_MESSAGE, isConfigConflict, saveWithRetry } from './save-policy';

export const CONFIG_SAVE_ERROR = 'Impossible d’enregistrer la configuration. Elle a été restaurée.';
export const CONFIG_RESET_OK = 'Configuration réinitialisée.';
export const CONFIG_RESET_ERROR = 'Impossible de réinitialiser la configuration.';

/**
 * The user's own table view of a space (specs 16, 19, D27). `tableConfig.get` is read once per
 * session (only this client writes it; the cache is cleared at logout). An edit updates the cache
 * at once (optimistic), the FULL config is saved 500 ms after the last edit, one request at a time.
 * A failed save toasts and restores the last config the server confirmed.
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

  const confirmed = useRef<TableConfigV1 | null>(null);
  if (confirmed.current === null && query.data) confirmed.current = query.data.config;

  const saver = useMemo(
    () =>
      new ConfigSaver({
        save: (config) => saveWithRetry(() => orpc.tableConfig.save.call({ spaceId, config })),
        onSaved: (config) => {
          confirmed.current = config;
        },
        onError: (error, _config, hasNewer) => {
          if (isConfigConflict(error)) toast.error(CONFIG_CONFLICT_MESSAGE);
          else if (spaceFailureKind(error) !== 'not_found') toast.error(CONFIG_SAVE_ERROR);
          if (hasNewer || !confirmed.current) return;
          queryClient.setQueryData<TableConfigOutput>(queryKey, {
            config: confirmed.current,
            isDefault: false,
          });
        },
      }),
    [spaceId, queryClient, queryKey],
  );

  // Leaving the page (or the space) must not lose the last edit.
  useEffect(() => {
    const flush = () => void saver.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [saver]);

  const update = useCallback(
    (edit: (config: TableConfigV1) => TableConfigV1) => {
      const current = queryClient.getQueryData<TableConfigOutput>(queryKey);
      if (!current) return;
      const next = edit(current.config);
      if (next === current.config) return;
      queryClient.setQueryData<TableConfigOutput>(queryKey, { config: next, isDefault: false });
      saver.schedule(next);
    },
    [queryClient, queryKey, saver],
  );

  const reset = useMutation({
    mutationFn: () => {
      saver.cancel(); // the reset supersedes an edit still waiting for its save
      return orpc.tableConfig.reset.call({ spaceId });
    },
    onSuccess: (output) => {
      confirmed.current = output.config;
      // An edit made while the reset was in flight is newer: keep it (last write wins).
      if (!saver.hasPending()) queryClient.setQueryData<TableConfigOutput>(queryKey, output);
      toast.success(CONFIG_RESET_OK);
    },
    onError: () => {
      toast.error(CONFIG_RESET_ERROR);
      void queryClient.invalidateQueries({ queryKey });
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
