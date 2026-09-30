import type { Page } from '@playwright/test';
import type { AccountKey } from './env';
import { spaceName } from './spaces';

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

/** Name of a space created for a scenario by global setup. */
export function scenarioSpaceName(key: AccountKey, label: 'A' | 'B'): string {
  const run = process.env['E2E_RUN_ID'];
  if (!run) throw new Error('E2E_RUN_ID missing (global setup did not run?)');
  return spaceName(run, key, label);
}

/** Id of a scenario space (created by global setup), whether or not the user is a member. */
export function scenarioSpaceId(key: AccountKey, label: 'A' | 'B'): string {
  const ids = JSON.parse(process.env['E2E_SPACE_IDS'] ?? '{}') as Record<string, string>;
  const id = ids[scenarioSpaceName(key, label)];
  if (!id) throw new Error(`No id for space ${key}/${label}`);
  return id;
}
