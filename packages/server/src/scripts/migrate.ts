// CLI entry for Compose/CI/local: `pnpm db:migrate`. Uses the OWNER connection
// (DATABASE_MIGRATE_URL, falling back to DATABASE_URL for simple local setups).
// The root .env is loaded by the package script (node --env-file-if-exists); process env wins.
import { runMigrations } from '../db/migrate';
import { pgErrorCode } from '../db/errors';

const url = process.env.DATABASE_MIGRATE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_MIGRATE_URL (or DATABASE_URL) is not set.');
  process.exit(1);
}

try {
  await runMigrations(url);
  console.log('Migrations applied.');
} catch (error) {
  // Print the error name/code only: driver messages can embed connection details.
  const code = pgErrorCode(error);
  console.error(`Migration failed${code ? ` (${code})` : ''}.`);
  if (code === '42501') {
    console.error(
      'Permission denied: migrations need the database OWNER. Set DATABASE_MIGRATE_URL to the owner connection (not the DML-only app role).',
    );
  }
  process.exit(1);
}
