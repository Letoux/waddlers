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
    expect(parseSpacePath('/s/%E0%A4%A')).toBeNull();
    expect(parseSpacePath('/s/%E0%A4%A/titres')).toBeNull();
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

  it('carries the validated period across spaces and sections', () => {
    expect(spaceHref('abc', 'dashboard', '6m')).toBe('/s/abc?periode=6m');
    expect(spaceHref('abc', 'titres', '1w')).toBe('/s/abc/titres?periode=1w');
    expect(spaceHref('abc')).toBe('/s/abc');
    expect(switchSpaceHref('/s/old/titres', 'new', '5y')).toBe('/s/new/titres?periode=5y');
    expect(switchSpaceHref('/espaces', 'new', null)).toBe('/s/new');
  });
});
