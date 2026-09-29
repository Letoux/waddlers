/** SQLSTATE / system code of a driver error, looking through Drizzle's wrapper (`cause`). */
export function pgErrorCode(error: unknown): string | undefined {
  for (
    let depth = 0, e: unknown = error;
    depth < 3 && typeof e === 'object' && e !== null;
    depth++
  ) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
