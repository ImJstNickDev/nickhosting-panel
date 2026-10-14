import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('file viewer Escape navigation', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  const errors: string[] = [];
  const samples = {
    'escape.txt': 'Escape editor fixture',
    'escape.json': '{"enabled":true}',
    'escape.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
    'escape.wav': 'Unplayable audio fixture',
    'escape.webm': 'Unplayable video fixture',
    'escape.zip': 'Archive metadata fixture',
    'escape.sqlite': 'Database metadata fixture',
  };
  const viewers = [
    '.cm-content',
    '.ve-json',
    '.ve-image-viewer',
    '.ve-wave',
    '.motion-player',
    '.ve-archive',
    '.dg-workspace',
  ];
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
    const files = await provider.files();
    for (const [name, content] of Object.entries(samples))
      files.set(`world/${name}`, Buffer.from(content));
    const endpoint = `/v1/servers/${provider.ids.serverId}/files/viewer`;
    await page.route(`**${endpoint}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/capabilities'))
        return route.fulfill({ json: { available: true } });
      if (url.pathname.endsWith('/preferences'))
        return route.fulfill({ json: { preferences: [] } });
      if (url.pathname.endsWith('/archive'))
        return route.fulfill({
          json: { directory: '', entries: [], offset: 0, limit: 200, total: 0 },
        });
      if (url.pathname.endsWith('/sqlite'))
        return route.fulfill({
          json: {
            tables: [],
            revision: 'escape-fixture',
            consistency: 'unverified',
            rows: [],
            columns: [],
            schema: [],
          },
        });
      const path = url.searchParams.get('path') ?? '';
      return route.fulfill({
        body: files.get(path) ?? Buffer.from(''),
        contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream',
      });
    });
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  const file = (name: string) =>
    page.locator('.fm-entry').getByRole('button', { name, exact: true });
  const home = () => page.getByRole('button', { name: 'Back to files', exact: true });
  async function folder() {
    await page.goto(base);
    await page.getByRole('button', { name: 'root', exact: true }).click();
    await file('world').click();
    await browserExpect(file('escape.txt')).toBeVisible();
  }
  async function open(name = 'escape.txt') {
    await file(name).click();
    await browserExpect(home()).toBeVisible();
  }

  it('returns every builtin viewer and the editor to its current folder, including failed media', async () => {
    await folder();
    for (const [index, name] of Object.keys(samples).entries()) {
      await open(name);
      const viewer = viewers[index];
      if (!viewer) throw new Error(`Missing viewer assertion for ${name}`);
      await browserExpect(page.locator(viewer)).toBeVisible();
      // Datagrid search must not trap Escape; lost focus must work as well.
      if (name.endsWith('.sqlite'))
        await page.getByRole('searchbox', { name: 'Search tables', exact: true }).focus();
      else await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await page.keyboard.press('Escape');
      await browserExpect(home()).toHaveCount(0);
      await browserExpect(file(name)).toBeVisible();
      await browserExpect(file(name)).toBeFocused();
      await browserExpect(page.getByRole('navigation', { name: 'File location' })).toContainText(
        'world',
      );
    }
  });

  it('gives search, path entry, account popover and Open with dialog the first Escape', async () => {
    await folder();
    await open();
    const editor = page.locator('.cm-content');
    await browserExpect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press('Control+f');
    await browserExpect(page.locator('.fm-search-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('.fm-search-panel')).toHaveCount(0);
    await browserExpect(home()).toBeVisible();
    await page.keyboard.press('Alt+g');
    await browserExpect(page.getByLabel('Path', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await browserExpect(page.getByLabel('Path', { exact: true })).toHaveCount(0);
    await browserExpect(home()).toBeVisible();
    await page.locator('.account-avatar').click();
    await browserExpect(page.locator('.account-dropdown')).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('.account-dropdown')).toHaveCount(0);
    await browserExpect(home()).toBeVisible();
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    await browserExpect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    await browserExpect(home()).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(file('escape.txt')).toBeVisible();
  });

  it('uses the Home discard guard for focused editor changes, keeping declined drafts intact', async () => {
    await folder();
    await open();
    const editor = page.locator('.cm-content');
    await browserExpect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' changed');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.keyboard.press('Escape');
    await browserExpect(home()).toBeVisible();
    await browserExpect(editor).toContainText(' changed');
    page.once('dialog', (dialog) => dialog.accept());
    await page.keyboard.press('Escape');
    await browserExpect(file('escape.txt')).toBeVisible();
    await open();
    await browserExpect(editor).toHaveText(samples['escape.txt']);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});
