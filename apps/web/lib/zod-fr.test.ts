import { loginInputSchema, newPasswordSchema } from '@waddlers/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { frenchIssueMessage } from './zod-fr';

const opts = { error: frenchIssueMessage } as const;

describe('French fallback validation messages', () => {
  it('replaces English defaults on the lenient login schema', () => {
    const r = loginInputSchema.safeParse({ username: '', password: '' }, opts);
    expect(r.error?.issues.map((i) => i.message)).toEqual([
      'Ce champ est requis.',
      'Ce champ est requis.',
    ]);
  });

  it('distinguishes required from too short / too long', () => {
    expect(z.string().min(5).safeParse('abc', opts).error?.issues[0]?.message).toBe(
      'Valeur trop courte.',
    );
    expect(z.string().max(2).safeParse('abc', opts).error?.issues[0]?.message).toBe(
      'Valeur trop longue.',
    );
    expect(z.string().safeParse(undefined, opts).error?.issues[0]?.message).toBe(
      'Ce champ est requis.',
    );
  });

  it('keeps explicit contract messages (password policy)', () => {
    const r = newPasswordSchema.safeParse('short', opts);
    expect(r.error?.issues[0]?.message).toBe('Au moins 12 caractères.');
  });

  it('is scoped: without the option the default is untouched (no global config)', () => {
    const r = z.string().min(1).safeParse('');
    expect(r.error?.issues[0]?.message).not.toBe('Ce champ est requis.');
  });
});
