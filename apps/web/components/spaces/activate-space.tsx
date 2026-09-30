'use client';

import { useEffect, useRef } from 'react';
import { useSetActiveSpace, useSpacesQuery } from '@/lib/spaces/use-spaces';

/** Renders nothing. Records the opened space as active, once, without blocking the page. */
export function ActivateSpace({ spaceId }: { spaceId: string }) {
  const { data } = useSpacesQuery();
  const { mutate } = useSetActiveSpace();
  const sent = useRef<string | null>(null);
  const activeSpaceId = data?.activeSpaceId;

  useEffect(() => {
    if (!data || activeSpaceId === spaceId || sent.current === spaceId) return;
    sent.current = spaceId;
    mutate({ spaceId });
  }, [data, activeSpaceId, spaceId, mutate]);

  return null;
}
