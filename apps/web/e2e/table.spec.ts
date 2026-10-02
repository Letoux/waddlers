import type { Locator, Page } from '@playwright/test';
import { AI, CW8_UNPRICED, expect, MC, MSFT, SAP, SHEL, test } from './support/fixtures';

// Every test builds its own user, space and positions (support/fixtures.ts).
test.describe.configure({ timeout: 120_000 });

const GROUP = ' ';
const rows = (page: Page) => page.getByTestId('position-row');
const count = (page: Page) => page.getByTestId('result-count');
const header = (page: Page, name: string | RegExp) => page.getByRole('columnheader', { name });
const search = (page: Page) => page.getByRole('searchbox', { name: 'Rechercher un titre' });

async function openTitres(page: Page, query = '') {
  await page.goto('/');
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
  await page.goto(`${new URL(page.url()).pathname}/titres${query}`);
  await expect(rows(page).first()).toBeVisible();
}

/** Column index (0-based) of a header, then the text of its main figure in every row. */
async function columnTexts(page: Page, name: string): Promise<string[]> {
  const heads = await page.getByRole('columnheader').allTextContents();
  const index = heads.findIndex((h) => h.trim().startsWith(name));
  expect(index, `column ${name}`).toBeGreaterThanOrEqual(0);
  const cells = rows(page).locator(`:is(th, td):nth-child(${index + 1})`);
  const out: string[] = [];
  for (const cell of await cells.all()) {
    out.push(((await cell.getByTestId('cell-value').first().textContent()) ?? '').trim());
  }
  return out;
}

/** Polls until the column is sorted with the unavailable values last (the rows swap after a request). */
async function expectColumnSorted(page: Page, name: string, direction: 'asc' | 'desc') {
  await expect(async () => {
    const texts = await columnTexts(page, name);
    expect(texts.at(-1)).toBe('—');
    expectSortedNullsLast(texts.map(toNumber), direction);
  }).toPass({ timeout: 10_000 });
}

/** "1 234,50 €" or "−3,2 %" to a number; "—" to null. */
const toNumber = (text: string): number | null =>
  text === '—'
    ? null
    : Number(
        text
          .replace('−', '-')
          .replace(/[^\d,.-]/g, '')
          .replace(',', '.'),
      );

function expectSortedNullsLast(values: (number | null)[], direction: 'asc' | 'desc') {
  const firstNull = values.indexOf(null);
  const present = firstNull === -1 ? values : values.slice(0, firstNull);
  const tail = firstNull === -1 ? [] : values.slice(firstNull);
  expect(
    tail.every((v) => v === null),
    'nulls come last',
  ).toBe(true);
  const nums = present as number[];
  const sorted = [...nums].sort((a, b) => (direction === 'asc' ? a - b : b - a));
  expect(nums).toEqual(sorted);
}

const FIVE = [AI, MC, SAP, MSFT, SHEL];

test.describe('recherche (specs 43)', () => {
  test('by name, code and currency; the count follows; empty state; the URL keeps it', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: FIVE }]);
    await s.signIn(page);
    await openTitres(page);
    await expect(count(page)).toHaveText('5 titres');

    await search(page).fill('air');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Air Liquide');
    await expect(count(page)).toHaveText('1 titre');
    await expect(page).toHaveURL(/[?&]q=air(&|$)/);

    await search(page).fill('SHEL'); // code
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Shell');

    await search(page).fill('usd'); // currency, case-insensitive
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Microsoft');

    await search(page).fill('zzzzz');
    await expect(page.getByTestId('no-match')).toHaveText('Aucun titre ne correspond à « zzzzz ».');
    await expect(count(page)).toHaveText('0 titre');
    await expect(rows(page)).toHaveCount(0);
    // The field stays usable.
    await expect(search(page)).toBeVisible();

    // Reload keeps the search (URL is the source of truth).
    await search(page).fill('lvmh');
    await expect(rows(page)).toHaveCount(1);
    await page.reload();
    await expect(search(page)).toHaveValue('lvmh');
    await expect(rows(page)).toHaveCount(1);

    await search(page).fill('');
    await expect(rows(page)).toHaveCount(5);
    await expect(page).not.toHaveURL(/[?&]q=/);
  });

  test('the "Titres" nav link clears a search (F-FE4)', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: FIVE }]);
    await s.signIn(page);
    await openTitres(page);
    await search(page).fill('air');
    await expect(rows(page)).toHaveCount(1);
    await expect(page).toHaveURL(/[?&]q=air(&|$)/);

    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Titres' })
      .click();
    await expect(search(page)).toHaveValue('');
    await expect(rows(page)).toHaveCount(5);
    await expect(page).not.toHaveURL(/[?&]q=/);
  });

  test('search ignores accents and case', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI], accent: true }]);
    await s.signIn(page);
    await openTitres(page);
    await expect(count(page)).toHaveText('2 titres');
    for (const q of ['societe', 'SOCIÉTÉ', 'accentuee']) {
      await search(page).fill(q);
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText('Société Accentuée');
    }
  });

  test('the search is debounced: one request after typing stops', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: FIVE }]);
    await s.signIn(page);
    await openTitres(page);
    let calls = 0;
    await page.route('**/api/rpc/positions/list', (route) => {
      calls++;
      return route.continue();
    });
    await search(page).pressSequentially('lvmh', { delay: 40 });
    await expect(rows(page)).toHaveCount(1);
    await page.waitForTimeout(500);
    expect(calls).toBe(1);
  });
});

