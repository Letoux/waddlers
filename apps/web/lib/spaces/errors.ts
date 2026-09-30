import { ORPCError } from '@orpc/client';

/** Role labels (French UI). */
export const ROLE_LABELS = {
  owner: 'Propriétaire',
  editor: 'Éditeur',
  viewer: 'Lecteur',
} as const;

export type SpaceFailureKind = 'forbidden' | 'not_found' | 'other';

/** NOT_FOUND = inaccessible/unknown (never reveals which); FORBIDDEN = role too low. */
export function spaceFailureKind(error: unknown): SpaceFailureKind {
  if (error instanceof ORPCError) {
    if (error.code === 'FORBIDDEN') return 'forbidden';
    if (error.code === 'NOT_FOUND') return 'not_found';
  }
  return 'other';
}

export const FORBIDDEN_MESSAGE = 'Vous n’avez pas le droit de modifier cet espace.';
export const MUTATION_ERROR_MESSAGE = 'La modification a échoué. Veuillez réessayer.';
/** User-facing message for a failed write (raw server messages are never rendered). */
export function writeFailureMessage(error: unknown): string {
  return spaceFailureKind(error) === 'forbidden' ? FORBIDDEN_MESSAGE : MUTATION_ERROR_MESSAGE;
}
