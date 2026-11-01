import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, request as browserRequest, type Page } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../../../packages/auth/src/test-fixtures.js';
import { apiError } from '../src/api/client.js';
import { browserHarness, browserPassword } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';

interface AccountSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  current: boolean;
}

const copy = {
  en: {
    settings: 'Settings',
    passkeys: 'Passkeys',
    sessions: 'Sessions',
    addPasskey: 'Add passkey',
    name: 'Name',
    signIn: 'Sign in',
    signInAgain: 'Sign in again',
    freshness: 'Confirm your identity to continue.',
    genericError: 'The request failed. Try again or check Activity.',
    code: 'Authentication code',
    verify: 'Verify',
    twoFactor: 'Two-factor authentication',
  },
  it: {
    settings: 'Impostazioni',
    passkeys: 'Passkey',
    sessions: 'Sessioni',
    addPasskey: 'Aggiungi passkey',
    name: 'Nome',
    signIn: 'Accedi',
    signInAgain: 'Accedi di nuovo',
    freshness: 'Conferma la tua identità per continuare.',
    genericError: 'Richiesta non riuscita. Riprova o controlla Attività.',
    code: 'Codice di autenticazione',
    verify: 'Verifica',
    twoFactor: 'Autenticazione a due fattori',
  },
} as const;

