import { mkdir } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as check, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Minecraft root hidden file grouping', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  const errors: string[] = [];
  const hidden = ['.fixture-cache', 'libraries', 'versions', 'eula.txt', 'usercache.json'];
  beforeAll(async () => {
    harness = await browserHarness();
    const identities = await prepareJourneyIdentities(harness);
    page = identities.user;
    page.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    const endpoint = `/v1/servers/${provider.ids.serverId}/files`;
    for (const name of ['.fixture-cache', 'libraries', 'versions', 'ordinary'])
      await journeyRequest(harness, page, endpoint, { action: 'mkdir', root: '', name });
    for (const name of ['.nested', 'libraries'])
      await journeyRequest(harness, page, endpoint, { action: 'mkdir', root: 'ordinary', name });
    const files = await provider.files();
    for (const name of [
      'visible.txt',
      '.dotfile',
      'eula.txt',
      'usercache.json',
      'libraries/inside.txt',
      'ordinary/eula.txt',
      'ordinary/usercache.json',
    ])
      files.set(name, Buffer.from('Isolated grouping fixture'));
    await mkdir('.codex/local/m5-browser/screenshots', { recursive: true });
  });
  afterEach(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.goto(`${harness.origin}/servers`);
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('nh.locale', 'en');
    });
    expect(errors).toEqual([]);
    expect((await provider.files()).get('eula.txt')?.toString()).toBe('Isolated grouping fixture');
    expect((await provider.files()).get('usercache.json')?.toString()).toBe(
      'Isolated grouping fixture',
    );
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  const row = (name: string) =>
    page.locator('.fm-entry').filter({ has: page.getByRole('button', { name, exact: true }) });
  const toggle = () => page.locator('.fm-hidden-toggle');
  async function open() {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base);
    await check(row('visible.txt')).toBeVisible();
    await check(toggle()).toHaveAttribute('aria-expanded', 'false');
  }
  async function screenshot(name: string) {
    await page.screenshot({
      path: `.codex/local/m5-browser/screenshots/file-hidden-${name}.png`,
      fullPage: true,
    });
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
  }

  it('keeps normal dotfiles visible and exposes grouped rows with their ordinary actions', async () => {
    await open();
    await check(row('.dotfile')).toBeVisible();
    for (const name of hidden) await check(row(name)).toHaveCount(0);
    await screenshot('collapsed-desktop-en');
    await toggle().click();
    for (const name of hidden) await check(row(name)).toBeVisible();
    await row('eula.txt')
      .getByRole('button', { name: 'Actions for eula.txt', exact: true })
      .click();
    await check(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await screenshot('expanded-desktop-en');
    await row('libraries').getByRole('button', { name: 'libraries', exact: true }).click();
    await check(row('inside.txt')).toBeVisible();
    await check(toggle()).toHaveCount(0);
  });

  it('limits selection to displayed rows and removes hidden selection when collapsed', async () => {
    await open();
    await row('visible.txt').getByRole('checkbox').focus();
    await page.keyboard.press('Control+a');
    await check(row('visible.txt').getByRole('checkbox')).toBeChecked();
    await toggle().click();
    for (const name of hidden) await check(row(name).getByRole('checkbox')).not.toBeChecked();
    await row('eula.txt').getByRole('checkbox').check();
    await check(row('eula.txt').getByRole('checkbox')).toBeChecked();
    await toggle().click();
    await toggle().click();
    await check(row('eula.txt').getByRole('checkbox')).not.toBeChecked();
    await check(row('visible.txt').getByRole('checkbox')).toBeChecked();
    await page.getByRole('checkbox', { name: 'Select all files', exact: true }).check();
    for (const name of hidden) await check(row(name).getByRole('checkbox')).toBeChecked();
    await page.keyboard.press('Escape');
    const lastMain = page.locator('.fm-list > ul > .fm-entry').last();
    const firstHidden = page.locator('.fm-hidden-entries > .fm-entry').first();
    await lastMain.locator('.fm-filename').click({ modifiers: ['Control'] });
    await firstHidden.locator('.fm-filename').click({ modifiers: ['Shift'] });
    await check(page.locator('.fm-entry.fm-selected')).toHaveCount(2);
    await check(lastMain.getByRole('checkbox')).toBeChecked();
    await check(firstHidden.getByRole('checkbox')).toBeChecked();
  });

  it('searches hidden matches, permits collapsing them without claiming an empty folder, and renders grid/mobile', async () => {
    await open();
    const search = page.getByLabel('Search this folder', { exact: true });
    await search.fill('eula');
    await check(toggle()).toHaveAttribute('aria-expanded', 'true');
    await check(row('eula.txt')).toBeVisible();
    await toggle().click();
    await check(row('eula.txt')).toHaveCount(0);
    await check(page.getByText('No matching files', { exact: true })).toHaveCount(0);
    await search.fill('');
    await check(toggle()).toHaveAttribute('aria-expanded', 'false');
    await toggle().click();
    await page.getByRole('button', { name: 'Grid', exact: true }).click();
    await check(page.locator('.fm-list.fm-grid .fm-hidden-entries')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await toggle().scrollIntoViewIfNeeded();
    await screenshot('expanded-mobile-en');
    await page.getByRole('button', { name: 'List', exact: true }).click();
  });

  it('does not group matching names below root or on a different game', async () => {
    await open();
    await row('ordinary').getByRole('button', { name: 'ordinary', exact: true }).click();
    for (const name of ['.nested', 'libraries', 'eula.txt', 'usercache.json'])
      await check(row(name)).toBeVisible();
    await check(toggle()).toHaveCount(0);
    await page.getByRole('button', { name: 'root', exact: true }).click();
    await check(toggle()).toBeVisible();
    const endpoint = `**/v1/platform/servers/${provider.ids.serverId}`;
    await page.route(endpoint, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        json: { ...(await response.json()), gameId: 'another-game', runtimeId: 'generic' },
      });
    });
    await page.reload();
    await check(toggle()).toHaveCount(0);
    for (const name of hidden) await check(row(name)).toBeVisible();
  });
});
