// Dev seed: `pnpm db:seed` (needs SEED_USER_PASSWORD; refuses NODE_ENV=production).
import { AdminError, createDatabase, seedDevWorkspace } from '@waddlers/server/admin';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const { db, sql } = createDatabase(url, { max: 1 });
try {
  const result = await seedDevWorkspace(db, process.env);
  console.log(`Seed user "${result.user.username}": ${result.user.status}.`);
  for (const space of result.spaces) {
    const state = space.created
      ? space.access
        ? `created, you are ${space.access}`
        : 'created, no member (pnpm admin -- space:grant ...)'
      : 'already exists, left untouched';
    console.log(`Space "${space.name}" (${space.id}): ${state}.`);
  }
} catch (error) {
  console.error(error instanceof AdminError ? error.message : 'Seed failed.');
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
