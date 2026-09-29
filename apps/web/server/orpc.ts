import 'server-only';
import { createServerClient } from '@waddlers/server';
import { headers } from 'next/headers';

/**
 * In-process oRPC client for Server Components, layouts and route handlers. Forwards the
 * incoming request headers (session cookie) and goes through the same router/middleware as
 * `/api/rpc`. Never write a cookie from here (RSC cannot); login/logout run in the browser.
 */
export async function getServerClient() {
  return createServerClient({ headers: await headers() });
}
