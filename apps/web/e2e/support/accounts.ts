import type { Page } from '@playwright/test';
import type { AccountKey } from './env';

export type Account = { username: string; password: string };

/** Credentials created by global setup for this scenario (see ACCOUNT_KEYS). */
export function account(key: AccountKey): Account {
  const raw = process.env['E2E_ACCOUNTS'];
  const all = raw ? (JSON.parse(raw) as Record<string, Account>) : {};
  const found = all[key];
  if (!found) throw new Error(`No E2E account "${key}" (global setup did not run?)`);
  return found;
}

export async function login(page: Page, username: string, password: string) {
  await page.getByLabel('Identifiant').fill(username);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}
