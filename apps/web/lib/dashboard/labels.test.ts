import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { joinNames, missingReasonLabel, rateLimitedMessage } from './labels';

describe('dashboard labels', () => {
  it('joins names in French', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B et C');
  });
  it('never shows a raw reason code', () => {
    expect(missingReasonLabel('price_missing')).toBe('cours indisponible');
    expect(missingReasonLabel('weird')).toBe('donnée indisponible');
  });
  it('uses retryAfterSeconds from the typed 429, never the server message', () => {
    const err = new ORPCError('TOO_MANY_REQUESTS', {
      message: 'Too many attempts',
      data: { retryAfterSeconds: 7 },
    });
    expect(rateLimitedMessage(err)).toContain('7 secondes');
    expect(rateLimitedMessage(err)).not.toContain('attempts');
    expect(
      rateLimitedMessage(new ORPCError('TOO_MANY_REQUESTS', { data: { retryAfterSeconds: 1 } })),
    ).toContain('1 seconde.');
    expect(rateLimitedMessage(new ORPCError('TOO_MANY_REQUESTS'))).toContain('quelques secondes');
  });
});
