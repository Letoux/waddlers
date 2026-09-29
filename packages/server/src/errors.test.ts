import { ORPCError } from '@orpc/server';
import { DrizzleQueryError } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeError,
  INTERNAL_ERROR_MESSAGE,
  logError,
  safeErrorInterceptor,
  toSafeError,
} from './errors';

describe('toSafeError', () => {
  it('preserves known ORPCErrors', () => {
    const known = new ORPCError('NOT_FOUND', { message: 'Space not found' });
    const log = vi.fn();
    expect(toSafeError(known, log)).toBe(known);
    expect(log).not.toHaveBeenCalled();
  });

  it('maps unknown errors to a neutral INTERNAL_SERVER_ERROR and logs the original', () => {
    const raw = new Error('relation "users" does not exist at postgres://u:pw@host/db');
    const log = vi.fn();
    const safe = toSafeError(raw, log);
    expect(safe).toBeInstanceOf(ORPCError);
    expect(safe.code).toBe('INTERNAL_SERVER_ERROR');
    expect(safe.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(safe.toJSON())).not.toMatch(/relation|postgres|pw/);
    expect(safe.cause).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.any(String), raw);
  });

  it('interceptor rethrows the safe error and returns successful results untouched', async () => {
    const interceptor = safeErrorInterceptor(() => {});
    await expect(interceptor({ next: async () => 42 })).resolves.toBe(42);
    await expect(
      interceptor({
        next: async () => {
          throw new TypeError('boom');
        },
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: INTERNAL_ERROR_MESSAGE });
  });
});

describe('ORPCError logging', () => {
  it('logs server errors (status >= 500) and still passes them through unchanged', () => {
    const err = new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Output validation failed' });
    const log = vi.fn();
    expect(toSafeError(err, log)).toBe(err);
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('describeError / logError', () => {
  afterEach(() => vi.restoreAllMocks());

  function leakyError() {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint'), {
      name: 'PostgresError',
      code: '23505',
      severity: 'ERROR',
      constraint_name: 'users_email_unique',
      detail: 'Key (email)=(x@y.z) already exists',
    });
    return new DrizzleQueryError(
      'insert into "users" ("email", "token") values ($1, $2)',
      ['x@y.z', 'SESSION-TOKEN-SECRET'],
      cause,
    );
  }

  it('keeps SQLSTATE, constraint and query text but no params, detail or message', () => {
    const described = describeError(leakyError());
    expect(described).toMatchObject({
      name: 'Error',
      query: 'insert into "users" ("email", "token") values ($1, $2)',
      cause: { name: 'PostgresError', code: '23505', constraint_name: 'users_email_unique' },
    });
    const text = JSON.stringify(described);
    expect(text).not.toMatch(/SESSION-TOKEN-SECRET|x@y\.z|Failed query|params/);
  });

  it('logError output contains the SQLSTATE but neither the secret nor the email', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('Unhandled error in oRPC procedure', leakyError());
    const text = JSON.stringify(spy.mock.calls);
    expect(text).toContain('23505');
    expect(text).not.toMatch(/SESSION-TOKEN-SECRET|x@y\.z/);
  });

  it('bounds cause depth and tolerates non-Error values', () => {
    const deep = new Error('a', { cause: new Error('b', { cause: new Error('c', { cause: 1 }) }) });
    const d = describeError(deep);
    expect(d.cause?.cause?.cause).toBeUndefined();
    expect(describeError('boom')).toEqual({ name: 'string' });
  });
});
