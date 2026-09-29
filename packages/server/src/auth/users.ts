import { eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '../db/create';
import { users, type User } from '../db/schema';

/** Users repository: the only place (with sessions.ts) that queries the users table. */

export async function findUserByUsername(
  db: DbExecutor,
  username: string,
): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return user;
}

export async function findUserById(db: DbExecutor, id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function insertUser(
  db: DbExecutor,
  input: { username: string; passwordHash: string },
): Promise<{ id: string; username: string } | undefined> {
  const [created] = await db
    .insert(users)
    .values(input)
    .returning({ id: users.id, username: users.username });
  return created;
}

export async function setPasswordHash(
  db: DbExecutor,
  userId: string,
  passwordHash: string,
  now: Date | null = null,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, updatedAt: now ?? sql`now()` })
    .where(eq(users.id, userId));
}

/** Idempotent: an already disabled user keeps its original timestamp. */
export async function markUserDisabled(db: DbExecutor, user: User): Promise<void> {
  if (user.disabledAt !== null) return;
  await db
    .update(users)
    .set({ disabledAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(users.id, user.id));
}
