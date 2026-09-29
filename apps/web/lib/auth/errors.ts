import { ORPCError } from '@orpc/client';

/**
 * Maps oRPC error codes to user-facing French messages. Raw server messages and validation
 * issues are never rendered (specs section 36).
 */

export const GENERIC_ERROR_MESSAGE = 'Une erreur est survenue. Veuillez réessayer.';
export const NETWORK_ERROR_MESSAGE = 'Impossible de joindre le serveur. Vérifiez votre connexion.';

/** "moins d'une minute", "3 minutes"... rounded up so the user is never told to retry early. */
export function formatWait(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return 'quelques minutes';
  }
  if (seconds <= 60) return 'moins d’une minute';
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}

function retryAfterSeconds(error: ORPCError<string, unknown>): number | undefined {
  const data = error.data;
  if (typeof data === 'object' && data !== null && 'retryAfterSeconds' in data) {
    const value = (data as { retryAfterSeconds: unknown }).retryAfterSeconds;
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function tooManyRequests(error: ORPCError<string, unknown>): string {
  return `Trop de tentatives. Réessayez dans ${formatWait(retryAfterSeconds(error))}.`;
}

export type LoginFailure = { kind: 'credentials' | 'throttled' | 'other'; message: string };

export function loginFailure(error: unknown): LoginFailure {
  if (error instanceof ORPCError) {
    if (error.code === 'UNAUTHORIZED') {
      return { kind: 'credentials', message: 'Identifiant ou mot de passe incorrect.' };
    }
    if (error.code === 'TOO_MANY_REQUESTS') {
      return { kind: 'throttled', message: tooManyRequests(error) };
    }
    return { kind: 'other', message: GENERIC_ERROR_MESSAGE };
  }
  // fetch failures (offline, server down) reject with a TypeError.
  if (error instanceof TypeError) return { kind: 'other', message: NETWORK_ERROR_MESSAGE };
  return { kind: 'other', message: GENERIC_ERROR_MESSAGE };
}

export type ChangePasswordFailure = {
  /** Field that should carry the error, or `form` for a general message. */
  target: 'currentPassword' | 'form';
  message: string;
  /** The session is gone: the user must sign in again. */
  sessionExpired: boolean;
};

export function changePasswordFailure(error: unknown): ChangePasswordFailure {
  if (error instanceof ORPCError) {
    switch (error.code) {
      case 'INVALID_CURRENT_PASSWORD':
        return {
          target: 'currentPassword',
          message: 'Le mot de passe actuel est incorrect.',
          sessionExpired: false,
        };
      case 'TOO_MANY_REQUESTS':
        return { target: 'form', message: tooManyRequests(error), sessionExpired: false };
      case 'UNAUTHORIZED':
        return {
          target: 'form',
          message: 'Votre session a expiré. Veuillez vous reconnecter.',
          sessionExpired: true,
        };
      default:
        return { target: 'form', message: GENERIC_ERROR_MESSAGE, sessionExpired: false };
    }
  }
  if (error instanceof TypeError) {
    return { target: 'form', message: NETWORK_ERROR_MESSAGE, sessionExpired: false };
  }
  return { target: 'form', message: GENERIC_ERROR_MESSAGE, sessionExpired: false };
}
