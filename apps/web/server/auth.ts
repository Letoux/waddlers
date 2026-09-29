import 'server-only';
import { ORPCError } from '@orpc/client';
import type { CurrentUser } from '@waddlers/contracts';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { loginUrlFor } from '@/lib/auth/safe-next';
import { getServerClient } from './orpc';

/**
 * The signed-in user for this request, or null (no/expired/revoked session, disabled user).
 * Memoised per request. Use it in layouts/pages for the route guard:
 *
 *   const user = await getCurrentUser();
 *   if (!user) redirect('/login');
 *
 * Any error other than UNAUTHORIZED (e.g. database down) propagates: it must not be
 * mistaken for "logged out".
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const client = await getServerClient();
  try {
    return (await client.auth.me()).user;
  } catch (error) {
    if (error instanceof ORPCError && error.code === 'UNAUTHORIZED') return null;
    throw error;
  }
});

/**
 * Page-level route guard. Every page under `app/(app)/` MUST call this: a layout is not an
 * auth boundary (client-side RSC navigations can render a page without re-running the layout).
 * Redirects to `/login?next=<requested path>` when there is no session; memoised per request.
 */
export const requireUser = cache(async (): Promise<CurrentUser> => {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlFor((await headers()).get('x-waddlers-path')));
  return user;
});
