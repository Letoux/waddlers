import { ORPCError } from '@orpc/server';
import type { CurrentUser } from '@waddlers/contracts';
import type { Database } from '../db/create';
import {
  parseSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  setSessionCookieHeader,
} from './cookie';
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
import { findUserById, findUserByUsername, setPasswordHash } from './users';

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

/** Typed error constructors supplied by oRPC (`errors` handler argument). */
export interface TooManyRequestsErrors {
  TOO_MANY_REQUESTS: (options: { data: { retryAfterSeconds: number } }) => Error;
}
export interface ChangePasswordErrors extends TooManyRequestsErrors {
  INVALID_CURRENT_PASSWORD: () => Error;
}

export const INVALID_CREDENTIALS_MESSAGE = 'Identifiants invalides';

function unauthorized(message = 'Unauthorized') {
  return new ORPCError('UNAUTHORIZED', { message });
}

function throttled(errors: TooManyRequestsErrors, ctx: AuthContext, retryAfterMs: number): never {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  ctx.resHeaders?.set('retry-after', String(retryAfterSeconds));
  throw errors.TOO_MANY_REQUESTS({ data: { retryAfterSeconds } });
}

/**
 * Procedures that set or clear the cookie need a response to carry it. Without `resHeaders`
 * (server-side client) they must fail loudly instead of committing a session nobody receives.
 * Checked before any side effect.
 */
function requireResponseHeaders(ctx: AuthContext): Headers {
  if (!ctx.resHeaders) {
    throw new Error('Session-mutating procedures require an HTTP response (resHeaders).');
  }
  return ctx.resHeaders;
}

function toCurrentUser(user: { id: string; username: string }): CurrentUser {
  return { id: user.id, username: user.username };
}

/**
 * Resolves the session behind the request's cookie. Sliding expiry is applied only when the
 * response can carry a refreshed cookie (`resHeaders` present, i.e. through the HTTP handler);
 * SSR/RSC reads never write, otherwise the DB expiry would move without the cookie following.
 * Expired sessions never resolve, hence are never refreshed.
 */
export async function authenticate(
  deps: AuthDeps,
  ctx: AuthContext,
): Promise<ResolvedSession | null> {
  const token = parseSessionCookie(ctx.headers.get('cookie')).token;
  if (!token) return null;
  const now = deps.now();
  const db = deps.getDb();
  const session = await resolveSession(db, token, now);
  if (!session) return null;
  if (ctx.resHeaders && shouldRefreshSession(session, now)) {
    const expiresAt = await refreshSession(db, session.sessionId, now);
    setSessionCookieHeader(ctx.resHeaders, serializeSessionCookie(token));
    return { ...session, lastSeenAt: now, expiresAt };
  }
  return session;
}

export async function login(
  deps: AuthDeps,
  ctx: AuthContext,
  input: { username: string; password: string },
  errors: TooManyRequestsErrors,
): Promise<{ user: CurrentUser }> {
  const resHeaders = requireResponseHeaders(ctx);
  // Reserve the attempt synchronously (no await between check and count).
  const reservation = deps.loginLimiter.acquire(input.username, deps.clientIp(ctx.headers));
  if (!reservation.allowed) throttled(errors, ctx, reservation.retryAfterMs);

  const db = deps.getDb();
  const user = await findUserByUsername(db, input.username);

  // Same work for unknown, disabled and wrong-password cases (timing), same error.
  const valid =
    user && user.disabledAt === null
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyDummy(input.password);
  if (!user || !valid) throw unauthorized(INVALID_CREDENTIALS_MESSAGE);

  reservation.succeed();
  const now = deps.now();
  if (needsRehash(user.passwordHash)) {
    await setPasswordHash(db, user.id, await hashPassword(input.password), now);
  }

  // A presented session is replaced (never reused) to prevent fixation. One transaction:
  // either the user ends with the new session, or nothing changed.
  const previous = parseSessionCookie(ctx.headers.get('cookie')).token;
  const { token } = await db.transaction(async (tx) => {
    if (previous) {
      const old = await resolveSession(tx, previous, now);
      if (old) await revokeSession(tx, old.sessionId);
    }
    await purgeExpiredSessions(tx, user.id, now);
    return createSession(tx, {
      userId: user.id,
      userAgent: ctx.headers.get('user-agent'),
      now,
    });
  });
  setSessionCookieHeader(resHeaders, serializeSessionCookie(token));
  return { user: toCurrentUser(user) };
}

export async function logout(
  deps: AuthDeps,
  ctx: AuthContext,
  session: ResolvedSession,
): Promise<{ ok: true }> {
  const resHeaders = requireResponseHeaders(ctx);
  await revokeSession(deps.getDb(), session.sessionId);
  setSessionCookieHeader(resHeaders, serializeClearedSessionCookie());
  return { ok: true };
}

export async function changePassword(
  deps: AuthDeps,
  ctx: AuthContext,
  session: ResolvedSession,
  input: { currentPassword: string; newPassword: string },
  errors: ChangePasswordErrors,
): Promise<{ user: CurrentUser }> {
  const resHeaders = requireResponseHeaders(ctx);
  const reservation = deps.passwordLimiter.acquire(session.user.id, '-');
  if (!reservation.allowed) throttled(errors, ctx, reservation.retryAfterMs);

  const db = deps.getDb();
  const user = await findUserById(db, session.user.id);
  if (!user || user.disabledAt !== null) throw unauthorized();
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw errors.INVALID_CURRENT_PASSWORD();
  }
  reservation.succeed();

  const now = deps.now();
  const newHash = await hashPassword(input.newPassword);
  const rotated = await db.transaction(async (tx) => {
    // Rotation goes first-class in the transaction: if the session was revoked or expired
    // meanwhile (or the user disabled), throwing rolls the password change back.
    await setPasswordHash(tx, user.id, newHash, now);
    await revokeUserSessions(tx, user.id, session.sessionId);
    const result = await rotateSession(tx, session.sessionId, now);
    if (!result) throw unauthorized();
    return result;
  });
  setSessionCookieHeader(resHeaders, serializeSessionCookie(rotated.token));
  return { user: toCurrentUser(user) };
}
