import { z } from 'zod';

/**
 * Fallback French messages for validation issues whose schema has no explicit message (e.g. the
 * lenient login schema), so English zod defaults never reach the UI. Messages set explicitly in
 * a schema (such as the password policy in @waddlers/contracts) take precedence.
 */
export function frenchIssueMessage(issue: { code: string }): string {
  switch (issue.code) {
    case 'too_small':
    case 'invalid_type':
      return 'Ce champ est requis.';
    case 'too_big':
      return 'Valeur trop longue.';
    default:
      return 'Valeur invalide.';
  }
}

z.config({ customError: (issue) => frenchIssueMessage(issue) });
