import { eq } from 'drizzle-orm';
import type { Database } from '../db/create';
import { users } from '../db/schema';
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

/**
 * Dev-only seed: one user with a password taken from the environment. Refuses to run in
 * production, and unless BOTH APP_ORIGIN is localhost and the DATABASE_URL host is local
 * (localhost, 127.0.0.1, ::1, or the Compose service `postgres`), unless ALLOW_DEV_SEED=1 (a
 * staging/remote database must not receive a known dev password by accident). Idempotent: an existing user
 * is left untouched, its password is NOT reset.
 */
export async function seedDevUser(
  db: Database,
  env: Record<string, string | undefined>,
): Promise<{ status: 'created' | 'exists'; username: string }> {
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
  const username = env.SEED_USER_USERNAME || 'dev';
  const password = env.SEED_USER_PASSWORD;
  if (!password) throw new AdminError('SEED_USER_PASSWORD is not set.');
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existing) return { status: 'exists', username };
  await createUser(db, { username, password });
  return { status: 'created', username };
}