test.describe('tri (specs 43)', () => {
  test('Cours EUR: asc, desc, none, with unavailable values last', async ({ page, scenario }) => {
    const s = await scenario([
      { label: 'A', role: 'owner', positions: [...FIVE, CW8_UNPRICED] }, // CW8 has no price
    ]);
    await s.signIn(page);
    await openTitres(page);
    const priceHeader = header(page, /Cours EUR/);
    await expect(priceHeader).toHaveAttribute('aria-sort', 'none');
    const initialNames = await columnTexts(page, 'Société');

    await priceHeader.getByRole('button').click();
    await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(page).toHaveURL(/[?&]tri=price_eur%3Aasc/);
    await expect.poll(async () => (await columnTexts(page, 'Cours EUR')).at(-1)).toBe('—');
    const asc = (await columnTexts(page, 'Cours EUR')).map(toNumber);
    expect(asc.filter((v) => v !== null).length).toBe(5);
    expectSortedNullsLast(asc, 'asc');

    await priceHeader.getByRole('button').click();
    await expect(priceHeader).toHaveAttribute('aria-sort', 'descending');
    await expect(page).toHaveURL(/tri=price_eur%3Adesc/);
    await expectColumnSorted(page, 'Cours EUR', 'desc');

    await priceHeader.getByRole('button').click();
    await expect(priceHeader).toHaveAttribute('aria-sort', 'none');
    await expect(page).not.toHaveURL(/tri=/);
    await expect.poll(() => columnTexts(page, 'Société')).toEqual(initialNames);
  });

  test('Perf. période follows the period; sorted both ways, nulls last; survives reload', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [...FIVE, CW8_UNPRICED] }]);
    await s.signIn(page);
    await openTitres(page);
    await expect(header(page, /Perf\. 1 mois/)).toBeVisible();

    await page.getByTestId('period-selector').click();
    await page.getByRole('option', { name: '1 an' }).click();
    await expect(page).toHaveURL(/periode=1y/);
    const perf = header(page, /Perf\. 1 an/);
    await expect(perf).toBeVisible();

    await perf.getByRole('button').click();
    await expect(perf).toHaveAttribute('aria-sort', 'ascending');
    await expectColumnSorted(page, 'Perf. 1 an', 'asc');

    await perf.getByRole('button').click();
    await expect(perf).toHaveAttribute('aria-sort', 'descending');
    await expectColumnSorted(page, 'Perf. 1 an', 'desc');

    await page.reload();
    await expect(header(page, /Perf\. 1 an/)).toHaveAttribute('aria-sort', 'descending');
  });

  test('sorting is validated: a hand-written bad ?tri= is ignored; unsortable headers are not buttons', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: FIVE }]);
    await s.signIn(page);
    await openTitres(page, '?tri=price%3Aasc&page=zzz');
    await expect(rows(page)).toHaveCount(5);
    for (const h of await page.getByRole('columnheader').all()) {
      await expect(h).not.toHaveAttribute('aria-sort', /ascending|descending/);
    }
    // Pending (S8) columns: a dash and the "bientôt" tooltip, never sortable.
    const cap = header(page, /Capitalisation EUR/);
    await expect(cap.getByRole('button')).toHaveCount(0);
    await expect(cap).not.toHaveAttribute('aria-sort', /.+/);
    const firstCap = rows(page).first().locator('th, td').nth(5);
    await expect(firstCap).toContainText('—');
    await firstCap.getByText('—').hover();
    await expect(page.getByRole('tooltip').first()).toContainText(
      'Donnée disponible prochainement',
    );
  });

  test('the sort is reachable by keyboard', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: FIVE }]);
    await s.signIn(page);
    await openTitres(page);
    const name = header(page, /Société/).getByRole('button');
    await name.focus();
    await page.keyboard.press('Enter');
    await expect(header(page, /Société/)).toHaveAttribute('aria-sort', 'ascending');
    await page.keyboard.press('Enter');
    await expect(header(page, /Société/)).toHaveAttribute('aria-sort', 'descending');
    await expect
      .poll(async () => {
        const names = await columnTexts(page, 'Société');
        return (
          JSON.stringify(names) ===
          JSON.stringify([...names].sort((a, b) => b.localeCompare(a, 'fr')))
        );
      })
      .toBe(true);
  });
});

