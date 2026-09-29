import { ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { SimpleCsrfProtectionHandlerPlugin } from '@orpc/server/plugins';
import { safeErrorInterceptor, type ErrorLogger } from './errors';
import { createRouter, type RouterDeps } from './router';

export const RPC_PREFIX = '/api/rpc';

export interface RpcHandlerOptions extends RouterDeps {
  log?: ErrorLogger;
  /** Expected browser Origin for requests (APP_ORIGIN). Required; resolved per request. */
  allowedOrigin: () => string;
}

/** Same body shape RPCLink decodes into a typed ORPCError (`{ json: <ORPCError json> }`). */
function errorResponse(error: ORPCError<string, unknown>, headers: Record<string, string> = {}) {
  return Response.json({ json: error.toJSON() }, { status: error.status, headers });
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Fetch-API RPC handler: `handle(request)` resolves to a Response, or `matched: false`. */
export function createRpcHandler({ allowedOrigin, ...deps }: RpcHandlerOptions) {
  const handler = new RPCHandler(createRouter(deps), {
    // Requires the `x-csrf-token` header (set by the client link): plain HTML forms and
    // cross-site navigations cannot send it without a CORS preflight (no CORS is enabled).
    // GET on procedures is refused by StrictGetMethodPlugin, which RPCHandler enables by default.
    plugins: [new SimpleCsrfProtectionHandlerPlugin()],
    clientInterceptors: [safeErrorInterceptor(deps.log)],
  });
  return async (request: Request) => {
    const respond = (response: Response) => ({ matched: true as const, response });
    // Defence in depth: the route exports POST only, but Next adds HEAD when GET is exported.
    if (request.method !== 'POST' && request.method !== 'GET') {
      return respond(
        noStore(
          errorResponse(new ORPCError('METHOD_NOT_SUPPORTED', { status: 405 }), {
            allow: 'POST',
          }),
        ),
      );
    }
    // Defence in depth on top of the CSRF header: reject cross-origin browser requests.
    // A missing Origin (curl, server-side calls) is allowed; the CSRF header is still required.
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== allowedOrigin()) {
      return respond(noStore(errorResponse(new ORPCError('FORBIDDEN', { message: 'Forbidden' }))));
    }
    const result = await handler.handle(request, { prefix: RPC_PREFIX, context: {} });
    return result.matched ? respond(noStore(result.response)) : result;
  };
}
