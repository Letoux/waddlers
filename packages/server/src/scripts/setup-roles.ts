// `pnpm db:setup-roles`: creates/updates the DML-only application role (see db/roles.ts).
// Run by the owner before/after migrations; idempotent.
import { setupAppRole } from '../db/roles';

const url = process.env.DATABASE_MIGRATE_URL || process.env.DATABASE_URL;
const password = process.env.APP_DB_PASSWORD;
if (!url || !password) {
  console.error('DATABASE_MIGRATE_URL (owner) and APP_DB_PASSWORD must be set.');
  process.exit(1);
}

try {
  await setupAppRole(url, {
    password,
    ...(process.env.APP_DB_USER ? { role: process.env.APP_DB_USER } : {}),
  });
  console.log('Application database role is up to date.');
} catch (error) {
  const code = (error as { code?: string } | null)?.code;
  const message =
    error instanceof Error && error.message.startsWith('APP_DB_PASSWORD')
      ? ` ${error.message}`
      : '';
  console.error(`Role setup failed${code ? ` (${code})` : ''}.${message}`);
  process.exit(1);
}
