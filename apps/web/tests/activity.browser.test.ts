import { randomUUID } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Unified Activity real browser journeys', () => {
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
      .updateTable('user')
      .set({ username: 'alex' })
      .where('id', '=', identities.userId)
      .execute();
    const base = Date.now();
    const insert = async (action: string, metadata: Record<string, unknown>, offset: number) =>
      fixture.database.db
        .insertInto('audit_events')
        .values({
          id: randomUUID(),
          actor_user_id: identities.userId,
          subject_user_id: identities.userId,
          action,
          correlation_id: randomUUID(),
          metadata: { serverId: provider.ids.serverId, ...metadata },
          created_at: new Date(base + offset),
        })
        .execute();
    const operationId = randomUUID();
    await insert(
      'server.files.requested',
      { operationId, action: 'copy', count: 12, path: '/uploads', target: '/plugins' },
      -10000,
    );
    await insert(
      'server.files.completed',
      {
        operationId,
        action: 'copy',
        count: 12,
        completed: 12,
        path: '/uploads',
        target: '/plugins',
        outcome: 'succeeded',
        entries: [{ path: '/uploads/config.yml', target: '/plugins/config.yml' }],
      },
      -9000,
    );
    await insert(
      'server.sftp.file.rename',
      {
        operationId: randomUUID(),
        path: '/world.old',
        target: '/world',
        credentialUsername: 'alex-fixture-extra',
        source: 'sftp',
        outcome: 'succeeded',
      },
      -8000,
    );
    await insert(
      'server.console.dispatched',
      { operationId: randomUUID(), command: 'whitelist add Steve', outcome: 'dispatched' },
      -7000,
    );
    await insert(
      'server.files.incomplete',
      {
        operationId: randomUUID(),
        action: 'delete',
        path: '/uploads',
        count: 3,
        outcome: 'uncertain',
      },
      -6000,
    );
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });
  const visit = () => page.goto(`${fixture.origin}/servers/${provider.ids.serverId}/activity`);
  it('groups mutations, shows actor/credential details and filters scoped history', async () => {
    await visit();
    await browserExpect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
    const copy = page.getByRole('button', { name: /^Copy files/ });
    await browserExpect(copy).toHaveCount(1);
    await copy.click();
    await browserExpect(page.getByRole('region', { name: 'Affected items' })).toContainText(
      '/plugins/config.yml',
    );
    await page.getByRole('button', { name: /^Rename or move/ }).click();
    await browserExpect(page.locator('.activity-detail')).toContainText('alex-fixture-extra');
    await browserExpect(page.locator('.activity-actor').first()).toContainText('alex');
    await page.getByRole('button', { name: /^Console command/ }).click();
    await browserExpect(page.locator('.activity-command pre')).toHaveText('whitelist add Steve');
    await page.getByRole('button', { name: 'Filter by alex', exact: true }).first().click();
    await browserExpect(page.locator('.activity-filter-chip')).toContainText('alex');
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search activity' }).fill('config.yml');
    await browserExpect(copy).toHaveCount(1);
    await browserExpect(
      page.locator('.activity-table tbody > tr:not(.activity-detail-row)'),
    ).toHaveCount(1);
    await page.getByRole('searchbox').fill('unmatched-fixture');
    await browserExpect(page.getByText('No matching activity', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: /^Console command/ })).toBeVisible();
    await fixture.screenshot(page, 'activity-unified-desktop-en');
  });
  it('supports keyboard disclosure, source/status filters and accessible mobile Italian layout', async () => {
    await visit();
    const search = page.getByRole('searchbox', { name: 'Search activity' });
    const borderBefore = await search
      .locator('..')
      .evaluate((node) => getComputedStyle(node).borderColor);
    await search.focus();
    expect(
      await search.locator('..').evaluate((node) => getComputedStyle(node).borderColor),
    ).not.toBe(borderBefore);
    const command = page.getByRole('button', { name: /^Console command/ });
    await command.focus();
    await page.keyboard.press('Enter');
    await browserExpect(command).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await browserExpect(command).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'More filters' }).click();
    await page.getByLabel('Source', { exact: true }).selectOption('sftp');
    await page.getByLabel('Action', { exact: true }).selectOption('rename');
    await browserExpect(
      page.locator('.activity-table tbody > tr:not(.activity-detail-row)'),
    ).toHaveCount(1);
    await page.getByRole('button', { name: /^Rename or move/ }).click();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('button', { name: 'More filters' }).click();
    await page.getByLabel('Status', { exact: true }).selectOption('uncertain');
    await browserExpect(
      page.locator('.activity-table tbody > tr:not(.activity-detail-row)'),
    ).toHaveCount(1);
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await visit();
    await browserExpect(page.getByRole('heading', { name: 'Attività', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Rinomina o spostamento/ }).click();
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
    await fixture.screenshot(page, 'activity-unified-mobile-it');
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'en' });
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  it('keeps table footprint while loading and exposes retry on a failed read', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/v1/platform/activity?**', async (route) => {
      await gate;
      await route.continue();
    });
    await visit();
    await browserExpect(page.locator('.activity-skeleton')).toBeVisible();
    await fixture.screenshot(page, 'activity-unified-loading-en');
    release();
    await browserExpect(page.getByRole('button', { name: /^Console command/ })).toBeVisible();
    await page.unroute('**/v1/platform/activity?**');
    await page.route('**/v1/platform/activity?**', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
        }),
      }),
    );
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await browserExpect(page.getByRole('alert')).toBeVisible();
    await browserExpect(page.getByRole('button', { name: /^Console command/ })).toBeVisible();
    await fixture.screenshot(page, 'activity-unified-refresh-error-en');
    await page.unroute('**/v1/platform/activity?**');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await browserExpect(page.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
