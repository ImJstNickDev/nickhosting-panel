import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../../../packages/auth/src/test-fixtures.js';
import { browserHarness, browserPassword } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';

describe('M5 guided authenticator enrollment through real identity handlers', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let user: Page;
  let accountIndex = 0;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
  });
  beforeEach(async () => {
    await fixture.database.db.deleteFrom('rateLimit').execute();
    user = (
      await identities.invite('Authenticator tester', `totp-${++accountIndex}@journey.example.test`)
    ).page;
    user.on('pageerror', (error) => pageErrors.push(error.message));
    await user.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await user.goto(`${fixture.origin}/settings/security`);
    await browserExpect(
      section().getByRole('button', { name: 'Enable', exact: true }),
    ).toBeVisible();
  });
  afterEach(async () => {
    await user?.context().close();
    expect(pageErrors).toEqual([]);
  });
  afterAll(async () => {
    await fixture?.close();
  });

  function section() {
    return user.locator('section').filter({
      has: user.getByRole('heading', {
        name: /^(Two-factor authentication|Autenticazione a due fattori)$/,
      }),
    });
  }
  function tabs() {
    return user.getByRole('navigation', { name: 'Settings', exact: true });
  }
  async function start() {
    await section().getByRole('button', { name: 'Enable', exact: true }).click();
    await section().getByLabel('Current password', { exact: true }).fill(browserPassword);
    await section().getByRole('button', { name: 'Continue', exact: true }).click();
    await browserExpect(
      section().getByRole('heading', { name: 'Connect your authenticator', exact: true }),
    ).toBeVisible();
    await browserExpect(
      section().getByRole('img', { name: 'Authenticator QR code' }),
    ).toBeVisible();
  }
  async function setupKey() {
    const details = section().locator('details').filter({ hasText: 'Enter key manually' });
    if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
      await details.locator('summary').click();
    const input = details.getByLabel('Authenticator setup key', { exact: true });
    await browserExpect(input).toHaveAttribute('readonly', '');
    const value = await input.inputValue();
    expect(value).toMatch(/^[A-Z2-7]+$/);
    return value;
  }
  async function storage() {
    return user.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
  }
  async function screenshot(name: string) {
    await user.evaluate(() => window.scrollTo(0, 0));
    await user.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots', `settings-totp-${name}.png`),
      fullPage: true,
      maskColor: '#c8d2d9',
      mask: [
        user.locator('input[type="password"]:visible'),
        section().getByRole('img'),
        section().locator('input[readonly]:visible'),
        section().locator('input[autocomplete="one-time-code"]:visible'),
        section().locator('li code:visible'),
      ],
    });
  }
  async function accessible() {
    const result = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    ).toEqual([]);
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }

  it('cancels password entry and retains one pending setup across tabs, defer and resume', async () => {
    const enableRequests: string[] = [];
    user.on('request', (request) => {
      if (request.url().endsWith('/api/auth/two-factor/enable')) enableRequests.push(request.url());
    });
    const initialStorage = await storage();
    await section().getByRole('button', { name: 'Enable', exact: true }).click();
    await browserExpect(section().getByLabel('Current password', { exact: true })).toBeFocused();
    await screenshot('password-desktop-en');
    await accessible();
    await section().getByLabel('Current password', { exact: true }).fill(browserPassword);
    await section().getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(
      section().getByRole('button', { name: 'Enable', exact: true }),
    ).toBeFocused();
    expect(enableRequests).toEqual([]);

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending = false;
    await user.route('**/api/auth/two-factor/enable', async (route) => {
      pending = true;
      await gate;
      await route.continue();
    });
    try {
      await section().getByRole('button', { name: 'Enable', exact: true }).click();
      await section().getByLabel('Current password', { exact: true }).fill(browserPassword);
      await section().getByRole('button', { name: 'Continue', exact: true }).click();
      await browserExpect.poll(() => pending).toBe(true);
      await tabs().getByRole('link', { name: 'Profile', exact: true }).click();
      await tabs().getByRole('link', { name: 'Security', exact: true }).click();
      await browserExpect(section().getByLabel('Current password', { exact: true })).toBeDisabled();
      await browserExpect(
        section().getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeDisabled();
      await browserExpect(
        section().getByRole('button', { name: 'Continue', exact: true }),
      ).toBeDisabled();
      await screenshot('loading-desktop-en');
    } finally {
      release();
    }
    await browserExpect(
      section().getByRole('img', { name: 'Authenticator QR code' }),
    ).toBeVisible();
    await user.unroute('**/api/auth/two-factor/enable');
    expect(enableRequests).toHaveLength(1);
    await browserExpect(section().locator('li code')).toHaveCount(0);
    await browserExpect(section().getByText('Disabled', { exact: true })).toBeVisible();
    const key = await setupKey();
    await section().getByRole('button', { name: 'Copy setup key', exact: true }).click();
    expect(await user.evaluate(() => navigator.clipboard.readText())).toBe(key);
    await screenshot('authenticator-manual-desktop-en');
    await accessible();
    await section().getByLabel('Authentication code', { exact: true }).fill('123');
    await tabs().getByRole('link', { name: 'Profile', exact: true }).click();
    await tabs().getByRole('link', { name: 'Security', exact: true }).click();
    expect(await setupKey()).toBe(key);
    await browserExpect(section().getByLabel('Authentication code', { exact: true })).toHaveValue(
      '',
    );
    await section().getByRole('button', { name: 'Set up later', exact: true }).click();
    await browserExpect(section().getByRole('img', { name: 'Authenticator QR code' })).toHaveCount(
      0,
    );
    await section().getByRole('button', { name: 'Resume setup', exact: true }).click();
    expect(await setupKey()).toBe(key);
    expect(enableRequests).toHaveLength(1);
    expect(await storage()).toBe(initialStorage);
    await user.reload();
    await browserExpect(
      section().getByRole('button', { name: 'Enable', exact: true }),
    ).toBeVisible();
    await browserExpect(
      section().getByRole('button', { name: 'Resume setup', exact: true }),
    ).toHaveCount(0);
    await browserExpect(section().locator('li code')).toHaveCount(0);
    await browserExpect(section().getByRole('img', { name: 'Authenticator QR code' })).toHaveCount(
      0,
    );
    expect(await storage()).toBe(initialStorage);
  });

  it('rejects malformed codes locally, preserves rejected setup and enables only after real verification', async () => {
    await section().getByRole('button', { name: 'Enable', exact: true }).click();
    await section().getByLabel('Current password', { exact: true }).fill('incorrect-password');
    const deniedPassword = user.waitForResponse((response) =>
      response.url().endsWith('/api/auth/two-factor/enable'),
    );
    await section().getByRole('button', { name: 'Continue', exact: true }).click();
    expect((await deniedPassword).ok()).toBe(false);
    await browserExpect(section().getByRole('alert')).toBeVisible();
    await browserExpect(section().getByRole('img', { name: 'Authenticator QR code' })).toHaveCount(
      0,
    );
    await section().getByLabel('Current password', { exact: true }).fill(browserPassword);
    await section().getByRole('button', { name: 'Continue', exact: true }).click();
    await browserExpect(
      section().getByRole('img', { name: 'Authenticator QR code' }),
    ).toBeVisible();
    const key = await setupKey();
    const requests: string[] = [];
    user.on('request', (request) => {
      if (request.url().endsWith('/api/auth/two-factor/verify-totp')) requests.push(request.url());
    });
    const code = section().getByLabel('Authentication code', { exact: true });
    await browserExpect(code).toHaveAttribute('inputmode', 'numeric');
    for (const malformed of ['12', 'abcdef']) {
      await code.fill(malformed);
      await section().getByRole('button', { name: 'Verify and enable', exact: true }).click();
      await browserExpect(
        section().getByRole('img', { name: 'Authenticator QR code' }),
      ).toBeVisible();
      expect(requests).toEqual([]);
    }
    const nearbyCodes = [-60_000, -30_000, 0, 30_000, 60_000].map((offset) =>
      totp(key, Date.now() + offset),
    );
    const wrongCode = ['000000', '111111', '222222', '333333', '444444', '555555'].find(
      (value) => !nearbyCodes.includes(value),
    );
    if (!wrongCode) throw new Error('Expected a code outside the current authenticator window');
    await code.fill(wrongCode);
    const rejected = user.waitForResponse((response) =>
      response.url().endsWith('/api/auth/two-factor/verify-totp'),
    );
    await section().getByRole('button', { name: 'Verify and enable', exact: true }).click();
    expect((await rejected).ok()).toBe(false);
    await browserExpect(section().getByRole('alert')).toBeVisible();
    await browserExpect(code).toHaveValue(wrongCode);
    expect(await setupKey()).toBe(key);
    await browserExpect(section().locator('li code')).toHaveCount(0);
    await browserExpect(section().getByText('Disabled', { exact: true })).toBeVisible();
    await screenshot('incorrect-code-desktop-en');
    await accessible();

    const before = (await user.context().cookies()).find((cookie) =>
      cookie.name.endsWith('.session_token'),
    );
    expect(before?.httpOnly).toBe(true);
    await code.fill(totp(key));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending = false;
    await user.route('**/api/auth/two-factor/verify-totp', async (route) => {
      pending = true;
      await gate;
      await route.continue();
    });
    const verified = user.waitForResponse((response) =>
      response.url().endsWith('/api/auth/two-factor/verify-totp'),
    );
    try {
      await section().getByRole('button', { name: 'Verify and enable', exact: true }).click();
      await browserExpect.poll(() => pending).toBe(true);
      await tabs().getByRole('link', { name: 'Profile', exact: true }).click();
      await tabs().getByRole('link', { name: 'Security', exact: true }).click();
      await browserExpect(code).toBeDisabled();
      await browserExpect(
        section().getByRole('button', { name: 'Verify and enable', exact: true }),
      ).toBeDisabled();
      await browserExpect(
        section().getByRole('button', { name: 'Set up later', exact: true }),
      ).toBeDisabled();
      await browserExpect(section().locator('li code')).toHaveCount(0);
    } finally {
      release();
    }
    expect((await verified).ok()).toBe(true);
    await user.unroute('**/api/auth/two-factor/verify-totp');
    await browserExpect(section().getByText('Enabled', { exact: true })).toBeVisible();
    await browserExpect(
      section().getByRole('heading', { name: 'Save your recovery codes' }),
    ).toBeVisible();
    const session = await journeyRequest<{ actor: { twoFactorEnabled: boolean } }>(
      fixture,
      user,
      '/v1/web/session',
    );
    expect(session.actor.twoFactorEnabled).toBe(true);
    const after = (await user.context().cookies()).find((cookie) =>
      cookie.name.endsWith('.session_token'),
    );
    expect(after?.httpOnly).toBe(true);
    expect(after?.value).not.toBe(before?.value);
    expect(requests).toHaveLength(2);
    await browserExpect(section().getByRole('img', { name: 'Authenticator QR code' })).toHaveCount(
      0,
    );
    await browserExpect(section().getByLabel('Authenticator setup key')).toHaveCount(0);
  });

  it('copies and downloads verified recovery codes, retains them across tabs and clears them on Done', async () => {
    const initialStorage = await storage();
    await start();
    await screenshot('authenticator-desktop-en');
    await user.setViewportSize({ width: 390, height: 844 });
    await screenshot('authenticator-mobile-en');
    await accessible();
    const key = await setupKey();
    await section().getByLabel('Authentication code', { exact: true }).fill(totp(key));
    await section().getByRole('button', { name: 'Verify and enable', exact: true }).click();
    await browserExpect(
      section().getByRole('heading', { name: 'Save your recovery codes' }),
    ).toBeVisible();
    const codes = await section().locator('li code').allTextContents();
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes).size).toBe(codes.length);
    await screenshot('recovery-mobile-en');
    await accessible();
    await user.setViewportSize({ width: 1440, height: 1000 });
    await screenshot('recovery-desktop-en');
    await user.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async () => {
          throw new DOMException('Clipboard unavailable for this test', 'NotAllowedError');
        },
      });
    });
    try {
      await section().getByRole('button', { name: 'Copy recovery codes', exact: true }).click();
      await browserExpect(section().getByRole('alert')).toBeVisible();
      await browserExpect(section().locator('li code')).toHaveText(codes);
      await screenshot('clipboard-error-desktop-en');
      await user.setViewportSize({ width: 390, height: 844 });
      await screenshot('clipboard-error-mobile-en');
      await accessible();
    } finally {
      await user.evaluate(() => Reflect.deleteProperty(navigator.clipboard, 'writeText'));
      await user.setViewportSize({ width: 1440, height: 1000 });
    }
    await section().getByRole('button', { name: 'Copy recovery codes', exact: true }).click();
    expect(await user.evaluate(() => navigator.clipboard.readText())).toBe(codes.join('\n'));
    await browserExpect(section().getByRole('alert')).toHaveCount(0);
    const downloading = user.waitForEvent('download');
    await section().getByRole('button', { name: 'Download recovery codes', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('nickhosting-recovery-codes.txt');
    const path = await download.path();
    if (!path) throw new Error('Expected a local recovery-code download');
    const contents = await readFile(path, 'utf8');
    for (const value of codes) expect(contents).toContain(value);
    expect(contents).not.toContain(key);
    expect(contents).not.toContain('otpauth:');
    await download.delete();
    await tabs().getByRole('link', { name: 'Profile', exact: true }).click();
    await tabs().getByRole('link', { name: 'Security', exact: true }).click();
    await browserExpect(section().locator('li code')).toHaveText(codes);
    expect(await storage()).toBe(initialStorage);
    await section().getByRole('button', { name: 'Done', exact: true }).click();
    await browserExpect(section().locator('li code')).toHaveCount(0);
    await browserExpect(section().getByText('Enabled', { exact: true })).toBeVisible();
    await user.reload();
    await browserExpect(section().getByText('Enabled', { exact: true })).toBeVisible();
    await browserExpect(section().locator('li code')).toHaveCount(0);
    expect(await storage()).toBe(initialStorage);
    await section().getByRole('button', { name: 'Recovery codes', exact: true }).click();
    await section().getByLabel('Current password', { exact: true }).fill(browserPassword);
    await section()
      .getByRole('button', { name: 'Generate new recovery codes', exact: true })
      .click();
    await browserExpect(
      section().getByRole('heading', { name: 'Save your recovery codes' }),
    ).toBeVisible();
    const replacements = await section().locator('li code').allTextContents();
    expect(replacements).toHaveLength(codes.length);
    expect(replacements.every((value) => !codes.includes(value))).toBe(true);
    await section().getByRole('button', { name: 'Done', exact: true }).click();
    await section()
      .getByRole('button', { name: 'Disable two-factor authentication', exact: true })
      .click();
    await section().getByLabel('Current password', { exact: true }).fill(browserPassword);
    await section().getByRole('button', { name: 'Disable', exact: true }).click();
    await browserExpect(section().getByText('Disabled', { exact: true })).toBeVisible();
    await browserExpect(section().locator('li code')).toHaveCount(0);
    const session = await journeyRequest<{ actor: { twoFactorEnabled: boolean } }>(
      fixture,
      user,
      '/v1/web/session',
    );
    expect(session.actor.twoFactorEnabled).toBe(false);
  });

  it('supports the full Italian flow at mobile width with keyboard-accessible recovery actions', async () => {
    await tabs().getByRole('link', { name: 'Profile', exact: true }).click();
    await user
      .locator('.account-profile')
      .getByRole('radio', { name: 'Italiano', exact: true })
      .check();
    await user
      .getByRole('navigation', { name: 'Impostazioni', exact: true })
      .getByRole('link', { name: 'Sicurezza', exact: true })
      .click();
    await user.setViewportSize({ width: 390, height: 844 });
    await section().getByRole('button', { name: 'Attiva', exact: true }).click();
    await browserExpect(section().getByLabel('Password attuale', { exact: true })).toBeFocused();
    await screenshot('password-mobile-it');
    await accessible();
    await section().getByLabel('Password attuale', { exact: true }).fill(browserPassword);
    await section().getByRole('button', { name: 'Continua', exact: true }).click();
    await browserExpect(
      section().getByRole('heading', { name: 'Collega l’autenticatore' }),
    ).toBeVisible();
    await browserExpect(
      section().getByRole('img', { name: 'Codice QR per l’autenticatore' }),
    ).toBeVisible();
    await browserExpect(
      section().getByLabel('Codice di autenticazione', { exact: true }),
    ).toBeFocused();
    await browserExpect(section().locator('li code')).toHaveCount(0);
    await screenshot('authenticator-mobile-it');
    await accessible();
    const disclosure = section()
      .locator('summary')
      .filter({ hasText: 'Inserisci la chiave manualmente' });
    await disclosure.focus();
    await user.keyboard.press('Enter');
    const key = await section()
      .getByLabel('Chiave di configurazione dell’autenticatore', { exact: true })
      .inputValue();
    await screenshot('authenticator-manual-mobile-it');
    await accessible();
    await section().getByLabel('Codice di autenticazione', { exact: true }).fill(totp(key));
    await section().getByRole('button', { name: 'Verifica e attiva', exact: true }).click();
    await browserExpect(
      section().getByRole('heading', { name: 'Conserva i codici di recupero' }),
    ).toBeVisible();
    await browserExpect(section().getByText('Attivo', { exact: true })).toBeVisible();
    await screenshot('recovery-mobile-it');
    await accessible();
    const copy = section().getByRole('button', { name: 'Copia codici di recupero', exact: true });
    await copy.focus();
    await user.keyboard.press('Enter');
    expect(await user.evaluate(() => navigator.clipboard.readText())).toBe(
      (await section().locator('li code').allTextContents()).join('\n'),
    );
    await browserExpect(
      section().getByRole('button', { name: 'Scarica codici di recupero', exact: true }),
    ).toBeVisible();
    await section().getByRole('button', { name: 'Fine', exact: true }).click();
    await browserExpect(section().locator('li code')).toHaveCount(0);
  });

  it('keeps manual enrollment available if the local QR module cannot load and clears setup on layout exit', async () => {
    const remoteRequests: string[] = [];
    user.on('request', (request) => {
      if (new URL(request.url()).origin !== fixture.origin) remoteRequests.push(request.url());
    });
    await user.route('**/account-two-factor-qr.*', (route) => route.abort('failed'));
    await section().getByRole('button', { name: 'Enable', exact: true }).click();
    await section().getByLabel('Current password', { exact: true }).fill(browserPassword);
    await section().getByRole('button', { name: 'Continue', exact: true }).click();
    await browserExpect(
      section().getByText(
        'The QR code could not load. Enter the setup key in your authenticator app.',
        { exact: true },
      ),
    ).toBeVisible();
    await browserExpect(section().getByRole('img', { name: 'Authenticator QR code' })).toHaveCount(
      0,
    );
    await browserExpect(
      section().getByLabel('Authenticator setup key', { exact: true }),
    ).toBeVisible();
    const key = await setupKey();
    await section().getByRole('button', { name: 'Copy setup key', exact: true }).click();
    expect(await user.evaluate(() => navigator.clipboard.readText())).toBe(key);
    expect(remoteRequests).toEqual([]);
    await screenshot('qr-unavailable-desktop-en');
    await accessible();
    await user.locator('.sidebar').getByRole('link', { name: 'Home', exact: true }).click();
    await browserExpect(user.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    await user.locator('.sidebar a[href="/settings"]').click();
    await tabs().getByRole('link', { name: 'Security', exact: true }).click();
    await browserExpect(
      section().getByRole('button', { name: 'Enable', exact: true }),
    ).toBeVisible();
    await browserExpect(
      section().getByRole('button', { name: 'Resume setup', exact: true }),
    ).toHaveCount(0);
    await browserExpect(
      section().getByLabel('Authenticator setup key', { exact: true }),
    ).toHaveCount(0);
  });

  it('preserves verified recovery codes through a failed session refresh and retries only the session read', async () => {
    await start();
    const key = await setupKey();
    const verifiedRequests: string[] = [];
    user.on('request', (request) => {
      if (request.url().endsWith('/api/auth/two-factor/verify-totp'))
        verifiedRequests.push(request.url());
    });
    let failSession = true;
    await user.route('**/v1/web/session', async (route) => {
      if (failSession)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'unavailable', messageKey: 'web.errors.request' },
          }),
        });
      else await route.continue();
    });
    await section().getByLabel('Authentication code', { exact: true }).fill(totp(key));
    const verified = user.waitForResponse((response) =>
      response.url().endsWith('/api/auth/two-factor/verify-totp'),
    );
    await section().getByRole('button', { name: 'Verify and enable', exact: true }).click();
    expect((await verified).status()).toBe(200);
    await browserExpect(user.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await browserExpect(section().getByText('Enabled', { exact: true })).toBeVisible();
    await browserExpect(
      section().getByRole('heading', { name: 'Save your recovery codes' }),
    ).toBeVisible();
    const codes = await section().locator('li code').allTextContents();
    expect(codes.length).toBeGreaterThan(0);
    await screenshot('session-refresh-error-desktop-en');
    failSession = false;
    const refreshed = user.waitForResponse((response) =>
      response.url().endsWith('/v1/web/session'),
    );
    await user.getByRole('button', { name: 'Try again', exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    await browserExpect(user.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(
      0,
    );
    expect(await section().locator('li code').allTextContents()).toEqual(codes);
    expect(verifiedRequests).toHaveLength(1);
    await section().getByRole('button', { name: 'Done', exact: true }).click();
    await browserExpect(
      section().getByRole('button', { name: 'Recovery codes', exact: true }),
    ).toBeVisible();
    await browserExpect(
      section().getByRole('button', { name: 'Disable two-factor authentication', exact: true }),
    ).toBeVisible();
    await browserExpect(section().getByRole('button', { name: 'Enable', exact: true })).toHaveCount(
      0,
    );
  });
});
