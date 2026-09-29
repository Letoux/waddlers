import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { orpc } from '../orpc';
import { shouldRedirectToLogin } from './unauthorized';

const unauthorized = new ORPCError('UNAUTHORIZED');

describe('shouldRedirectToLogin', () => {
  it('redirects on UNAUTHORIZED from an ordinary query or mutation', () => {
    expect(shouldRedirectToLogin(unauthorized, { pathname: '/settings' })).toBe(true);
    expect(
      shouldRedirectToLogin(unauthorized, {
        pathname: '/settings',
        key: orpc.auth.changePassword.mutationKey(),
      }),
    ).toBe(true);
  });

  it('ignores other errors', () => {
    expect(shouldRedirectToLogin(new ORPCError('TOO_MANY_REQUESTS'), { pathname: '/' })).toBe(
      false,
    );
    expect(shouldRedirectToLogin(new Error('x'), { pathname: '/' })).toBe(false);
  });

  it('does not treat bad credentials, logout or the login page as an expired session', () => {
    expect(
      shouldRedirectToLogin(unauthorized, {
        pathname: '/login',
        key: orpc.auth.login.mutationKey(),
      }),
    ).toBe(false);
    expect(
      shouldRedirectToLogin(unauthorized, {
        pathname: '/',
        key: orpc.auth.logout.mutationKey(),
      }),
    ).toBe(false);
    expect(shouldRedirectToLogin(unauthorized, { pathname: '/login' })).toBe(false);
  });
});
