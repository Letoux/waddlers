import type { Page } from '@playwright/test';
import { AI, expect, MC, MSFT_WATCH, SAP, SHEL, test } from './support/fixtures';

const selector = (page: Page) => page.getByRole('combobox', { name: 'Espace' });
const rowFor = (page: Page, name: string) =>
  page.getByTestId('position-row').filter({ hasText: name });
const editButton = (page: Page, name: string) =>
  rowFor(page, name).getByRole('button', { name: /Modifier la quantité/ });
const editor = (page: Page, name: string) =>
  page.getByRole('textbox', { name: `Quantité de ${name}` });
const GROUP = '\u202f'; // fr-FR thousands separator (narrow no-break space)

/** Waits for the request that records the active space (persisted before we log out). */
function activeSpaceSaved(page: Page) {
  return page.waitForResponse(
    (r) => r.url().includes('/api/rpc/spaces/setActive') && r.status() === 200,
  );
}

async function openTitres(page: Page) {
  await page.getByRole('link', { name: 'Titres' }).click();
  await expect(page).toHaveURL(/\/titres$/);
  await expect(page.getByTestId('position-row').first()).toBeVisible();
}

// Every test builds its own user, spaces and positions (support/fixtures.ts): nothing is shared,
// so tests can be repeated (`--repeat-each`) and retried. Creating them takes a few CLI calls.
test.describe.configure({ timeout: 90_000 });

