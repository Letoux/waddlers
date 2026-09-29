import { ORPCError } from '@orpc/server';
import { DrizzleQueryError } from 'drizzle-orm';

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

export type ErrorLogger = (message: string, error: unknown) => void;

const MAX_CAUSE_DEPTH = 2;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function field(source: unknown, key: string): string | undefined {
  return typeof source === 'object' && source !== null
    ? str((source as Record<string, unknown>)[key])
    : undefined;
}

/** Stack frames only: the first lines of `stack` repeat `message` (SQL + params for Drizzle). */
function stackFrames(error: Error): string | undefined {
  const lines = error.stack?.split('\n') ?? [];
  const first = lines.findIndex((line) => /^\s+at\s/.test(line));
  return first === -1 ? undefined : lines.slice(first).join('\n');
}

export interface DescribedError {
  name: string;
  /** SQL text with placeholders (never parameter values). Drizzle query errors only. */
  query?: string;
  /** SQLSTATE (postgres) or system error code (ECONNREFUSED, ...). */
  code?: string;
  constraint_name?: string;
  severity?: string;
  stack?: string;
  cause?: DescribedError;
}

/**
 * Log-safe description of an error. Deliberately omits `message` (Drizzle embeds query
 * params in it; driver messages can echo connection strings), `params` and Postgres
 * `detail` (contains row values, e.g. `Key (email)=(...)`). Only allow-listed fields are copied.
 */
export function describeError(error: unknown, depth = 0): DescribedError {
  if (!(error instanceof Error)) return { name: typeof error };
  const out: DescribedError = { name: error.name };
  if (error instanceof DrizzleQueryError) out.query = error.query;
  const code = field(error, 'code');
  if (code) out.code = code;
  const constraint = field(error, 'constraint_name');
  if (constraint) out.constraint_name = constraint;
  const severity = field(error, 'severity');
  if (severity) out.severity = severity;
  const stack = stackFrames(error);
  if (stack) out.stack = stack;
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause = describeError(error.cause, depth + 1);
  }
  return out;
}

/**
 * Error policy (specs §36): known ORPCErrors pass through unchanged (those with status
 * >= 500, e.g. output validation failures, are logged first); anything else is logged
 * server-side and replaced with a neutral INTERNAL_SERVER_ERROR (no stack, SQL or driver
 * text). The original error is never attached to the returned error.
 */
export function toSafeError(error: unknown, log: ErrorLogger = logError) {
  if (error instanceof ORPCError) {
    if (error.status >= 500) log('oRPC server error', error);
    return error;
  }
  log('Unhandled error in oRPC procedure', error);
  return new ORPCError('INTERNAL_SERVER_ERROR', { message: INTERNAL_ERROR_MESSAGE });
}

/** Default logger: sanitised description only (see describeError); never the raw error object. */
export function logError(message: string, error: unknown): void {
  console.error(message, describeError(error));
}

/** oRPC client interceptor applying the policy to every procedure call. */
export function safeErrorInterceptor(log?: ErrorLogger) {
  return async ({ next }: { next: () => Promise<unknown> }) => {
    try {
      return await next();
    } catch (error) {
      throw toSafeError(error, log);
    }
  };
}
