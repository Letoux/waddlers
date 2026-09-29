import { usernameSchema } from '@waddlers/contracts';
import { checkPasswordPolicy, hashPassword } from '../auth/password';
import { revokeUserSessions } from '../auth/sessions';
import { findUserByUsername, insertUser, markUserDisabled, setPasswordHash } from '../auth/users';
import type { Database } from '../db/create';
import { AdminError } from './errors';

export { createDatabase, type Database } from '../db/create';
export { pgErrorCode } from '../db/errors';
export { AdminError } from './errors';
export { runAdminCli, USAGE, type CliIo } from './cli';
export { readSecret } from './prompt';
export { seedDevUser, seedDevWorkspace } from './seed';
export {
  addPosition,
  createSpace,
  grantSpace,
  listAllSpaces,
  parseListingRef,
  renameSpace,
  revokeSpace,
} from './spaces';

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

export async function createUser(
  db: Database,
  input: { username: string; password: string },
): Promise<{ id: string; username: string }> {
  const username = parseUsername(input.username);
  assertPassword(input.password);
  if (await findUserByUsername(db, username)) throw new AdminError('User already exists');
  const created = await insertUser(db, {
    username,
    passwordHash: await hashPassword(input.password),
  });
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
  const user = await findUserByUsername(db, username);
  if (!user) throw new AdminError('User not found');
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    await setPasswordHash(tx, user.id, passwordHash);
    return { revokedSessions: await revokeUserSessions(tx, user.id) };
  });
}

/** Idempotent: disabling an already disabled user keeps the original timestamp. */
export async function disableUser(
  db: Database,
  input: { username: string },
): Promise<{ revokedSessions: number }> {
  const username = parseUsername(input.username);
  const user = await findUserByUsername(db, username);
  if (!user) throw new AdminError('User not found');
  return db.transaction(async (tx) => {
    await markUserDisabled(tx, user);
    return { revokedSessions: await revokeUserSessions(tx, user.id) };
  });
}
