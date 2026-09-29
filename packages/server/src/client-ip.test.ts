import { describe, expect, it } from 'vitest';
import { clientIpFrom } from './router';

describe('clientIpFrom', () => {
  const headers = new Headers({
    'x-forwarded-for': '6.6.6.6, 203.0.113.9',
    'x-real-ip': '5.5.5.5',
  });

  it('ignores forwarded headers unless a trusted proxy header is configured', () => {
    expect(clientIpFrom(headers, undefined)).toBe('unknown');
  });

  it('uses the right-most x-forwarded-for entry (the trusted proxy appends the real client)', () => {
    expect(clientIpFrom(headers, 'x-forwarded-for')).toBe('203.0.113.9');
    expect(clientIpFrom(headers, 'x-real-ip')).toBe('5.5.5.5');
    expect(clientIpFrom(new Headers(), 'x-forwarded-for')).toBe('unknown');
  });
});
