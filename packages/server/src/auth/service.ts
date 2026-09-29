import { ORPCError } from '@orpc/server';
import type { CurrentUser } from '@waddlers/contracts';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/create';
import { users } from '../db/schema';
import { readSessionToken, serializeClearedSessionCookie, serializeSessionCookie } from './cookie';
import { hashPassword, needsRehash, verifyDummy, verifyPassword } from './password';
import { LoginRateLimiter } from './rate-limit';
import {
  createSession,
  purgeExpiredSessions,
  refreshSession,
  resolveSession,
  revokeSession,
  revokeUserSessions,
  rotateSession,
  shouldRefreshSession,
  type ResolvedSession,
} from './sessions';

export interface AuthDeps {
  getDb: () => Database;
  now: () => Date;
  loginLimiter: LoginRateLimiter;
  /** Throttles wrong-current-password guesses on changePassword, per user. */
  passwordLimiter: LoginRateLimiter;
  clientIp: (headers: Headers) => string;
}

export interface AuthContext {
  headers: Headers;
  resHeaders?: Headers;
}

export const INVALID_CREDENTIALS_MESSAGE = 'Identifiants invalides';

function unauthorized(message = 'Unauthorized') {
  return new ORPCError('UNAUTHORIZED', { message });
}

function tooManyRequests(retryAfterMs: number) {
  return new ORPCError('TOO_MANY_REQUESTS', {
    message: 'Too many attempts',
    data: { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
  });
}

function toCurrentUser(user: { id: string; username: string }): CurrentUser {
  return { id: user.id, username: user.username };
}

/**
 * Resolves the session behind the request's cookie. Sliding expiry is applied only when the
 * response can carry a refreshed cookie (`resHeaders` present, i.e. through the HTTP handler);
 * SSR/RSC reads never write, otherwise the DB expiry would move without the cookie following.
 */
export async function authenticate(
  deps: AuthDeps,
  ctx: AuthContext,
): Promise<ResolvedSession | null> {
  const token = readSessionToken(ctx.headers.get('cookie'));
  if (!token) return null;
  const now = deps.now();
  const db = deps.getDb();
  const session = await resolveSession(db, token, now);
  if (!session) return null;
  if (ctx.resHeaders && shouldRefreshSession(session, now)) {
    const expiresAt = await refreshSession(db, session.sessionId, now);
    ctx.resHeaders.append('set-cookie', serializeSessionCookie(token));
    return { ...session, lastSeenAt: now, expiresAt };
  }
  return session;
}

export async function login(
  deps: AuthDeps,
  ctx: AuthContext,
  input: { username: string; password: string },
): Promise<{ user: CurrentUser }> {
  const ip = deps.clientIp(ctx.headers);
  const blockedMs = deps.loginLimiter.check(input.username, ip);
  if (blockedMs > 0) throw tooManyRequests(blockedMs);

  const db = deps.getDb();
  const [user] = await db.select().from(users).where(eq(users.username, input.username)).limit(1);

  // Same work for unknown, disabled and wrong-password cases (timing), same error.
  const valid =
    user && user.disabledAt === null
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyDummy(input.password);
  if (!user || !valid) {
    deps.loginLimiter.recordFailure(input.username, ip);
    throw unauthorized(INVALID_CREDENTIALS_MESSAGE);
  }

  deps.loginLimiter.recordSuccess(input.username, ip);
  const now = deps.now();
  if (needsRehash(user.passwordHash)) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(input.password), updatedAt: now })
      .where(eq(users.id, user.id));
  }

  // A presented session is replaced (never reused) to prevent fixation.
  const previous = readSessionToken(ctx.headers.get('cookie'));
  if (previous) {
    const old = await resolveSession(db, previous, now);
    if (old) await revokeSession(db, old.sessionId);
  }
  await purgeExpiredSessions(db, user.id, now);
  const { token } = await createSession(db, {
    userId: user.id,
    userAgent: ctx.headers.get('user-agent'),
    now,
  });
  ctx.resHeaders?.append('set-cookie', serializeSessionCookie(token));
  return { user: toCurrentUser(user) };
}

export async function logout(
  deps: AuthDeps,
  ctx: AuthContext,
  session: ResolvedSession,
): Promise<{ ok: true }> {
  await revokeSession(deps.getDb(), session.sessionId);
  ctx.resHeaders?.append('set-cookie', serializeClearedSessionCookie());
  return { ok: true };
}

export async function changePassword(
  deps: AuthDeps,
  ctx: AuthContext,
  session: ResolvedSession,
  input: { currentPassword: string; newPassword: string },
): Promise<{ user: CurrentUser }> {
  const limiterKey = session.user.id;
  const blockedMs = deps.passwordLimiter.check(limiterKey, '-');
  if (blockedMs > 0) throw tooManyRequests(blockedMs);

  const db = deps.getDb();
  const [user] = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
  if (!user || user.disabledAt !== null) throw unauthorized();
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    deps.passwordLimiter.recordFailure(limiterKey, '-');
    throw new ORPCError('INVALID_CURRENT_PASSWORD', {
      status: 400,
      message: 'Invalid current password',
    });
  }
  deps.passwordLimiter.recordSuccess(limiterKey, '-');

  const now = deps.now();
  const newHash = await hashPassword(input.newPassword);
  const { token } = await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: newHash, updatedAt: now })
      .where(eq(users.id, user.id));
    await revokeUserSessions(tx, user.id, session.sessionId);
    return rotateSession(tx, session.sessionId, now);
  });
  ctx.resHeaders?.append('set-cookie', serializeSessionCookie(token));
  return { user: toCurrentUser(user) };
}
