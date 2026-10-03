import type { Page } from '@playwright/test';
import { AI, CW8_UNPRICED, expect, MC, MSFT, SAP, SHEL, test } from './support/fixtures';

// S7: column chooser, filters and the persisted per-user, per-space table config.
test.describe.configure({ timeout: 120_000 });

const SIX = [AI, MC, SAP, MSFT, SHEL, CW8_UNPRICED];
const rows = (page: Page) => page.getByTestId('position-row');
const count = (page: Page) => page.getByTestId('result-count');
const headers = async (page: Page) =>
  (await page.getByRole('columnheader').allTextContents()).map((h) => h.trim());

async function openTitres(page: Page, spaceId?: string) {
  if (spaceId) {
    await page.goto(`/s/${spaceId}/titres`);
  } else {
    await page.goto('/');
    await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
    await page.goto(`${new URL(page.url()).pathname}/titres`);
  }
  await expect(rows(page).first()).toBeVisible();
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function reloadTable(page: Page) {
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
}

type SavedConfig = {
  density?: string;
  filters?: { kind: string; columnId: string; min?: string }[];
  columns: { id: string; visible: boolean }[];
};
const isShown = (c: SavedConfig, id: string) => c.columns.some((x) => x.id === id && x.visible);

/**
 * The config is saved 500 ms after the last edit: wait for the successful save whose body
 * (the full config) matches `match`, so an earlier save can never satisfy the wait. Register it
 * BEFORE the last edit.
 */
const configSaved = (page: Page, match: (config: SavedConfig) => boolean) =>
  page.waitForResponse((r) => {
    if (!r.url().includes('/tableConfig/save') || !r.ok()) return false;
    try {
      const body = r.request().postDataJSON() as { json?: { config?: SavedConfig } };
      return !!body.json?.config && match(body.json.config);
    } catch {
      return false;
    }
  });

async function openPanel(page: Page, name: 'Colonnes' | 'Filtres') {
  const button = page.getByRole('button', { name: new RegExp(`^${name}`) });
  await button.click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

const toNumber = (text: string) =>
  Number(
    text
      .replace('−', '-')
      .replace(/[^\d,.-]/g, '')
      .replace(',', '.'),
  );

/** Text of the main figure of one column in the row of a company. */
async function cellOf(page: Page, company: string, column: string) {
  const index = (await headers(page)).findIndex((h) => h.startsWith(column));
  expect(index, `column ${column}`).toBeGreaterThanOrEqual(0);
  const cell = rows(page)
    .filter({ hasText: company })
    .locator(`:is(th, td):nth-child(${index + 1})`);
  return ((await cell.getByTestId('cell-value').first().textContent()) ?? '').trim();
}

test.describe('filtrage (specs 43)', () => {
  test('sector and perf range combine; the count updates; no-data rows hidden; clear all', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: SIX }]);
    await s.signIn(page);
    await openTitres(page);
    await expect(count(page)).toHaveText('6 titres');
    await expect(page.getByTestId('filter-note')).toHaveCount(0);

    // A wide perf range: the unpriced row has no performance, so it is hidden (never read as 0).
    await openPanel(page, 'Filtres');
    await page.getByLabel('Minimum Perf. 12 mois').fill('-1000');
    await page.getByLabel('Maximum Perf. 12 mois').fill('1000,5');
    await page.getByRole('button', { name: 'Appliquer' }).click();
    await expect(count(page)).toHaveText('5 titres');
    await expect(rows(page).filter({ hasText: 'Amundi' })).toHaveCount(0);
    await expect(page.getByTestId('filter-note')).toHaveText(
      'Les titres sans donnée pour un filtre actif sont masqués.',
    );
    await expect(page.getByTestId('filter-chip')).toHaveText(
      /Perf\. 12 mois : −1000\s% à 1000,5\s%/,
    );

    // Sector in-filter (counts are the space's totals).
    await page.getByRole('checkbox', { name: /Information Technology/ }).click();
    await expect(count(page)).toHaveText('2 titres');
    await expect(page.getByTestId('filter-chip')).toHaveCount(2);

    // Narrow the range between SAP and Microsoft: one is left.
    await page.keyboard.press('Escape');
    const sap = toNumber(await cellOf(page, 'SAP', 'Perf. 12 mois'));
    const msft = toNumber(await cellOf(page, 'Microsoft', 'Perf. 12 mois'));
    const cut = ((sap + msft) / 2).toFixed(2).replace('.', ',');
    await openPanel(page, 'Filtres');
    await page.getByLabel('Minimum Perf. 12 mois').fill(cut);
    await page.getByLabel('Maximum Perf. 12 mois').fill('');
    const saved = configSaved(
      page,
      (c) => !!c.filters?.some((f) => f.kind === 'between' && f.min === cut.replace(',', '.')),
    );
    await page.getByRole('button', { name: 'Appliquer' }).click();
    await expect(count(page)).toHaveText('1 titre');
    await saved;
    await expect(rows(page).filter({ hasText: sap > msft ? 'SAP' : 'Microsoft' })).toHaveCount(1);

    // min > max is refused client-side and nothing changes.
    await page.getByLabel('Minimum Perf. 12 mois').fill('50');
    await page.getByLabel('Maximum Perf. 12 mois').fill('10');
    await page.getByRole('button', { name: 'Appliquer' }).click();
    await expect(page.getByText('Le minimum dépasse le maximum.')).toBeVisible();
    await expect(count(page)).toHaveText('1 titre');
    await page.keyboard.press('Escape');

    // Filters survive a reload (saved config); a chip can be removed with its own button.
    await reloadTable(page);
    await expect(count(page)).toHaveText('1 titre');
    await page.getByRole('button', { name: /^Retirer le filtre Secteur/ }).click();
    await expect(count(page)).toHaveText(/^[2-5] titres$/);

    await page.getByRole('button', { name: 'Tout effacer' }).click();
    await expect(count(page)).toHaveText('6 titres');
    await expect(page.getByTestId('filter-chip')).toHaveCount(0);
    await expect(page.getByTestId('filter-note')).toHaveCount(0);
  });

  test('an active value stays listed when its positions are gone and can be unticked', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI, SHEL] }]);
    await s.signIn(page);
    await openTitres(page);
    await openPanel(page, 'Filtres');
    await page.getByRole('checkbox', { name: /Energy/ }).click();
    await expect(count(page)).toHaveText('1 titre');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Retirer Shell de l’espace' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Retirer', exact: true }).click();
    await expect(page.getByTestId('no-match')).toHaveText('Aucun résultat pour ces filtres.');

    await openPanel(page, 'Filtres');
    const energy = page.getByRole('checkbox', { name: /Energy/ });
    await expect(energy).toBeChecked();
    await expect(page.getByRole('dialog')).toContainText('(absent)');
    await energy.click();
    await expect(count(page)).toHaveText('1 titre');
    await expect(page.getByTestId('filter-chip')).toHaveCount(0);
  });
});

