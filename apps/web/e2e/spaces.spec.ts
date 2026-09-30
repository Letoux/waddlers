import { expect, test, type Page } from '@playwright/test';
import { account, login, scenarioSpaceId, scenarioSpaceName } from './support/accounts';
import type { AccountKey } from './support/env';

async function signIn(page: Page, key: AccountKey) {
  const { username, password } = account(key);
  await page.goto('/login');
  await login(page, username, password);
  await expect(page).not.toHaveURL(/\/login/);
}

const selector = (page: Page) => page.getByRole('combobox', { name: 'Espace' });
const rowFor = (page: Page, name: string) =>
  page.getByTestId('position-row').filter({ hasText: name });
const nbsp = ' ';

/** Waits for the request that records the active space (persisted before we log out). */
function activeSpaceSaved(page: Page) {
  return page.waitForResponse(
    (r) => r.url().includes('/api/rpc/spaces/setActive') && r.status() === 200,
  );
}

test.describe('sélection d’un espace', () => {
  test('login lands on the active space, the selector switches, and the choice is remembered', async ({
    page,
  }) => {
    const nameA = scenarioSpaceName('space-nav', 'A');
    const nameB = scenarioSpaceName('space-nav', 'B');
    await signIn(page, 'space-nav');

    // First by name, since nothing was opened before.
    await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: nameA })).toBeVisible();
    await expect(page.getByTestId('space-role')).toHaveText('Propriétaire');
    await expect(page.getByTestId('tracked-count')).toHaveText('4');
    await expect(selector(page)).toContainText(nameA);

    // The active nav item is highlighted; the sub-page is kept when switching.
    await page.getByRole('link', { name: 'Titres' }).click();
    await expect(page).toHaveURL(/\/titres$/);
    await expect(page.getByRole('link', { name: 'Titres' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(rowFor(page, 'Air Liquide')).toBeVisible();
    await expect(page.getByTestId('position-row')).toHaveCount(4);

    const saved = activeSpaceSaved(page);
    await selector(page).click();
    await page.getByRole('option', { name: nameB }).click();
    await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}\/titres$/);
    await expect(page.getByText(`Espace ${nameB}`)).toBeVisible();
    await expect(page.getByTestId('position-row')).toHaveCount(1);
    await expect(rowFor(page, 'SAP')).toBeVisible();
    await expect(rowFor(page, 'Air Liquide')).toHaveCount(0);
    await saved;

    // The Espaces page shows role and count, and marks the active space.
    await page.getByRole('link', { name: 'Espaces' }).click();
    const item = page.getByTestId('space-item').filter({ hasText: nameB });
    await expect(item).toContainText('Éditeur');
    await expect(item).toContainText('1 titre');
    await expect(item).toContainText('Espace actif');
    await expect(page.getByTestId('space-item').filter({ hasText: nameA })).toContainText(
      '4 titres',
    );

    // Log out and in again: back to the last active space.
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, 'space-nav');
    await expect(page.getByRole('heading', { level: 1, name: nameB })).toBeVisible();
    await expect(page.getByTestId('space-role')).toHaveText('Éditeur');
  });

  test('opening a space from the Espaces page makes it the active space', async ({ page }) => {
    await signIn(page, 'space-forbidden');
    await page.goto('/espaces');
    const nameA = scenarioSpaceName('space-forbidden', 'A');
    const item = page.getByTestId('space-item').filter({ hasText: nameA });
    await expect(item).toHaveCount(1);
    // A space nobody granted is invisible.
    await expect(page.getByTestId('space-item')).toHaveCount(1);
    await item.getByRole('link', { name: /Ouvrir/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: nameA })).toBeVisible();
  });

  test('an inaccessible or unknown space shows the same not-found page', async ({ page }) => {
    await signIn(page, 'space-forbidden');
    await expect(page.getByTestId('space-selector')).toBeVisible();

    // The foreign space exists but the user is not a member: same answer as for an id that
    // does not exist, and as for a malformed id.
    for (const path of [
      `/s/${scenarioSpaceId('space-forbidden', 'B')}`,
      `/s/${scenarioSpaceId('space-forbidden', 'B')}/titres`,
      '/s/00000000-0000-4000-8000-000000000000',
      '/s/00000000-0000-4000-8000-000000000000/titres',
      '/s/not-a-uuid',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible();
      await expect(
        page.getByText('Cette page n’existe pas ou vous n’y avez pas accès.'),
      ).toBeVisible();
    }
    // Still inside the shell: the header is usable.
    await expect(page.getByRole('link', { name: 'Espaces' })).toBeVisible();
  });

  test('a user without any space sees the empty state', async ({ page }) => {
    await signIn(page, 'space-none');
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByText('Aucun espace disponible. Contactez l’administrateur.'),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Espace' })).toHaveCount(0);
  });

  test('an editor edits a quantity with a comma decimal and it persists', async ({ page }) => {
    await signIn(page, 'space-edit');
    await page.getByRole('link', { name: 'Titres' }).click();
    const row = rowFor(page, 'Air Liquide');
    await expect(row.getByTestId('quantity')).toContainText('8');
    // Read-only details of the row.
    await expect(row).toContainText('Action');
    await expect(row).toContainText('AI');
    await expect(row).toContainText('Euronext Paris');
    await expect(row).toContainText('EUR');

    await row.getByRole('button', { name: /Modifier la quantité de Air Liquide/ }).click();
    const input = page.getByRole('textbox', { name: 'Quantité de Air Liquide' });
    await expect(input).toBeFocused();
    await input.fill('1 234,56');
    await input.press('Enter');
    await expect(page.getByText('Quantité mise à jour.').first()).toBeVisible();
    await expect(row.getByTestId('quantity')).toContainText(`1${nbsp}234,56`);
    await expect(page.getByTestId('save-status')).toHaveText('Quantité mise à jour.');
    // Focus goes back to the edit button.
    await expect(
      row.getByRole('button', { name: /Modifier la quantité de Air Liquide/ }),
    ).toBeFocused();

    await page.reload();
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).toContainText(
      `1${nbsp}234,56`,
    );
    // The edit text uses the decimal comma too.
    await rowFor(page, 'Air Liquide')
      .getByRole('button', { name: /Modifier la quantité/ })
      .click();
    await expect(page.getByRole('textbox', { name: 'Quantité de Air Liquide' })).toHaveValue(
      '1234,56',
    );
  });

  test('invalid input is rejected client side, Escape cancels, blur saves', async ({ page }) => {
    await signIn(page, 'space-edit');
    await page.getByRole('link', { name: 'Titres' }).click();
    const row = rowFor(page, 'LVMH');
    await expect(row.getByTestId('quantity')).toContainText('3,5');

    await row.getByRole('button', { name: /Modifier la quantité/ }).click();
    const input = page.getByRole('textbox', { name: 'Quantité de LVMH' });
    await input.fill('1,123456789');
    await input.press('Enter');
    await expect(page.getByText('Quantité invalide')).toBeVisible();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused();

    await input.fill('99');
    await input.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Quantité de LVMH' })).toHaveCount(0);
    await expect(row.getByTestId('quantity')).toContainText('3,5');

    await row.getByRole('button', { name: /Modifier la quantité/ }).click();
    await page.getByRole('textbox', { name: 'Quantité de LVMH' }).fill('7');
    await page.getByRole('heading', { name: 'Titres', level: 1 }).click(); // blur
    await expect(row.getByTestId('quantity')).toContainText('7');
    await expect(page.getByText('Quantité mise à jour.').first()).toBeVisible();
  });

  test('clearing the quantity shows a dash, not zero', async ({ page }) => {
    await signIn(page, 'space-clear');
    await page.getByRole('link', { name: 'Titres' }).click();
    const row = rowFor(page, 'LVMH');
    await row.getByRole('button', { name: /Modifier la quantité/ }).click();
    const input = page.getByRole('textbox', { name: 'Quantité de LVMH' });
    await input.fill('');
    await input.press('Enter');
    await expect(row.getByTestId('quantity')).toContainText('—');
    await expect(row.getByTestId('quantity')).not.toHaveText(/(^|\s)0(\s|$)/);
    await page.reload();
    await expect(rowFor(page, 'LVMH').getByTestId('quantity')).toContainText('—');

    // 0 is a real quantity, distinct from "no quantity".
    await rowFor(page, 'LVMH')
      .getByRole('button', { name: /Modifier la quantité/ })
      .click();
    await page.getByRole('textbox', { name: 'Quantité de LVMH' }).fill('0');
    await page.getByRole('textbox', { name: 'Quantité de LVMH' }).press('Enter');
    await expect(rowFor(page, 'LVMH').getByTestId('quantity')).toHaveText(/^\s*0\s*$/);
  });

  test('removing a position asks for confirmation', async ({ page }) => {
    await signIn(page, 'space-remove');
    await page.getByRole('link', { name: 'Titres' }).click();
    await expect(page.getByTestId('position-row')).toHaveCount(2);

    const trigger = rowFor(page, 'LVMH').getByRole('button', { name: 'Retirer LVMH de l’espace' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Retirer ce titre ?' });
    await expect(dialog).toBeVisible();

    // Cancel keeps the row and returns focus to the trigger.
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId('position-row')).toHaveCount(2);

    await trigger.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Retirer', exact: true }).dblclick();
    await expect(page.getByText('Titre retiré de l’espace.').first()).toBeVisible();
    await expect(page.getByTestId('position-row')).toHaveCount(1);
    await expect(rowFor(page, 'LVMH')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('position-row')).toHaveCount(1);
    await expect(rowFor(page, 'Air Liquide')).toBeVisible();
  });

  test('a viewer sees values but no edit controls', async ({ page }) => {
    await signIn(page, 'space-viewer');
    await expect(page.getByTestId('space-role')).toHaveText('Lecteur');
    await page.getByRole('link', { name: 'Titres' }).click();
    await expect(page.getByTestId('position-row')).toHaveCount(2);
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).toContainText('8');
    // Watchlist entry: dash, never 0.
    await expect(rowFor(page, 'Microsoft').getByTestId('quantity')).toContainText('—');
    await expect(page.getByRole('button', { name: /Modifier la quantité/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Retirer/ })).toHaveCount(0);
    await expect(page.getByText('Lecture seule')).toBeVisible();
  });

  test('the raw currency is shown and never divided (GBX)', async ({ page }) => {
    await signIn(page, 'space-currency');
    await page.getByRole('link', { name: 'Titres' }).click();
    const shell = rowFor(page, 'Shell');
    await expect(shell).toContainText('GBX');
    await expect(shell.getByTestId('quantity')).toContainText(`1${nbsp}234,5`);
  });

  test('at 375px there is no horizontal overflow and the selector is reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, 'space-mobile');
    const nameB = scenarioSpaceName('space-mobile', 'B');
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await overflow()).toBe(false);
    await expect(selector(page)).toBeVisible();

    // Compact menu with the same links.
    await page.getByRole('button', { name: 'Menu' }).click();
    const menu = page.getByRole('dialog');
    await expect(menu.getByRole('link', { name: 'Titres' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Espaces' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Paramètres' })).toBeVisible();
    await menu.getByRole('link', { name: 'Titres' }).click();
    await expect(page).toHaveURL(/\/titres$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('position-row')).toHaveCount(2);
    expect(await overflow()).toBe(false);

    await selector(page).click();
    await page.getByRole('option', { name: nameB }).click();
    await expect(page.getByTestId('position-row')).toHaveCount(1);
    expect(await overflow()).toBe(false);

    await page.goto('/espaces');
    await expect(page.getByTestId('space-item')).toHaveCount(2);
    expect(await overflow()).toBe(false);
  });
});
