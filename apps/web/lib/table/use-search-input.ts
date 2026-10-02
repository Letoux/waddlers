'use client';

import { useEffect, useRef, useState } from 'react';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Search field state: the field is local, the URL value (hence the query) follows 300 ms after
 * typing stops. An external URL change (nav link without `?q=`, back/forward) resets the field
 * (F-FE4); the echo of our own debounced update is ignored so it can never overwrite typing.
 */
export function useSearchInput(urlQ: string, push: (q: string) => void) {
  const [input, setInput] = useState(urlQ);
  const latestUrlQ = useRef(urlQ);
  latestUrlQ.current = urlQ;
  const pushedQ = useRef(urlQ);
  useEffect(() => {
    if (input === latestUrlQ.current) return;
    const timer = setTimeout(() => {
      pushedQ.current = input;
      push(input);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, push]);
  useEffect(() => {
    if (urlQ === pushedQ.current) return;
    pushedQ.current = urlQ;
    setInput(urlQ);
  }, [urlQ]);
  return [input, setInput] as const;
}
