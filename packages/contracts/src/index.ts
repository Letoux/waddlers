import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  dashboardHistoryInputSchema,
  dashboardHistoryOutputSchema,
  dashboardInputSchema,
  dashboardMoversOutputSchema,
  dashboardSummaryOutputSchema,
} from './dashboard';

export * from './dashboard';

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

// --- spaces & positions (S3) ---

export const SPACE_ROLES = ['owner', 'editor', 'viewer'] as const;
export const spaceRoleSchema = z.enum(SPACE_ROLES);
export type SpaceRole = z.infer<typeof spaceRoleSchema>;

/** Roles allowed to change quantities and remove positions. `viewer` is read-only. */
export const SPACE_WRITER_ROLES = ['owner', 'editor'] as const satisfies readonly SpaceRole[];

/** Numeric column of `space_positions.quantity`: numeric(24, 8). */
export const QUANTITY_MAX_INTEGER_DIGITS = 16;
export const QUANTITY_MAX_FRACTION_DIGITS = 8;

/**
 * Non-negative plain decimal string, bounded like the column (at most 16 integer digits and 8
 * fraction digits). Rejects exponents, thousands separators, signs, blanks, `NaN`, a leading
 * dot/trailing dot and superfluous leading zeros. Numbers are never accepted (floats).
 */
export const quantitySchema = z
  .string()
  .regex(
    new RegExp(
      `^(0|[1-9][0-9]{0,${QUANTITY_MAX_INTEGER_DIGITS - 1}})(\\.[0-9]{1,${QUANTITY_MAX_FRACTION_DIGITS}})?$`,
    ),
    'Quantité invalide : nombre positif ou nul, au plus 16 chiffres avant et 8 après la virgule (séparateur « . »).',
  );

/** `null` = watchlist entry (no quantity), never 0. */
export const nullableQuantitySchema = quantitySchema.nullable();

export const spaceIdInputSchema = z.object({ spaceId: z.uuid() });

export const spaceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** ISO 4217 major currency (EUR only in the MVP, D7). */
  referenceCurrency: z.string(),
  /** The caller's role in this space. */
  role: spaceRoleSchema,
  positionCount: z.number().int().min(0),
});
export type SpaceSummary = z.infer<typeof spaceSummarySchema>;

export const spacesListOutputSchema = z.object({
  spaces: z.array(spaceSummarySchema),
  /**
   * The space to open by default: the user's last active space if still accessible, otherwise
   * the first accessible space by name; `null` when the user has no space.
   */
  activeSpaceId: z.uuid().nullable(),
});
export type SpacesListOutput = z.infer<typeof spacesListOutputSchema>;

export const positionRowSchema = z.object({
  id: z.uuid(),
  /** Decimal string (no exponent), `null` = watchlist entry. */
  quantity: z.string().nullable(),
  /** Why this listing was retained (specs 35); `null` when not recorded. */
  selectionReason: z.string().nullable(),
  addedAt: z.iso.datetime(),
  instrument: z.object({
    id: z.uuid(),
    name: z.string(),
    type: z.enum(['stock', 'etf']),
    isin: z.string().nullable(),
  }),
  listing: z.object({
    id: z.uuid(),
    symbol: z.string(),
    exchange: z.object({ mic: z.string(), name: z.string() }),
    /** Provider's raw quote currency (may be a minor unit such as `GBX`). */
    currency: z.string(),
    /** Major currency of `currency` (`GBX` -> `GBP`); `null` when the code is not recognised. */
    currencyMajor: z.string().nullable(),
    /** Minor units per major unit (100 for `GBX`, 1 otherwise); `null` when not recognised. */
    minorUnitDivisor: z.number().int().positive().nullable(),
  }),
});
export type PositionRow = z.infer<typeof positionRowSchema>;

/** `positions.list` returns at most this many rows per page (S6 adds server sort, filter and search). */
export const POSITIONS_LIST_MAX = 1000;

/**
 * Omitted `page` = first page of `POSITIONS_LIST_MAX` rows (the S3 behaviour). Offset pagination
 * over a stable order (instrument name case-insensitive, then id).
 */
