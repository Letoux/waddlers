import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { newPasswordSchema } from '@waddlers/contracts';

/**
 * argon2id, OWASP-recommended minimum profile: m = 19 MiB, t = 2, p = 1. Chosen for a small
 * single-instance deployment (~40-60 ms per hash); raise memoryCost if the host allows.
 * Parameters are embedded in the PHC string, so raising them later only requires rehashing on
 * next successful login (`needsRehash`).
 */
/** `Algorithm.Argon2id` (ambient const enum, unusable under verbatimModuleSyntax). */
const ARGON2ID = 2 as Algorithm;

export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export type PasswordPolicyResult = { ok: true } | { ok: false; reason: string };

/** Server-side policy check (same schema the UI reuses): 12-256 chars, no composition rules. */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const result = newPasswordSchema.safeParse(password);
  return result.success
    ? { ok: true }
    : { ok: false, reason: result.error.issues[0]?.message ?? 'Invalid password' };
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Malformed hash: treat as a mismatch, never as an error path distinguishable by callers.
    return false;
  }
}

/** True when the stored hash was produced with weaker parameters than the current profile. */
export function needsRehash(passwordHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(passwordHash);
  if (!match) return true;
  const [, m, t, p] = match;
  return (
    Number(m) < ARGON2_PARAMS.memoryCost ||
    Number(t) < ARGON2_PARAMS.timeCost ||
    Number(p) !== ARGON2_PARAMS.parallelism
  );
}

let dummyHash: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  return (dummyHash ??= hashPassword('waddlers-dummy-password-for-timing'));
}

/** Starts computing the dummy hash in the background (errors surface on first real use). */
export function warmDummyHash(): void {
  getDummyHash().catch(() => {
    dummyHash = undefined;
  });
}

/**
 * Verifies against a throwaway hash (same parameters) so unknown/disabled accounts cost the
 * same as a wrong password. Always returns false.
 */
export async function verifyDummy(password: string): Promise<false> {
  await verifyPassword(await getDummyHash(), password);
  return false;
}
