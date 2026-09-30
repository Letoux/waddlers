import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_MESSAGE,
  MUTATION_ERROR_MESSAGE,
  spaceFailureKind,
  writeFailureMessage,
} from './errors';

describe('space failures', () => {
  it('classifies oRPC codes', () => {
    expect(spaceFailureKind(new ORPCError('NOT_FOUND'))).toBe('not_found');
    expect(spaceFailureKind(new ORPCError('FORBIDDEN'))).toBe('forbidden');
    expect(spaceFailureKind(new ORPCError('BAD_REQUEST'))).toBe('other');
    expect(spaceFailureKind(new TypeError('fetch failed'))).toBe('other');
  });

  it('never renders server messages', () => {
    expect(writeFailureMessage(new ORPCError('FORBIDDEN', { message: 'secret' }))).toBe(
      FORBIDDEN_MESSAGE,
    );
    expect(writeFailureMessage(new ORPCError('INTERNAL_SERVER_ERROR', { message: 'db' }))).toBe(
      MUTATION_ERROR_MESSAGE,
    );
  });
});
