import { expect as browserExpect } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserHarness, browserPassword } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';

describe('Password confirmation through actual handlers', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;

  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
  });
  beforeEach(async () => {
    await fixture.database.db.deleteFrom('rateLimit').execute();
  });
  afterAll(async () => fixture?.close());

  for (const locale of ['en', 'it'] as const) {
    it(`requires an exact confirmation before changing the password (${locale})`, async () => {
      const page = locale === 'en' ? identities.user : identities.peer;
      const email = locale === 'en' ? 'alex@journey.example.test' : identities.peerEmail;
      const labels =
        locale === 'en'
          ? {
              current: 'Current password',
              next: 'New password',
              repeat: 'Repeat new password',
              change: 'Change password',
              mismatch: 'The new passwords do not match.',
              saved: 'Changes saved',
            }
          : {
              current: 'Password attuale',
              next: 'Nuova password',
              repeat: 'Ripeti nuova password',
              change: 'Cambia password',
              mismatch: 'Le nuove password non coincidono.',
              saved: 'Modifiche salvate',
            };
      await journeyRequest(fixture, page, '/api/auth/update-user', { locale });
      const otherSession = await fixture.page(locale);
      await journeyRequest(fixture, otherSession, '/api/auth/sign-in/email', {
        email,
        password: browserPassword,
      });
      if (locale === 'it') await page.setViewportSize({ width: 390, height: 844 });
      const requests: unknown[] = [];
      page.on('request', (request) => {
        if (request.url().endsWith('/api/auth/change-password'))
          requests.push(request.postDataJSON());
      });
      await page.goto(`${fixture.origin}/settings/security`);
      const password = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Password', exact: true }),
      });
      const submit = password.getByRole('button', { name: labels.change, exact: true });
      await submit.click();
      const current = password.getByLabel(labels.current, { exact: true });
      const next = password.getByLabel(labels.next, { exact: true });
      const repeat = password.getByLabel(labels.repeat, { exact: true });
      await browserExpect(current).toBeFocused();
      await browserExpect(repeat).toHaveAttribute('type', 'password');
      await browserExpect(repeat).toHaveAttribute('autocomplete', 'new-password');
      await browserExpect(repeat).toHaveAttribute('minlength', '12');
      await browserExpect(repeat).toHaveAttribute('maxlength', '128');
      await browserExpect(repeat).toHaveAttribute('required', '');
      await fixture.screenshot(page, `settings-password-confirmation-${locale}`);

      const newPassword = `${browserPassword}-${locale} `;
      await current.fill(browserPassword);
      await next.fill(newPassword);
      await submit.click();
      await browserExpect(repeat).toBeFocused();
      expect(await repeat.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(
        true,
      );
      expect(requests).toEqual([]);

      await repeat.fill(newPassword.trimEnd());
      await submit.click();
      await browserExpect(password.getByRole('alert')).toHaveText(labels.mismatch);
      expect(requests).toEqual([]);
      await browserExpect(current).toHaveValue(browserPassword);
      await browserExpect(next).toHaveValue(newPassword);

      await repeat.fill(newPassword);
      const response = page.waitForResponse((result) =>
        result.url().endsWith('/api/auth/change-password'),
      );
      await submit.click();
      expect((await response).status()).toBe(200);
      await browserExpect(password.getByRole('status')).toHaveText(labels.saved);
      await browserExpect(repeat).toHaveCount(0);
      expect(requests).toEqual([
        { currentPassword: browserPassword, newPassword, revokeOtherSessions: true },
      ]);
      expect((await page.request.get(`${fixture.origin}/v1/web/session`)).status()).toBe(200);
      expect((await otherSession.request.get(`${fixture.origin}/v1/web/session`)).status()).toBe(
        401,
      );
    });
  }
});
