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
  // Belt and braces: it must resolve to the same origin.
  try {
    const base = 'http://waddlers.invalid';
    const url = new URL(value, base);
    if (url.origin !== base) return '/';
  } catch {
    return '/';
  }
  // Never bounce back to the login page itself.
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login/')) return '/';
  return value;
}

/** `/login?next=<path>` for an unauthenticated visit of `path` (omitted for `/`). */
export function loginUrlFor(path: string | null | undefined): string {
  const next = safeNextPath(path);
  return next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}
