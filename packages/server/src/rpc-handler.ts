import { RPCHandler } from '@orpc/server/fetch';
import { SimpleCsrfProtectionHandlerPlugin, StrictGetMethodPlugin } from '@orpc/server/plugins';
import { safeErrorInterceptor } from './errors';
import { createRouter, type RouterDeps } from './router';

export const RPC_PREFIX = '/api/rpc';

export interface RpcHandlerOptions extends RouterDeps {
  log?: (message: string, error: unknown) => void;
  /** Expected browser Origin for state-changing requests (APP_ORIGIN). Resolved per request. */
  allowedOrigin?: () => string;
}

/** Fetch-API RPC handler: `handle(request)` resolves to a Response, or `matched: false`. */
export function createRpcHandler({ log, allowedOrigin, ...deps }: RpcHandlerOptions = {}) {
  const handler = new RPCHandler(createRouter(deps), {
    // Requires the `x-csrf-token` header (set by the client link): plain HTML forms and
    // cross-site navigations cannot send it without a CORS preflight (no CORS is enabled).
    plugins: [new SimpleCsrfProtectionHandlerPlugin(), new StrictGetMethodPlugin()],
    clientInterceptors: [safeErrorInterceptor(log)],
  });
  return async (request: Request) => {
    // Defence in depth on top of the CSRF header: reject cross-origin browser requests.
    // A missing Origin (curl, server-side calls) is allowed; the CSRF header is still required.
    const origin = request.headers.get('origin');
    if (allowedOrigin && origin !== null && origin !== allowedOrigin()) {
      return {
        matched: true as const,
        response: Response.json({ code: 'FORBIDDEN', message: 'Forbidden' }, { status: 403 }),
      };
    }
    return handler.handle(request, { prefix: RPC_PREFIX, context: {} });
  };
}
