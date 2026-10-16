import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';

for (const browser of ['chromium', 'firefox'] as const) {
  describe(`Profile settings through actual handlers (${browser})`, () => {
    let fixture: Awaited<ReturnType<typeof browserHarness>>;
    let page: Page;
    let userId: string;
    const errors: string[] = [];
    const reactErrors: string[] = [];
    const originalEmail = 'alex@journey.example.test';

    beforeAll(async () => {
      fixture = await browserHarness({ browser });
      const identities = await prepareJourneyIdentities(fixture);
      page = identities.user;
      userId = identities.userId;
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          /same key|Each child|React has detected/.test(message.text())
        )
          reactErrors.push(message.text());
      });
      await page.goto(`${fixture.origin}/settings`);
      await browserExpect(page.getByLabel('Display name', { exact: true })).toHaveValue('Alex');
    });
    afterAll(async () => fixture?.close());

    const save = () => page.locator('.account-details-form button[type="submit"]');
    const profile = () => page.locator('.account-profile');
    async function storedProfile() {
      return fixture.database.db
        .selectFrom('user')
        .select(['name', 'locale', 'email', 'username'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
    }
    async function accessibility() {
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        result.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map((n) => n.target) })),
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      expect(reactErrors).toEqual([]);
    }

    it('keeps unchanged profiles quiet and preserves the draft through failed and pending saves', async () => {
      await browserExpect(save()).toBeDisabled();
      const initial = await storedProfile();
      expect(initial.username).toBeTruthy();
      await browserExpect(profile().getByLabel('Username', { exact: true })).toHaveCount(0);
      await browserExpect(profile()).toContainText(initial.username ?? '');
      const name = page.getByLabel('Display name', { exact: true });
      const restingBorder = await name.evaluate(
        (element) => getComputedStyle(element).borderTopColor,
      );
      await name.focus();
      await browserExpect(name).not.toHaveCSS('border-top-color', restingBorder);
      await browserExpect(name).toHaveCSS('outline-style', 'none');
      await browserExpect(name).toHaveCSS('box-shadow', 'none');
      await page.keyboard.press('Tab');
      await browserExpect(page.getByLabel('Language', { exact: true })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await browserExpect(name).toBeFocused();
      await name.fill('Alex Rivera');
      await browserExpect(save()).toBeEnabled();
      await page.route('**/api/auth/update-user', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal_error' } }),
        }),
      );
      await save().click();
      await browserExpect(profile().getByRole('alert')).toBeVisible();
      await browserExpect(name).toHaveValue('Alex Rivera');
      expect((await storedProfile()).name).toBe('Alex');
      await page.unroute('**/api/auth/update-user');

      let release = () => {};
      let pending = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/auth/update-user', async (route) => {
        pending = true;
        await gate;
        await route.continue();
      });
      try {
        await save().click();
        await browserExpect.poll(() => pending).toBe(true);
        await browserExpect(name).toBeDisabled();
        await browserExpect(page.getByLabel('Language', { exact: true })).toBeDisabled();
        await browserExpect(save()).toBeDisabled();
        expect((await storedProfile()).name).toBe('Alex');
      } finally {
        release();
      }
      await browserExpect(
        page.getByRole('button', { name: 'Profile: Alex Rivera', exact: true }),
      ).toBeVisible();
      await page.unroute('**/api/auth/update-user');
      await browserExpect(save()).toBeDisabled();
      await browserExpect(name).toHaveValue('Alex Rivera');
      await page.reload();
      await browserExpect(name).toHaveValue('Alex Rivera');
      await browserExpect(save()).toBeDisabled();
      expect((await storedProfile()).username).toBe(initial.username);
      await accessibility();
      if (browser === 'firefox') {
        await fixture.screenshot(page, 'settings-profile-polish-desktop-en');
        await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'it' });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await browserExpect(page.getByLabel('Lingua', { exact: true })).toHaveValue('it');
        await accessibility();
        await fixture.screenshot(page, 'settings-profile-polish-mobile-it');
        await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'en' });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.reload();
        await browserExpect(name).toHaveValue('Alex Rivera');
      }
      expect(reactErrors).toEqual([]);
    });

    it('opens email changes inline and keeps the current address until verification', async () => {
      const change = () => page.getByRole('button', { name: 'Change email', exact: true });
      await browserExpect(page.getByRole('textbox', { name: 'Email', exact: true })).toHaveCount(0);
      await browserExpect(
        profile().getByText(originalEmail, { exact: true }).first(),
      ).toBeVisible();
      await change().click();
      const email = page.getByRole('textbox', { name: 'Email', exact: true });
      await browserExpect(email).toBeFocused();
      await email.fill('discarded@journey.example.test');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(email).toHaveCount(0);
      expect(fixture.mails.some((mail) => mail.to === 'discarded@journey.example.test')).toBe(
        false,
      );
      await change().click();
      const nextEmail = 'alex-updated@journey.example.test';
      await email.fill(nextEmail);
      let release = () => {};
      let pending = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/auth/change-email', async (route) => {
        pending = true;
        await gate;
        await route.continue();
      });
      const finished = page.waitForResponse((response) =>
        response.url().endsWith('/api/auth/change-email'),
      );
      try {
        await change().click();
        await browserExpect.poll(() => pending).toBe(true);
        await browserExpect(email).toBeDisabled();
        await browserExpect(
          page.getByRole('button', { name: 'Cancel', exact: true }),
        ).toBeDisabled();
        await browserExpect(
          profile().getByText(originalEmail, { exact: true }).first(),
        ).toBeVisible();
        expect((await storedProfile()).email).toBe(originalEmail);
      } finally {
        release();
      }
      expect((await finished).status()).toBe(200);
      await page.unroute('**/api/auth/change-email');
      await browserExpect(
        page.getByText('Check your email for the verification link, then sign in.'),
      ).toBeVisible();
      expect(fixture.mails.some((mail) => mail.to === nextEmail)).toBe(true);
      expect((await storedProfile()).email).toBe(originalEmail);
      await browserExpect(
        profile().getByText(originalEmail, { exact: true }).first(),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(email).toHaveCount(0);
    });

    it('keeps the only login method, localizes saved preferences and fits desktop and mobile', async () => {
      const methods = profile().locator('.account-method');
      await browserExpect(methods.getByText('Email', { exact: true })).toBeVisible();
      await browserExpect(profile().getByRole('button', { name: /^Unlink/ })).toHaveCount(0);
      await browserExpect(
        profile().getByRole('button', { name: 'Link Discord', exact: true }),
      ).toHaveCount(0);
      await accessibility();
      if (browser === 'firefox')
        await fixture.screenshot(page, 'settings-profile-polish-desktop-en');
      await page.getByLabel('Language', { exact: true }).selectOption('it');
      await browserExpect(save()).toBeEnabled();
      await save().click();
      await browserExpect(
        page.getByRole('heading', { name: 'Impostazioni', exact: true }),
      ).toBeVisible();
      await browserExpect(
        page.getByRole('button', { name: 'Salva modifiche', exact: true }),
      ).toBeDisabled();
      expect((await storedProfile()).locale).toBe('it');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await browserExpect(page.getByLabel('Lingua', { exact: true })).toHaveValue('it');
      await browserExpect(
        page.getByRole('button', { name: 'Cambia foto', exact: true }),
      ).toBeVisible();
      await accessibility();
      if (browser === 'firefox')
        await fixture.screenshot(page, 'settings-profile-polish-mobile-it');
    });
  });
}
