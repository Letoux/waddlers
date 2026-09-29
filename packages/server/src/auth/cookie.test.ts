import { describe, expect, it } from 'vitest';
import {
  hasSessionCookie,
  readSessionToken,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from './cookie';
import { generateSessionToken } from './token';

function attributes(cookie: string): string[] {
  return cookie
    .split(';')
    .slice(1)
    .map((a) => a.trim());
}

describe('session cookie', () => {
  it('uses the __Host- prefix with HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain', () => {
    const cookie = serializeSessionCookie('tok');
    expect(cookie.startsWith('__Host-wd_session=tok;')).toBe(true);
    const attrs = attributes(cookie);
    expect(attrs).toEqual(expect.arrayContaining(['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']));
    expect(attrs.some((a) => /^domain=/i.test(a))).toBe(false);
    expect(attrs).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
  });

  it('clears with Max-Age=0 and the same security attributes', () => {
    const cookie = serializeClearedSessionCookie();
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(attributes(cookie)).toEqual(
      expect.arrayContaining(['Max-Age=0', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );
  });

  it('reads only the exact cookie name and well-formed tokens', () => {
    const token = generateSessionToken();
    expect(readSessionToken(`a=1; ${SESSION_COOKIE_NAME}=${token}; b=2`)).toBe(token);
    expect(readSessionToken(`x${SESSION_COOKIE_NAME}=${token}`)).toBeUndefined();
    expect(readSessionToken(`wd_session=${token}`)).toBeUndefined();
    expect(readSessionToken(`${SESSION_COOKIE_NAME}=short`)).toBeUndefined();
    expect(readSessionToken(`${SESSION_COOKIE_NAME}=${'a b'.repeat(20)}`)).toBeUndefined();
    expect(readSessionToken(null)).toBeUndefined();
    expect(hasSessionCookie(`${SESSION_COOKIE_NAME}=garbage`)).toBe(true);
    expect(hasSessionCookie('theme=dark')).toBe(false);
  });
});
