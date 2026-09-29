import { loginInputSchema, newPasswordSchema } from '@waddlers/contracts';
import { describe, expect, it } from 'vitest';
import './zod-fr';

describe('French fallback validation messages', () => {
  it('replaces English defaults on the lenient login schema', () => {
    const r = loginInputSchema.safeParse({ username: '', password: '' });
    expect(r.success).toBe(false);
    const messages = r.error?.issues.map((i) => i.message);
    expect(messages).toEqual(['Ce champ est requis.', 'Ce champ est requis.']);
  });

  it('keeps explicit contract messages (password policy)', () => {
    const r = newPasswordSchema.safeParse('short');
    expect(r.error?.issues[0]?.message).toBe('Au moins 12 caractères.');
  });
});
