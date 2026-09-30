import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/create';
import {
  exchanges,
  instruments,
  listingProviderIds,
  listings,
  spaceMembers,
  spaces,
  users,
  type SpaceRole,
} from '../db/schema';
import { operatorSpaceAccess } from '../spaces/access';
import { insertPosition } from '../spaces/repository';
import { AdminError } from './errors';
import { createUser } from './index';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalOrigin(origin: string | undefined): boolean {
  try {
    return origin !== undefined && LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Local database hosts: loopback, or the Compose service name. */
const LOCAL_DB_HOSTS = new Set([...LOCAL_HOSTNAMES, '::1', 'postgres']);

function isLocalDatabase(url: string | undefined): boolean {
  try {
    return url !== undefined && LOCAL_DB_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function assertSeedAllowed(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV === 'production') {
    throw new AdminError('Refusing to seed: NODE_ENV=production.');
  }
  if (env.ALLOW_DEV_SEED !== '1') {
    if (!isLocalOrigin(env.APP_ORIGIN)) {
      throw new AdminError(
        'Refusing to seed: APP_ORIGIN is not localhost (set ALLOW_DEV_SEED=1 to override).',
      );
    }
    if (!isLocalDatabase(env.DATABASE_URL)) {
      throw new AdminError(
        'Refusing to seed: DATABASE_URL host is not local (set ALLOW_DEV_SEED=1 to override).',
      );
    }
  }
}

/**
 * Dev-only seed of the dev user. Refuses to run in production, and unless BOTH APP_ORIGIN is
 * localhost and the DATABASE_URL host is local (localhost, 127.0.0.1, ::1, or the Compose
 * service `postgres`), unless ALLOW_DEV_SEED=1 (a staging/remote database must not receive a
 * known dev password by accident). Idempotent: an existing user is left untouched, its password
 * is NOT reset (and SEED_USER_PASSWORD is then not required).
 */
export async function seedDevUser(
  db: Database,
  env: Record<string, string | undefined>,
): Promise<{ status: 'created' | 'exists'; username: string; id: string }> {
  assertSeedAllowed(env);
  const username = env.SEED_USER_USERNAME || 'dev';
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existing) return { status: 'exists', username, id: existing.id };
  const password = env.SEED_USER_PASSWORD;
  if (!password) throw new AdminError('SEED_USER_PASSWORD is not set.');
  const created = await createUser(db, { username, password });
  return { status: 'created', username, id: created.id };
}

/**
 * Dev seed for the whole workspace: the dev user (see `seedDevUser`), realistic reference data
 * and three spaces: "PEA" (dev is owner, one watchlist entry), "Actions US" (dev is viewer) and
 * "Famille" (nobody has access: for manual IDOR checks).
 *
 * Safety semantics (the seed must never attach to data it did not create):
 * - a space is only filled (members, positions) when THIS run created it (`insert ... returning`);
 *   a pre-existing space with the same name is left completely untouched;
 * - memberships are only granted to the dev user when THIS run created that user, so an existing
 *   account (even one named like SEED_USER_USERNAME) never receives grants;
 * - each space is seeded in one transaction (all or nothing).
 * Consequently a re-run changes nothing: it does not resurrect deleted positions or revoked
 * memberships, and never overwrites an edited quantity or role. Spaces created for a pre-existing
 * user have no member: grant access with `space:grant`.
 */
export async function seedDevWorkspace(
  db: Database,
  env: Record<string, string | undefined>,
): Promise<{
  user: { status: 'created' | 'exists'; username: string };
  spaces: { name: string; id: string; created: boolean; access: SpaceRole | null }[];
}> {
  const user = await seedDevUser(db, env);
  await seedReferenceData(db);
  const result: { name: string; id: string; created: boolean; access: SpaceRole | null }[] = [];
  for (const def of DEV_SPACES) {
    const outcome = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(spaces)
        .values({ name: def.name })
        .onConflictDoNothing({ target: spaces.name })
        .returning({ id: spaces.id });
      if (!created) {
        const [existing] = await tx
          .select({ id: spaces.id })
          .from(spaces)
          .where(eq(spaces.name, def.name));
        if (!existing) throw new AdminError('Seed failed: space vanished.');
        return { id: existing.id, created: false, access: null };
      }
      let access: SpaceRole | null = null;
      if (def.devRole && user.status === 'created') {
        await tx
          .insert(spaceMembers)
          .values({ spaceId: created.id, userId: user.id, role: def.devRole });
        access = def.devRole;
      }
      const operator = operatorSpaceAccess(created.id);
      for (const p of def.positions) {
        const [listing] = await tx
          .select({ id: listings.id, instrumentId: listings.instrumentId })
          .from(listings)
          .where(and(eq(listings.exchangeMic, p.mic), eq(listings.symbol, p.symbol)));
        if (!listing) throw new AdminError('Seed failed: listing missing.');
        await insertPosition(tx, operator, {
          instrumentId: listing.instrumentId,
          listingId: listing.id,
          quantity: p.quantity,
          selectionReason: p.reason,
        });
      }
      return { id: created.id, created: true, access };
    });
    result.push({ name: def.name, ...outcome });
  }
  return { user: { status: user.status, username: user.username }, spaces: result };
}

