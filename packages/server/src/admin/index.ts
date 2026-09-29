import { usernameSchema } from '@waddlers/contracts';
import { eq, sql } from 'drizzle-orm';
import { checkPasswordPolicy, hashPassword } from '../auth/password';
import { revokeUserSessions } from '../auth/sessions';
import type { Database } from '../db/create';
import { sessions, users } from '../db/schema';

export { createDatabase, type Database } from '../db/create';
export { runAdminCli, USAGE, type CliIo } from './cli';
export { readSecret } from './prompt';
export { seedDevUser } from './seed';

/** Operator-facing error: the message is safe to print (never contains secrets). */
export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminError';
  }
}

function parseUsername(raw: string): string {
  const result = usernameSchema.safeParse(raw);
  if (!result.success) {
    throw new AdminError(`Invalid username: ${result.error.issues[0]?.message ?? 'invalid'}`);
  }
  return result.data;
}

function assertPassword(password: string): void {
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new AdminError(`Password rejected: ${policy.reason}`);
}

async function findUser(db: Database, username: string) {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return user;
}

export async function createUser(
  db: Database,
  input: { username: string; password: string },
): Promise<{ id: string; username: string }> {
  const username = parseUsername(input.username);
  assertPassword(input.password);
  if (await findUser(db, username)) throw new AdminError('User already exists');
  const [created] = await db
    .insert(users)
    .values({ username, passwordHash: await hashPassword(input.password) })
    .returning({ id: users.id, username: users.username });
  if (!created) throw new AdminError('User creation failed');
  return created;
}

/** Sets a new password and revokes every session of the user. Re-enables nothing. */
export async function resetPassword(
  db: Database,
  input: { username: string; password: string },
): Promise<{ revokedSessions: number }> {
  const username = parseUsername(input.username);
  assertPassword(input.password);
  const user = await findUser(db, username);
  if (!user) throw new AdminError('User not found');
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: sql`now()` })
      .where(eq(users.id, user.id));
    return { revokedSessions: await countAndRevoke(tx, user.id) };
  });
}

/** Idempotent: disabling an already disabled user keeps the original timestamp. */
export async function disableUser(
  db: Database,
  input: { username: string },
): Promise<{ revokedSessions: number }> {
  const username = parseUsername(input.username);
  const user = await findUser(db, username);
  if (!user) throw new AdminError('User not found');
  return db.transaction(async (tx) => {
    if (user.disabledAt === null) {
      await tx
        .update(users)
        .set({ disabledAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(users.id, user.id));
    }
    return { revokedSessions: await countAndRevoke(tx, user.id) };
  });
}

async function countAndRevoke(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  userId: string,
) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  await revokeUserSessions(tx, userId);
  return row?.n ?? 0;
}
