import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken } from './token';

describe('session tokens', () => {
  it('are 32 random bytes in base64url and never repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('hash to a deterministic hex SHA-256 that differs from the token', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
    // Known vector: sha256("abc")
    expect(hashSessionToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