test.describe('colonnes et ordre (specs 43, 16)', () => {
  test('hide a column, add a non-default one, S8 columns are disabled', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI, SAP] }]);
    await s.signIn(page);
    await openTitres(page);
    expect(await headers(page)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Secteur/)]),
    );

    await openPanel(page, 'Colonnes');
    await page.getByRole('checkbox', { name: "Secteur d'activité" }).click();
    const saved = configSaved(page, (c) => !isShown(c, 'sector') && isShown(c, 'price_date'));
    await page.getByRole('checkbox', { name: 'Date du cours' }).click();
    const pending = page.getByRole('checkbox', { name: /Dette nette/ });
    await expect(pending).toBeDisabled();
    await expect(page.getByRole('dialog')).toContainText('bientôt disponible');
    await expect(async () => {
      const heads = await headers(page);
      expect(heads.some((h) => h.startsWith('Secteur'))).toBe(false);
      expect(heads.at(-2)?.startsWith('Date du cours')).toBe(true); // before the Actions column
    }).toPass();

    await page.keyboard.press('Escape');
    await saved;
    await reloadTable(page);
    const heads = await headers(page);
    expect(heads.some((h) => h.startsWith('Secteur'))).toBe(false);
    expect(heads.some((h) => h.startsWith('Date du cours'))).toBe(true);
  });

  test('the last visible column cannot be hidden', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI] }]);
    await s.signIn(page);
    await openTitres(page);
    await openPanel(page, 'Colonnes');
    const order = page.getByTestId('column-order').getByRole('listitem');
    const labels = (await order.locator('span:first-child').allTextContents()).map((l) => l.trim());
    for (const [i, label] of labels.slice(1).entries()) {
      await page.getByRole('checkbox', { name: new RegExp(`^${escapeRe(label)}`) }).click();
      await expect(order).toHaveCount(labels.length - 1 - i);
    }
    await expect(page.getByRole('checkbox', { name: /^Société/ })).toBeDisabled();
    await expect(page.getByRole('dialog')).toContainText(
      'Au moins une colonne doit rester affichée.',
    );
  });

  test('move a column up with the keyboard: the header order changes and persists', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI, SAP] }]);
    await s.signIn(page);
    await openTitres(page);
    const before = await headers(page);
    expect(before[1]).toMatch(/^Code/);
    expect(before[2]).toMatch(/^Cours EUR/);

    await openPanel(page, 'Colonnes');
    await page.getByRole('button', { name: 'Monter Cours en EUR' }).focus();
    const saved = configSaved(
      page,
      (c) => c.columns.filter((x) => x.visible)[1]?.id === 'price_eur',
    );
    await page.keyboard.press('Enter');
    await expect(async () => {
      const heads = await headers(page);
      expect(heads[1]).toMatch(/^Cours EUR/);
      expect(heads[2]).toMatch(/^Code/);
    }).toPass();
    await expect(page.getByRole('button', { name: 'Monter Société' })).toBeDisabled();

    await page.keyboard.press('Escape');
    await saved;
    await reloadTable(page);
    expect((await headers(page))[1]).toMatch(/^Cours EUR/);
  });

  test('move a column down: focus stays on the moved item, falls back at an end, and is announced', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI, SAP] }]);
    await s.signIn(page);
    await openTitres(page);
    await openPanel(page, 'Colonnes');
    const status = page.getByTestId('column-move-status');

    await page.getByRole('button', { name: 'Descendre Société' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Descendre Société' })).toBeFocused();
    await expect(status).toHaveText('Société déplacée en position 2');
    await expect.poll(async () => (await headers(page))[0]).toMatch(/^Code/);

    // "Code" is now first: its "Monter" button is disabled, focus falls back to "Descendre".
    await page.getByRole('button', { name: 'Monter Société' }).click();
    await expect(page.getByRole('button', { name: 'Monter Société' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Descendre Société' })).toBeFocused();
    await expect(status).toHaveText('Société déplacée en position 1');
  });

  test('reset goes back to the defaults with a toast', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI, SAP] }]);
    await s.signIn(page);
    await openTitres(page);
    const defaults = await headers(page);

    await page.getByRole('button', { name: 'Compacte' }).click();
    await openPanel(page, 'Colonnes');
    await page.getByRole('checkbox', { name: "Secteur d'activité" }).click();
    await page.getByRole('button', { name: 'Monter Code' }).click();
    await expect.poll(async () => (await headers(page))[0]).toMatch(/^Code/);
    await page.getByRole('button', { name: 'Réinitialiser' }).click();
    await expect(page.getByText('Configuration réinitialisée.')).toBeVisible();
    await expect.poll(() => headers(page)).toEqual(defaults);
    await expect(page.getByRole('table')).toHaveAttribute('data-density', 'comfortable');

    await page.keyboard.press('Escape');
    await reloadTable(page);
    expect(await headers(page)).toEqual(defaults);
  });
});

