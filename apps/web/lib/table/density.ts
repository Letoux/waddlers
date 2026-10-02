'use client';

import { useCallback, useEffect, useState } from 'react';

export type Density = 'comfortable' | 'compact';
const KEY = 'waddlers.table.density';

/** Simple S6 toggle; full table configuration (S7) will own this. Storage may be unavailable. */
export function useDensity(): [Density, (next: Density) => void] {
  const [density, setDensity] = useState<Density>('comfortable');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY);
      if (saved === 'compact' || saved === 'comfortable') setDensity(saved);
    } catch {
      /* private mode or blocked storage: keep the default */
    }
  }, []);
  const update = useCallback((next: Density) => {
    setDensity(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* not persisted, still applied for this visit */
    }
  }, []);
  return [density, update];
}
