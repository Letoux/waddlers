import { describe, expect, it } from 'vitest';
import { parseSpacePath, spaceHref, switchSpaceHref } from './nav';

describe('space navigation helpers', () => {
  it('parses space pages', () => {
    expect(parseSpacePath('/s/abc')).toEqual({ spaceId: 'abc', section: 'dashboard' });
    expect(parseSpacePath('/s/abc/')).toEqual({ spaceId: 'abc', section: 'dashboard' });
    expect(parseSpacePath('/s/abc/titres')).toEqual({ spaceId: 'abc', section: 'titres' });
    expect(parseSpacePath('/espaces')).toBeNull();
    expect(parseSpacePath('/s/abc/autre')).toBeNull();
    expect(parseSpacePath('/settings')).toBeNull();
  });

  it('keeps the sub-page when switching space', () => {
    expect(switchSpaceHref('/s/a/titres', 'b')).toBe('/s/b/titres');
    expect(switchSpaceHref('/s/a', 'b')).toBe('/s/b');
    expect(switchSpaceHref('/espaces', 'b')).toBe('/s/b');
    expect(switchSpaceHref('/settings', 'b')).toBe('/s/b');
  });

  it('builds hrefs', () => {
    expect(spaceHref('x', 'titres')).toBe('/s/x/titres');
    expect(spaceHref('x')).toBe('/s/x');
  });
});
