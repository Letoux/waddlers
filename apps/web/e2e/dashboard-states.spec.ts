import type { Page, Route } from '@playwright/test';
import { AI, expect, MC, MSFT, SHEL, test, type ScenarioSpace } from './support/fixtures';

// Error, rate-limit, stale and invariant scenarios of the dashboard. Backend answers are altered
// per test with `page.route` (the fake market data is shared by all tests and never mutated).
test.describe.configure({ timeout: 90_000 });

const SPACE_A: ScenarioSpace = { label: 'A', role: 'owner', positions: [AI, MC, MSFT, SHEL] };
const UNAVAILABLE = 'Les données financières ne sont actuellement pas disponibles.';
const periodSelect = (page: Page) => page.getByRole('combobox', { name: 'Période' });
const pickPeriod = async (page: Page, label: string) => {
  await periodSelect(page).click();
  await page.getByRole('option', { name: label, exact: true }).click();
};
const SUMMARY = '**/api/rpc/dashboard/summary*';
const HISTORY = '**/api/rpc/dashboard/history*';

async function openDashboard(page: Page) {
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('total-value')).toBeVisible();
  await expect(page.getByTestId('history-plot')).toBeVisible();
}

const rateLimited = (route: Route, seconds = 1) =>
  route.fulfill({
    status: 429,
    contentType: 'application/json',
    headers: { 'retry-after': String(seconds) },
    body: JSON.stringify({
      json: {
        defined: true,
        code: 'TOO_MANY_REQUESTS',
        status: 429,
        message: 'internal limiter detail',
        data: { retryAfterSeconds: seconds },
      },
    }),
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

/** Fetches the real answer and lets `edit` change its JSON payload (oRPC wraps it in `json`). */
const alter = (edit: (data: Payload) => void) => async (route: Route) => {
  const response = await route.fetch();
  const body = (await response.json()) as { json: Payload };
  edit(body.json);
  await route.fulfill({ response, json: body });
};

const eurValue = (text: string) =>
  Number(
    text
      .replace(/−/g, '-')
      .replace(/[^\d,-]/g, '')
      .replace(',', '.'),
  );

test.describe('dashboard states', () => {
  test('quick period changes and FX toggles never leave an error block', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([SPACE_A]);
    await s.signIn(page);
    await openDashboard(page);

    await pickPeriod(page, '1 an');
    await pickPeriod(page, 'Max');
    await page.getByRole('button', { name: 'Taux actuel' }).click();
    await page.getByRole('button', { name: 'Taux historique' }).click();
    await page.getByRole('button', { name: 'Taux actuel' }).click();

    await expect(page).toHaveURL(/periode=max/);
    await expect(page.getByTestId('chart-title')).toContainText('au taux de change actuel');
    await expect(page.getByTestId('total-value')).not.toHaveText('—');
    await expect(page.getByTestId('history-plot')).toBeVisible();
    await expect(page.getByTestId('current-fx')).toBeVisible();
    // Neither a block error nor a skeleton may remain once the queries settled.
    await expect(page.getByTestId('summary-error')).toHaveCount(0);
    await expect(page.getByTestId('history-error')).toHaveCount(0);
    await expect(page.getByText(UNAVAILABLE)).toHaveCount(0);
    await expect(page.getByText('Trop de requêtes')).toHaveCount(0);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  });

  test('a single 429 is retried after retryAfterSeconds and never shown', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([SPACE_A]);
    let calls = 0;
    await page.route(SUMMARY, (route) => (++calls === 1 ? rateLimited(route) : route.continue()));
    await s.signIn(page);
    await expect(page.getByTestId('total-value')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('total-value')).not.toHaveText('—');
    expect(calls).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('Trop de requêtes')).toHaveCount(0);
  });

  test('a persistent 429 shows the wait, never the server message, then Réessayer recovers', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([SPACE_A]);
    let limited = true;
    await page.route(SUMMARY, (route) => (limited ? rateLimited(route) : route.continue()));
    await s.signIn(page);
    const error = page.getByTestId('summary-error');
    // Initial call + two retries (1 s each) are refused, then the message stays.
    await expect(error).toContainText('Réessayez dans 1 seconde', { timeout: 20_000 });
    await expect(error).not.toContainText('internal limiter detail');
    limited = false;
    await error.getByRole('button', { name: 'Réessayer' }).click();
    await expect(page.getByTestId('total-value')).not.toHaveText('—');
    await expect(error).toHaveCount(0);
  });

  test('spec 36 error state: neutral message and Réessayer, no technical detail', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([SPACE_A]);
    let broken = true;
    const fail = (route: Route) =>
      broken
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              json: {
                defined: false,
                code: 'INTERNAL_SERVER_ERROR',
                status: 500,
                message: 'pg: boom',
              },
            }),
          })
        : route.continue();
    await page.route(SUMMARY, fail);
    await page.route(HISTORY, fail);
    await s.signIn(page);
    const error = page.getByTestId('summary-error');
    await expect(error).toContainText(UNAVAILABLE, { timeout: 30_000 });
    await expect(page.getByTestId('history-error')).toContainText(UNAVAILABLE);
    await expect(error.getByRole('button', { name: 'Réessayer' })).toBeVisible();
    await expect(page.getByText('pg: boom')).toHaveCount(0);
    await expect(page.getByTestId('total-value')).toHaveCount(0); // never a 0 €

    broken = false;
    await error.getByRole('button', { name: 'Réessayer' }).click();
    await expect(page.getByTestId('total-value')).not.toHaveText('—');
    await expect(error).toHaveCount(0);
  });

  test('old prices show the stale badge and the price date range', async ({ page, scenario }) => {
    const s = await scenario([SPACE_A]);
    await s.signIn(page);
    await openDashboard(page);
    await expect(page.getByTestId('stale-badge')).toHaveCount(0);
    await expect(page.getByTestId('chart-stale-badge')).toHaveCount(0);

    await page.route(
      SUMMARY,
      alter((d) => {
        d.freshness = {
          ...d.freshness,
          isStale: true,
          oldestPriceDate: '2026-09-01',
          newestPriceDate: '2026-09-30',
          stalePositions: [{ positionId: 'p', name: 'Air Liquide', asOf: '2026-09-01' }],
        };
      }),
    );
    await page.route(
      HISTORY,
      alter((d) => (d.isStale = true)),
    );
    await pickPeriod(page, '6 mois');
    await expect(page.getByTestId('stale-badge')).toBeVisible();
    await expect(page.getByTestId('chart-stale-badge')).toBeVisible();
    await expect(page.getByTestId('as-of')).toHaveText(
      'Cours du 1 septembre 2026 au 30 septembre 2026',
    );
    await expect(page.getByTestId('freshness')).toContainText('Air Liquide (cours du 01/09/2026)');
  });

  test('D23 on screen: total - delta = first chart value, total = last chart value', async ({
    page,
    scenario,
  }) => {
    const s = await scenario([SPACE_A]);
    await s.signIn(page);
    await openDashboard(page);
    await expect(page.getByTestId('delta-amount')).toBeVisible();
    const total = eurValue(await page.getByTestId('total-value').innerText());
    const delta = eurValue(await page.getByTestId('delta-amount').innerText());
    const summary = (await page.getByTestId('chart-summary').innerText()).replace(
      /[\u202f\u00a0]/g,
      ' ',
    );
    const m = /de (-?[\d ]+) € à (-?[\d ]+) €/.exec(summary);
    expect(m, summary).not.toBeNull();
    const [first, last] = [eurValue(m![1]!), eurValue(m![2]!)];
    expect(last).toBe(total);
    // Exact on the wire; each figure is rounded to the euro for display, so allow one euro.
    expect(Math.abs(total - delta - first)).toBeLessThanOrEqual(1);
  });

  test('a GBP-only rate carries no pence note', async ({ page, scenario }) => {
    const s = await scenario([{ label: 'A', role: 'owner', positions: [SHEL] }]);
    await page.route(
      HISTORY,
      alter((d) => {
        for (const p of d.points) for (const r of p.fxRates) r.quotedCurrencies = ['GBP'];
      }),
    );
    await s.signIn(page);
    await openDashboard(page);
    await page.getByTestId('history-plot').scrollIntoViewIfNeeded();
    const box = (await page.getByTestId('history-plot').boundingBox())!;
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    const fx = page.getByTestId('tooltip-fx');
    await expect(fx).toContainText('GBP/EUR');
    await expect(fx).not.toContainText('GBX');
    await expect(fx).not.toContainText('pence');
  });
});
