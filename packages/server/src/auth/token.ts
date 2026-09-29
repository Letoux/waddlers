import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url (43 chars). Only its SHA-256 is ever stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hex SHA-256. Tokens are high-entropy, so a fast unsalted hash is appropriate. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
