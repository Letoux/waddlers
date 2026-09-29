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

/**
 * Single parser for the Cookie header (exact name match). `present` is true for any session
 * cookie, even a malformed one (used by the CSRF fail-closed rule); `token` only for a
 * well-formed value.
 */
export function parseSessionCookie(cookieHeader: string | null | undefined): {
  present: boolean;
  token?: string;
} {
  if (!cookieHeader) return { present: false };
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{20,100}$/.test(value)
      ? { present: true, token: value }
      : { present: true };
  }
  return { present: false };
}

export function readSessionToken(cookieHeader: string | null | undefined): string | undefined {
  return parseSessionCookie(cookieHeader).token;
}

export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  return parseSessionCookie(cookieHeader).present;
}

/**
 * Sets the session cookie on a response, replacing any session Set-Cookie already queued
 * (e.g. a sliding refresh followed by logout): a response carries at most one, the last write.
 */
export function setSessionCookieHeader(resHeaders: Headers, setCookie: string): void {
  const others = resHeaders
    .getSetCookie()
    .filter((value) => !value.startsWith(`${SESSION_COOKIE_NAME}=`));
  resHeaders.delete('set-cookie');
  for (const value of others) resHeaders.append('set-cookie', value);
  resHeaders.append('set-cookie', setCookie);
}
