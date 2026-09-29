/**
 * Session cookie. `__Host-` requires Secure + Path=/ + no Domain, which pins the cookie to the
 * exact host and stops subdomain/insecure-origin overwrite. Browsers treat http://localhost as
 * a secure context and accept Secure cookies there (Chromium, Firefox); Safari does not, so use
 * Chromium/Firefox for local development over http.
 */
export const SESSION_COOKIE_NAME = '__Host-wd_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax';

export function serializeSessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${maxAge}; ${ATTRIBUTES}`;
}

export function serializeClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; ${ATTRIBUTES}`;
}

/** Extracts the raw session token from a Cookie header (exact name match). */
export function readSessionToken(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/** True if the Cookie header carries a session cookie (even a malformed one). */
export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  return (cookieHeader ?? '')
    .split(';')
    .some((p) => p.trim().startsWith(`${SESSION_COOKIE_NAME}=`));
}
