import { expect, test } from '@playwright/test';
import { E2E_DB_DOWN_PORT } from './support/env';

// Second server, unreachable database. A (fake but well-formed) session cookie forces a session
// lookup, which fails: users must see the neutral French error, never Next's English default.
const baseURL = `http://localhost:${E2E_DB_DOWN_PORT}`;
test.use({ baseURL });

test('database down: neutral French error page, no technical detail', async ({ context, page }) => {
  await context.addCookies([
    {
      name: '__Host-wd_session',
      value: 'A'.repeat(43),
      domain: 'localhost',
      path: '/',
      secure: true,
    },
  ]);
  await page.goto('/settings');
  await expect(page.getByText('Une erreur est survenue')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/Application error|ECONNREFUSED|postgres|digest/i);
});
