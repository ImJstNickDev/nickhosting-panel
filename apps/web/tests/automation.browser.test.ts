import { randomUUID } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
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
    fixture = await browserHarness();
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
    const wake = page
      .locator('.automation-policy')
      .filter({ has: page.getByRole('heading', { name: 'Wake on join', exact: true }) });
    await wake.getByLabel('Wake on join', { exact: true }).selectOption('false');
    const savedWake = page.waitForResponse(
      (response) =>
        response.url().endsWith('/auto-wake-policy') && response.request().method() === 'PUT',
    );
    await wake.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await savedWake).status()).toBe(200);
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
    await wake.getByLabel('Wake on join', { exact: true }).selectOption('inherit');
    const inheritedWake = page.waitForResponse(
      (response) =>
        response.url().endsWith('/auto-wake-policy') && response.request().method() === 'PUT',
    );
    await wake.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await inheritedWake).status()).toBe(200);
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
      .locator('.automation-policy')
      .filter({ has: page.getByRole('heading', { name: 'Wake on join', exact: true }) });
    await browserExpect(wake.locator('select[name="wake"] option[value="true"]')).toBeDisabled();
    await browserExpect(
      wake.locator('select[name="wake"] option[value="inherit"]'),
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
    await page.goto(`${fixture.origin}${base()}/messages`);
    await page.getByLabel('Server list message', { exact: true }).fill('§a{server}');
    await page.getByLabel('Status', { exact: true }).selectOption('waking');
    await page.getByLabel('Join message', { exact: true }).fill('Starting soon');
    await page.getByLabel('Status', { exact: true }).selectOption('sleeping');
    await browserExpect(page.getByLabel('Server list message', { exact: true })).toHaveValue(
      '§a{server}',
    );
    await browserExpect(page.locator('.gateway-preview').first()).toContainText('Survival');
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
      page.getByLabel('Messaggio nella lista server', { exact: true }),
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
});
