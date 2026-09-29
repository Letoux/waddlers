// CLI entry for Compose/CI/local: `pnpm --filter @waddlers/server db:migrate`.
import { runMigrations } from '../db/migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
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
