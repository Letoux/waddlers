'use client';

import { useState, type ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { loginUrlFor } from '@/lib/auth/safe-next';
import { shouldRetryQuery } from '@/lib/query-retry';
import { shouldRedirectToLogin } from '@/lib/auth/unauthorized';

function makeQueryClient() {
  // Session expired or revoked while the page was open: drop cached data and go to /login,
  // remembering where the user was. Hard navigation on purpose (fresh RSC + empty client state).
  const onUnauthorized = (error: unknown, key?: readonly unknown[]) => {
    const { pathname, search } = window.location;
    if (!shouldRedirectToLogin(error, { pathname, key })) return;
    client.clear();
    window.location.assign(loginUrlFor(pathname + search));
  };

  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => onUnauthorized(error, query.queryKey),
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) =>
        onUnauthorized(error, mutation.options.mutationKey),
    }),
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: shouldRetryQuery,
        refetchOnWindowFocus: false,
      },
    },
  });
  return client;
}

export function Providers({ children }: { children: ReactNode }) {
  // useState keeps one client per browser session and avoids sharing across SSR requests.
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ToastContainer position="bottom-right" />
    </QueryClientProvider>
  );
}
