/**
 * Secret redaction for anything that may reach a log line, an error message or a stored value.
 * Provider errors routinely embed the request URL (`?api_token=...`), so every provider message
 * goes through `redactSecrets` before it leaves the wrapper.
 */

const REDACTED = '[REDACTED]';

// Query/header style secrets, whatever the provider names them.
const SECRET_PARAM =
  /((?:api[_-]?token|api[_-]?key|apikey|access[_-]?token|access[_-]?key|token|key|secret|password|authorization)(?:=|%3d))[^&\s"'<>]*/gi;
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const BASIC = /(basic\s+)[A-Za-z0-9._~+/=-]+/gi;

export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
    .replace(SECRET_PARAM, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(BASIC, `$1${REDACTED}`);
  for (const secret of secrets) {
    // Very short values would shred the message; real API keys are longer than this.
    if (!secret || secret.length < 4) continue;
    for (const form of secretForms(secret)) out = out.split(form).join(REDACTED);
  }
  return out;
}

/** The secret as it may appear in a URL (percent-encoded) or an encoded header (base64). */
function secretForms(secret: string): string[] {
  const base64 = Buffer.from(secret).toString('base64');
  const forms = new Set([
    secret,
    encodeURIComponent(secret),
    base64,
    base64.replace(/=+$/, ''),
    base64.replace(/\+/g, '-').replace(/\//g, '_'),
    base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  ]);
  // Longest first so a form is never half-replaced by a shorter one that it contains.
  return [...forms].filter((f) => f.length >= 4).sort((a, b) => b.length - a.length);
}

/** Redacted message of any thrown value (never the stack: it embeds the same text). */
export function safeErrorMessage(
  error: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecrets(raw, secrets).slice(0, 300);
}
