import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../../../packages/auth/src/test-fixtures.js';
import { browserHarness, browserPassword } from './harness.js';

describe('M5 real browser identity and Owner setup', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>, owner: Page, user: Page;
  const pageErrors: string[] = [];
  beforeAll(async () => {
    fixture = await browserHarness();
    owner = await fixture.page();
    owner.on('pageerror', (error) => pageErrors.push(error.message));
  });
  beforeEach(async () => {
    await fixture.database.db.deleteFrom('rateLimit').execute();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  it('completes protected first-run, email verification and provider validation through actual handlers', async () => {
    await owner.goto(`${fixture.origin}/setup`);
    await browserExpect(owner.getByRole('heading', { name: 'Set up NickHosting' })).toBeVisible();
    await fixture.screenshot(owner, 'setup-desktop-en');
    await owner.getByLabel('Setup token').fill(fixture.setupToken);
    await owner.getByLabel('Display name', { exact: true }).fill('Owner');
    await owner.getByLabel('Username', { exact: true }).fill('owner');
    await owner.getByLabel('Email', { exact: true }).fill('owner@browser.example.test');
    await owner.getByLabel('Password', { exact: true }).fill(browserPassword);
    await owner.getByRole('button', { name: 'Create Owner account' }).click();
    await browserExpect(
      owner.getByText('The Owner account has been created.', { exact: false }),
    ).toBeVisible();
    const mail = fixture.mails.findLast((value) => value.to === 'owner@browser.example.test');
    expect(mail?.template).toBe('verify-email');
    await owner.goto(mail!.url);
    await owner.goto(`${fixture.origin}/login`);
    await owner.getByLabel('Email', { exact: true }).fill('owner@browser.example.test');
    await owner.getByLabel('Password', { exact: true }).fill(browserPassword);
    await owner.getByRole('button', { name: 'Sign in', exact: true }).click();
    await browserExpect(
      owner.getByRole('button', { name: 'Validate and finish setup' }),
    ).toBeVisible();
    await owner.getByLabel('Instance name', { exact: true }).fill('NickHosting');
    await owner.getByLabel('Pterodactyl URL').fill('https://panel.example.test');
    await owner.getByLabel('Application API key').fill('browser-fixture-application');
    await browserExpect(owner.getByLabel('Client API key')).toHaveCount(0);
    await fixture.screenshot(owner, 'setup-provider-individual-keys-desktop-en');
    await owner.getByRole('button', { name: 'Validate and finish setup' }).click();
    await browserExpect(owner).toHaveURL(`${fixture.origin}/owner`);
    expect(
      (
        await fixture.database.db
          .selectFrom('instance_setup')
          .select('completed_at')
          .executeTakeFirst()
      )?.completed_at,
    ).toBeTruthy();
    expect(
      await fixture.database.db
        .selectFrom('user')
        .select('id')
        .where('role', '=', 'owner')
        .execute(),
    ).toHaveLength(1);
  });
  it('creates an invitation, registers a real user and keeps Owner routes inaccessible', async () => {
    await owner.goto(`${fixture.origin}/owner/invitations`);
    await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const dialog = owner.getByRole('dialog');
    await dialog.getByLabel('Email (Optional)').fill('member@browser.example.test');
    await dialog.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const invitation = await owner
      .getByRole('textbox', { name: 'Invitation link', exact: true })
      .inputValue();
    user = await fixture.page();
    user.on('pageerror', (error) => pageErrors.push(error.message));
    await user.goto(invitation);
    await fixture.screenshot(user, 'invite-desktop-en');
    await user.getByLabel('Display name', { exact: true }).fill('Alex');
    await user.getByLabel('Username', { exact: true }).fill('alex');
    await user.getByLabel('Email', { exact: true }).fill('member@browser.example.test');
    await user.getByLabel('Password', { exact: true }).fill(browserPassword);
    await user.getByRole('button', { name: 'Create account', exact: true }).click();
    await browserExpect(
      user.getByText('Check your email for the verification link, then sign in.'),
    ).toBeVisible();
    const mail = fixture.mails.findLast((value) => value.to === 'member@browser.example.test');
    expect(mail?.template).toBe('verify-email');
    await user.goto(mail!.url);
    await user.goto(`${fixture.origin}/login`);
    await fixture.screenshot(user, 'login-desktop-en');
    await user.getByLabel('Email', { exact: true }).fill('member@browser.example.test');
    await user.getByLabel('Password', { exact: true }).fill(browserPassword);
    await user.getByRole('button', { name: 'Sign in', exact: true }).click();
    await browserExpect(user.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    expect((await user.request.get(`${fixture.origin}/v1/owner/settings`)).status()).toBe(403);
    await user.goto(`${fixture.origin}/owner`);
    await browserExpect(user).toHaveURL(`${fixture.origin}/`);
  });
  it('recovers the same invitation after reload, persists edits and revokes it through real APIs', async () => {
    await owner.goto(`${fixture.origin}/owner/invitations`);
    await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const dialog = owner.getByRole('dialog');
    await dialog.getByLabel('Email (Optional)').fill('managed-invite@browser.example.test');
    await dialog.getByLabel('Maximum uses').fill('3');
    await dialog.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const original = await dialog.getByLabel('Invitation link').inputValue();
    await browserExpect(
      dialog.getByText('Copy this link now. It cannot be retrieved again.'),
    ).toHaveCount(0);
    await owner.reload();
    const row = owner.getByRole('row').filter({ hasText: 'managed-invite@browser.example.test' });
    await row
      .getByRole('button', { name: 'Show link: managed-invite@browser.example.test' })
      .click();
    await browserExpect(dialog.getByLabel('Invitation link')).toHaveValue(original);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await row
      .getByRole('button', { name: 'Edit invitation: managed-invite@browser.example.test' })
      .click();
    await dialog.getByLabel('Maximum uses').fill('5');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    await owner.reload();
    await browserExpect(row).toContainText('0 / 5');
    await row
      .getByRole('button', { name: 'Show link: managed-invite@browser.example.test' })
      .click();
    await browserExpect(dialog.getByLabel('Invitation link')).toHaveValue(original);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await row
      .getByRole('button', { name: 'Revoke invitation: managed-invite@browser.example.test' })
      .click();
    await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(row).toContainText('Revoked');
    const token = new URL(original).pathname.split('/').at(-1);
    expect((await owner.request.get(`${fixture.origin}/v1/invitations/${token}`)).status()).toBe(
      410,
    );
  });
  it('enrolls TOTP and a real WebAuthn virtual authenticator, then signs in using recovery', async () => {
    const securityRequests: string[] = [];
    user.on('request', (request) => {
      if (/\/api\/auth\/(list-sessions|passkey\/list-user-passkeys)$/.test(request.url()))
        securityRequests.push(request.url());
    });
    await user.goto(`${fixture.origin}/settings`);
    const tabs = user.getByRole('navigation', { name: 'Settings', exact: true });
    await browserExpect(tabs.getByRole('link', { name: 'Profile', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await browserExpect(user.getByRole('button', { name: /^Edit display name:/ })).toBeVisible();
    await browserExpect(user.getByRole('heading', { name: 'Passkeys', exact: true })).toHaveCount(
      0,
    );
    await browserExpect(
      user.getByRole('heading', { name: 'Linked accounts', exact: true }),
    ).toBeVisible();
    await browserExpect(
      user
        .locator('section')
        .filter({ has: user.getByRole('heading', { name: 'Linked accounts', exact: true }) })
        .getByText('Email', { exact: true }),
    ).toBeVisible();
    await fixture.screenshot(user, 'settings-profile-desktop-en');
    await user.setViewportSize({ width: 390, height: 844 });
    await fixture.screenshot(user, 'settings-profile-mobile-en');
    expect(securityRequests).toEqual([]);
    await user.setViewportSize({ width: 1440, height: 1000 });
    await tabs.getByRole('link', { name: 'Security', exact: true }).focus();
    await user.keyboard.press('Enter');
    await browserExpect(user).toHaveURL(`${fixture.origin}/settings/security`);
    await user.reload();
    await browserExpect(tabs.getByRole('link', { name: 'Security', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await browserExpect(user.getByRole('heading', { name: 'Profile', exact: true })).toHaveCount(0);
    await browserExpect(
      user.getByRole('heading', { name: 'Linked accounts', exact: true }),
    ).toHaveCount(0);
    const passwordRequests: string[] = [];
    user.on('request', (request) => {
      if (request.url().endsWith('/api/auth/change-password')) passwordRequests.push(request.url());
    });
    const password = user.locator('section').filter({
      has: user.getByRole('heading', { name: 'Password', exact: true }),
    });
    await password.getByRole('button', { name: 'Change password', exact: true }).click();
    await browserExpect(password.getByLabel('Current password', { exact: true })).toBeFocused();
    await fixture.screenshot(user, 'settings-security-password-edit-desktop-en');
    await password.getByLabel('Current password', { exact: true }).fill(browserPassword);
    await password.getByLabel('New password', { exact: true }).fill(`${browserPassword}-cancelled`);
    await password.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(password.getByLabel('Current password', { exact: true })).toHaveCount(0);
    expect(passwordRequests).toEqual([]);
    const twoFactor = user.locator('section').filter({
      has: user.getByRole('heading', { name: 'Two-factor authentication', exact: true }),
    });
    await twoFactor.getByRole('button', { name: 'Enable', exact: true }).click();
    await twoFactor.getByLabel('Current password').fill(browserPassword);
    await twoFactor.getByRole('button', { name: 'Enable', exact: true }).click();
    const secret = await twoFactor.getByLabel('Authenticator setup key').inputValue();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const recovery = (await twoFactor.locator('li code').allTextContents())[0];
    if (!recovery) throw new Error('Missing recovery code fixture');
    await tabs.getByRole('link', { name: 'Profile', exact: true }).click();
    await browserExpect(twoFactor).toHaveCount(0);
    await user.goBack();
    await browserExpect(twoFactor.getByLabel('Authenticator setup key')).toHaveValue(secret);
    await browserExpect(twoFactor.locator('li code').first()).toHaveText(recovery);
    await twoFactor.getByLabel('Authentication code').fill(totp(secret));
    await twoFactor.getByRole('button', { name: 'Verify', exact: true }).click();
    await browserExpect(twoFactor.getByText('Enabled', { exact: true })).toBeVisible();
    await twoFactor.getByRole('button', { name: 'Close', exact: true }).click();
    const cdp = await user.context().newCDPSession(user);
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
    const passkeys = user
      .locator('section')
      .filter({ has: user.getByRole('heading', { name: 'Passkeys', exact: true }) });
    await passkeys.getByRole('button', { name: 'Add passkey', exact: true }).click();
    await passkeys.getByLabel('Name', { exact: true }).fill('Initial browser passkey');
    await passkeys.getByRole('button', { name: 'Add passkey' }).click();
    await browserExpect(passkeys.getByLabel('Name', { exact: true })).toHaveCount(0);
    await passkeys
      .getByRole('button', { name: 'Rename passkey: Initial browser passkey', exact: true })
      .click();
    await browserExpect(passkeys.getByLabel('Name', { exact: true })).toBeFocused();
    await passkeys.getByLabel('Name', { exact: true }).fill('Browser test passkey');
    let releaseRename = () => {};
    let renaming = false;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    await user.route('**/api/auth/passkey/update-passkey', async (route) => {
      renaming = true;
      await renameGate;
      await route.continue();
    });
    try {
      await passkeys.getByRole('button', { name: 'Save changes', exact: true }).click();
      await browserExpect.poll(() => renaming).toBe(true);
      await browserExpect(
        passkeys.getByRole('button', { name: 'Add passkey', exact: true }),
      ).toBeDisabled();
      await browserExpect(passkeys.getByLabel('Name', { exact: true })).toBeDisabled();
      await browserExpect(
        passkeys.getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeDisabled();
    } finally {
      releaseRename();
    }
    await browserExpect(passkeys.getByLabel('Name', { exact: true })).toHaveCount(0);
    await user.unroute('**/api/auth/passkey/update-passkey');
    await browserExpect(
      passkeys.getByRole('button', { name: 'Rename passkey: Browser test passkey', exact: true }),
    ).toBeFocused();
    await browserExpect(passkeys.getByText('Browser test passkey', { exact: true })).toBeVisible();
    const persistedPasskeys = await fixture.database.db
      .selectFrom('passkey')
      .select(['id', 'name'])
      .execute();
    expect(persistedPasskeys).toHaveLength(1);
    expect(persistedPasskeys[0]?.name).toBe('Browser test passkey');
    await passkeys
      .getByRole('button', { name: 'Remove passkey: Browser test passkey', exact: true })
      .click();
    const removePasskey = user.getByRole('dialog', { name: 'Remove this passkey?', exact: true });
    await browserExpect(
      removePasskey.getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeFocused();
    await fixture.screenshot(user, 'settings-security-passkey-remove-desktop-en');
    await removePasskey.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(removePasskey).not.toBeVisible();
    expect(
      await fixture.database.db.selectFrom('passkey').select(['id', 'name']).execute(),
    ).toEqual(persistedPasskeys);
    await browserExpect(user.getByRole('button', { name: 'Revoke', exact: true })).toBeVisible();
    await user.getByRole('heading', { name: 'Settings', exact: true }).focus();
    await user.evaluate(() => window.scrollTo(0, 0));
    await fixture.screenshot(user, 'settings-security-desktop-en');
    await user.setViewportSize({ width: 390, height: 844 });
    await user.getByRole('heading', { name: 'Settings', exact: true }).focus();
    await user.evaluate(() => window.scrollTo(0, 0));
    await fixture.screenshot(user, 'settings-security-mobile-en');
    expect(
      await user.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const securityAxe = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(securityAxe.violations.map((item) => item.id)).toEqual([]);
    await user.setViewportSize({ width: 1440, height: 1000 });
    await user.getByRole('button', { name: 'Sign out', exact: true }).click();
    await browserExpect(user).toHaveURL(`${fixture.origin}/login`);
    await user.getByLabel('Email', { exact: true }).fill('member@browser.example.test');
    await user.getByLabel('Password', { exact: true }).fill('wrong-password');
    const denied = user.waitForResponse((r) => r.url().endsWith('/api/auth/sign-in/email'));
    await user.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await denied).status()).toBe(401);
    await browserExpect(user.getByRole('alert')).toContainText(
      'The email address or password is incorrect.',
    );
    await user.getByLabel('Password', { exact: true }).fill(browserPassword);
    await user.getByRole('button', { name: 'Sign in', exact: true }).click();
    await user.getByRole('button', { name: 'Use a recovery code' }).click();
    await user.getByLabel('Recovery code', { exact: true }).fill(recovery);
    await user.getByRole('button', { name: 'Verify', exact: true }).click();
    await browserExpect(user.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  });
  it('updates profile/locale, keeps keyboard focus visible and checks EN/IT mobile reflow', async () => {
    await user.goto(`${fixture.origin}/settings`);
    const profile = user.locator('.account-profile');
    await profile.getByRole('button', { name: /^Edit display name:/ }).click();
    await profile.getByLabel('Display name', { exact: true }).fill('Alex Updated');
    await profile.getByLabel('Display name', { exact: true }).press('Enter');
    await browserExpect(
      profile.getByRole('heading', { name: 'Alex Updated', exact: true }),
    ).toBeVisible();
    await profile.getByRole('radio', { name: 'Italiano', exact: true }).check();
    await browserExpect(
      user.getByRole('heading', { name: 'Impostazioni', exact: true }),
    ).toBeVisible();
    await fixture.screenshot(user, 'settings-profile-desktop-it');
    await user.setViewportSize({ width: 390, height: 844 });
    await fixture.screenshot(user, 'settings-profile-mobile-it');
    expect(
      await user.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await user.keyboard.press('Tab');
    expect(await user.evaluate(() => document.activeElement !== document.body)).toBe(true);
    const results = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
    await user
      .getByRole('navigation', { name: 'Impostazioni', exact: true })
      .getByRole('link', { name: 'Sicurezza', exact: true })
      .click();
    await browserExpect(user.getByRole('heading', { name: 'Passkey', exact: true })).toBeVisible();
    await browserExpect(user.getByRole('button', { name: 'Revoca', exact: true })).toBeVisible();
    await browserExpect(
      user
        .locator('section')
        .filter({ has: user.getByRole('heading', { name: 'Passkey', exact: true }) })
        .getByText('Browser test passkey', { exact: true }),
    ).toBeVisible();
    await user.getByRole('heading', { name: 'Impostazioni', exact: true }).focus();
    await user.evaluate(() => window.scrollTo(0, 0));
    await fixture.screenshot(user, 'settings-security-mobile-it');
    expect(
      await user.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await user.setViewportSize({ width: 1440, height: 1000 });
    await user.getByRole('heading', { name: 'Impostazioni', exact: true }).focus();
    await user.evaluate(() => window.scrollTo(0, 0));
    await fixture.screenshot(user, 'settings-security-desktop-it');
    expect(pageErrors).toEqual([]);
  });
  it('recovers sign-in after parent-session expiry leaves an assisted-session cookie', async () => {
    const member = await fixture.database.db
      .selectFrom('user')
      .select('id')
      .where('email', '=', 'member@browser.example.test')
      .executeTakeFirstOrThrow();
    await owner.goto(`${fixture.origin}/owner/users/${member.id}`);
    await owner.getByRole('button', { name: 'Assisted session', exact: true }).click();
    const dialog = owner.getByRole('dialog');
    await dialog.getByLabel('Reason').fill('Browser assisted session verification');
    await dialog.getByLabel('Current password').fill(browserPassword);
    await dialog.getByLabel('Confirm', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Start assistance' }).click();
    await browserExpect(owner.locator('.support-banner')).toBeVisible();
    await fixture.screenshot(owner, 'assisted-session-desktop-it');
    const actor = await fixture.database.db
      .selectFrom('user')
      .select('id')
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow();
    await fixture.database.db
      .updateTable('session')
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where('userId', '=', actor.id)
      .execute();
    await owner.goto(`${fixture.origin}/`);
    await browserExpect(owner).toHaveURL(`${fixture.origin}/login`);
    // The subject locale is Italian during assistance; the localized Exit must
    // clear only this browser's stale HttpOnly token before normal auth works.
    await owner.getByRole('button', { name: /Exit assistance|Termina assistenza/ }).click();
    await browserExpect(
      owner.getByRole('button', { name: /Exit assistance|Termina assistenza/ }),
    ).toHaveCount(0);
    await owner.getByLabel('Email', { exact: true }).fill('owner@browser.example.test');
    await owner.getByLabel('Password', { exact: true }).fill(browserPassword);
    await owner.getByRole('button', { name: /^(Sign in|Accedi)$/ }).click();
    await browserExpect(owner.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
  it('recovers the Owner password from an actual reset message and rejects a consumed token', async () => {
    const client = await fixture.page();
    await client.goto(`${fixture.origin}/recover`);
    await client.getByLabel('Email', { exact: true }).fill('owner@browser.example.test');
    await client.getByRole('button', { name: 'Send reset link', exact: true }).click();
    await browserExpect(client.getByRole('status')).toContainText(
      'If this address has an account, a reset link has been sent.',
    );
    const mail = fixture.mails.findLast((value) => value.template === 'reset-password');
    expect(mail).toBeTruthy();
    await client.goto(mail!.url);
    await client.getByLabel('New password', { exact: true }).fill(`${browserPassword}-new`);
    await client.getByRole('button', { name: 'Reset password', exact: true }).click();
    await browserExpect(client.getByRole('status')).toContainText('Changes saved');
    await client.goto(`${fixture.origin}/login`);
    await client.getByLabel('Email', { exact: true }).fill('owner@browser.example.test');
    await client.getByLabel('Password', { exact: true }).fill(`${browserPassword}-new`);
    await client.getByRole('button', { name: 'Sign in', exact: true }).click();
    await browserExpect(client.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    await client.goto(mail!.url);
    await client.getByLabel('New password', { exact: true }).fill(`${browserPassword}-another`);
    await client.getByRole('button', { name: 'Reset password', exact: true }).click();
    await browserExpect(client.getByRole('alert')).toBeVisible();
    await client.context().close();
  });
});