test.describe('persistance (specs 19, 43)', () => {
  test('restored after logout and login, per space', async ({ page, scenario }) => {
    const s = await scenario([
      { label: 'A', role: 'owner', positions: [AI, SAP] },
      { label: 'B', role: 'owner', positions: [MSFT] },
    ]);
    await s.signIn(page);
    await openTitres(page, s.spaces['A']!.id);
    await openPanel(page, 'Colonnes');
    await page.getByRole('checkbox', { name: "Secteur d'activité" }).click();
    const saved = configSaved(page, (c) => c.density === 'compact' && !isShown(c, 'sector'));
    await page.getByRole('button', { name: 'Compacte' }).click();
    await page.keyboard.press('Escape');
    await saved;

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login/);
    await s.signIn(page);

    await openTitres(page, s.spaces['A']!.id);
    expect((await headers(page)).some((h) => h.startsWith('Secteur'))).toBe(false);
    await expect(page.getByRole('table')).toHaveAttribute('data-density', 'compact');

    // The other space keeps its own (default) view.
    await openTitres(page, s.spaces['B']!.id);
    expect((await headers(page)).some((h) => h.startsWith('Secteur'))).toBe(true);
    await expect(page.getByRole('table')).toHaveAttribute('data-density', 'comfortable');
  });

  test('logout right after an edit: no toast on /login and the edit is not lost', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI, SAP] }]);
    await s.signIn(page);
    await openTitres(page);
    await openPanel(page, 'Colonnes');
    await page.getByRole('checkbox', { name: "Secteur d'activité" }).click();
    await page.keyboard.press('Escape');
    // Well inside the 500 ms debounce: the logout must flush the edit first.
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.waitForTimeout(1500);
    await expect(page.locator('.Toastify__toast')).toHaveCount(0);

    await s.signIn(page);
    await openTitres(page);
    expect((await headers(page)).some((h) => h.startsWith('Secteur'))).toBe(false);
  });

  test('logging out in one tab reloads the other tab onto /login', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI] }]);
    await s.signIn(page);
    await openTitres(page);
    const other = await page.context().newPage();
    await other.goto(page.url());
    await expect(rows(other).first()).toBeVisible();

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(other).toHaveURL(/\/login/);
  });

  test('a viewer can save their own view', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'viewer', positions: [AI, SAP] }]);
    await s.signIn(page);
    await openTitres(page);
    await openPanel(page, 'Colonnes');
    const saved = configSaved(page, (c) => !isShown(c, 'sector'));
    await page.getByRole('checkbox', { name: "Secteur d'activité" }).click();
    await page.keyboard.press('Escape');
    await saved;
    await reloadTable(page);
    expect((await headers(page)).some((h) => h.startsWith('Secteur'))).toBe(false);
    await expect(page.getByText('Lecture seule')).toBeVisible();
  });

  test('a save failure toasts and restores the previous columns', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI] }]);
    await s.signIn(page);
    await openTitres(page);
    await page.route('**/tableConfig/save', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        json: { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'boom' },
      }),
    );
    await openPanel(page, 'Colonnes');
    await page.getByRole('checkbox', { name: "Secteur d'activité" }).click();
    await expect(
      page.getByText('Impossible d’enregistrer la configuration. Elle a été restaurée.'),
    ).toBeVisible();
    await expect
      .poll(async () => (await headers(page)).some((h) => h.startsWith('Secteur')))
      .toBe(true);
  });
});

test.describe('mobile 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the panels are usable in a sheet and the page does not overflow', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: SIX }]);
    await s.signIn(page);
    await openTitres(page);
    const noOverflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    await openPanel(page, 'Colonnes');
    const dialog = page.getByRole('dialog');
    const box = await dialog.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
    await page.getByRole('checkbox', { name: 'Date du cours' }).click();
    await page.getByRole('button', { name: 'Descendre Société' }).click();
    expect(await noOverflow()).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Focus returns to the trigger.
    await expect(page.getByRole('button', { name: /^Colonnes/ })).toBeFocused();

    await openPanel(page, 'Filtres');
    await page.getByRole('checkbox', { name: /Information Technology/ }).click();
    await page.getByLabel('Minimum Cours EUR').fill('1');
    await page.getByRole('button', { name: 'Appliquer' }).click();
    expect(await noOverflow()).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('filter-chip')).toHaveCount(2);
    expect(await noOverflow()).toBe(true);
  });
});
