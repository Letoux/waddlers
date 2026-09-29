import { and, eq, isNull, lt, ne, gt } from 'drizzle-orm';
import type { Database } from '../db/create';
import { sessions, users } from '../db/schema';
import { SESSION_TTL_MS } from './cookie';
import { generateSessionToken, hashSessionToken } from './token';

/** Sliding expiry: expires_at is pushed forward at most once per day (limits writes). */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const USER_AGENT_MAX = 256;

export interface SessionUser {
  id: string;
  username: string;
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
  lastSeenAt: Date;
  expiresAt: Date;
}

type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

export async function createSession(
  db: Executor,
  input: { userId: string; userAgent?: string | null; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    userId: input.userId,
    tokenHash: hashSessionToken(token),
    createdAt: input.now,
    lastSeenAt: input.now,
    expiresAt,
    userAgent: input.userAgent ? input.userAgent.slice(0, USER_AGENT_MAX) : null,
  });
  return { token, expiresAt };
}

/** Valid = token known, not expired, user not disabled. Anything else resolves to null. */
export async function resolveSession(
  db: Executor,
  token: string,
  now: Date,
): Promise<ResolvedSession | null> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      username: users.username,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        gt(sessions.expiresAt, now),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.sessionId,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    user: { id: row.userId, username: row.username },
  };
}

export function shouldRefreshSession(session: ResolvedSession, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= SESSION_REFRESH_AFTER_MS;
}

/** Idempotent: safe to repeat (same result, never shortens a session). */
export async function refreshSession(db: Executor, sessionId: string, now: Date): Promise<Date> {
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.update(sessions).set({ lastSeenAt: now, expiresAt }).where(eq(sessions.id, sessionId));
  return expiresAt;
}

export async function revokeSession(db: Executor, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Revokes every session of a user, optionally keeping one. */
export async function revokeUserSessions(
  db: Executor,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(
      exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
        : eq(sessions.userId, userId),
    );
}

/** Housekeeping: drops a user's expired sessions (called on login). */
export async function purgeExpiredSessions(db: Executor, userId: string, now: Date): Promise<void> {
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, now)));
}

/** Issues a fresh token for an existing session (same row, new secret, full sliding window). */
export async function rotateSession(
  db: Executor,
  sessionId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db
    .update(sessions)
    .set({ tokenHash: hashSessionToken(token), lastSeenAt: now, expiresAt })
    .where(eq(sessions.id, sessionId));
  return { token, expiresAt };
}
