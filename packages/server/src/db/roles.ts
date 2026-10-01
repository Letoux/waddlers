import postgres from 'postgres';

export const DEFAULT_APP_ROLE = 'waddlers_app';
/**
 * Per-role limits of the web app (security F1, S5): a statement that runs longer is cancelled and a
 * transaction left idle is terminated, so a slow or abandoned request cannot hold a pool
 * connection indefinitely. Set with `ALTER ROLE ... SET`: they apply to every NEW session of the
 * app role only (the owner/migration and worker roles are untouched: backfills may run long).
 */
export const APP_STATEMENT_TIMEOUT = '10s';
export const APP_IDLE_IN_TRANSACTION_TIMEOUT = '30s';

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
// URL-safe so the password can be embedded in DATABASE_URL without percent-encoding.
const URL_SAFE_PASSWORD = /^[A-Za-z0-9._~-]{16,128}$/;

/**
 * Idempotent least-privilege setup, run by the OWNER role (the one that runs migrations):
 * creates/updates a login role for the web app with DML only (SELECT/INSERT/UPDATE/DELETE on
 * public tables, sequence usage) and no DDL, no TRUNCATE, no access to the `drizzle` migrations
 * schema. Default privileges make tables created by later migrations (run by the owner)
 * accessible automatically. It also sets `statement_timeout` / `idle_in_transaction_session_timeout` on the role. A compromised web process (SQL injection, RCE) can therefore not
 * alter the schema or migration history.
 */
export async function setupAppRole(
  ownerUrl: string,
  options: { password: string; role?: string },
): Promise<void> {
  const role = options.role ?? DEFAULT_APP_ROLE;
  if (!ROLE_NAME.test(role)) throw new Error('Invalid role name.');
  if (!URL_SAFE_PASSWORD.test(options.password)) {
    throw new Error(
      'APP_DB_PASSWORD must be 16-128 URL-safe characters (A-Z a-z 0-9 . _ ~ -), e.g. `openssl rand -hex 24`.',
    );
  }
  const sql = postgres(ownerUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    // Role/database names and the password are quoted server-side by format(%I / %L).
    const [{ statements } = { statements: [] as string[] }] = await sql<{ statements: string[] }[]>`
      select array[
        case when exists (select 1 from pg_roles where rolname = ${role})
          then format('alter role %I with login nosuperuser nocreatedb nocreaterole password %L', ${role}::text, ${options.password}::text)
          else format('create role %I with login nosuperuser nocreatedb nocreaterole password %L', ${role}::text, ${options.password}::text)
        end,
        format('alter role %I set statement_timeout = %L', ${role}::text, ${APP_STATEMENT_TIMEOUT}::text),
        format('alter role %I set idle_in_transaction_session_timeout = %L', ${role}::text, ${APP_IDLE_IN_TRANSACTION_TIMEOUT}::text),
        format('grant connect on database %I to %I', current_database(), ${role}::text),
        'revoke create on schema public from public',
        format('revoke create on schema public from %I', ${role}::text),
        format('grant usage on schema public to %I', ${role}::text),
        format('grant select, insert, update, delete on all tables in schema public to %I', ${role}::text),
        format('grant usage, select on all sequences in schema public to %I', ${role}::text),
        format('alter default privileges in schema public grant select, insert, update, delete on tables to %I', ${role}::text),
        format('alter default privileges in schema public grant usage, select on sequences to %I', ${role}::text)
      ] as statements
    `;
    for (const statement of statements) await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