async function seedReferenceData(db: Database): Promise<void> {
  await db
    .insert(exchanges)
    .values([...DEV_EXCHANGES])
    .onConflictDoNothing();
  for (const i of DEV_INSTRUMENTS) {
    await db
      .insert(instruments)
      .values({ type: i.type, name: i.name, isin: i.isin, sector: i.sector, description: null })
      .onConflictDoNothing({ target: instruments.isin });
    const [instrument] = await db
      .select({ id: instruments.id })
      .from(instruments)
      .where(eq(instruments.isin, i.isin));
    if (!instrument) throw new AdminError('Seed failed: instrument missing after insert.');
    await db
      .insert(listings)
      .values({
        instrumentId: instrument.id,
        exchangeMic: i.mic,
        symbol: i.symbol,
        currency: i.currency,
      })
      .onConflictDoNothing({ target: [listings.exchangeMic, listings.symbol] });
    const [listing] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.exchangeMic, i.mic), eq(listings.symbol, i.symbol)));
    if (!listing) throw new AdminError('Seed failed: listing missing after insert.');
    await db
      .insert(listingProviderIds)
      .values({ listingId: listing.id, provider: 'eodhd', providerSymbol: i.eodhd })
      .onConflictDoNothing();
  }
}

const DEV_EXCHANGES = [
  { mic: 'XPAR', name: 'Euronext Paris', timezone: 'Europe/Paris', country: 'FR' },
  { mic: 'XNAS', name: 'Nasdaq', timezone: 'America/New_York', country: 'US' },
  { mic: 'XNYS', name: 'New York Stock Exchange', timezone: 'America/New_York', country: 'US' },
  { mic: 'XETR', name: 'Xetra', timezone: 'Europe/Berlin', country: 'DE' },
  { mic: 'XLON', name: 'London Stock Exchange', timezone: 'Europe/London', country: 'GB' },
] as const;

/**
 * Dev-only sample data. ISINs/symbols are real-looking but NOT verified against a provider; the
 * `eodhd` symbols follow EODHD's `<code>.<exchange>` convention and must be checked before the
 * real adapter (D1). Sectors are English labels (translation is D16, open).
 */
