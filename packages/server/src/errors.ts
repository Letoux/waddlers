import { ORPCError } from '@orpc/server';

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/**
 * Error policy (specs §36): known ORPCErrors pass through unchanged; anything else
 * is logged server-side and replaced with a neutral INTERNAL_SERVER_ERROR (no stack,
 * SQL or driver text). The original error is never attached (`cause` is not serialized
 * by oRPC, but we do not attach it anyway).
 */
export function toSafeError(
  error: unknown,
  log: (message: string, error: unknown) => void = logError,
) {
  if (error instanceof ORPCError) return error;
  log('Unhandled error in oRPC procedure', error);
  return new ORPCError('INTERNAL_SERVER_ERROR', { message: INTERNAL_ERROR_MESSAGE });
}

function logError(message: string, error: unknown): void {
  // Log name + message + stack only; never the surrounding request (may hold secrets).
  console.error(message, error instanceof Error ? error : String(error));
}

/** oRPC client interceptor applying the policy to every procedure call. */
export function safeErrorInterceptor(log?: (message: string, error: unknown) => void) {
  return async ({ next }: { next: () => Promise<unknown> }) => {
    try {
      return await next();
    } catch (error) {
      throw toSafeError(error, log);
    }
  };
}
