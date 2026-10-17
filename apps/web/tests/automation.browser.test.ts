import { randomUUID } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Locator, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Automation browser journeys', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  const errors: string[] = [];
  beforeAll(async () => {
    fixture = await browserHarness({
      browser: process.env.NH_BROWSER === 'firefox' ? 'firefox' : 'chromium',
    });
    identities = await prepareJourneyIdentities(fixture);
    page = identities.user;
    page.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    // An installed integration can retain a manifest predating message support.
    await fixture.database.pool.query(
      "UPDATE game_integrations SET manifest = manifest #- '{capabilities,gatewayMessages}' WHERE id = $1",
      ['minecraft'],
    );
    await fixture.database.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'gateway' })
      .where('id', '=', provider.ids.serverId)
      .execute();
    await fixture.database.db
      .insertInto('gateway_server_states')
      .values({
        server_id: provider.ids.serverId,
        generation: randomUUID(),
        enabled: true,
        protocol_id: 'minecraft-java',
        game_version: '26.1',
        state: 'sleeping',
        readiness_timeout_seconds: 120,
        readiness_max_age_seconds: 15,
        estimate_max_age_seconds: 86400,
        wake_retry_seconds: 10,
        owner_idle_timeout_seconds: 60,
        owner_idle_timeout_user_access: 'editable',
        idle_timeout_inherited: true,
      })
      .execute();
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });
  const base = () => `/servers/${provider.ids.serverId}/automation`;
  async function choosePolicy(
    targetPage: Page,
    section: Locator,
    choice: string,
    endpoint: string,
  ) {
    const button = section.getByRole('button', { name: choice, exact: true });
    if ((await button.getAttribute('aria-pressed')) === 'true') return;
    const response = targetPage.waitForResponse(
      (response) => response.url().endsWith(endpoint) && response.request().method() === 'PUT',
    );
    await section.getByRole('button', { name: choice, exact: true }).click();
    expect((await response).status()).toBe(200);
    await browserExpect(section.getByRole('button', { name: choice, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await browserExpect(section.getByRole('button', { name: choice, exact: true })).toBeEnabled();
  }
  it('creates calendar schedules, previews times, toggles, duplicates and deletes with actual API handlers', async () => {
    await page.goto(`${fixture.origin}${base()}`);
    await page.getByRole('button', { name: 'Add schedule' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Nightly backup');
    await dialog.getByLabel('Action', { exact: true }).selectOption('backup');
    await dialog.getByLabel('Time zone', { exact: true }).fill('Europe/Rome');
    await browserExpect(dialog.locator('.automation-preview-runs li')).toHaveCount(3);
    // Typing an incomplete timezone must never crash the current preview.
    await dialog.getByLabel('Time zone', { exact: true }).fill('Europe/');
    await browserExpect(
      dialog.getByText('Choose a valid time, time zone and recurrence.'),
    ).toBeVisible();
    await dialog.getByLabel('Time zone', { exact: true }).fill('Europe/Rome');
    await browserExpect(dialog.locator('.automation-preview-runs li')).toHaveCount(3);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(page.locator('.automation-table')).toContainText('Nightly backup');
    await browserExpect(page.locator('.automation-table')).toContainText('Alex');
    await page.getByRole('switch', { name: 'Enable Nightly backup' }).click();
    await browserExpect(
      page.getByRole('switch', { name: 'Enable Nightly backup' }),
    ).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Weekend restart');
    await dialog.getByLabel('Action', { exact: true }).selectOption('restart');
    await dialog.getByLabel('Repeat', { exact: true }).selectOption('weekly');
    await dialog.getByRole('button', { name: 'Mon', exact: true }).click();
    await dialog.getByRole('button', { name: 'Sat', exact: true }).click();
    await dialog.getByRole('button', { name: 'Sun', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(page.locator('.automation-table tbody > tr')).toHaveCount(2);
    await page.mouse.move(0, 0);
    await fixture.screenshot(page, 'automation-schedules-desktop-en');
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await browserExpect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await browserExpect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(page.locator('.automation-table tbody > tr')).toHaveCount(1);
  });
  it('keeps schedules during refresh errors and exposes scoped history', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const schedulesUrl = `**/v1/servers/${provider.ids.serverId}/schedules`;
    await page.route(schedulesUrl, async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto(`${fixture.origin}${base()}`);
      await browserExpect(page.locator('.automation-skeleton')).toBeVisible();
      await fixture.screenshot(page, 'automation-loading-en');
    } finally {
      release();
    }
    await browserExpect(page.locator('.automation-table')).toContainText('Nightly backup');
    await page.unroute(schedulesUrl);
    await page.getByRole('button', { name: 'Run history', exact: true }).click();
    await browserExpect(page.getByText('No runs yet', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Create backup', exact: true })
      .click();
    await browserExpect(page.getByRole('dialog')).not.toBeVisible();
    await browserExpect(page.locator('.automation-history-item')).toHaveCount(1);
    await browserExpect(page.locator('.automation-history-item')).toContainText('Run manually');
    await browserExpect(page.locator('.automation-run-result')).toHaveCount(0);
    await page.route(`**/v1/servers/${provider.ids.serverId}/schedules`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
        }),
      }),
    );
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await browserExpect(page.getByRole('alert')).toContainText('This integration is unavailable.');
    await browserExpect(page.locator('.automation-table')).toContainText('Nightly backup');
    await fixture.screenshot(page, 'automation-refresh-error-en');
    await page.unroute(`**/v1/servers/${provider.ids.serverId}/schedules`);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await browserExpect(page.getByRole('alert')).toHaveCount(0);
  });
  it('disables wake independently and restores inheritance through actual handlers', async () => {
    await page.goto(`${fixture.origin}${base()}/sleep`);
    const consent = page.getByRole('switch', { name: 'Allow automatic starts', exact: true });
    await browserExpect(consent).toHaveAttribute('aria-checked', 'false');
    async function expectKnob(checked: boolean) {
      const track = await consent.boundingBox();
      const knob = await consent.locator('span').boundingBox();
      if (!track || !knob) throw new Error('Switch must be visible');
      expect(knob.x).toBeGreaterThanOrEqual(track.x);
      expect(knob.x + knob.width).toBeLessThanOrEqual(track.x + track.width);
      expect(Math.abs(knob.x - track.x - (checked ? 15 : 2))).toBeLessThan(0.5);
    }
    await expectKnob(false);
    await browserExpect(page.locator('.sleep-wake-consent-copy p')).toContainText(
      'cannot start the server',
    );
    await consent.click();
    await browserExpect(consent).toHaveAttribute('aria-checked', 'true');
    await expectKnob(true);
    await browserExpect(page.locator('.sleep-wake-consent-copy p')).toContainText(
      'can start the server when configured',
    );
    await browserExpect(page.locator('.sleep-wake-status')).toHaveText('Allowed');
    await fixture.screenshot(page, 'automation-sleep-consent-en');
    await consent.click();
    await browserExpect(consent).toHaveAttribute('aria-checked', 'false');
    await expectKnob(false);
    await browserExpect(page.locator('.sleep-wake-status')).toHaveText('Paused');
    await browserExpect(page.locator('.sleep-wake-admin')).toHaveCount(0);
    await browserExpect(page.getByText('Gateway operation', { exact: true })).toHaveCount(0);
    const wake = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Wake on join', exact: true }) });
    await browserExpect(
      wake.getByRole('button', { name: 'Save changes', exact: true }),
    ).toHaveCount(0);
    await choosePolicy(page, wake, 'Disabled', '/auto-wake-policy');
    await browserExpect(wake.locator('.sleep-wake-hint')).toContainText(
      'will not start the server',
    );
    await choosePolicy(page, wake, 'Enabled', '/auto-wake-policy');
    await browserExpect(wake.locator('.sleep-wake-hint')).toContainText(
      'can start the server when',
    );
    await choosePolicy(page, wake, 'Disabled', '/auto-wake-policy');
    await browserExpect(
      wake.getByRole('button', { name: 'Save changes', exact: true }),
    ).toHaveCount(0);
    const policy = await journeyRequest<{ effectiveEnabled: boolean }>(
      fixture,
      page,
      `/v1/platform/servers/${provider.ids.serverId}/auto-wake-policy`,
    );
    expect(policy.effectiveEnabled).toBe(false);
    const stored = await fixture.database.db
      .selectFrom('gateway_server_states')
      .select(['enabled', 'owner_idle_timeout_seconds'])
      .where('server_id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ enabled: true, owner_idle_timeout_seconds: 60 });
    await fixture.screenshot(page, 'automation-sleep-desktop-en');
    await page.route(
      `**/v1/platform/servers/${provider.ids.serverId}/auto-wake-policy`,
      (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'integration_unavailable',
              messageKey: 'errors.integration_unavailable',
            },
          }),
        });
      },
    );
    await wake.getByRole('button', { name: 'Inherit', exact: true }).click();
    await browserExpect(wake.getByRole('alert')).toBeVisible();
    await browserExpect(
      wake.getByRole('button', { name: 'Disabled', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.unroute(`**/v1/platform/servers/${provider.ids.serverId}/auto-wake-policy`);
    await choosePolicy(page, wake, 'Inherit', '/auto-wake-policy');
    await browserExpect(wake.locator('.sleep-wake-hint')).toContainText('Inherited: enabled.');
    await browserExpect(wake.getByRole('alert')).toHaveCount(0);
  });
  it('steps idle timeout by whole minutes without losing fractional durations or allowing zero', async () => {
    await page.goto(`${fixture.origin}${base()}/sleep`);
    const sleep = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Sleep when idle', exact: true }),
    });
    await choosePolicy(page, sleep, 'Custom', '/gateway');
    const minutes = sleep.getByRole('spinbutton');
    await browserExpect(minutes).toHaveValue('1');
    await minutes.focus();
    await page.keyboard.press('ArrowUp');
    await browserExpect(minutes).toHaveValue('2');
    await page.keyboard.press('ArrowUp');
    await browserExpect(minutes).toHaveValue('3');
    await page.keyboard.press('ArrowDown');
    await browserExpect(minutes).toHaveValue('2');
    await minutes.fill('-1');
    expect(
      await minutes.evaluate((input) => (input as HTMLInputElement).validationMessage),
    ).not.toContain('-1');
    expect(await minutes.evaluate((input) => (input as HTMLInputElement).checkValidity())).toBe(
      false,
    );
    await minutes.fill('0');
    expect(await minutes.evaluate((input) => (input as HTMLInputElement).checkValidity())).toBe(
      false,
    );
    await minutes.fill('0.5');
    expect(await minutes.evaluate((input) => (input as HTMLInputElement).checkValidity())).toBe(
      true,
    );
    const saved = page.waitForResponse(
      (response) => response.url().endsWith('/gateway') && response.request().method() === 'PUT',
    );
    await sleep.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await saved).status()).toBe(200);
    const policy = await journeyRequest<{ idleTimeout: { effectiveSeconds: number } }>(
      fixture,
      page,
      `/v1/platform/servers/${provider.ids.serverId}/sleep-policy`,
    );
    expect(policy.idleTimeout.effectiveSeconds).toBe(30);
    await minutes.fill('-1');
    await choosePolicy(page, sleep, 'Disabled', '/gateway');
    const disabledPolicy = await journeyRequest<{ idleTimeout: { effectiveSeconds: number } }>(
      fixture,
      page,
      `/v1/platform/servers/${provider.ids.serverId}/sleep-policy`,
    );
    expect(disabledPolicy.idleTimeout.effectiveSeconds).toBe(-1);
    await choosePolicy(page, sleep, 'Inherit', '/gateway');
  });
  it('edits sleep with retained drafts on failure and renders compact Owner and Italian mobile controls', async () => {
    await page.goto(`${fixture.origin}${base()}/sleep`);
    const sleep = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Sleep when idle', exact: true }),
    });
    await choosePolicy(page, sleep, 'Custom', '/gateway');
    const minutes = sleep.getByRole('spinbutton');
    // Entering a custom duration starts from the inherited value, never -1.
    await browserExpect(minutes).toHaveValue('1');
    await minutes.fill('2');
    await page.route(`**/v1/servers/${provider.ids.serverId}/gateway`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
        }),
      }),
    );
    await sleep.getByRole('button', { name: 'Disabled', exact: true }).click();
    await browserExpect(sleep.getByRole('alert')).toBeVisible();
    await browserExpect(sleep.getByRole('button', { name: 'Custom', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await browserExpect(minutes).toHaveValue('2');
    await sleep.getByRole('button', { name: 'Restore saved value', exact: true }).click();
    await browserExpect(minutes).toHaveValue('1');
    await browserExpect(sleep.getByRole('alert')).toHaveCount(0);
    await page.unroute(`**/v1/servers/${provider.ids.serverId}/gateway`);
    await choosePolicy(page, sleep, 'Disabled', '/gateway');
    await choosePolicy(page, sleep, 'Custom', '/gateway');
    await minutes.fill('2');
    await page.route(`**/v1/servers/${provider.ids.serverId}/gateway`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
        }),
      }),
    );
    await sleep.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(sleep.getByRole('alert')).toBeVisible();
    await browserExpect(minutes).toHaveValue('2');
    await fixture.screenshot(page, 'automation-sleep-save-error-en');
    await sleep.getByRole('button', { name: 'Restore saved value', exact: true }).click();
    await browserExpect(sleep.getByRole('alert')).toHaveCount(0);
    await sleep.getByRole('button', { name: 'Custom', exact: true }).click();
    await browserExpect(minutes).toHaveValue('1');
    await minutes.fill('2');
    await page.unroute(`**/v1/servers/${provider.ids.serverId}/gateway`);
    const saved = page.waitForResponse(
      (response) => response.url().endsWith('/gateway') && response.request().method() === 'PUT',
    );
    await sleep.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await browserExpect(
      sleep.getByRole('button', { name: 'Save changes', exact: true }),
    ).toHaveCount(0);
    const policy = await journeyRequest<{ idleTimeout: { effectiveSeconds: number } }>(
      fixture,
      page,
      `/v1/platform/servers/${provider.ids.serverId}/sleep-policy`,
    );
    expect(policy.idleTimeout.effectiveSeconds).toBe(120);
    await minutes.fill('3');
    await sleep.getByRole('button', { name: 'Restore saved value', exact: true }).click();
    await browserExpect(minutes).toHaveValue('2');
    await sleep.getByRole('button', { name: 'Inherit', exact: true }).focus();
    const restored = page.waitForResponse(
      (response) => response.url().endsWith('/gateway') && response.request().method() === 'PUT',
    );
    await page.keyboard.press('Enter');
    expect((await restored).status()).toBe(200);
    await browserExpect(
      sleep.getByRole('button', { name: 'Save changes', exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    const owner = identities.owner;
    await owner.goto(`${fixture.origin}${base()}/sleep`);
    await browserExpect(
      owner.getByRole('heading', { name: 'Sleep when idle', exact: true }),
    ).toBeVisible();
    const admin = owner.locator('.sleep-wake-admin');
    await admin.locator('summary').first().click();
    await browserExpect(owner.locator('select[name="sleepAccess"]')).toBeVisible();
    await browserExpect(owner.locator('select[name="access"]')).toBeVisible();
    const ownerSleep = owner
      .locator('.sleep-wake-policy')
      .filter({ has: owner.getByRole('heading', { name: 'Sleep when idle', exact: true }) });
    const ownerWake = owner
      .locator('.sleep-wake-policy')
      .filter({ has: owner.getByRole('heading', { name: 'Wake on join', exact: true }) });
    await choosePolicy(owner, ownerSleep, 'Custom', '/gateway');
    await ownerSleep.getByRole('spinbutton').fill('4');
    await choosePolicy(owner, ownerWake, 'Disabled', '/auto-wake-policy');
    const sleepAccessForm = admin
      .locator('form')
      .filter({ has: owner.locator('select[name="sleepAccess"]') });
    await sleepAccessForm.locator('select').selectOption('shorten-only');
    const savedSleepAccess = owner.waitForResponse(
      (response) => response.url().endsWith('/gateway') && response.request().method() === 'PUT',
    );
    await sleepAccessForm.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await savedSleepAccess).status()).toBe(200);
    await browserExpect(ownerSleep.getByRole('spinbutton')).toHaveValue('4');
    const wakeAccessForm = admin
      .locator('form')
      .filter({ has: owner.locator('select[name="access"]') });
    await wakeAccessForm.locator('select').selectOption('disable-only');
    const savedWakeAccess = owner.waitForResponse(
      (response) =>
        response.url().endsWith('/auto-wake-policy') && response.request().method() === 'PUT',
    );
    await wakeAccessForm.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await savedWakeAccess).status()).toBe(200);
    await browserExpect(
      ownerWake.getByRole('button', { name: 'Disabled', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const ownerSettings = await fixture.database.db
      .selectFrom('gateway_server_states')
      .select([
        'owner_idle_timeout_seconds',
        'owner_auto_wake_override',
        'owner_idle_timeout_user_access',
        'owner_auto_wake_user_access',
      ])
      .where('server_id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    expect(ownerSettings).toEqual({
      owner_idle_timeout_seconds: 60,
      owner_auto_wake_override: false,
      owner_idle_timeout_user_access: 'shorten-only',
      owner_auto_wake_user_access: 'disable-only',
    });
    await ownerSleep.getByRole('button', { name: 'Restore saved value', exact: true }).click();
    await choosePolicy(owner, ownerWake, 'Inherit', '/auto-wake-policy');
    expect(
      (
        await new AxeBuilder({ page: owner })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await fixture.screenshot(owner, 'automation-sleep-owner-en');
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.origin}${base()}/sleep`);
    await browserExpect(
      page.getByRole('heading', { name: 'Sospensione per inattività', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await fixture.screenshot(page, 'automation-sleep-mobile-it');
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'en' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await fixture.database.db
      .updateTable('gateway_server_states')
      .set({ owner_idle_timeout_user_access: 'shorten-only' })
      .where('server_id', '=', provider.ids.serverId)
      .execute();
    await page.goto(`${fixture.origin}${base()}/sleep`);
    await browserExpect(
      sleep.getByRole('button', { name: 'Disabled', exact: true }),
    ).toBeDisabled();
    await sleep.getByRole('button', { name: 'Custom', exact: true }).click();
    await browserExpect(sleep.getByRole('spinbutton')).toHaveAttribute('max', '1');
    await sleep.getByRole('spinbutton').fill('2');
    expect(
      await sleep
        .getByRole('spinbutton')
        .evaluate((input) => (input as HTMLInputElement).validity.rangeOverflow),
    ).toBe(true);
  });
  it('saves Owner global, game and runtime policies and enforces disable-only in the user form', async () => {
    const owner = identities.owner;
    await owner.goto(`${fixture.origin}/owner/settings`);
    const global = owner
      .locator('form')
      .filter({ has: owner.locator('select[name="wake-global"]') });
    await global.locator('select[name="wake-global"]').selectOption('false');
    await global.locator('select[name="wake-global-access"]').selectOption('editable');
    const savedGlobal = owner.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/owner/settings') && response.request().method() === 'PATCH',
    );
    await global.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await savedGlobal).status()).toBe(200);
    await owner.goto(`${fixture.origin}/owner/integrations/minecraft/sleep`);
    const game = owner.locator('form').filter({ has: owner.locator('select[name="wake-game"]') });
    await game.locator('select[name="wake-game"]').selectOption('true');
    const runtime = game
      .locator('details')
      .filter({ has: owner.locator('select[name="wake-vanilla"]') });
    await runtime.locator('summary').click();
    await runtime.locator('select[name="wake-vanilla"]').selectOption('true');
    await runtime.locator('select[name="access-vanilla"]').selectOption('disable-only');
    const savedGame = owner.waitForResponse(
      (response) =>
        response.url().endsWith('/minecraft/auto-wake-policy') &&
        response.request().method() === 'PUT',
    );
    await game.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await savedGame).status()).toBe(200);
    const policy = await journeyRequest<{
      gameEnabled: boolean;
      runtimeEnabled: Record<string, boolean>;
      runtimeUserAccess: Record<string, string>;
    }>(fixture, owner, '/v1/owner/integrations/minecraft/auto-wake-policy');
    expect(policy).toMatchObject({
      gameEnabled: true,
      runtimeEnabled: { vanilla: true },
      runtimeUserAccess: { vanilla: 'disable-only' },
    });
    await runtime.locator('summary').click();
    await owner.mouse.move(0, 0);
    await fixture.screenshot(owner, 'automation-owner-runtime-en');
    await page.goto(`${fixture.origin}${base()}/sleep`);
    const wake = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Wake on join', exact: true }) });
    await browserExpect(wake.getByRole('button', { name: 'Enabled', exact: true })).toBeDisabled();
    await browserExpect(
      wake.getByRole('button', { name: 'Inherit', exact: true }),
    ).not.toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.origin}${base()}`);
    await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Morning start');
    await dialog.getByLabel('Action', { exact: true }).selectOption('start');
    await dialog.getByLabel('Repeat', { exact: true }).selectOption('weekly');
    await browserExpect(dialog.locator('.automation-preview-runs li')).toHaveCount(3);
    await page.mouse.move(0, 0);
    await fixture.screenshot(page, 'automation-schedule-mobile-en');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  it('saves Gateway messages through actual handlers and renders accessible Italian mobile layout', async () => {
    await page.goto(`${fixture.origin}${base()}/sleep`);
    await page.getByRole('link', { name: 'Gateway messages', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Server list message', exact: true })
      .fill('§a{server}');
    await page.getByLabel('Status', { exact: true }).selectOption('waking');
    await page.getByRole('textbox', { name: 'Join message', exact: true }).fill('Starting soon');
    await page.getByLabel('Status', { exact: true }).selectOption('sleeping');
    await browserExpect(
      page.getByRole('textbox', { name: 'Server list message', exact: true }),
    ).toHaveText('Survival');
    await browserExpect(page.locator('.mc-server-entry')).toContainText('Survival');
    const savedMessages = page.waitForResponse(
      (response) =>
        response.url().endsWith('/gateway-messages') && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await savedMessages).status()).toBe(200);
    const saved = await journeyRequest<{
      overrides: Record<string, { motd?: string; disconnect?: string }>;
    }>(fixture, page, `/v1/servers/${provider.ids.serverId}/gateway-messages`);
    expect(saved.overrides.sleeping?.motd).toBe('§a{server}');
    expect(saved.overrides.waking?.disconnect).toBe('Starting soon');
    await page.mouse.move(0, 0);
    await fixture.screenshot(page, 'automation-messages-desktop-en');
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.origin}${base()}/messages`);
    await browserExpect(
      page.getByRole('textbox', { name: 'Messaggio nella lista server', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await fixture.screenshot(page, 'automation-messages-mobile-it');
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(errors).toEqual([]);
  });
  it('edits Minecraft preview text, preserves tokens and selection, and supports keyboard history', async () => {
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'en' });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`${fixture.origin}${base()}/messages`);
    const section = page.getByRole('region', { name: 'Server list message', exact: true });
    const editor = section.getByRole('textbox', { name: 'Server list message', exact: true });
    await editor.fill('Hello world');
    await editor.press('Home');
    await editor.press('Control+Shift+ArrowRight');
    await section.getByRole('button', { name: 'Bold', exact: true }).click();
    await browserExpect(editor.locator('span[style*="bold"]')).toContainText('Hello');
    await editor.press('Control+z');
    await browserExpect(editor).toHaveText('Hello world');
    await browserExpect(editor.locator('span[style*="bold"]')).toHaveCount(0);
    await editor.press('Control+y');
    await browserExpect(editor.locator('span[style*="bold"]')).toContainText('Hello');
    await section.getByRole('button', { name: 'Text codes', exact: true }).click();
    const source = section.getByRole('textbox', { name: 'Server list message', exact: true });
    await browserExpect(source).toHaveValue(/§lHello/);
    await source.fill('§aCaffè {server}');
    await section.getByRole('button', { name: 'Visual editor', exact: true }).click();
    await browserExpect(editor).toHaveText('Caffè Survival');
    await editor.press('Control+End');
    await editor.press('Backspace');
    await browserExpect(editor).toHaveText('Caffè ');
    await editor.press('Control+z');
    await browserExpect(editor).toHaveText('Caffè Survival');
    // Plain-text clipboard content must never create HTML nodes or execute markup.
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.setData('text/plain', '<img src=x onerror=alert(1)>');
      data.setData('text/html', '<img src=x onerror=alert(1)>');
      // Firefox protects the DataTransfer on untrusted ClipboardEvent dispatch.
      // Supply the test clipboard explicitly; the real browser handler still runs.
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => data.getData(type) },
      });
      element.dispatchEvent(event);
    });
    await browserExpect(editor.locator('img')).toHaveCount(0);
    await browserExpect(editor).toContainText('<img');
    await section.getByRole('button', { name: 'Restore default', exact: true }).click();
    await browserExpect(editor).not.toContainText('<img');
    // Empty draft remains empty while editing, rather than immediately restoring the default.
    await editor.fill('');
    await browserExpect(editor).toHaveText('');
    await editor.pressSequentially('New message');
    await browserExpect(editor).toHaveText('New message');
    await section.getByRole('button', { name: 'Text color', exact: true }).click();
    await section.getByRole('button', { name: 'Green', exact: true }).click();
    await editor.pressSequentially('!');
    await browserExpect(editor).toHaveText('New message!');
    await section.getByRole('button', { name: 'Insert variable', exact: true }).click();
    await section.getByRole('button', { name: 'Server name', exact: true }).click();
    await browserExpect(editor).toContainText('Survival');
    const saveResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/gateway-messages') && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await saveResponse).status()).toBe(200);
    const saved = await journeyRequest<{ overrides: Record<string, { motd?: string }> }>(
      fixture,
      page,
      `/v1/servers/${provider.ids.serverId}/gateway-messages`,
    );
    expect(saved.overrides.sleeping?.motd).toContain('{server}');
    expect(errors).toEqual([]);
  });
  it('renders an isolated integration with a state-specific announcement channel and no Minecraft controls', async () => {
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'en' });
    await page.setViewportSize({ width: 1280, height: 900 });
    const pattern = `**/v1/servers/${provider.ids.serverId}/gateway-messages`;
    await page.route(pattern, async (route) => {
      await route.fulfill({
        json: {
          available: true,
          editable: true,
          revision: 'a'.repeat(64),
          overrides: {},
          definition: {
            version: 1,
            channels: [
              {
                id: 'announcement',
                label: { en: 'Announcement', it: 'Annuncio' },
                maxLength: 64,
                multiline: false,
              },
              {
                id: 'banner',
                label: { en: 'Banner', it: 'Banner' },
                maxLength: 128,
                multiline: true,
              },
            ],
            variables: [{ id: 'room', label: { en: 'Room', it: 'Stanza' } }],
            states: [
              {
                id: 'queue_full',
                label: { en: 'Queue full', it: 'Coda piena' },
                defaults: {
                  en: { announcement: 'Try room {room}' },
                  it: { announcement: 'Stanza {room}' },
                },
                previewVariables: { en: { room: 'A' }, it: { room: 'A' } },
              },
              {
                id: 'welcome',
                label: { en: 'Welcome', it: 'Benvenuto' },
                defaults: { en: { banner: 'Hello' }, it: { banner: 'Ciao' } },
                previewVariables: { en: { room: 'B' }, it: { room: 'B' } },
              },
            ],
          },
        },
      });
    });
    try {
      await page.goto(`${fixture.origin}${base()}/messages`);
      await browserExpect(page.getByLabel('Announcement', { exact: true })).toHaveAttribute(
        'maxlength',
        '64',
      );
      await browserExpect(page.locator('.gateway-preview')).toHaveText('Try room A');
      await browserExpect(
        page.getByRole('textbox', { name: 'Server list message', exact: true }),
      ).toHaveCount(0);
      await browserExpect(
        page.getByRole('textbox', { name: 'Join message', exact: true }),
      ).toHaveCount(0);
      await browserExpect(page.getByLabel('Formatting', { exact: true })).toHaveCount(0);
      await page.getByLabel('Announcement', { exact: true }).fill('Room: ');
      await page.getByRole('button', { name: 'Room', exact: true }).click();
      await browserExpect(page.getByLabel('Announcement', { exact: true })).toHaveValue(
        'Room: {room}',
      );
      await page.getByLabel('Status', { exact: true }).selectOption('welcome');
      await browserExpect(page.getByLabel('Announcement', { exact: true })).toHaveCount(0);
      await browserExpect(page.getByLabel('Banner', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Room', exact: true }).click();
      await browserExpect(page.getByLabel('Banner', { exact: true })).toHaveValue('{room}');
      expect(errors).toEqual([]);
    } finally {
      await page.unroute(pattern);
    }
  });
});