test.describe('sélection d’un espace', () => {
  test('login lands on the active space, the selector switches, and the choice is remembered', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([
      { label: 'A', role: 'owner', positions: [AI, MC, MSFT_WATCH, SHEL] },
      { label: 'B', role: 'editor', positions: [SAP] },
    ]);
    const nameA = s.spaces['A']!.name;
    const nameB = s.spaces['B']!.name;
    await s.signIn(page);

    // First by name, since nothing was opened before.
    await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: nameA })).toBeVisible();
    await expect(page.getByTestId('space-role')).toHaveText('Propriétaire');
    await expect(page.getByTestId('tracked-count')).toHaveText('4');
    await expect(selector(page)).toContainText(nameA);

    // The active nav item is highlighted; the sub-page is kept when switching.
    await openTitres(page);
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
    await s.signIn(page);
    await expect(page.getByRole('heading', { level: 1, name: nameB })).toBeVisible();
    await expect(page.getByTestId('space-role')).toHaveText('Éditeur');
  });

  test('opening a space from the Espaces page makes it the active space', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([
      { label: 'A', role: 'owner', positions: [AI] },
      { label: 'B', role: null, positions: [SAP] },
    ]);
    await s.signIn(page);
    await page.goto('/espaces');
    const nameA = s.spaces['A']!.name;
    await expect(page.getByTestId('space-item').filter({ hasText: nameA })).toHaveCount(1);
    // A space nobody granted is invisible.
    await expect(page.getByTestId('space-item')).toHaveCount(1);
    await page
      .getByTestId('space-item')
      .getByRole('link', { name: /Ouvrir/ })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: nameA })).toBeVisible();
  });

  test('an inaccessible or unknown space shows the same not-found page', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([
      { label: 'A', role: 'owner', positions: [AI] },
      { label: 'B', role: null, positions: [SAP] },
    ]);
    await s.signIn(page);
    await expect(page.getByTestId('space-selector')).toBeVisible();

    // The foreign space exists but the user is not a member: same answer as for an id that
    // does not exist, and as for a malformed id. (A malformed percent-encoding never reaches the
    // app: Next answers a plain 500 itself; parseSpacePath only guards the header.)
    const foreign = s.spaces['B']!.id;
    for (const path of [
      `/s/${foreign}`,
      `/s/${foreign}/titres`,
      '/s/00000000-0000-4000-8000-000000000000',
      '/s/00000000-0000-4000-8000-000000000000/titres',
      '/s/not-a-uuid',
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404); // a real 404, not a streamed 200 fallback
      await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible();
      await expect(
        page.getByText('Cette page n’existe pas ou vous n’y avez pas accès.'),
      ).toBeVisible();
    }
    // Still inside the shell: the header is usable, and the foreign name never leaks.
    await expect(page.getByRole('link', { name: 'Espaces' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(s.spaces['B']!.name);
  });

  test('a user without any space sees the empty state', async ({ page, scenario }) => {
    const s = await scenario([]);
    await s.signIn(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByText('Aucun espace disponible. Contactez l’administrateur.'),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Espace' })).toHaveCount(0);
  });

  test('an editor edits a quantity with a comma decimal and it persists', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI, MC] }]);
    await s.signIn(page);
    await openTitres(page);
    const row = rowFor(page, 'Air Liquide');
    await expect(row.getByTestId('quantity')).toContainText('8');
    // Read-only details of the row (default columns: name, code, price in EUR).
    await expect(row.locator('th, td').first()).toContainText('Air Liquide');
    await expect(row.locator('th, td').nth(1)).toHaveText('AI');
    await expect(row.locator('th, td').nth(2)).toContainText('€');

    await editButton(page, 'Air Liquide').click();
    await expect(editor(page, 'Air Liquide')).toBeFocused();
    await editor(page, 'Air Liquide').fill('1 234,56');
    await editor(page, 'Air Liquide').press('Enter');
    await expect(page.getByText('Quantité mise à jour.').first()).toBeVisible();
    await expect(row.getByTestId('quantity')).toContainText(`1${GROUP}234,56`);
    await expect(page.getByTestId('save-status')).toHaveText(
      'Quantité de Air Liquide mise à jour.',
    );
    // Focus goes back to the edit button.
    await expect(editButton(page, 'Air Liquide')).toBeFocused();

    await page.reload();
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).toContainText(
      `1${GROUP}234,56`,
    );
    // The edit text uses the decimal comma too.
    await editButton(page, 'Air Liquide').click();
    await expect(editor(page, 'Air Liquide')).toHaveValue('1234,56');
  });

  test('an unchanged value (even written 8,0) sends nothing and shows no toast', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI] }]);
    await s.signIn(page);
    await openTitres(page);
    let writes = 0;
    await page.route('**/api/rpc/positions/setQuantity', (route) => {
      writes++;
      return route.continue();
    });
    await editButton(page, 'Air Liquide').click();
    await editor(page, 'Air Liquide').fill('8,0');
    await editor(page, 'Air Liquide').press('Enter');
    await expect(editButton(page, 'Air Liquide')).toBeFocused();
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).toContainText('8');
    await page.waitForTimeout(500);
    expect(writes).toBe(0);
    await expect(page.getByText('Quantité mise à jour.')).toHaveCount(0);
  });

  test('invalid input: French hints, Escape cancels, Tab does not steal focus back, blur saves', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI, MC] }]);
    await s.signIn(page);
    await openTitres(page);
    const row = rowFor(page, 'LVMH');
    await expect(row.getByTestId('quantity')).toContainText('3,5');

    await editButton(page, 'LVMH').click();
    const input = editor(page, 'LVMH');
    await input.fill('1,123456789');
    await input.press('Enter');
    await expect(page.getByText('Quantité invalide')).toBeVisible();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused(); // Enter: back to the field

    // An ambiguous dot gets a specific hint.
    await input.fill('1.234');
    await input.press('Enter');
    await expect(page.getByText('Utilisez la virgule pour les décimales')).toBeVisible();

    // Tab moves on: an invalid value on blur keeps its message but never grabs focus back.
    await input.press('Tab');
    await expect(input).not.toBeFocused();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Utilisez la virgule pour les décimales')).toBeVisible();

    await input.focus();
    await input.fill('99');
    await input.press('Escape');
    await expect(editor(page, 'LVMH')).toHaveCount(0);
    await expect(row.getByTestId('quantity')).toContainText('3,5');
    await expect(editButton(page, 'LVMH')).toBeFocused();

    await editButton(page, 'LVMH').click();
    await editor(page, 'LVMH').fill('7');
    await page.getByRole('heading', { name: 'Titres', level: 1 }).click(); // blur
    await expect(row.getByTestId('quantity')).toContainText('7');
    await expect(page.getByText('Quantité mise à jour.').first()).toBeVisible();
  });

  test('clearing the quantity shows a dash, not zero', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [MC] }]);
    await s.signIn(page);
    await openTitres(page);
    const row = rowFor(page, 'LVMH');
    await editButton(page, 'LVMH').click();
    await editor(page, 'LVMH').fill('');
    await editor(page, 'LVMH').press('Enter');
    await expect(row.getByTestId('quantity')).toContainText('—');
    await expect(row.getByTestId('quantity')).not.toHaveText(/(^|\s)0(\s|$)/);
    await page.reload();
    await expect(rowFor(page, 'LVMH').getByTestId('quantity')).toContainText('—');

    // 0 is a real quantity, distinct from "no quantity".
    await editButton(page, 'LVMH').click();
    await editor(page, 'LVMH').fill('0');
    await editor(page, 'LVMH').press('Enter');
    await expect(rowFor(page, 'LVMH').getByTestId('quantity')).toHaveText(/^\s*0\s*$/);
  });

  test('a server failure rolls the value back and shows a French message', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI] }]);
    await s.signIn(page);
    await openTitres(page);
    await page.route('**/api/rpc/positions/setQuantity', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          json: { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'boom' },
        }),
      }),
    );
    await editButton(page, 'Air Liquide').click();
    await editor(page, 'Air Liquide').fill('42');
    await editor(page, 'Air Liquide').press('Enter');
    await expect(page.getByText('La modification a échoué. Veuillez réessayer.')).toBeVisible();
    await expect(page.getByText('boom')).toHaveCount(0);
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).toContainText('8');
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).not.toContainText('42');
  });

  test('a role downgraded after the page loaded gets a French message and the old value', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI] }]);
    await s.signIn(page);
    await openTitres(page);
    await s.setRole('A', 'viewer'); // the page still shows edit controls
    await editButton(page, 'Air Liquide').click();
    await editor(page, 'Air Liquide').fill('42');
    await editor(page, 'Air Liquide').press('Enter');
    await expect(
      page.getByText('Vous n’avez pas le droit de modifier cet espace.').first(),
    ).toBeVisible();
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).toContainText('8');
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).not.toContainText('42');
  });

  test('a revoked space shows "Espace indisponible" instead of a stale list, quietly', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI] }]);
    await s.signIn(page);
    await openTitres(page);
    await s.revoke('A');
    await editButton(page, 'Air Liquide').click();
    await editor(page, 'Air Liquide').fill('42');
    await editor(page, 'Air Liquide').press('Enter');
    await expect(page.getByText('Espace indisponible')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Voir mes espaces' })).toHaveAttribute(
      'href',
      '/espaces',
    );
    await expect(page.getByTestId('position-row')).toHaveCount(0);
    await expect(page.getByText('La modification a échoué')).toHaveCount(0);
  });

  test('a failed refresh keeps the data and flags it as not up to date', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI, MC] }]);
    await s.signIn(page);
    await openTitres(page);
    await page.route('**/api/rpc/positions/list', (route) => route.abort());
    // A successful write triggers a refetch, which now fails.
    await editButton(page, 'Air Liquide').click();
    await editor(page, 'Air Liquide').fill('9');
    await editor(page, 'Air Liquide').press('Enter');
    const banner = page.getByRole('status').filter({ hasText: 'Données non actualisées.' });
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('position-row')).toHaveCount(2);
    await expect(rowFor(page, 'LVMH').getByTestId('quantity')).toContainText('3,5');

    await page.unroute('**/api/rpc/positions/list');
    await banner.getByRole('button', { name: 'Réessayer' }).click();
    await expect(banner).toHaveCount(0);
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).toContainText('9');
  });

  test('removing a position asks for confirmation', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI, MC] }]);
    await s.signIn(page);
    await openTitres(page);
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
    // The trigger is gone: focus lands on the list region, not on the page body.
    await expect(page.getByRole('region', { name: 'Liste des titres' })).toBeFocused();

    await page.reload();
    await expect(page.getByTestId('position-row')).toHaveCount(1);
    await expect(rowFor(page, 'Air Liquide')).toBeVisible();
  });

  test('a viewer sees values but no edit controls', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'viewer', positions: [AI, MSFT_WATCH] }]);
    await s.signIn(page);
    await expect(page.getByTestId('space-role')).toHaveText('Lecteur');
    await openTitres(page);
    await expect(page.getByTestId('position-row')).toHaveCount(2);
    await expect(rowFor(page, 'Air Liquide').getByTestId('quantity')).toContainText('8');
    // Watchlist entry: dash, never 0.
    await expect(rowFor(page, 'Microsoft').getByTestId('quantity')).toContainText('—');
    await expect(page.getByRole('button', { name: /Modifier la quantité/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Retirer/ })).toHaveCount(0);
    await expect(page.getByText('Lecture seule')).toBeVisible();
  });

  test('a pence-quoted listing (GBX) shows its EUR price, not a raw pence amount', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [SHEL] }]);
    await s.signIn(page);
    await openTitres(page);
    const shell = rowFor(page, 'Shell');
    await expect(shell.getByTestId('quantity')).toContainText(`1${GROUP}234,5`);
    // Cours EUR is converted from pence via the pound (the raw GBX price is the `price` column).
    await expect(shell.locator('th, td').nth(2)).toContainText('€');
    await expect(shell.locator('th, td').nth(2)).not.toContainText('GBX');
  });

  test('at 375px there is no horizontal overflow and the selector is reachable', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([
      { label: 'A', role: 'owner', positions: [AI, SHEL] },
      { label: 'B', role: 'viewer', positions: [SAP] },
    ]);
    await page.setViewportSize({ width: 375, height: 800 });
    await s.signIn(page);
    const nameB = s.spaces['B']!.name;
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
