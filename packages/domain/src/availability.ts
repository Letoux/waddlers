/**
 * Unavailable financial values are `null`/`undefined`, never `0` (CLAUDE.md §5).
 * `0` is a real, available value and must pass this guard.
 */
export function isAvailable<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
