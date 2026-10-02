// Test-only fixture writing to the throwaway test database (see the header); app code never does.
// eslint-disable-next-line no-restricted-imports
import postgres from 'postgres';
import { E2E_DATABASE_URL } from './env';

/**
 * Bulk reference data for pagination scenarios: 60 unpriced instruments "Bulk 001" ... "Bulk 060"
 * on Euronext Paris. The admin CLI adds one position per call (too slow for 60), so the positions
 * of a bulk scenario are inserted with one statement against the throwaway test database (the
 * connection string is the same one global setup already verified with `assertSafeDatabase`).
 * Unpriced on purpose: their performance and price are null ("—").
 */
export const BULK_COUNT = 60;
const pad = (i: number) => String(i).padStart(3, '0');

const withSql = async <T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> => {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

/** Idempotent; called once from global setup. */
export async function seedBulkReferenceData() {
  await withSql(async (sql) => {
    for (let i = 1; i <= BULK_COUNT; i++) {
      const isin = `ZZE2EB00${pad(i)}0`;
      await sql`insert into instruments (type, name, isin, sector) values ('stock', ${`Bulk ${pad(i)}`}, ${isin}, 'Bulk') on conflict (isin) do nothing`;
      await sql`insert into listings (instrument_id, exchange_mic, symbol, currency)
        select id, 'XPAR', ${`EB${pad(i)}`}, 'EUR' from instruments where isin = ${isin}
        on conflict (exchange_mic, symbol) do nothing`;
    }
    await sql`insert into instruments (type, name, isin, sector) values ('stock', ${ACCENT_NAME}, ${ACCENT_ISIN}, 'Bulk') on conflict (isin) do nothing`;
    await sql`insert into listings (instrument_id, exchange_mic, symbol, currency)
      select id, 'XPAR', 'EACC', 'EUR' from instruments where isin = ${ACCENT_ISIN}
      on conflict (exchange_mic, symbol) do nothing`;
  });
}

/** One unpriced instrument with an accented name, to prove search ignores accents. */
export const ACCENT_NAME = 'Société Accentuée';
const ACCENT_ISIN = 'ZZE2EACC0010';

export async function addAccentPosition(spaceId: string) {
  await withSql(async (sql) => {
    await sql`insert into space_positions (space_id, instrument_id, listing_id)
      select ${spaceId}::uuid, i.id, l.id
      from instruments i join listings l on l.instrument_id = i.id and l.symbol = 'EACC'
      where i.isin = ${ACCENT_ISIN}
      on conflict do nothing`;
  });
}

/** Adds the first `count` bulk instruments to a space as watchlist entries (no quantity). */
export async function addBulkPositions(spaceId: string, count: number) {
  if (count < 1 || count > BULK_COUNT) throw new Error(`bulk count must be 1..${BULK_COUNT}`);
  await withSql(async (sql) => {
    await sql`insert into space_positions (space_id, instrument_id, listing_id)
      select ${spaceId}::uuid, i.id, l.id
      from instruments i join listings l on l.instrument_id = i.id and l.exchange_mic = 'XPAR'
      where i.isin like 'ZZE2EB00%' and i.isin <= ${`ZZE2EB00${pad(count)}0`}
      on conflict do nothing`;
  });
}
