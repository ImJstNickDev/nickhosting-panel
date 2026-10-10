import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('inherited sleep timeout controls', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let owner: Page;
  let user: Page;
  const errors: string[] = [];
  beforeAll(async () => {
    harness = await browserHarness();
    const identities = await prepareJourneyIdentities(harness);
    owner = identities.owner;
    user = identities.user;
    owner.setDefaultTimeout(10000);
    user.setDefaultTimeout(10000);
    for (const page of [owner, user]) page.on('pageerror', (error) => errors.push(error.message));
    harness.env.NH_GATEWAY_ENABLED = 'true';
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  async function saved(page: Page, url: string, action: () => Promise<unknown>) {
    const response = page.waitForResponse(
      (response) =>
        ['PUT', 'PATCH'].includes(response.request().method()) && response.url().endsWith(url),
    );
    const [result] = await Promise.all([response, action()]);
    expect(result.status()).toBe(200);
  }
  it('sets the instance timeout and keeps controls hidden by default', async () => {
    await owner.goto(`${harness.origin}/owner/settings`);
    const form = owner.locator('form').filter({ has: owner.locator('input[name="sleepGlobal"]') });
    await browserExpect(form.locator('select[name="sleepGlobalAccess"]')).toHaveValue('hidden');
    await user.goto(`${harness.origin}/servers/${provider.ids.serverId}/automation`);
    await user.getByRole('button', { name: 'Configure sleep and wake', exact: true }).click();
    await browserExpect(
      user.getByLabel('Wake on player connection', { exact: true }),
    ).toBeEnabled();
    const wake = user.getByLabel('Wake on player connection', { exact: true });
    const wakeForm = user.locator('form').filter({ has: wake });
    await wake.check();
    await saved(user, '/gateway', () =>
      wakeForm.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await browserExpect(wake).toBeChecked();
    await wake.uncheck();
    await saved(user, '/gateway', () =>
      wakeForm.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await browserExpect(user.locator('select[name="idleMinutesMode"]')).toHaveCount(0);
    await browserExpect(user.getByText('Current timeout:', { exact: false })).toHaveCount(0);
    await form.locator('input[name="sleepGlobal"]').fill('20');
    await saved(owner, '/owner/settings', () =>
      form.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await harness.screenshot(owner, 'inherited-sleep-global-desktop-en');
    await user.reload();
    await browserExpect(
      user.getByLabel('Wake on player connection', { exact: true }),
    ).toBeDisabled();
    const sleepSection = user
      .locator('section')
      .filter({ has: user.getByLabel('Wake on player connection', { exact: true }) });
    await browserExpect(
      sleepSection.getByRole('button', { name: 'Save changes', exact: true }),
    ).toHaveCount(0);
    await browserExpect(
      sleepSection.getByText('The Owner manages automatic sleep for this server.', { exact: true }),
    ).toBeVisible();
    await harness.screenshot(user, 'inherited-sleep-hidden-desktop-en');
  });
  it('saves game and runtime defaults through actual Owner handlers', async () => {
    await owner.goto(`${harness.origin}/owner/integrations`);
    const settings = owner.getByTestId('sleep-settings-minecraft-java');
    await settings.locator('summary').first().click();
    await settings.locator('select[name="sleepGameMode"]').selectOption('override');
    await settings.locator('input[name="sleepGame"]').fill('30');
    await settings.locator('select[name="sleepGameAccess"]').selectOption('editable');
    await settings.getByText('Vanilla', { exact: true }).click();
    await browserExpect(
      settings.locator('select[name="sleepRuntime-vanillaMode"] option[value="inherit"]'),
    ).toHaveText('Inherit (30 min)');
    await settings.locator('select[name="sleepRuntime-vanillaMode"]').selectOption('override');
    await settings.locator('input[name="sleepRuntime-vanilla"]').fill('10');
    await saved(owner, '/minecraft-java/sleep-policy', () =>
      settings.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await browserExpect(settings.locator('input[name="sleepGame"]')).toHaveValue('30');
    await settings.getByText('Vanilla', { exact: true }).click();
    await browserExpect(settings.locator('input[name="sleepRuntime-vanilla"]')).toHaveValue('10');
    await settings.scrollIntoViewIfNeeded();
    await harness.screenshot(owner, 'inherited-sleep-owner-desktop-en');
    expect(
      (
        await new AxeBuilder({ page: owner })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
  it('inherits runtime defaults, overrides or disables per server without granting automatic wake', async () => {
    await user.goto(`${harness.origin}/servers/${provider.ids.serverId}/automation`);
    const form = user
      .locator('form')
      .filter({ has: user.locator('select[name="idleMinutesMode"]') });
    await form.locator('select[name="idleMinutesMode"]').selectOption('inherit');
    await saved(user, '/gateway', () =>
      form.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await browserExpect(
      user.getByText('Current timeout: 10 min · Source: runtime', { exact: true }),
    ).toBeVisible();
    await form.locator('select[name="idleMinutesMode"]').selectOption('override');
    await form.getByLabel('Time without players (minutes)', { exact: true }).fill('5');
    await saved(user, '/gateway', () =>
      form.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await browserExpect(
      user.getByText('Current timeout: 5 min · Source: server', { exact: true }),
    ).toBeVisible();
    await form.getByLabel('Time without players (minutes)', { exact: true }).fill('-1');
    await saved(user, '/gateway', () =>
      form.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await browserExpect(
      user.getByText('Current timeout: Disabled · Source: server', { exact: true }),
    ).toBeVisible();
    const row = await harness.database.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    expect(row.enabled).toBe(false);
    expect(row.state).toBe('manually_stopped');
    await form.locator('select[name="idleMinutesMode"]').selectOption('inherit');
    await saved(user, '/gateway', () =>
      form.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await browserExpect(
      user.getByText('Current timeout: 10 min · Source: runtime', { exact: true }),
    ).toBeVisible();
    await harness.screenshot(user, 'inherited-sleep-server-desktop-en');
  });
  it('enforces shorten-only input bounds and preserves automatic controls', async () => {
    const settings = owner.getByTestId('sleep-settings-minecraft-java');
    await settings
      .locator('select[name="sleepRuntimeAccess-vanilla"]')
      .selectOption('shorten-only');
    await saved(owner, '/minecraft-java/sleep-policy', () =>
      settings.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await user.goto(`${harness.origin}/servers/${provider.ids.serverId}/automation`);
    await user.locator('select[name="idleMinutesMode"]').selectOption('override');
    const input = user.locator('input[name="idleMinutes"]');
    await browserExpect(input).toHaveAttribute('max', '10');
    await input.fill('-1');
    expect(await input.evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(
      false,
    );
    await input.fill('11');
    expect(await input.evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(
      false,
    );
    await input.fill('4');
    const form = user
      .locator('form')
      .filter({ has: user.locator('select[name="idleMinutesMode"]') });
    await saved(user, '/gateway', () =>
      form.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await browserExpect(input).toHaveValue('4');
    await browserExpect(
      form.getByText('The Owner manages automatic sleep for this server.', { exact: true }),
    ).toBeVisible();
    await harness.screenshot(user, 'inherited-sleep-limited-desktop-en');
    await browserExpect(
      user.getByLabel('Wake on player connection', { exact: true }),
    ).toBeDisabled();
    await user.locator('select[name="idleMinutesMode"]').selectOption('inherit');
    await saved(user, '/gateway', () =>
      form.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await settings.getByText('Vanilla', { exact: true }).click();
  });
  it('removes runtime overrides and renders effective game inheritance on Italian mobile', async () => {
    const settings = owner.getByTestId('sleep-settings-minecraft-java');
    await settings.locator('select[name="sleepRuntime-vanillaMode"]').selectOption('inherit');
    await settings.locator('select[name="sleepRuntimeAccess-vanilla"]').selectOption('inherit');
    await saved(owner, '/minecraft-java/sleep-policy', () =>
      settings.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    await user.goto(`${harness.origin}/servers/${provider.ids.serverId}/automation`);
    await browserExpect(
      user.getByText('Tempo attuale: 30 min · Origine: gioco', { exact: true }),
    ).toBeVisible();
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await harness.screenshot(user, 'inherited-sleep-server-mobile-it');
    expect(
      (
        await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(errors).toEqual([]);
  });
  it('lets the Owner set an immutable user ceiling per server then restore global inheritance', async () => {
    await owner.goto(`${harness.origin}/servers/${provider.ids.serverId}/automation`);
    const form = owner
      .locator('form')
      .filter({ has: owner.locator('select[name="idleMinutesMode"]') });
    await form.locator('select[name="idleMinutesMode"]').selectOption('override');
    await form.locator('input[name="idleMinutes"]').fill('7');
    await form.locator('select[name="sleepServerAccess"]').selectOption('shorten-only');
    await saved(owner, '/gateway', () =>
      form.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await user.reload();
    await user.locator('select[name="idleMinutesMode"]').selectOption('override');
    await browserExpect(user.locator('input[name="idleMinutes"]')).toHaveAttribute('max', '7');
    await form.locator('select[name="idleMinutesMode"]').selectOption('inherit');
    await form.locator('select[name="sleepServerAccess"]').selectOption('inherit');
    await saved(owner, '/gateway', () =>
      form.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await owner.goto(`${harness.origin}/owner/integrations`);
    const settings = owner.getByTestId('sleep-settings-minecraft-java');
    await settings.locator('summary').first().click();
    await settings.locator('select[name="sleepGameMode"]').selectOption('inherit');
    await saved(owner, '/minecraft-java/sleep-policy', () =>
      settings.getByRole('button', { name: 'Save changes', exact: true }).click(),
    );
    await user.reload();
    await browserExpect(
      user.getByText('Tempo attuale: 20 min · Origine: istanza', { exact: true }),
    ).toBeVisible();
  });
});
