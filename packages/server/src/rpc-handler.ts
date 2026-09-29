import { ORPCError } from '@orpc/server';
import { BodyLimitPlugin, RPCHandler } from '@orpc/server/fetch';
import { ResponseHeadersPlugin, SimpleCsrfProtectionHandlerPlugin } from '@orpc/server/plugins';
import { hasSessionCookie } from './auth/cookie';
import { safeErrorInterceptor, type ErrorLogger } from './errors';
import { createRouter, type RouterDeps, type RpcContext } from './router';

export const RPC_PREFIX = '/api/rpc';
/** Auth procedures take tiny JSON payloads; 1 MB is generous and bounds memory per request. */
export const MAX_BODY_BYTES = 1_048_576;

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

const forbidden = () => errorResponse(new ORPCError('FORBIDDEN', { message: 'Forbidden' }));

/**
 * Cookie-session CSRF invariants (defence in depth on top of the `x-csrf-token` header, which
 * a cross-site page cannot add without a CORS preflight; no CORS is ever enabled):
 * 1. Sec-Fetch-Site, when sent, must be `same-origin`.
 * 2. Origin, when sent, must equal APP_ORIGIN.
 * 3. Fail closed: a request carrying the session cookie must prove where it comes from, so it
 *    is rejected if BOTH Origin and Sec-Fetch-Site are missing.
 * Requests without a session cookie and without both headers (curl, login from scripts) are
 * allowed; they still need the CSRF header and carry no ambient authority.
 */
export function checkRequestOrigin(request: Request, allowedOrigin: string): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') return false;
  if (origin !== null && origin !== allowedOrigin) return false;
  if (origin === null && fetchSite === null && hasSessionCookie(request.headers.get('cookie'))) {
    return false;
  }
  return true;
}

/** Fetch-API RPC handler: `handle(request)` resolves to a Response, or `matched: false`. */
export function createRpcHandler({ allowedOrigin, ...deps }: RpcHandlerOptions) {
  const handler = new RPCHandler<RpcContext>(createRouter(deps), {
    plugins: [
      new BodyLimitPlugin({ maxBodySize: MAX_BODY_BYTES }),
      // Lets procedures append Set-Cookie (login/logout/refresh) via `context.resHeaders`.
      new ResponseHeadersPlugin<RpcContext>(),
      // Requires the `x-csrf-token` header (set by the client link).
      // GET on procedures is refused by StrictGetMethodPlugin, which RPCHandler enables by default.
      new SimpleCsrfProtectionHandlerPlugin(),
    ],
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
    if (!checkRequestOrigin(request, allowedOrigin())) return respond(noStore(forbidden()));
    const result = await handler.handle(request, {
      prefix: RPC_PREFIX,
      context: { headers: request.headers },
    });
    return result.matched ? respond(noStore(result.response)) : result;
  };
}
