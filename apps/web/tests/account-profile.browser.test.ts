import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';

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
      await browserExpect(page.getByRole('button', { name: /^Edit display name:/ })).toBeVisible();
    });
    afterAll(async () => fixture?.close());

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

    it('edits the name inline, cancels with Escape and preserves failed or pending drafts', async () => {
      const initial = await storedProfile();
      expect(initial.username).toBeTruthy();
      await browserExpect(
        profile().getByRole('textbox', { name: 'Username', exact: true }),
      ).toHaveCount(0);
      await browserExpect(profile()).toContainText(initial.username ?? '');
      await browserExpect(
        profile().getByRole('button', { name: 'Save changes', exact: true }),
      ).toHaveCount(0);
      const edit = page.getByRole('button', { name: /^Edit display name:/ });
      const name = page.getByRole('textbox', { name: 'Display name', exact: true });
      await browserExpect(name).toHaveCount(0);
      await edit.click();
      await browserExpect(name).toBeFocused();
      await browserExpect(name).toHaveCSS('outline-style', 'none');
      await browserExpect(name).toHaveCSS('box-shadow', 'none');
      await name.fill('Discarded name');
      await page.keyboard.press('Escape');
      await browserExpect(name).toHaveCount(0);
      expect((await storedProfile()).name).toBe(initial.name);
      await edit.click();
      await name.fill('Alex Rivera');
      await page.route('**/api/auth/update-user', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal_error' } }),
        }),
      );
      await name.press('Enter');
      await browserExpect(profile().getByRole('alert')).toBeVisible();
      await browserExpect(name).toHaveValue('Alex Rivera');
      expect((await storedProfile()).name).toBe(initial.name);
      await page.unroute('**/api/auth/update-user');

      let release = () => {};
      let pending = false;
      const payloads: unknown[] = [];
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/auth/update-user', async (route) => {
        payloads.push(route.request().postDataJSON());
        pending = true;
        await gate;
        await route.continue();
      });
      try {
        await name.press('Enter');
        await browserExpect.poll(() => pending).toBe(true);
        await browserExpect(name).toBeDisabled();
        await browserExpect(
          page.getByRole('radio', { name: 'English', exact: true }),
        ).toBeEnabled();
        expect((await storedProfile()).name).toBe(initial.name);
      } finally {
        release();
      }
      await browserExpect(
        page.getByRole('button', { name: 'Profile: Alex Rivera', exact: true }),
      ).toBeVisible();
      await browserExpect(name).toHaveCount(0);
      await page.unroute('**/api/auth/update-user');
      expect(payloads).toEqual([{ name: 'Alex Rivera' }]);
      await page.reload();
      await browserExpect(
        profile().getByRole('heading', { name: 'Alex Rivera', exact: true }),
      ).toBeVisible();
      expect((await storedProfile()).username).toBe(initial.username);
      await accessibility();
      if (browser === 'firefox')
        await fixture.screenshot(page, 'settings-profile-polish-desktop-en');
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
      if (browser === 'firefox')
        await fixture.screenshot(page, 'settings-profile-email-edit-desktop-en');
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

    it('saves language immediately, rolls back failures and preserves a concurrent name change', async () => {
      const initial = await storedProfile();
      const english = page.getByRole('radio', { name: 'English', exact: true });
      const italian = page.getByRole('radio', { name: 'Italiano', exact: true });
      const methods = profile().locator('.account-method');
      await browserExpect(methods.getByText('Email', { exact: true })).toBeVisible();
      await browserExpect(profile().getByRole('button', { name: /^Unlink/ })).toHaveCount(0);
      await browserExpect(
        profile().getByRole('button', { name: 'Link Discord', exact: true }),
      ).toHaveCount(0);
      let release = () => {};
      let pending = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/auth/update-user', async (route) => {
        pending = true;
        await gate;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal_error' } }),
        });
      });
      try {
        await english.focus();
        await page.keyboard.press('ArrowRight');
        await browserExpect.poll(() => pending).toBe(true);
        await browserExpect(italian).toBeChecked();
        await browserExpect(italian).toBeDisabled();
        await browserExpect(english).toBeDisabled();
        await browserExpect(
          page.getByRole('heading', { name: 'Impostazioni', exact: true }),
        ).toBeVisible();
        expect((await storedProfile()).locale).toBe(initial.locale);
      } finally {
        release();
      }
      await browserExpect(profile().getByRole('alert')).toBeVisible();
      await browserExpect(english).toBeChecked();
      await browserExpect(
        page.getByRole('heading', { name: 'Settings', exact: true }),
      ).toBeVisible();
      await page.unroute('**/api/auth/update-user');
      const payloads: unknown[] = [];
      await page.route('**/api/auth/update-user', async (route) => {
        payloads.push(route.request().postDataJSON());
        await route.continue();
      });
      await page.getByRole('button', { name: /^Edit display name:/ }).click();
      await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Alex Updated');
      // Clicking the language also blurs the name: both independent updates must survive.
      await italian.check();
      await browserExpect
        .poll(async () => {
          const stored = await storedProfile();
          return { name: stored.name, locale: stored.locale };
        })
        .toEqual({ name: 'Alex Updated', locale: 'it' });
      await browserExpect(
        page.getByRole('button', { name: 'Profilo: Alex Updated', exact: true }),
      ).toBeVisible();
      await browserExpect(italian).toBeEnabled();
      await page.unroute('**/api/auth/update-user');
      expect(payloads).toHaveLength(2);
      expect(payloads).toEqual(
        expect.arrayContaining([{ name: 'Alex Updated' }, { locale: 'it' }]),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await browserExpect(italian).toBeChecked();
      await browserExpect(
        page.getByRole('button', { name: 'Cambia foto', exact: true }),
      ).toBeVisible();
      await accessibility();
      if (browser === 'firefox')
        await fixture.screenshot(page, 'settings-profile-polish-mobile-it');
    });
  });
}
