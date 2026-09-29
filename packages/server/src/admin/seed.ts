import type { Database } from '../db/create';
import { AdminError, createUser } from './index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

/**
 * Dev-only seed: one user with a password taken from the environment. Refuses to run in
 * production. Idempotent (an existing user is left untouched, its password is NOT reset).
 */
export async function seedDevUser(
  db: Database,
  env: Record<string, string | undefined>,
): Promise<{ status: 'created' | 'exists'; username: string }> {
  if (env.NODE_ENV === 'production') {
    throw new AdminError('Refusing to seed: NODE_ENV=production.');
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
