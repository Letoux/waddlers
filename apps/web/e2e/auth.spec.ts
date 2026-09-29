import { expect, test, type Page } from '@playwright/test';

const user = () => ({
  name: process.env['E2E_USER_NAME']!,
  password: process.env['E2E_USER_PASSWORD']!,
});

async function login(page: Page, username: string, password: string) {
  await page.getByLabel('Identifiant').fill(username);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

test.describe('connexion', () => {
  test('unauthenticated visit of / redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible();
    await expect(page.getByText(/créer un compte/i)).toHaveCount(0);
  });

  test('empty submit shows French required messages', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByText('Ce champ est requis.')).toHaveCount(2);
    await expect(page.getByLabel('Identifiant')).toBeFocused();
  });

  test('protected page keeps the requested path through login', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await login(page, user().name, user().password);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Paramètres', level: 1 })).toBeVisible();
  });

  test('an external next parameter is ignored', async ({ page }) => {
    await page.goto('/login?next=//evil.example');
    await login(page, user().name, user().password);
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });

  test('bad credentials show a generic French error, unknown user identical', async ({ page }) => {
    await page.goto('/login');
    await login(page, user().name, 'not-the-password');
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Identifiant ou mot de passe incorrect.' });
    await expect(alert).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Mot de passe', { exact: true })).toBeFocused();

    await login(page, 'nobody-here', 'not-the-password');
    await expect(alert).toBeVisible();
  });

  test('login, see the username, logout, and / is protected again', async ({ page }) => {
    await page.goto('/login');
    await login(page, user().name, user().password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('current-user')).toContainText(user().name);

    // Already authenticated: /login bounces to /.
    await page.goto('/login');
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('paramètres', () => {
  test('change password: wrong current, then success, then new password works', async ({
    page,
  }) => {
    const name = process.env['E2E_PW_USER_NAME']!;
    const oldPassword = process.env['E2E_PW_USER_PASSWORD']!;
    const newPassword = `changed-${Date.now()}-password`;

    await page.goto('/login');
    await login(page, name, oldPassword);
    await page.getByRole('link', { name: 'Paramètres' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByText('12 caractères minimum.')).toBeVisible();

    const current = page.getByLabel('Mot de passe actuel');
    const next = page.getByLabel('Nouveau mot de passe', { exact: true });
    const confirm = page.getByLabel('Confirmer le nouveau mot de passe');
    const submit = page.getByRole('button', { name: 'Modifier le mot de passe' });

    // Client-side checks.
    await current.fill(oldPassword);
    await next.fill('short');
    await confirm.fill('short');
    await submit.click();
    await expect(page.getByText('Au moins 12 caractères.')).toBeVisible();
    await expect(next).toHaveAttribute('aria-invalid', 'true');

    await next.fill(newPassword);
    await confirm.fill(`${newPassword}x`);
    await submit.click();
    await expect(page.getByText('Les mots de passe ne correspondent pas.')).toBeVisible();

    // Wrong current password: field error, session still valid.
    await current.fill('definitely-wrong-password');
    await confirm.fill(newPassword);
    await submit.click();
    await expect(page.getByText('Le mot de passe actuel est incorrect.')).toBeVisible();
    await expect(current).toHaveAttribute('aria-invalid', 'true');
    await expect(current).toBeFocused();

    // Success.
    await current.fill(oldPassword);
    await submit.click();
    await expect(page.getByText('Mot de passe modifié.')).toBeVisible();
    await expect(current).toHaveValue('');
    await expect(next).toHaveValue('');

    // Session survives the rotation; the new password is what works from now on.
    await page.reload();
    await expect(page.getByTestId('current-user')).toContainText(name);
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page, name, oldPassword);
    await expect(page.getByRole('alert').filter({ hasText: 'incorrect' })).toBeVisible();
    await login(page, name, newPassword);
    await expect(page).toHaveURL(/\/$/);
  });
});

test('mobile width: login form usable without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto('/login');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible();
});
