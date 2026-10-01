import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { joinNames, leadingMissingNotice, missingReasonLabel, rateLimitedMessage } from './labels';

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

describe('leadingMissingNotice (D20)', () => {
  it('names up to three titles, without ever saying "création"', () => {
    const n = leadingMissingNotice(['A', 'B'], '2026-09-01', '1y');
    expect(n).toEqual({
      kind: 'short',
      text: 'Pas de donnée avant le début de l’historique disponible de A et B.',
    });
    expect(JSON.stringify(n)).not.toContain('création');
  });

  it('more than three names: the date for the whole set, a count, names in a disclosure', () => {
    const n = leadingMissingNotice(['A', 'B', 'C', 'D'], '2026-09-01', '1y');
    expect(n?.kind).toBe('long');
    expect(n?.text).toContain('Historique complet disponible depuis le 1 septembre 2026');
    expect(n?.text).toContain(
      'pour l’ensemble des positions — 4 titres sans historique plus ancien',
    );
    expect(n && 'names' in n && n.names).toEqual(['A', 'B', 'C', 'D']);
  });

  it('max always uses the long form, singular count, and copes with a missing base date', () => {
    const n = leadingMissingNotice(['A'], null, 'max');
    expect(n?.kind).toBe('long');
    expect(n?.text).toBe(
      'Historique complet disponible pour l’ensemble des positions — 1 titre sans historique plus ancien.',
    );
  });

  it('nothing to say without leading-missing positions', () => {
    expect(leadingMissingNotice([], '2026-09-01', 'max')).toBeNull();
  });
});