for (const browser of ['chromium', 'firefox'] as const) {
  describe(`Account security after session freshness expires (${browser})`, () => {
    let fixture: Awaited<ReturnType<typeof browserHarness>>;
    let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
    let page: Page;
    const pageErrors: string[] = [];
    const email = 'alex@journey.example.test';

    beforeAll(async () => {
      fixture = await browserHarness({ browser });
      identities = await prepareJourneyIdentities(fixture);
      page = identities.user;
      page.on('pageerror', (error) => pageErrors.push(error.message));
      if (browser === 'chromium') {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('WebAuthn.enable');
        await cdp.send('WebAuthn.addVirtualAuthenticator', {
          options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        });
      }
    });
    beforeEach(async () => {
      await fixture.database.db.deleteFrom('rateLimit').execute();
    });
    afterAll(async () => fixture?.close());

    async function ageUserSessions() {
      // Only this account in the harness's generated schema is aged. Session
      // expiration stays untouched: this is fresh-auth expiry, not sign-out.
      const changed = await fixture.database.db
        .updateTable('session')
        .set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) })
        .where('userId', '=', identities.userId)
        .executeTakeFirst();
      expect(changed.numUpdatedRows).toBeGreaterThan(0n);
    }

    it('lists persisted sessions after their browser closes and revokes only the selected session', async () => {
      const secondBrowser = await fixture.page();
      await journeyRequest(fixture, secondBrowser, '/api/auth/sign-in/email', {
        email,
        password: browserPassword,
      });
      const secondSessions = await journeyRequest<AccountSession[]>(
        fixture,
        secondBrowser,
        '/v1/web/account/sessions',
      );
      const secondId = secondSessions.find((session) => session.current)?.id;
      expect(secondId).toBeTruthy();
      const persistedState = await secondBrowser.context().storageState();
      await secondBrowser.context().close();
      const persisted = await browserRequest.newContext({ storageState: persistedState });
      try {
        await ageUserSessions();
        expect((await persisted.get(`${fixture.origin}/v1/web/session`)).status()).toBe(200);
        const listed = page.waitForResponse((response) =>
          response.url().endsWith('/v1/web/account/sessions'),
        );
        await page.goto(`${fixture.origin}/settings/security`);
        const response = await listed;
        expect(response.status()).toBe(200);
        const sessions = (await response.json()) as AccountSession[];
        expect(sessions).toHaveLength(2);
        expect(sessions.filter((session) => session.current)).toHaveLength(1);
        expect(sessions.find((session) => session.id === secondId)?.current).toBe(false);
        for (const session of sessions) {
          expect(Object.keys(session).sort()).toEqual(
            ['id', 'createdAt', 'expiresAt', 'userAgent', 'ipAddress', 'current'].sort(),
          );
          expect(Date.parse(session.createdAt)).toBeLessThan(Date.now() - 5 * 60 * 1000);
          expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
        }
        const sessionSection = page.locator('section').filter({
          has: page.getByRole('heading', { name: 'Sessions', exact: true }),
        });
        await browserExpect(sessionSection.locator('.account-session')).toHaveCount(2);
        await browserExpect(sessionSection.getByRole('alert')).toHaveCount(0);

        const peerSessions = await journeyRequest<AccountSession[]>(
          fixture,
          identities.peer,
          '/v1/web/account/sessions',
        );
        const foreignId = peerSessions[0]?.id;
        expect(foreignId).toBeTruthy();
        const forbidden = await page.request.delete(
          `${fixture.origin}/v1/web/account/sessions/${foreignId}`,
          { headers: { Origin: fixture.origin } },
        );
        expect(forbidden.status()).toBe(404);
        expect(
          (await identities.peer.request.get(`${fixture.origin}/v1/web/session`)).status(),
        ).toBe(200);

        const otherRow = sessionSection
          .locator('.account-session')
          .filter({ hasNot: page.getByText('This session', { exact: true }) });
        await browserExpect(otherRow).toHaveCount(1);
        await otherRow.getByRole('button', { name: 'Revoke', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Sign out this session?', exact: true });
        await browserExpect(
          dialog.getByRole('button', { name: 'Cancel', exact: true }),
        ).toBeFocused();
        const revoked = page.waitForResponse(
          (result) =>
            result.url().endsWith(`/v1/web/account/sessions/${secondId}`) &&
            result.request().method() === 'DELETE',
        );
        await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
        expect((await revoked).status()).toBe(204);
        await browserExpect(dialog).not.toBeVisible();
        await browserExpect(sessionSection.locator('.account-session')).toHaveCount(1);
        expect((await persisted.get(`${fixture.origin}/v1/web/session`)).status()).toBe(401);
        expect((await page.request.get(`${fixture.origin}/v1/web/session`)).status()).toBe(200);
        await browserExpect(page.getByRole('alert')).toHaveCount(0);
      } finally {
        await persisted.dispose();
      }
      expect(pageErrors).toEqual([]);
    });

    for (const locale of ['en', 'it'] as const) {
      it(`recovers stale passkey registration through the existing ${locale === 'it' ? 'password and TOTP' : 'password'} sign-in (${locale})`, async () => {
        const labels = copy[locale];
        await page.goto(`${fixture.origin}/settings`);
        await page
          .getByRole('radio', { name: locale === 'it' ? 'Italiano' : 'English', exact: true })
          .check();
        await browserExpect
          .poll(
            async () =>
              (
                await fixture.database.db
                  .selectFrom('user')
                  .select('locale')
                  .where('id', '=', identities.userId)
                  .executeTakeFirstOrThrow()
              ).locale,
          )
          .toBe(locale);
        let secret: string | null = null;
        if (locale === 'it') {
          const enabled = await journeyRequest<{ totpURI: string }>(
            fixture,
            page,
            '/api/auth/two-factor/enable',
            { password: browserPassword },
          );
          secret = new URL(enabled.totpURI).searchParams.get('secret');
          if (!secret) throw new Error('Missing isolated TOTP secret');
          await journeyRequest(fixture, page, '/api/auth/two-factor/verify-totp', {
            code: totp(secret),
          });
        }
        await ageUserSessions();
        await page.setViewportSize(
          locale === 'it' ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        );
        const listed = page.waitForResponse((response) =>
          response.url().endsWith('/v1/web/account/sessions'),
        );
        const passkeysListed = page.waitForResponse((response) =>
          response.url().endsWith('/api/auth/passkey/list-user-passkeys'),
        );
        await page.goto(`${fixture.origin}/settings/security`);
        expect((await listed).status()).toBe(200);
        expect((await passkeysListed).status()).toBe(200);
        await browserExpect(
          page.getByRole('heading', { name: labels.settings, exact: true }),
        ).toBeVisible();
        await browserExpect(page.getByRole('alert')).toHaveCount(0);
        const passkeys = page.locator('section').filter({
          has: page.getByRole('heading', { name: labels.passkeys, exact: true }),
        });
        const sessions = page.locator('section').filter({
          has: page.getByRole('heading', { name: labels.sessions, exact: true }),
        });
        await passkeys.getByRole('button', { name: labels.addPasskey, exact: true }).click();
        await passkeys.getByLabel(labels.name, { exact: true }).fill(`Recovered ${locale} passkey`);
        const denied = page.waitForResponse((response) =>
          new URL(response.url()).pathname.endsWith('/api/auth/passkey/generate-register-options'),
        );
        await passkeys.getByRole('button', { name: labels.addPasskey, exact: true }).click();
        const stale = await denied;
        expect(stale.status()).toBe(403);
        const failure = await stale.json();
        expect(failure).toMatchObject({ error: { messageKey: 'auth.step_up_required' } });
        expect(apiError(failure, stale.status()).messageKey).toBe('auth.step_up_required');
        const alert = passkeys.getByRole('alert');
        await browserExpect(alert).toContainText(labels.freshness);
        await browserExpect(alert).not.toContainText(labels.genericError);
        await browserExpect(sessions.getByRole('alert')).toHaveCount(0);
        const signInAgain = alert.getByRole('link', { name: labels.signInAgain, exact: true });
        await browserExpect(signInAgain).toHaveAttribute('href', '/login?reauth=security');
        await signInAgain.focus();
        await browserExpect(signInAgain).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const accessibility = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(accessibility.violations.map(({ id }) => id)).toEqual([]);
        await fixture.screenshot(page, `settings-security-stale-passkey-${browser}-${locale}`);
        await page.keyboard.press('Enter');
        await browserExpect(page).toHaveURL(`${fixture.origin}/login?reauth=security`);
        await browserExpect(
          page.getByRole('heading', { name: labels.signIn, exact: true }),
        ).toBeVisible();
        await fixture.screenshot(page, `settings-security-reauth-login-${browser}-${locale}`);
        await page.getByLabel('Email', { exact: true }).fill(email);
        await page.getByLabel('Password', { exact: true }).fill(browserPassword);
        await page.getByRole('button', { name: labels.signIn, exact: true }).click();
        if (secret) {
          await browserExpect(
            page.getByRole('heading', { name: labels.twoFactor, exact: true }),
          ).toBeVisible();
          await browserExpect(page).toHaveURL(`${fixture.origin}/login?reauth=security`);
          await page.getByLabel(labels.code, { exact: true }).fill(totp(secret));
          await page.getByRole('button', { name: labels.verify, exact: true }).click();
        }
        await browserExpect(page).toHaveURL(`${fixture.origin}/settings/security`);
        await browserExpect(sessions.locator('.account-session').first()).toBeVisible();
        await browserExpect(page.getByRole('alert')).toHaveCount(0);
        expect((await page.request.get(`${fixture.origin}/v1/web/account/sessions`)).status()).toBe(
          200,
        );
        expect(
          (
            await page.request.get(`${fixture.origin}/api/auth/passkey/list-user-passkeys`)
          ).status(),
        ).toBe(200);
        expect(
          (
            await page.request.get(`${fixture.origin}/api/auth/passkey/generate-register-options`)
          ).status(),
        ).toBe(200);
        const current = await journeyRequest<{ actor: { id: string } }>(
          fixture,
          page,
          '/v1/web/session',
        );
        expect(current.actor.id).toBe(identities.userId);
        if (browser === 'chromium' && locale === 'en') {
          await passkeys.getByRole('button', { name: labels.addPasskey, exact: true }).click();
          await passkeys
            .getByLabel(labels.name, { exact: true })
            .fill(`Recovered ${locale} passkey`);
          const registered = page.waitForResponse((response) =>
            response.url().endsWith('/api/auth/passkey/verify-registration'),
          );
          await passkeys.getByRole('button', { name: labels.addPasskey, exact: true }).click();
          expect((await registered).status()).toBe(200);
          await browserExpect(
            passkeys.getByText(`Recovered ${locale} passkey`, { exact: true }),
          ).toBeVisible();
          await browserExpect(passkeys.getByLabel(labels.name, { exact: true })).toHaveCount(0);
          expect(
            await fixture.database.db
              .selectFrom('passkey')
              .select('id')
              .where('userId', '=', identities.userId)
              .where('name', '=', `Recovered ${locale} passkey`)
              .execute(),
          ).toHaveLength(1);
        }
        await browserExpect(page.getByRole('alert')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
      });
    }

    it('returns to sign-in when the current session is revoked', async () => {
      await ageUserSessions();
      await page.goto(`${fixture.origin}/settings/security`);
      const currentRow = page.locator('.account-session').filter({
        has: page.getByText('Questa sessione', { exact: true }),
      });
      await browserExpect(currentRow).toHaveCount(1);
      await currentRow.getByRole('button', { name: 'Revoca', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const revoked = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.startsWith('/v1/web/account/sessions/') &&
          response.request().method() === 'DELETE',
      );
      await dialog.getByRole('button', { name: 'Revoca', exact: true }).click();
      expect((await revoked).status()).toBe(204);
      await browserExpect(page).toHaveURL(`${fixture.origin}/login`);
      expect((await page.request.get(`${fixture.origin}/v1/web/session`)).status()).toBe(401);
      expect(pageErrors).toEqual([]);
    });
  });
}
