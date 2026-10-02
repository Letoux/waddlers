import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { releaseTestEnv, resetAuthTables, useTestEnv } from '../../test/auth-harness';
import { createSpaceRow } from '../../test/space-fixtures';
import { ensureExchanges, seedEntries, seedFx } from '../../test/table-fixtures';
import { operatorSpaceAccess } from './access';
import { currentFxRates } from './table-fx';

/**
 * Security P3-B: the reference date of the table's FX rates comes from the CALLER's space only. A
 * later price date held by ANOTHER space must never move it (it would pick a rate dated after the
 * caller's own `spaceAsOf`, and diverge from the dashboard).
 */

beforeAll(useTestEnv);
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});

let spaceA: string;
let spaceB: string;

beforeEach(async () => {
  await resetAuthTables();
  await ensureExchanges();
  // USD: one rate inside A's window, one dated AFTER A's spaceAsOf (09-29).
  await seedFx([
    { currency: 'USD', rate: '1.20', date: '2026-09-28' },
    { currency: 'USD', rate: '1.30', date: '2026-10-01' },
  ]);
  spaceA = await createSpaceRow('A');
  spaceB = await createSpaceRow('B');
  await seedEntries(spaceA, [
    {
      name: 'A Usd',
      symbol: 'AU',
      currency: 'USD',
      mic: 'XNAS',
      metrics: { asOfDate: '2026-09-29' },
    },
  ]);
  await seedEntries(spaceB, [
    {
      name: 'B Usd',
      symbol: 'BU',
      currency: 'USD',
      mic: 'XNAS',
      metrics: { asOfDate: '2026-10-02' },
    },
  ]);
});

async function usdRate(spaceId: string) {
  const db = getDb();
  const fx = currentFxRates(db, operatorSpaceAccess(spaceId));
  const rows = await db.select().from(fx);
  return rows.find((r) => r.currency === 'USD');
}

describe('currentFxRates is scoped to the caller space', () => {
  it("space A's rate stays at or before A's own spaceAsOf", async () => {
    const a = await usdRate(spaceA);
    expect(a?.rateDate).toBe('2026-09-28');
    expect(Number(a?.ratePerEur)).toBe(1.2);
    expect(a!.rateDate <= '2026-09-29').toBe(true);
  });

  it('space B still gets its own, later rate', async () => {
    expect((await usdRate(spaceB))?.rateDate).toBe('2026-10-01');
  });
});
