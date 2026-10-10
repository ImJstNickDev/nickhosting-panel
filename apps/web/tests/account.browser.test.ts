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
    await owner.getByLabel('Name', { exact: true }).fill('Owner');
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
    await owner.getByLabel('Client API key').fill('browser-fixture-client');
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
    const invitation = await owner.getByLabel('Invitation link').inputValue();
    user = await fixture.page();
    user.on('pageerror', (error) => pageErrors.push(error.message));
    await user.goto(invitation);
    await fixture.screenshot(user, 'invite-desktop-en');
    await user.getByLabel('Name', { exact: true }).fill('Alex');
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
  it('enrolls TOTP and a real WebAuthn virtual authenticator, then signs in using recovery', async () => {
    await user.goto(`${fixture.origin}/settings`);
    const twoFactor = user.locator('section').filter({
      has: user.getByRole('heading', { name: 'Two-factor authentication', exact: true }),
    });
    await twoFactor.getByLabel('Current password').fill(browserPassword);
    await twoFactor.getByRole('button', { name: 'Enable', exact: true }).click();
    const secret = await twoFactor.getByLabel('Authenticator setup key').inputValue();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const recovery = (await twoFactor.locator('li code').allTextContents())[0];
    expect(recovery).toBeTruthy();
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
    await passkeys.getByLabel('Name', { exact: true }).fill('Browser test passkey');
    await passkeys.getByRole('button', { name: 'Add passkey' }).click();
    await browserExpect(passkeys.getByLabel('Name', { exact: true })).toHaveCount(2);
    await browserExpect(passkeys.getByLabel('Name', { exact: true }).first()).toHaveValue(
      'Browser test passkey',
    );
    expect(await fixture.database.db.selectFrom('passkey').select('id').execute()).toHaveLength(1);
    await fixture.screenshot(user, 'security-desktop-en');
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
    await user.getByLabel('Recovery code', { exact: true }).fill(recovery!);
    await user.getByRole('button', { name: 'Verify', exact: true }).click();
    await browserExpect(user.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  });
  it('updates profile/locale, keeps keyboard focus visible and checks EN/IT mobile reflow', async () => {
    await user.goto(`${fixture.origin}/settings`);
    const profile = user
      .locator('section')
      .filter({ has: user.getByRole('heading', { name: 'Profile', exact: true }) });
    await profile.getByLabel('Name', { exact: true }).fill('Alex Updated');
    await profile.getByLabel('Language', { exact: true }).selectOption('it');
    await profile.getByRole('button', { name: 'Save changes' }).click();
    await browserExpect(
      user.getByRole('heading', { name: 'Impostazioni', exact: true }),
    ).toBeVisible();
    await user.setViewportSize({ width: 390, height: 844 });
    await fixture.screenshot(user, 'account-mobile-it');
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
