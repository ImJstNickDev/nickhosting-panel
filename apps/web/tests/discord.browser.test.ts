import { randomBytes } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { discordProviderFixture } from './discord-fixture.js';
import { browserHarness, browserPassword } from './harness.js';

describe('M5 browser Discord invitation and explicit bidirectional linking', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let discord: ReturnType<typeof discordProviderFixture>;
  let owner: Page;
  const errors: string[] = [];
  const clientId = 'browser-fixture-client';

  async function page() {
    const result = await fixture.page();
    result.on('pageerror', (error) => errors.push(error.message));
    return result;
  }
  async function invite(email?: string) {
    const response = await owner.request.post(`${fixture.origin}/v1/owner/invitations`, {
      headers: { origin: fixture.origin },
      data: { role: 'user', maxUses: 1, ...(email ? { email } : {}) },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as { id: string; token: string; url: string };
  }
  async function currentUser(client: Page) {
    const response = await client.request.get(`${fixture.origin}/v1/me`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    return body.identity.actorUserId as string;
  }
  async function emailLogin(client: Page, email: string) {
    await client.goto(`${fixture.origin}/login`);
    await client.getByLabel('Email', { exact: true }).fill(email);
    await client.getByLabel('Password', { exact: true }).fill(browserPassword);
    await client.getByRole('button', { name: 'Sign in', exact: true }).click();
    await browserExpect(client.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  }
  async function oauthLogin(client: Page, code: string, url = `${fixture.origin}/login`) {
    await discord.authorize(client, fixture.origin, code);
    await client.goto(url);
    const callback = client.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/auth/callback/discord' ||
        (new URL(response.url()).pathname === '/api/auth/sign-in/social' &&
          response.status() >= 400),
    );
    await client.getByRole('button', { name: 'Continue with Discord', exact: true }).click();
    const response = await callback;
    expect(response.status(), response.status() === 302 ? undefined : await response.text()).toBe(
      302,
    );
  }
  function linkedAccounts(client: Page) {
    return client.locator('section').filter({
      has: client.getByRole('heading', { name: 'Linked accounts', exact: true }),
    });
  }

  beforeAll(async () => {
    fixture = await browserHarness({
      discord: { clientId, clientSecret: randomBytes(32).toString('base64url') },
    });
    discord = discordProviderFixture(clientId);
    owner = await page();
    // Setup uses the actual handlers. The separate account suite exercises its UI.
    const claim = await owner.request.post(`${fixture.origin}/v1/setup/owner`, {
      headers: { origin: fixture.origin },
      data: {
        token: fixture.setupToken,
        name: 'Owner',
        email: 'owner-discord@browser.example.test',
        password: browserPassword,
        locale: 'en',
      },
    });
    expect(claim.status()).toBe(201);
    const mail = fixture.mails.findLast((value) => value.template === 'verify-email');
    if (!mail) throw new Error('Missing Owner verification fixture mail');
    expect((await owner.request.get(mail.url)).ok()).toBe(true);
    expect(
      (
        await owner.request.post(`${fixture.origin}/api/auth/sign-in/email`, {
          headers: { origin: fixture.origin },
          data: { email: 'owner-discord@browser.example.test', password: browserPassword },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await owner.request.post(`${fixture.origin}/v1/setup/complete`, {
          headers: { origin: fixture.origin },
          data: {
            instanceName: 'NickHosting',
            pterodactylBaseURL: 'https://panel.example.test',
            pterodactylApplicationKey: 'browser-fixture-application',
            pterodactylClientKey: 'browser-fixture-client',
          },
        })
      ).status(),
    ).toBe(200);
  });
  afterAll(async () => {
    discord?.close();
    await fixture?.close();
  });
  beforeEach(async () => {
    // Independent users share the fixture's loopback peer IP. Reset only this
    // disposable schema between scenarios; limits remain active inside each journey.
    await fixture.database.db.deleteFrom('rateLimit').execute();
  });

  it('rejects new Discord identities without an invitation and shows an actionable error', async () => {
    discord.profiles.set('no-invite', {
      id: '123456789012345678',
      email: 'no-invite@browser.example.test',
      verified: true,
    });
    const visitor = await page();
    await oauthLogin(visitor, 'no-invite');
    await browserExpect(visitor).toHaveURL(/\/login\?error=/);
    await browserExpect(visitor.getByRole('alert')).toContainText('This invitation is invalid.');
    expect((await visitor.request.get(`${fixture.origin}/v1/me`)).status()).toBe(401);
    expect(
      await fixture.database.db
        .selectFrom('user')
        .select('id')
        .where('email', '=', 'no-invite@browser.example.test')
        .execute(),
    ).toHaveLength(0);
    await visitor.context().close();
  });

  it('consumes an invitation through Discord and signs into the same account without another invite', async () => {
    const invitation = await invite('discord@browser.example.test');
    discord.profiles.set('invited-discord', {
      id: '223456789012345678',
      email: 'discord@browser.example.test',
      verified: true,
    });
    const member = await page();
    await oauthLogin(member, 'invited-discord', invitation.url);
    await browserExpect(member.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    const userId = await currentUser(member);
    expect(
      (
        await fixture.database.db
          .selectFrom('invitation')
          .select('remainingUses')
          .where('id', '=', invitation.id)
          .executeTakeFirstOrThrow()
      ).remainingUses,
    ).toBe(0);
    expect((await member.request.get(`${fixture.origin}/v1/owner/settings`)).status()).toBe(403);
    const returning = await page();
    await oauthLogin(returning, 'invited-discord');
    await browserExpect(
      returning.getByRole('heading', { name: 'Home', exact: true }),
    ).toBeVisible();
    expect(await currentUser(returning)).toBe(userId);
    await member.context().close();
    await returning.context().close();
  });

  it('requires explicit email-to-Discord linking and unlinks through the real account UI', async () => {
    const email = 'explicit-link@browser.example.test';
    const invitation = await invite(email);
    const member = await page();
    await member.goto(invitation.url);
    await member.getByLabel('Name', { exact: true }).fill('Explicit Link');
    await member.getByLabel('Email', { exact: true }).fill(email);
    await member.getByLabel('Password', { exact: true }).fill(browserPassword);
    await member.getByRole('button', { name: 'Create account', exact: true }).click();
    await browserExpect(
      member.getByText('Check your email for the verification link, then sign in.'),
    ).toBeVisible();
    const verification = fixture.mails.findLast(
      (mail) => mail.to === email && mail.template === 'verify-email',
    );
    if (!verification) throw new Error('Missing member verification fixture mail');
    await member.goto(verification.url);
    await emailLogin(member, email);
    const userId = await currentUser(member);
    discord.profiles.set('explicit-link', {
      id: '323456789012345678',
      email,
      verified: true,
    });
    const implicit = await page();
    await oauthLogin(implicit, 'explicit-link');
    await browserExpect(implicit).toHaveURL(/\/login\?error=/);
    await browserExpect(implicit.getByRole('alert')).toContainText(
      'Sign in to your existing account before linking this login method.',
    );
    expect((await implicit.request.get(`${fixture.origin}/v1/me`)).status()).toBe(401);
    expect(
      await fixture.database.db
        .selectFrom('account')
        .select('id')
        .where('userId', '=', userId)
        .where('providerId', '=', 'discord')
        .execute(),
    ).toHaveLength(0);
    await discord.authorize(member, fixture.origin, 'explicit-link');
    await member.goto(`${fixture.origin}/settings`);
    await linkedAccounts(member).getByRole('button', { name: 'Link Discord', exact: true }).click();
    await browserExpect(linkedAccounts(member).getByText('Discord', { exact: true })).toBeVisible();
    await fixture.screenshot(member, 'account-discord-email-verified-desktop-en');
    expect(await currentUser(member)).toBe(userId);
    await discord.authorize(owner, fixture.origin, 'explicit-link');
    await owner.goto(`${fixture.origin}/settings`);
    await linkedAccounts(owner).getByRole('button', { name: 'Link Discord', exact: true }).click();
    await browserExpect(owner).toHaveURL(/\/settings\?error=/);
    await browserExpect(owner.getByRole('alert')).toContainText(
      'Sign in to your existing account before linking this login method.',
    );
    expect(
      (
        await fixture.database.db
          .selectFrom('account')
          .select('userId')
          .where('providerId', '=', 'discord')
          .where('accountId', '=', '323456789012345678')
          .executeTakeFirstOrThrow()
      ).userId,
    ).toBe(userId);
    const returning = await page();
    await oauthLogin(returning, 'explicit-link');
    await browserExpect(
      returning.getByRole('heading', { name: 'Home', exact: true }),
    ).toBeVisible();
    expect(await currentUser(returning)).toBe(userId);
    await fixture.screenshot(member, 'account-discord-linked-desktop-en');
    const discordRow = linkedAccounts(member)
      .locator('.section-heading')
      .filter({
        has: member.getByText('Discord', { exact: true }),
      });
    await discordRow.getByLabel('Confirm', { exact: true }).check();
    await discordRow.getByRole('button', { name: 'Unlink', exact: true }).click();
    await browserExpect(linkedAccounts(member).getByText('Discord', { exact: true })).toHaveCount(
      0,
    );
    await browserExpect(linkedAccounts(member).getByText('Email', { exact: true })).toBeVisible();
    const accounts = await fixture.database.db
      .selectFrom('account')
      .select('providerId')
      .where('userId', '=', userId)
      .execute();
    expect(accounts.map((account) => account.providerId)).toEqual(['credential']);
    const afterUnlink = await page();
    await oauthLogin(afterUnlink, 'explicit-link');
    await browserExpect(afterUnlink).toHaveURL(/\/login\?error=/);
    expect((await afterUnlink.request.get(`${fixture.origin}/v1/me`)).status()).toBe(401);
    for (const client of [member, implicit, returning, afterUnlink]) await client.context().close();
  });

  it('links a no-email Discord identity to verified credentials only in its own session', async () => {
    const invitation = await invite();
    discord.profiles.set('no-email', {
      id: '423456789012345678',
      email: null,
      verified: false,
    });
    const member = await page();
    await oauthLogin(member, 'no-email', invitation.url);
    await browserExpect(member.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    const userId = await currentUser(member);
    expect(fixture.mails.some((mail) => mail.to.endsWith('.invalid'))).toBe(false);
    await member.goto(`${fixture.origin}/settings`);
    const form = linkedAccounts(member)
      .locator('form')
      .filter({
        has: member.getByRole('button', { name: 'Add email and password', exact: true }),
      });
    await form.getByLabel('Email', { exact: true }).fill('reverse-link@browser.example.test');
    await form.getByLabel('New password', { exact: true }).fill(browserPassword);
    await form.getByRole('button', { name: 'Add email and password', exact: true }).click();
    await browserExpect(
      member.getByText('Open the verification link in this browser to confirm the new email.'),
    ).toBeVisible();
    const mail = fixture.mails.findLast(
      (value) =>
        value.to === 'reverse-link@browser.example.test' && value.template === 'link-email',
    );
    if (!mail) throw new Error('Missing reverse-link verification fixture mail');
    await owner.goto(mail.url);
    await owner.getByRole('button', { name: 'Confirm', exact: true }).click();
    await browserExpect(owner.getByRole('alert')).toBeVisible();
    expect(
      (
        await fixture.database.db
          .selectFrom('user')
          .select('email')
          .where('id', '=', userId)
          .executeTakeFirstOrThrow()
      ).email,
    ).toBe('423456789012345678@discord.placeholder.invalid');
    await member.goto(mail.url);
    await member.getByRole('button', { name: 'Confirm', exact: true }).click();
    await browserExpect(member).toHaveURL(`${fixture.origin}/settings`);
    await browserExpect(linkedAccounts(member).getByText('Email', { exact: true })).toBeVisible();
    await browserExpect(linkedAccounts(member).getByText('Discord', { exact: true })).toBeVisible();
    const credential = await page();
    await emailLogin(credential, 'reverse-link@browser.example.test');
    expect(await currentUser(credential)).toBe(userId);
    const axe = await new AxeBuilder({ page: member })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe.violations.map((item) => item.id)).toEqual([]);
    expect(discord.unexpected).toEqual([]);
    expect(discord.calls.authorization).toBeGreaterThan(0);
    expect(discord.calls.token).toBe(discord.calls.authorization);
    expect(discord.calls.profile).toBe(discord.calls.token);
    expect(errors).toEqual([]);
    await member.context().close();
    await credential.context().close();
  });

  it('keeps OAuth throttling active and explains its retry boundary in the browser', async () => {
    const visitor = await page();
    await visitor.goto(`${fixture.origin}/login`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await visitor.request.post(`${fixture.origin}/api/auth/sign-in/social`, {
        headers: { origin: fixture.origin },
        data: { provider: 'discord', callbackURL: `${fixture.origin}/auth/callback` },
      });
      expect(response.status()).toBe(200);
    }
    await visitor.getByRole('button', { name: 'Continue with Discord', exact: true }).click();
    await browserExpect(visitor.getByRole('alert')).toContainText(
      'Too many attempts. Try again later.',
    );
    await browserExpect(visitor).toHaveURL(`${fixture.origin}/login`);
    expect((await visitor.request.get(`${fixture.origin}/v1/me`)).status()).toBe(401);
    await visitor.context().close();
  });
});