test.describe('pagination', () => {
  test('60 positions: pages of 50, range label, previous/next, resets on search and sort', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI], bulk: 59 }]);
    await s.signIn(page);
    await openTitres(page);
    await expect(count(page)).toHaveText('60 titres');
    await expect(rows(page)).toHaveCount(50);
    const range = page.getByTestId('page-range');
    await expect(range).toHaveText('1–50 sur 60');
    await expect(page.getByRole('button', { name: 'Précédent' })).toBeDisabled();

    await page.getByRole('button', { name: 'Suivant' }).click();
    await expect(range).toHaveText('51–60 sur 60');
    await expect(rows(page)).toHaveCount(10);
    await expect(page).toHaveURL(/[?&]page=2/);
    await expect(page.getByRole('button', { name: 'Suivant' })).toBeDisabled();

    await page.reload();
    await expect(range).toHaveText('51–60 sur 60');

    // A new search goes back to the first page.
    await search(page).fill('Bulk 0');
    await expect(page).not.toHaveURL(/page=/);
    await expect(range).toHaveText('1–50 sur 59');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await expect(range).toHaveText('51–59 sur 59');
    // So does a new sort.
    await header(page, /Société/)
      .getByRole('button')
      .click();
    await expect(page).not.toHaveURL(/page=/);
    await expect(range).toHaveText('1–50 sur 59');
    await page.getByRole('button', { name: 'Précédent' }).waitFor();
  });
});

test.describe('quantité dans le tableau', () => {
  const trackedValue = async (page: Page, name: string) => {
    const index = (await page.getByRole('columnheader').allTextContents()).findIndex((h) =>
      h.startsWith('Valeur suivie'),
    );
    const cell = rows(page)
      .filter({ hasText: name })
      .locator(`:is(th, td):nth-child(${index + 1})`);
    return toNumber(((await cell.getByTestId('cell-value').first().textContent()) ?? '').trim());
  };

  test('an edit persists and is reflected in Valeur suivie', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI, MC] }]);
    await s.signIn(page);
    await openTitres(page);
    const before = await trackedValue(page, 'Air Liquide');
    expect(before).not.toBeNull();
    const row = rows(page).filter({ hasText: 'Air Liquide' });
    await row.getByRole('button', { name: /Modifier la quantité/ }).click();
    const input = page.getByRole('textbox', { name: 'Quantité de Air Liquide' });
    await input.fill('16'); // 8 -> 16
    await input.press('Enter');
    await expect(row.getByTestId('quantity')).toContainText('16');
    await expect
      .poll(async () => (await trackedValue(page, 'Air Liquide')) ?? 0, { timeout: 15_000 })
      .toBeCloseTo((before ?? 0) * 2, 1);

    await page.reload();
    await expect(
      rows(page).filter({ hasText: 'Air Liquide' }).getByTestId('quantity'),
    ).toContainText('16');
  });

  test('an edit on page 2 of a sorted table updates that row only', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI], bulk: 59 }]);
    await s.signIn(page);
    await openTitres(page, '?tri=name%3Adesc&page=2');
    await expect(page.getByTestId('page-range')).toHaveText('51–60 sur 60');
    const first = rows(page).first();
    const name = (await first.locator('th, td').first().textContent())?.trim() ?? '';
    await first.getByRole('button', { name: /Modifier la quantité/ }).click();
    const input = page.getByRole('textbox', { name: `Quantité de ${name}` });
    await input.fill('3,5');
    await input.press('Enter');
    await expect(first.getByTestId('quantity')).toContainText('3,5');
    await expect(rows(page).nth(1).getByTestId('quantity')).not.toContainText('3,5');
    await expect(page.getByText('Quantité mise à jour.').first()).toBeVisible();
  });

  test('the remove action stays available for an editor', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'editor', positions: [AI, MC] }]);
    await s.signIn(page);
    await openTitres(page);
    await rows(page)
      .filter({ hasText: 'LVMH' })
      .getByRole('button', { name: 'Retirer LVMH de l’espace' })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Retirer', exact: true }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(count(page)).toHaveText('1 titre');
  });

  test('a viewer gets no edit controls in the table', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'viewer', positions: [AI, MC] }]);
    await s.signIn(page);
    await openTitres(page);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByRole('button', { name: /Modifier la quantité/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Retirer/ })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Actions' })).toHaveCount(0);
    await expect(page.getByText('Lecture seule')).toBeVisible();
    // Sorting and search stay available to a viewer.
    await header(page, /Société/)
      .getByRole('button')
      .click();
    await expect(header(page, /Société/)).toHaveAttribute('aria-sort', 'ascending');
  });
});

