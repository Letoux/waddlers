import { describe, expect, it } from 'vitest';
import type { DashboardSummaryOutput } from '@waddlers/contracts';
import { deltaEndNote } from './delta-end';

const change = (toDate: string) => ({ toDate }) as NonNullable<DashboardSummaryOutput['change']>;

describe('deltaEndNote (D23)', () => {
  it('flags a delta that ends before the prices behind the total', () => {
    expect(deltaEndNote(change('2026-09-25'), '2026-09-29')).toBe('2026-09-25');
  });
  it('says nothing when the delta reaches the total, or when unknown', () => {
    expect(deltaEndNote(change('2026-09-29'), '2026-09-29')).toBeNull();
    expect(deltaEndNote(null, '2026-09-29')).toBeNull();
    expect(deltaEndNote(change('2026-09-25'), null)).toBeNull();
  });
});
