import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

const forwarded = (res: Response) => res.headers.get('x-middleware-request-x-waddlers-path');

describe('proxy', () => {
  it('sets the requested path (with query) for server layouts', () => {
    const res = proxy(new NextRequest('http://localhost:3000/settings?tab=a'));
    expect(forwarded(res)).toBe('/settings?tab=a');
  });

  it('overwrites a client-supplied x-waddlers-path', () => {
    const res = proxy(
      new NextRequest('http://localhost:3000/settings', {
        headers: { 'x-waddlers-path': '//evil.example' },
      }),
    );
    expect(forwarded(res)).toBe('/settings');
  });
});
