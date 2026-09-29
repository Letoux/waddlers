import { getDb } from '../src/db/client';
import {
  exchanges,
  instruments,
  listings,
  spaceMembers,
  spacePositions,
  spaces,
  type SpaceRole,
} from '../src/db/schema';

/** Minimal reference data shared by the space integration tests (idempotent). */
export async function ensureReferenceData() {
  const db = getDb();
  await db
    .insert(exchanges)
    .values([
      { mic: 'XPAR', name: 'Euronext Paris', timezone: 'Europe/Paris', country: 'FR' },
      { mic: 'XLON', name: 'London Stock Exchange', timezone: 'Europe/London', country: 'GB' },
      { mic: 'XNAS', name: 'Nasdaq', timezone: 'America/New_York', country: 'US' },
    ])
    .onConflictDoNothing();
  const defs = [
    {
      key: 'ai',
      name: 'Air Liquide',
      isin: 'FR0000120073',
      mic: 'XPAR',
      symbol: 'AI',
      currency: 'EUR',
      type: 'stock',
    },
    {
      key: 'shel',
      name: 'Shell',
      isin: 'GB00BP6MXD84',
      mic: 'XLON',
      symbol: 'SHEL',
      currency: 'GBX',
      type: 'stock',
    },
    {
      key: 'cw8',
      name: 'World ETF',
      isin: 'LU1681043599',
      mic: 'XPAR',
      symbol: 'CW8',
      currency: 'EUR',
      type: 'etf',
    },
    {
      key: 'msft',
      name: 'Microsoft',
      isin: 'US5949181045',
      mic: 'XNAS',
      symbol: 'MSFT',
      currency: 'USD',
      type: 'stock',
    },
  ] as const;
  const out: Record<string, { instrumentId: string; listingId: string }> = {};
  for (const d of defs) {
    await db
      .insert(instruments)
      .values({ name: d.name, isin: d.isin, type: d.type })
      .onConflictDoNothing();
    const instrument = (await db.select().from(instruments)).find((i) => i.isin === d.isin)!;
    await db
      .insert(listings)
      .values({
        instrumentId: instrument.id,
        exchangeMic: d.mic,
        symbol: d.symbol,
        currency: d.currency,
      })
      .onConflictDoNothing();
    const listing = (await db.select().from(listings)).find(
      (l) => l.exchangeMic === d.mic && l.symbol === d.symbol,
    )!;
    out[d.key] = { instrumentId: instrument.id, listingId: listing.id };
  }
  return out as Record<'ai' | 'shel' | 'cw8' | 'msft', { instrumentId: string; listingId: string }>;
}

export async function createSpaceRow(
  name: string,
  members: { userId: string; role: SpaceRole }[] = [],
): Promise<string> {
  const db = getDb();
  const [space] = await db.insert(spaces).values({ name }).returning({ id: spaces.id });
  if (members.length > 0) {
    await db.insert(spaceMembers).values(members.map((m) => ({ spaceId: space!.id, ...m })));
  }
  return space!.id;
}

export async function createPositionRow(
  spaceId: string,
  ref: { instrumentId: string; listingId: string },
  quantity: string | null,
  selectionReason: string | null = null,
): Promise<string> {
  const [row] = await getDb()
    .insert(spacePositions)
    .values({ spaceId, ...ref, quantity, selectionReason })
    .returning({ id: spacePositions.id });
  return row!.id;
}
