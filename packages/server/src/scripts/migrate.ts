// CLI entry for Compose/CI/local: `pnpm db:migrate`. Uses the OWNER connection
// (DATABASE_MIGRATE_URL, falling back to DATABASE_URL for simple local setups).
// The root .env is loaded by the package script (node --env-file-if-exists); process env wins.
import { runMigrations } from '../db/migrate';

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
  const code = (error as { code?: string } | null)?.code;
  console.error(`Migration failed${code ? ` (${code})` : ''}.`);
  process.exit(1);
}
