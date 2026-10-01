import type { Page } from '@playwright/test';
import {
  AI,
  CW8_UNPRICED,
  expect,
  MC,
  MSFT,
  SHEL,
  test,
  type ScenarioSpace,
} from './support/fixtures';

// Market data comes from the fake providers seeded in global setup (support/global-setup.ts).
test.describe.configure({ timeout: 90_000 });

const periodSelect = (page: Page) => page.getByRole('combobox', { name: 'Période' });
const pickPeriod = async (page: Page, label: string) => {
  await periodSelect(page).click();
  await page.getByRole('option', { name: label, exact: true }).click();
};
const SPACE_A: ScenarioSpace = { label: 'A', role: 'owner', positions: [AI, MC, MSFT, SHEL] };

async function openDashboard(page: Page) {
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('total-value')).toBeVisible();
}
const plot = (page: Page) => page.getByTestId('history-plot').locator('.recharts-area-curve');

test.describe('dashboard', () => {
  test('shows the value, the chart and the movers', async ({ page, scenario }) => {
    const s = await scenario([SPACE_A]);
    await s.signIn(page);
    await openDashboard(page);
    await expect(plot(page)).toBeVisible();

    await expect(page.getByTestId('total-value')).not.toHaveText('—');
    await expect(page.getByTestId('total-value')).toContainText('€');
    await expect(page.getByTestId('delta-pct')).toContainText('%');
    await expect(page.getByTestId('base-date')).not.toBeEmpty();
    await expect(page.getByTestId('as-of')).not.toHaveText('—');
    await expect(page.getByTestId('chart-title')).toHaveText('Valeur des positions actuelles');
    await expect(page.getByTestId('movers-gainers')).toContainText('Plus fortes progressions');
    await expect(page.getByTestId('movers-losers')).toContainText('Plus fortes baisses');
    expect(await page.getByTestId('mover-row').count()).toBeGreaterThan(0);
    await expect(page.getByTestId('partial-warning')).toHaveCount(0);
    await expect(page.getByTestId('chart-summary')).toContainText('Minimum');
  });

  test('changing the period updates the URL, the delta and the movers', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([SPACE_A]);
    await s.signIn(page);
    await openDashboard(page);
    await expect(periodSelect(page)).toContainText('Mois');
    const baseBefore = await page.getByTestId('base-date').innerText();
    const moversBefore = await page.getByTestId('movers-gainers').innerText();

    await pickPeriod(page, '1 an');
    await expect(page).toHaveURL(/\?periode=1y$/);
    await expect(periodSelect(page)).toContainText('1 an');
    await expect(page.getByTestId('base-date')).not.toHaveText(baseBefore);
    await expect(page.getByTestId('movers-gainers')).not.toHaveText(moversBefore);

    // The URL is the source of truth: a reload keeps it, an invalid value falls back to the month.
    await page.reload();
    await expect(periodSelect(page)).toContainText('1 an');
    await page.goto(page.url().split('?')[0] + '?periode=nope');
    await expect(periodSelect(page)).toContainText('Mois');
  });

  test('the period survives a space switch', async ({ page, scenario }) => {
    const s = await scenario([SPACE_A, { label: 'B', role: 'editor', positions: [AI] }]);
    await s.signIn(page);
    await openDashboard(page);
    await pickPeriod(page, '6 mois');
    await expect(page).toHaveURL(/periode=6m/);

    await page.getByRole('combobox', { name: 'Espace' }).click();
    await page.getByRole('option', { name: s.spaces['B']!.name }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${s.spaces['B']!.id}\\?periode=6m$`));
    await expect(periodSelect(page)).toContainText('6 mois');
    await expect(page.getByTestId('total-value')).toBeVisible();
  });

  test('the FX toggle switches the chart label', async ({ page, scenario }) => {
    const s = await scenario([SPACE_A]);
    await s.signIn(page);
    await openDashboard(page);
    const title = page.getByTestId('chart-title');
    await expect(title).toHaveText('Valeur des positions actuelles');
    await expect(page.getByRole('button', { name: 'Taux historique' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: 'Taux actuel' }).click();
    await expect(title).toHaveText('Valeur des positions actuelles au taux de change actuel');
    await expect(page.getByTestId('current-fx')).toContainText('USD/EUR');

    await page.getByRole('button', { name: 'Taux historique' }).click();
    await expect(title).toHaveText('Valeur des positions actuelles');
  });

  test('hovering a chart point shows the FX rates applied', async ({ page, scenario }) => {
    const s = await scenario([SPACE_A]);
    await s.signIn(page);
    await openDashboard(page);
    await expect(plot(page)).toBeVisible();
    await page.getByTestId('history-plot').scrollIntoViewIfNeeded();
    const box = (await page.getByTestId('history-plot').boundingBox())!;
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    const tip = page.getByTestId('chart-tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Valeur');
    await expect(tip).toContainText('Évolution');
    await expect(page.getByTestId('tooltip-fx')).toContainText(
      /USD\/EUR\s: 0,\d{4} \(taux du \d{2}\/\d{2}\/\d{4}\)/,
    );
    await expect(page.getByTestId('tooltip-fx')).toContainText(/GBP\/EUR/);
    await expect(page.getByTestId('tooltip-fx')).toContainText('GBX');
  });

  test('a position without a price makes the total partial, with the reason', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [AI, CW8_UNPRICED] }]);
    await s.signIn(page);
    await openDashboard(page);
    const warning = page.getByTestId('partial-warning');
    await expect(warning).toContainText('Total partiel');
    await expect(warning).toContainText('Amundi');
    await expect(page.getByTestId('period-delta')).toContainText('total partiel');
    await expect(warning).toContainText('cours indisponible');
    // D20: nothing to draw while a counted position has no data, and the page says why.
    await expect(page.getByTestId('chart-notices')).toContainText(
      'Pas de donnée avant la création de',
    );
    await expect(page.getByTestId('total-value')).not.toHaveText('—');
  });

  test('an empty space says so and starts no dashboard request', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [] }]);
    const requests: string[] = [];
    page.on('request', (r) => r.url().includes('/api/rpc/dashboard/') && requests.push(r.url()));
    await s.signIn(page);
    await expect(page.getByTestId('empty-space')).toHaveText('Aucun titre dans cet espace.');
    expect(requests).toEqual([]);
  });

  test('returning to the dashboard within the staleTime does not refetch', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([SPACE_A]);
    const requests: string[] = [];
    page.on('request', (r) => r.url().includes('/api/rpc/dashboard/') && requests.push(r.url()));
    await s.signIn(page);
    await openDashboard(page);
    await expect(page.getByTestId('mover-row').first()).toBeVisible();
    const seen = requests.length;
    expect(seen).toBe(3);

    await page.getByRole('link', { name: 'Titres' }).click();
    await expect(page).toHaveURL(/\/titres/);
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByTestId('total-value')).toBeVisible();
    await expect(page.getByTestId('mover-row').first()).toBeVisible();
    expect(requests).toHaveLength(seen);
  });

  test('has no horizontal overflow at 375px', async ({ page, scenario }) => {
    const s = await scenario([
      { label: 'A', role: 'owner', positions: [AI, MC, MSFT, SHEL, CW8_UNPRICED] },
    ]);
    await page.setViewportSize({ width: 375, height: 800 });
    await s.signIn(page);
    await openDashboard(page);
    await expect(page.getByTestId('mover-row').first()).toBeVisible();
    await expect(page.getByTestId('partial-warning')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
