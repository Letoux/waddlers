/**
 * Validates the post-login redirect target (`?next=`). Only same-origin relative paths are
 * accepted, so the login page can never be used as an open redirect. Anything else falls back
 * to `/`.
 */
export function safeNextPath(raw: string | string[] | null | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return '/';
  // Must be a path ("/x"), not protocol-relative ("//host") nor backslash-tricked ("/\host").
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  // Control characters (tab/newline are stripped by URL parsers: "/\t/host" -> "//host").
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  // Normalise with the URL parser (resolves dot segments and %2e%2e) and return the normalised
  // form: `/..//evil.example` would otherwise be sent as-is and later resolve to `//evil.example`.
  try {
    const base = 'http://waddlers.invalid';
    const url = new URL(value, base);
    if (url.origin !== base) return '/';
    const { pathname } = url;
    if (pathname.startsWith('//') || pathname.includes('\\')) return '/';
    // Never bounce back to the login page itself.
    const lower = pathname.toLowerCase();
    if (lower === '/login' || lower.startsWith('/login/')) return '/';
    return pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

/** `/login?next=<path>` for an unauthenticated visit of `path` (omitted for `/`). */
export function loginUrlFor(path: string | null | undefined): string {
  const next = safeNextPath(path);
  return next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}
