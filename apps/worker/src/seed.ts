// Dev seed: `pnpm db:seed` (needs SEED_USER_PASSWORD; refuses NODE_ENV=production).
import { AdminError, createDatabase, seedDevUser } from '@waddlers/server/admin';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const { db, sql } = createDatabase(url, { max: 1 });
try {
  const result = await seedDevUser(db, process.env);
  console.log(`Seed user "${result.username}": ${result.status}.`);
} catch (error) {
  console.error(error instanceof AdminError ? error.message : 'Seed failed.');
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
