import { describe, expect, it } from 'vitest';
import { loginUrlFor, safeNextPath } from './safe-next';

describe('safeNextPath', () => {
  it.each(['/settings', '/settings?tab=a', '/a/b#frag', '/'])('accepts %s', (v) => {
    expect(safeNextPath(v)).toBe(v);
  });

  it.each([
    undefined,
    null,
    '',
    'settings',
    'https://evil.example',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'javascript:alert(1)',
    'data:text/html,x',
    '/login',
    '/login?next=/settings',
    '/' + 'a'.repeat(3000),
  ])('falls back to / for %j', (v) => {
    expect(safeNextPath(v)).toBe('/');
  });

  it('uses the first value of a repeated parameter', () => {
    expect(safeNextPath(['/settings', '//evil'])).toBe('/settings');
    expect(safeNextPath(['//evil', '/settings'])).toBe('/');
  });
});

describe('loginUrlFor', () => {
  it('encodes the requested path', () => {
    expect(loginUrlFor('/settings?a=1&b=2')).toBe('/login?next=%2Fsettings%3Fa%3D1%26b%3D2');
  });
  it('omits next for / or unsafe input', () => {
    expect(loginUrlFor('/')).toBe('/login');
    expect(loginUrlFor(null)).toBe('/login');
    expect(loginUrlFor('//evil.example')).toBe('/login');
  });
});
