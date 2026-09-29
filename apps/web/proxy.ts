import { NextResponse, type NextRequest } from 'next/server';

/**
 * Convenience only, NOT the auth boundary: exposes the requested path to server layouts so the
 * route guard can send the user to `/login?next=<path>`. Authentication is enforced by
 * `getCurrentUser()` in the `(app)` layout (and by `authed` in every RPC procedure).
 * The header is overwritten here, so a client-supplied value is never trusted as such; it is
 * additionally re-validated by `safeNextPath`.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-waddlers-path', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon.ico).*)'],
};
