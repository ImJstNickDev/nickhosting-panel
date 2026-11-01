import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Server settings browser journeys', () => {
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
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });
  const settingsURL = () => `${fixture.origin}/servers/${provider.ids.serverId}/settings`;
  const metadataPath = () => `/v1/platform/servers/${provider.ids.serverId}`;
  const operationPath = () => `/v1/servers/${provider.ids.serverId}/operations`;
  async function screenshot(name: string) {
    // These screens contain only disposable fixture names and limits, never credentials.
    await page.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots', `${name}.png`),
      fullPage: true,
    });
  }
  async function accessible() {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  }
  function responseFor(path: string, method: string) {
    return page.waitForResponse(
      (response) => response.url().endsWith(path) && response.request().method() === method,
    );
  }

  it('saves name and project independently, with compact dirty controls and accessible desktop settings', async () => {
    const project = await journeyRequest<{ id: string }>(fixture, page, '/v1/projects', {
      name: 'Friends',
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(settingsURL());
    const general = page.getByRole('region', { name: 'General', exact: true });
    const name = general.locator('form').filter({ has: page.getByLabel('Name', { exact: true }) });
    const grouping = general
      .locator('form')
      .filter({ has: page.getByLabel('Project', { exact: true }) });
    await browserExpect(general.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await name.getByLabel('Name', { exact: true }).fill('Evening world');
    await grouping.getByLabel('Project', { exact: true }).selectOption(project.id);
    const savedName = responseFor(metadataPath(), 'PATCH');
    await name.getByRole('button', { name: 'Save changes', exact: true }).click();
    const nameResponse = await savedName;
    expect(nameResponse.status()).toBe(200);
    expect(nameResponse.request().postDataJSON()).toEqual({ name: 'Evening world' });
    await browserExpect(name.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    // Saving the name must neither submit nor discard a separate unsaved project choice.
    await browserExpect(grouping.getByLabel('Project', { exact: true })).toHaveValue(project.id);
    const savedProject = responseFor(metadataPath(), 'PATCH');
    await grouping.getByRole('button', { name: 'Save changes', exact: true }).click();
    const projectResponse = await savedProject;
    expect(projectResponse.status()).toBe(200);
    expect(projectResponse.request().postDataJSON()).toEqual({ projectId: project.id });
    await browserExpect(grouping.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await page.reload();
    await browserExpect(name.getByLabel('Name', { exact: true })).toHaveValue('Evening world');
    await browserExpect(grouping.getByLabel('Project', { exact: true })).toHaveValue(project.id);
    await browserExpect(
      general.getByRole('searchbox', { name: 'Find project', exact: true }),
    ).toHaveCount(0);
    await general.getByRole('button', { name: 'Find project', exact: true }).click();
    await browserExpect(
      general.getByRole('searchbox', { name: 'Find project', exact: true }),
    ).toBeVisible();
    await general.getByRole('button', { name: 'Find project', exact: true }).click();
    const memoryBox = await page.getByLabel('Memory (MiB)', { exact: true }).boundingBox();
    const cpuBox = await page.getByLabel('CPU (%)', { exact: true }).boundingBox();
    expect(memoryBox).not.toBeNull();
    expect(cpuBox).not.toBeNull();
    expect(Math.abs((memoryBox?.y ?? 0) - (cpuBox?.y ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((memoryBox?.height ?? 0) - (cpuBox?.height ?? 0))).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'General', exact: true }).hover();
    await screenshot('server-settings-desktop-en');
    await accessible();
  });

  it('keeps running resource limits readable and shows an accepted change as pending until confirmed', async () => {
    const db = fixture.database.db;
    // The real detail handler derives allowed actions from this isolated provider state.
    await db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running' })
      .where('id', '=', provider.ids.serverId)
      .execute();
    await page.goto(settingsURL());
    const resources = page.getByRole('region', { name: 'Resource limits', exact: true });
    await browserExpect(resources.getByLabel('Memory (MiB)', { exact: true })).toHaveValue('128');
    await browserExpect(resources.getByLabel('Memory (MiB)', { exact: true })).toBeDisabled();
    await browserExpect(resources.getByLabel('CPU (%)', { exact: true })).toBeDisabled();
    await browserExpect(resources.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await browserExpect(page.getByLabel('Memoria (MiB)', { exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await screenshot('server-settings-running-mobile-it');
    await accessible();
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'en' });
    await db
      .updateTable('managed_servers')
      .set({ runtime_state: 'offline' })
      .where('id', '=', provider.ids.serverId)
      .execute();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.reload();
    await resources.getByLabel('Memory (MiB)', { exact: true }).fill('192');
    const accepted = responseFor(operationPath(), 'POST');
    await resources.getByRole('button', { name: 'Save changes', exact: true }).click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    const job = (await response.json()) as { jobId: string };
    expect(response.request().postDataJSON()).toMatchObject({
      action: 'configure',
      limits: { memory: 192, cpu: 10 },
    });
    const persisted = await db
      .selectFrom('operation_jobs')
      .select('state')
      .where('id', '=', job.jobId)
      .executeTakeFirstOrThrow();
    expect(persisted.state).toBe('queued');
    await browserExpect(resources.getByLabel('Memory (MiB)', { exact: true })).toBeDisabled();
    await browserExpect(page.getByText('Changes saved', { exact: true })).toHaveCount(0);
    const server = await journeyRequest<{ activeOperationId: string | null }>(
      fixture,
      page,
      metadataPath(),
    );
    expect(server.activeOperationId).toBe(job.jobId);
    await screenshot('server-settings-pending-desktop-en');
    await provider.processPending();
    await page.reload();
    await browserExpect(resources.getByLabel('Memory (MiB)', { exact: true })).toHaveValue('192');
    await browserExpect(resources.getByLabel('Memory (MiB)', { exact: true })).toBeEnabled();
    await browserExpect(resources.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  });

  it('defaults destructive dialogs to Cancel and only queues an explicitly confirmed reinstall', async () => {
    await page.goto(settingsURL());
    const maintenance = page.getByRole('region', { name: 'Maintenance', exact: true });
    const countOperations = () =>
      fixture.database.db
        .selectFrom('server_operations')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('server_id', '=', provider.ids.serverId)
        .executeTakeFirstOrThrow();
    const baseline = await countOperations();
    for (const label of ['Reinstall', 'Wipe files', 'Delete server']) {
      await maintenance.getByRole('button', { name: label, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await browserExpect(
        dialog.getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeFocused();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
      await browserExpect(dialog).toHaveCount(0);
    }
    expect(await countOperations()).toEqual(baseline);
    await maintenance.getByRole('button', { name: 'Reinstall', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('switch', { name: 'Require a completed backup before continuing' })
      .click();
    await screenshot('server-settings-reinstall-desktop-en');
    await accessible();
    const accepted = responseFor(operationPath(), 'POST');
    await dialog.getByRole('button', { name: 'Reinstall', exact: true }).click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON()).toMatchObject({
      action: 'reinstall',
      confirm: true,
      backupBefore: true,
    });
    await browserExpect(dialog).toHaveCount(0);
    await browserExpect(
      maintenance.getByRole('button', { name: 'Reinstall', exact: true }),
    ).toBeDisabled();
    expect(errors).toEqual([]);
    // No worker executes this destructive request; only its actual durable API contract is exercised.
  });
});
