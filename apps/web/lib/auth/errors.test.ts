import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_ERROR_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  changePasswordFailure,
  formatWait,
  loginFailure,
} from './errors';

describe('formatWait', () => {
  it('rounds up and handles missing values', () => {
    expect(formatWait(30)).toBe('moins d’une minute');
    expect(formatWait(61)).toBe('2 minutes');
    expect(formatWait(900)).toBe('15 minutes');
    expect(formatWait(undefined)).toBe('quelques minutes');
    expect(formatWait(0)).toBe('quelques minutes');
  });
});

describe('loginFailure', () => {
  it('maps bad credentials without echoing the server message', () => {
    const f = loginFailure(new ORPCError('UNAUTHORIZED', { message: 'Identifiants invalides' }));
    expect(f).toEqual({
      kind: 'credentials',
      message: 'Identifiant ou mot de passe incorrect.',
    });
  });

  it('includes the wait duration on 429', () => {
    const f = loginFailure(
      new ORPCError('TOO_MANY_REQUESTS', { data: { retryAfterSeconds: 600 } }),
    );
    expect(f.kind).toBe('throttled');
    expect(f.message).toContain('10 minutes');
  });

  it('is generic otherwise and never leaks technical details', () => {
    const server = loginFailure(new ORPCError('INTERNAL_SERVER_ERROR', { message: 'SELECT boom' }));
    expect(server.message).toBe(GENERIC_ERROR_MESSAGE);
    const bad = loginFailure(
      new ORPCError('BAD_REQUEST', { data: { issues: [{ message: 'secret' }] } }),
    );
    expect(bad.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(loginFailure(new TypeError('Failed to fetch')).message).toBe(NETWORK_ERROR_MESSAGE);
    expect(loginFailure('weird').message).toBe(GENERIC_ERROR_MESSAGE);
  });
});

describe('changePasswordFailure', () => {
  it('targets the current-password field', () => {
    const f = changePasswordFailure(new ORPCError('INVALID_CURRENT_PASSWORD'));
    expect(f.target).toBe('currentPassword');
    expect(f.sessionExpired).toBe(false);
  });

  it('flags an expired session', () => {
    expect(changePasswordFailure(new ORPCError('UNAUTHORIZED')).sessionExpired).toBe(true);
  });

  it('shows the throttle wait on the form', () => {
    const f = changePasswordFailure(
      new ORPCError('TOO_MANY_REQUESTS', { data: { retryAfterSeconds: 120 } }),
    );
    expect(f.target).toBe('form');
    expect(f.message).toContain('2 minutes');
  });

  it('is generic for anything else', () => {
    expect(changePasswordFailure(new ORPCError('BAD_REQUEST')).message).toBe(GENERIC_ERROR_MESSAGE);
    expect(changePasswordFailure(new Error('x')).message).toBe(GENERIC_ERROR_MESSAGE);
  });
});
