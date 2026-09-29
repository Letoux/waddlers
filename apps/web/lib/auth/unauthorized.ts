import { ORPCError } from '@orpc/client';

/**
 * Should a failed query/mutation send the user back to /login? True for UNAUTHORIZED (session
 * expired or revoked), except where UNAUTHORIZED is an expected answer: the login mutation
 * (bad credentials), logout (already signed out; the button handles it), and the login page.
 */
export function shouldRedirectToLogin(
  error: unknown,
  ctx: { pathname: string; key?: readonly unknown[] | undefined },
): boolean {
  if (!(error instanceof ORPCError) || error.code !== 'UNAUTHORIZED') return false;
  if (ctx.pathname === '/login' || ctx.pathname.startsWith('/login/')) return false;
  const key = JSON.stringify(ctx.key ?? []);
  if (key.includes('"login"') || key.includes('"logout"')) return false;
  return true;
}
