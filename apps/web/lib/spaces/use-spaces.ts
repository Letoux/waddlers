'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SpacesListOutput } from '@waddlers/contracts';
import { orpc } from '@/lib/orpc';
import { spaceFailureKind } from './errors';

/** Spaces the user can access + the active one. `initialData` comes from the server shell. */
export function useSpacesQuery(options?: { initialData?: SpacesListOutput; fresh?: boolean }) {
  return useQuery({
    ...orpc.spaces.list.queryOptions(),
    ...(options?.initialData ? { initialData: options.initialData } : {}),
    ...(options?.fresh ? { staleTime: 0 } : {}),
  });
}

/**
 * Remembers the active space server-side (`users.last_space_id`, advisory). Never blocks
 * navigation and stays silent on failure: a revoked space just refreshes the list.
 */
export function useSetActiveSpace() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.spaces.setActive.mutationOptions({
      onSuccess: ({ activeSpaceId }) => {
        queryClient.setQueryData(
          orpc.spaces.list.queryKey(),
          (old: SpacesListOutput | undefined) => (old ? { ...old, activeSpaceId } : old),
        );
      },
      onError: (error) => {
        if (spaceFailureKind(error) === 'not_found') {
          void queryClient.invalidateQueries({ queryKey: orpc.spaces.list.key() });
        }
      },
    }),
  );
}
