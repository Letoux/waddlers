import { expect, test } from '@playwright/test';
import { account, login } from './support/accounts';

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
    const { username, password } = account('next-kept');
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await login(page, username, password);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Paramètres', level: 1 })).toBeVisible();
  });

  test('a next parameter with a query string survives login', async ({ page }) => {
    const { username, password } = account('next-query');
    await page.goto('/settings?tab=securite&x=1');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%3Ftab%3Dsecurite%26x%3D1$/);
    await login(page, username, password);
    await expect(page).toHaveURL(/\/settings\?tab=securite&x=1$/);
  });

  test('an external or dot-segment next parameter is ignored', async ({ page }) => {
    const { username, password } = account('external-next');
    for (const next of ['//evil.example', '/..//evil.example', '/%2e%2e//evil.example']) {
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await login(page, username, password);
      await expect(page).toHaveURL(/localhost:\d+\/$/);
      await page.getByRole('button', { name: 'Se déconnecter' }).click();
      await expect(page).toHaveURL(/\/login$/);
    }
  });

  test('bad credentials show a generic French error, unknown user identical', async ({ page }) => {
    const { username } = account('bad-credentials');
    await page.goto('/login');
    await login(page, username, 'not-the-password');
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Identifiant ou mot de passe incorrect.' });
    await expect(alert).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Mot de passe', { exact: true })).toBeFocused();

    await login(page, 'nobody-here', 'not-the-password');
    await expect(alert).toBeVisible();
  });

  test('too many failures show the wait duration (429)', async ({ page }) => {
    const { username, password } = account('throttle');
    await page.goto('/login');
    const throttled = page.getByRole('alert').filter({ hasText: 'Trop de tentatives.' });
    for (let i = 0; i < 8 && !(await throttled.isVisible()); i++) {
      await login(page, username, `wrong-password-${i}`);
      await page
        .getByRole('alert')
        .filter({ hasText: /incorrect|Trop de tentatives/ })
        .waitFor();
    }
    await expect(throttled).toContainText(/Réessayez dans (\d+ minutes|moins d’une minute)\./);
    // Even the right password is refused while throttled, without leaking why to other messages.
    await login(page, username, password);
    await expect(throttled).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('login, see the username, logout, and / is protected again', async ({ page }) => {
    const { username, password } = account('login-logout');
    await page.goto('/login');
    await login(page, username, password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('current-user')).toContainText(username);

    // Already authenticated: /login bounces to /.
    await page.goto('/login');
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('logout with an already expired session still lands on /login', async ({
    page,
    context,
  }) => {
    const { username, password } = account('logout-expired');
    await page.goto('/login');
    await login(page, username, password);
    await expect(page).toHaveURL(/\/$/);
    await context.clearCookies(); // the session is gone server-side as far as the browser knows
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('garde de route', () => {
  test('an anonymous client-side RSC navigation to /settings gets no page content', async ({
    request,
  }) => {
    account('rsc-anonymous'); // reserved, keeps one account per scenario
    // Router state as a client claiming the (app) layout is already mounted (shape validated by
    // Next: nested [segment, routes] tuples, root flags as a number).
    const tree = encodeURIComponent(
      JSON.stringify(['', { children: ['(app)', { children: ['__PAGE__', {}] }] }, null, null, 1]),
    );
    for (const path of ['/settings', '/settings?tab=x']) {
      const res = await request.get(`${path}${path.includes('?') ? '&' : '?'}_rsc=abcde`, {
        headers: { RSC: '1', 'Next-Router-State-Tree': tree, 'Next-Url': '/' },
      });
      const body = await res.text();
      // Either a redirect to /login or a payload that redirects: never the protected content.
      expect(body).not.toContain('Mot de passe actuel');
      expect(body).not.toContain('vos autres sessions');
      // Next first redirects to add the `_rsc` cache-busting hash, then answers the guarded
      // request: the payload must be the login redirect.
      expect(res.status()).toBe(200);
      expect(body).toMatch(/NEXT_REDIRECT;replace;\/login\?next=/);
    }
  });
});

test.describe('paramètres', () => {
  test('change password: wrong current, then success, then new password works', async ({
    page,
  }, testInfo) => {
    // A retry starts after the first attempt may already have changed the password.
    const { username: name, password: oldPassword } = account(
      testInfo.retry > 0 ? 'password-retry' : 'password',
    );
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