export const positionsListInputSchema = spaceIdInputSchema.extend({
  page: z
    .object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(POSITIONS_LIST_MAX).default(POSITIONS_LIST_MAX),
    })
    .optional(),
});
export type PositionsListInput = z.infer<typeof positionsListInputSchema>;

export const positionsListOutputSchema = z.object({
  rows: z.array(positionRowSchema),
  /** Positions matching the query (today: every position of the space), not just this page. */
  total: z.number().int().min(0),
  /** `offset + rows.length < total`: more rows exist after this page. */
  hasMore: z.boolean(),
});
export type PositionsListOutput = z.infer<typeof positionsListOutputSchema>;

export const setQuantityInputSchema = z.object({
  spaceId: z.uuid(),
  positionId: z.uuid(),
  quantity: nullableQuantitySchema,
});
export type SetQuantityInput = z.infer<typeof setQuantityInputSchema>;

export const removePositionInputSchema = z.object({ spaceId: z.uuid(), positionId: z.uuid() });

/** Typed 429 for login/changePassword and dashboard.summary/history; also sent as a `Retry-After` header. */
export const tooManyRequestsError = {
  status: 429,
  message: 'Too many attempts',
  data: z.object({ retryAfterSeconds: z.number().int().min(1) }),
} as const;

/**
 * Error codes the UI must handle:
 * - UNAUTHORIZED: bad credentials (login) or no/expired session (everything else);
 * - TOO_MANY_REQUESTS: login/changePassword throttled, or dashboard.summary/history over the per-user
 *   concurrency/rate cap (retry after `data.retryAfterSeconds`);
 * - INVALID_CURRENT_PASSWORD: changePassword with a wrong current password (session stays valid);
 * - BAD_REQUEST: input failed validation (never render `message`/`issues` raw);
 * - NOT_FOUND: space-scoped procedures, for a space the caller cannot access AND for a space or
 *   position that does not exist (indistinguishable on purpose);
 * - FORBIDDEN: the caller can access the space but their role is too low (viewer writing).
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
  spaces: {
    /** Spaces the caller belongs to (never others), with role and position count. */
    list: oc.input(z.undefined()).output(spacesListOutputSchema),
    /** Any accessible space; NOT_FOUND otherwise. */
    get: oc.input(spaceIdInputSchema).output(spaceSummarySchema),
    /** Remembers the space as the caller's active one (access-checked). */
    setActive: oc.input(spaceIdInputSchema).output(z.object({ activeSpaceId: z.uuid() })),
  },
  positions: {
    /** `asOf` (data freshness) is added with the market data in S4/S6. */
    list: oc.input(positionsListInputSchema).output(positionsListOutputSchema),
    /** owner/editor only. `quantity: null` turns the entry into a watchlist entry. */
    setQuantity: oc
      .input(setQuantityInputSchema)
      .output(z.object({ positionId: z.uuid(), quantity: z.string().nullable() })),
    /** owner/editor only. NOT_FOUND when the position is not in that space (also when already removed). */
    remove: oc.input(removePositionInputSchema).output(z.object({ ok: z.literal(true) })),
  },
  /**
   * S5, all viewer-level and space-scoped. They read PostgreSQL only (never a provider); the
   * worker keeps the data fresh. `period` is one of 1w | 1m | 6m | 1y | 5y | max.
   */
  dashboard: {
    /** Current value (partial total + `missing`, D5), period change, freshness. */
    summary: oc
      .input(dashboardInputSchema)
      .output(dashboardSummaryOutputSchema)
      .errors({ TOO_MANY_REQUESTS: tooManyRequestsError }),
    /** Value series of the CURRENT positions (D6/D20), at most 400 points; `fxMode` (D22) defaults to `historical`. */
    history: oc
      .input(dashboardHistoryInputSchema)
      .output(dashboardHistoryOutputSchema)
      .errors({ TOO_MANY_REQUESTS: tooManyRequestsError }),
    /** Top 5 gainers and losers by period performance (local currency, D4). */
    movers: oc.input(dashboardInputSchema).output(dashboardMoversOutputSchema),
  },
};

export type Contract = typeof contract;

/** Procedures reachable without a session. Everything else requires `authed` (tested). */
export const PUBLIC_PROCEDURES = ['health', 'auth.login'] as const;
