/**
 * Fallback French messages for validation issues whose schema has no explicit message (e.g. the
 * lenient login schema), so English zod defaults never reach the UI. Passed per form as the
 * parse-level `error` option (`zodResolver(schema, { error: frenchIssueMessage })`); messages set
 * explicitly in a schema (such as the password policy in @waddlers/contracts) take precedence.
 * Deliberately NOT a global `z.config`: that would also affect the server and other schemas.
 */
export function frenchIssueMessage(issue: { code: string; minimum?: unknown }): string {
  switch (issue.code) {
    case 'too_small':
      // minimum 1 on a string = "required"; a larger minimum is a length rule.
      return typeof issue.minimum === 'number' && issue.minimum > 1
        ? 'Valeur trop courte.'
        : 'Ce champ est requis.';
    case 'invalid_type':
      return 'Ce champ est requis.';
    case 'too_big':
      return 'Valeur trop longue.';
    default:
      return 'Valeur invalide.';
  }
}
