import { createRouterClient } from '@orpc/server';
import { safeErrorInterceptor } from './errors';
import { createRouter, type RouterDeps } from './router';

let shared: ReturnType<typeof createRouter> | undefined;

/**
 * In-process client for SSR/RSC (route guards, server components): no HTTP hop, no CSRF surface,
 * same router and middleware as the HTTP handler. Pass the incoming request headers (they carry
 * the session cookie). It never writes a cookie (no `resHeaders`), so the sliding expiry is not
 * advanced from server-side reads.
 */
export function createServerClient(context: { headers: Headers }, deps?: RouterDeps) {
  const router = deps ? createRouter(deps) : (shared ??= createRouter());
  return createRouterClient(router, {
    context,
    interceptors: [safeErrorInterceptor(deps?.log)],
  });
}
