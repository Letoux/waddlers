import { ORPCError } from '@orpc/client';
import { dashboardRetryDelay } from '@/lib/query-retry';

/** `tableConfig.save` answered 409: the stored view was written by a newer app version. */
export const CONFIG_CONFLICT_MESSAGE =
  'Configuration enregistrée par une version plus récente ; rechargez la page.';

const hasCode = (error: unknown, code: string) => error instanceof ORPCError && error.code === code;
export const isConfigConflict = (error: unknown) => hasCode(error, 'CONFLICT');

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One save with the rate-limit policy: a 429 (30 saves a minute; a debounced UI should never reach
 * it) keeps the local state and is retried ONCE after the server's `retryAfterSeconds` (0.5-3 s).
 * Anything else, including the second 429, is thrown to the caller.
 */
export async function saveWithRetry<T>(
  save: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<T> {
  try {
    return await save();
  } catch (error) {
    if (!hasCode(error, 'TOO_MANY_REQUESTS')) throw error;
    await sleep(dashboardRetryDelay(0, error));
    return save();
  }
}