test.describe('états et affichage', () => {
  test('density toggle persists; null values are dashes; the empty space message', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([
      { label: 'A', role: 'owner', positions: [AI, { listing: 'CW8.XPAR' }] },
      { label: 'B', role: 'owner', positions: [] },
    ]);
    await s.signIn(page);
    await openTitres(page);
    const table = page.getByRole('table');
    await expect(table).toHaveAttribute('data-density', 'comfortable');
    await page.getByRole('button', { name: 'Compacte' }).click();
    await expect(table).toHaveAttribute('data-density', 'compact');
    await page.reload();
    await expect(page.getByRole('table')).toHaveAttribute('data-density', 'compact');

    // CW8 is unpriced and a watchlist entry: dashes, never 0.
    const cw8 = rows(page).filter({ hasText: 'Amundi' });
    await expect(cw8.getByTestId('quantity')).toContainText('—');
    for (const cell of await cw8.locator('th, td').all()) {
      await expect(cell).not.toHaveText(/^\s*0(,0+)?\s*(%|€)?\s*$/);
    }

    await page.goto(`/s/${s.spaces['B']!.id}/titres`);
    await expect(page.getByTestId('empty-space')).toHaveText('Aucun titre dans cet espace.');
  });

  test('an error shows a retry; the retry recovers', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI] }]);
    await s.signIn(page);
    await page.goto('/');
    await page.route('**/api/rpc/positions/list', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          json: { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'boom' },
        }),
      }),
    );
    await page.getByRole('link', { name: 'Titres' }).click();
    const error = page.getByTestId('table-error');
    await expect(error).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('boom')).toHaveCount(0);
    await page.unroute('**/api/rpc/positions/list');
    await error.getByRole('button', { name: 'Réessayer' }).click();
    await expect(rows(page)).toHaveCount(1);
  });

  test('a stale price is flagged, not shown as current', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI] }]);
    await s.signIn(page);
    await page.route('**/api/rpc/positions/list', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        json: { rows: { values: Record<string, unknown> }[] };
      };
      for (const row of body.json.rows) {
        const cell = row.values['price_eur'] as { isStale: boolean } | undefined;
        if (cell) cell.isStale = true;
      }
      await route.fulfill({ response, json: body });
    });
    await openTitres(page);
    await expect(rows(page).first().getByTestId('stale-marker')).toBeVisible();
    await expect(rows(page).first().getByTestId('stale-marker')).toHaveCount(1);
  });
});

test.describe('mobile (375px)', () => {
  test('horizontal scroll inside the table, sticky first column, no page overflow', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: FIVE }]);
    await page.setViewportSize({ width: 375, height: 800 });
    await s.signIn(page);
    await openTitres(page);
    const pageOverflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
    expect(await pageOverflow()).toBe(false);

    const scroller = page.getByTestId('table-scroll');
    const metrics = await scroller.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    expect(metrics.scroll).toBeGreaterThan(metrics.client);

    await scroller.evaluate((el) => (el.scrollLeft = 300));
    const left = (l: Locator) => l.evaluate((el) => Math.round(el.getBoundingClientRect().left));
    const scrollerLeft = await left(scroller);
    // The first column header and cells stay at the left edge of the scroll area.
    expect(Math.abs((await left(header(page, /Société/))) - scrollerLeft)).toBeLessThanOrEqual(2);
    expect(
      Math.abs((await left(rows(page).first().locator('th, td').first())) - scrollerLeft),
    ).toBeLessThanOrEqual(2);
    // Scrolled to the end, the last column really is in view (and the first stays pinned).
    await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    expect(Math.abs((await left(header(page, /Société/))) - scrollerLeft)).toBeLessThanOrEqual(2);
    await expect(header(page, /Perf\. 5 ans|Perf\. 60 mois/)).toBeInViewport();
    expect(await pageOverflow()).toBe(false);
    expect(GROUP).toBeTruthy();
    // Toolbar controls are all reachable without page scroll sideways.
    await expect(search(page)).toBeVisible();
    await expect(page.getByTestId('period-selector')).toBeVisible();
  });
});