const DEV_INSTRUMENTS = [
  {
    name: 'Air Liquide',
    type: 'stock',
    isin: 'FR0000120073',
    sector: 'Materials',
    mic: 'XPAR',
    symbol: 'AI',
    currency: 'EUR',
    eodhd: 'AI.PA',
  },
  {
    name: 'LVMH',
    type: 'stock',
    isin: 'FR0000121014',
    sector: 'Consumer Discretionary',
    mic: 'XPAR',
    symbol: 'MC',
    currency: 'EUR',
    eodhd: 'MC.PA',
  },
  {
    name: 'Amundi MSCI World UCITS ETF EUR',
    type: 'etf',
    isin: 'LU1681043599',
    sector: null,
    mic: 'XPAR',
    symbol: 'CW8',
    currency: 'EUR',
    eodhd: 'CW8.PA',
  },
  {
    name: 'SAP',
    type: 'stock',
    isin: 'DE0007164600',
    sector: 'Information Technology',
    mic: 'XETR',
    symbol: 'SAP',
    currency: 'EUR',
    eodhd: 'SAP.XETRA',
  },
  {
    name: 'Shell',
    type: 'stock',
    isin: 'GB00BP6MXD84',
    sector: 'Energy',
    mic: 'XLON',
    symbol: 'SHEL',
    currency: 'GBX',
    eodhd: 'SHEL.LSE',
  },
  {
    name: 'Microsoft',
    type: 'stock',
    isin: 'US5949181045',
    sector: 'Information Technology',
    mic: 'XNAS',
    symbol: 'MSFT',
    currency: 'USD',
    eodhd: 'MSFT.US',
  },
  {
    name: 'Apple',
    type: 'stock',
    isin: 'US0378331005',
    sector: 'Information Technology',
    mic: 'XNAS',
    symbol: 'AAPL',
    currency: 'USD',
    eodhd: 'AAPL.US',
  },
  {
    name: 'NVIDIA',
    type: 'stock',
    isin: 'US67066G1040',
    sector: 'Information Technology',
    mic: 'XNAS',
    symbol: 'NVDA',
    currency: 'USD',
    eodhd: 'NVDA.US',
  },
  {
    name: 'Amazon',
    type: 'stock',
    isin: 'US0231351067',
    sector: 'Consumer Discretionary',
    mic: 'XNAS',
    symbol: 'AMZN',
    currency: 'USD',
    eodhd: 'AMZN.US',
  },
  {
    name: 'Coca-Cola',
    type: 'stock',
    isin: 'US1912161007',
    sector: 'Consumer Staples',
    mic: 'XNYS',
    symbol: 'KO',
    currency: 'USD',
    eodhd: 'KO.US',
  },
] as const;

interface DevPosition {
  mic: string;
  symbol: string;
  quantity: string | null;
  reason: string;
}

const DEV_SPACES: {
  name: string;
  devRole: SpaceRole | null;
  positions: DevPosition[];
}[] = [
  {
    name: 'PEA',
    devRole: 'owner',
    positions: [
      {
        mic: 'XPAR',
        symbol: 'CW8',
        quantity: '12',
        reason: 'Ligne éligible au PEA sur Euronext Paris, cotée en EUR.',
      },
      { mic: 'XPAR', symbol: 'AI', quantity: '8', reason: 'Place principale (Euronext Paris).' },
      { mic: 'XPAR', symbol: 'MC', quantity: '3.5', reason: 'Place principale (Euronext Paris).' },
      {
        mic: 'XETR',
        symbol: 'SAP',
        quantity: '10',
        reason: 'Place principale (Xetra), cotée en EUR.',
      },
      {
        mic: 'XLON',
        symbol: 'SHEL',
        quantity: '100',
        reason: 'Cotée en pence (GBX) à Londres.',
      },
      {
        mic: 'XNAS',
        symbol: 'MSFT',
        quantity: null,
        reason: 'Liste de suivi : place principale US (Nasdaq).',
      },
    ],
  },
  {
    name: 'Actions US',
    devRole: 'viewer',
    positions: [
      { mic: 'XNAS', symbol: 'AAPL', quantity: '25', reason: 'Place principale US (Nasdaq).' },
      { mic: 'XNAS', symbol: 'NVDA', quantity: '25.5', reason: 'Place principale US (Nasdaq).' },
      { mic: 'XNAS', symbol: 'AMZN', quantity: '4', reason: 'Place principale US (Nasdaq).' },
      { mic: 'XNYS', symbol: 'KO', quantity: '40', reason: 'Place principale US (NYSE).' },
    ],
  },
  {
    // The dev user has no access to this space: manual IDOR checks (`pnpm admin -- space:list`).
    name: 'Famille',
    devRole: null,
    positions: [
      { mic: 'XNAS', symbol: 'AAPL', quantity: '1', reason: 'Place principale US (Nasdaq).' },
      { mic: 'XETR', symbol: 'SAP', quantity: '2', reason: 'Place principale (Xetra).' },
    ],
  },
];
