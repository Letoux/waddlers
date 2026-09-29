import { oc } from '@orpc/contract';
import { z } from 'zod';

/** Browser-safe oRPC contract. Never import server code here. */

// --- Shared rules (single source of truth; the UI reuses these schemas, it must not copy them) ---

/** Password policy: length only (NIST 800-63B style), no composition rules. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Au moins ${PASSWORD_MIN_LENGTH} caractères.`)
  .max(PASSWORD_MAX_LENGTH, `Au plus ${PASSWORD_MAX_LENGTH} caractères.`);

/** Username set by the admin: 3-64 characters among letters, digits, `.`, `_` and `-`; case-insensitive (citext). */
export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Au moins 3 caractères.')
  .max(64, 'Au plus 64 caractères.')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Lettres, chiffres, point, tiret et underscore uniquement.');

// --- health (public, liveness only) ---

export const healthOutputSchema = z.object({
  status: z.literal('ok'),
  /** ISO-8601 UTC timestamp. */
  time: z.iso.datetime(),
});
export type HealthOutput = z.infer<typeof healthOutputSchema>;

// --- system status (authenticated, includes dependency state) ---

export const systemStatusOutputSchema = z.object({
  /** `degraded` when a dependency (the database) is unavailable. */
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'unavailable']),
  time: z.iso.datetime(),
});
export type SystemStatusOutput = z.infer<typeof systemStatusOutputSchema>;

// --- auth ---

export const currentUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

/**
 * Login input is deliberately lenient (only bounded): the policy applies when a password is
 * set, never to what a user types at login (that would leak the policy to attackers).
 */
export const loginInputSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const changePasswordInputSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: newPasswordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'Le nouveau mot de passe doit différer de l’actuel.',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

export const sessionOutputSchema = z.object({ user: currentUserSchema });
export type SessionOutput = z.infer<typeof sessionOutputSchema>;

/** Typed 429 for login/changePassword; also sent as a `Retry-After` header. */
export const tooManyRequestsError = {
  status: 429,
  message: 'Too many attempts',
  data: z.object({ retryAfterSeconds: z.number().int().min(1) }),
} as const;

/**
 * Error codes the UI must handle:
 * - UNAUTHORIZED: bad credentials (login) or no/expired session (everything else);
 * - TOO_MANY_REQUESTS: login/changePassword throttled (retry later);
 * - INVALID_CURRENT_PASSWORD: changePassword with a wrong current password (session stays valid);
 * - BAD_REQUEST: input failed validation (never render `message`/`issues` raw).
 */
export const contract = {
  health: oc.input(z.undefined()).output(healthOutputSchema),
  systemStatus: oc.input(z.undefined()).output(systemStatusOutputSchema),
  auth: {
    login: oc
      .input(loginInputSchema)
      .output(sessionOutputSchema)
      .errors({ TOO_MANY_REQUESTS: tooManyRequestsError }),
    logout: oc.input(z.undefined()).output(z.object({ ok: z.literal(true) })),
    me: oc.input(z.undefined()).output(sessionOutputSchema),
    changePassword: oc
      .input(changePasswordInputSchema)
      .output(sessionOutputSchema)
      .errors({
        INVALID_CURRENT_PASSWORD: { status: 400, message: 'Invalid current password' },
        TOO_MANY_REQUESTS: tooManyRequestsError,
      }),
  },
};

export type Contract = typeof contract;

/** Procedures reachable without a session. Everything else requires `authed` (tested). */
export const PUBLIC_PROCEDURES = ['health', 'auth.login'] as const;
