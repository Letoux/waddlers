import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMS,
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyDummy,
  verifyPassword,
} from './password';

describe('password policy', () => {
  it('requires 12 to 256 characters and nothing else', () => {
    expect(checkPasswordPolicy('a'.repeat(11)).ok).toBe(false);
    expect(checkPasswordPolicy('a'.repeat(12)).ok).toBe(true);
    expect(checkPasswordPolicy('a'.repeat(256)).ok).toBe(true);
    expect(checkPasswordPolicy('a'.repeat(257)).ok).toBe(false);
  });

  it('has no composition rules (lowercase-only, spaces, unicode all pass)', () => {
    expect(checkPasswordPolicy('correct horse battery').ok).toBe(true);
    expect(checkPasswordPolicy('mot de passe très long').ok).toBe(true);
    expect(checkPasswordPolicy('            ').ok).toBe(true);
  });
});

describe('argon2id hashing', () => {
  it('produces a salted argon2id PHC string with the documented parameters', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}\\$`,
      ),
    );
    expect(a).not.toBe(b); // unique salt
    expect(a).not.toContain('correct horse');
  });

  it('verifies the right password only, and treats a malformed hash as a mismatch', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse batterY')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await verifyPassword('', 'x')).toBe(false);
  });

  it('flags weaker or foreign hashes for rehash, not current ones', async () => {
    expect(needsRehash(await hashPassword('correct horse battery'))).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHQ$aGFzaA')).toBe(true);
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('dummy verification always fails but does the hashing work', async () => {
    expect(await verifyDummy('anything at all')).toBe(false);
  });
});
