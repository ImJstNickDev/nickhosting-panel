import { Buffer } from 'node:buffer';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Atlas path extension', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  const reads: URL[] = [];
  const errors: string[] = [];
  const e = (name: string, directory = false, parent = '') => ({
    name,
    directory,
    path: [parent, name].filter(Boolean).join('/'),
    size: 14,
  });
  const tree = new Map([
    ['[]:', [e('config', true), e('nested.zip'), e('packed.zip.gz'), e('many', true)]],
    ['[]:config', [e('settings.json', false, 'config')]],
    ['["nested.zip"]:', [e('inner', true)]],
    ['["nested.zip"]:inner', [e('deep.json', false, 'inner')]],
    ['["packed.zip.gz"]:', [e('packed.zip')]],
    ['["packed.zip.gz","packed.zip"]:', [e('data', true)]],
    ['["packed.zip.gz","packed.zip"]:data', [e('inside.json', false, 'data')]],
    [
      '[]:many',
      [
        ...Array.from({ length: 220 }, (_, index) => e(`a-${index}-target.json`, false, 'many')),
        e('target.json', false, 'many'),
      ],
    ],
  ]);
  beforeAll(async () => {
    harness = await browserHarness();
    const identities = await prepareJourneyIdentities(harness);
    page = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    (await provider.files()).set('virtual.zip', Buffer.from('isolated archive fixture'));
    const server = await harness.database.db
      .selectFrom('managed_servers')
      .select('pterodactyl_identifier')
      .where('id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    await provider.adapter.createDirectory(server.pterodactyl_identifier ?? '', '', 'backups');
    (await provider.files()).set('backups/world.zip', Buffer.from('isolated archive fixture'));
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    const endpoint = `/v1/servers/${provider.ids.serverId}/files/viewer`;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('/files')) reads.push(new URL(request.url()));
    });
    await page.route(
      (url) => url.pathname.startsWith(`${endpoint}/`),
      async (route) => {
        const url = new URL(route.request().url());
        const action = url.pathname.slice(endpoint.length);
        if (action === '/capabilities') return route.fulfill({ json: { available: true } });
        if (action === '/preferences') return route.fulfill({ json: { preferences: [] } });
        if (action === '/archive/content')
          return route.fulfill({ body: '{"ready":true}', contentType: 'application/json' });
        if (action === '/archive') {
          const chain = url.searchParams.get('archives') ?? '[]';
          const directory = url.searchParams.get('directory') ?? '';
          const entries = tree.get(`${chain}:${directory}`);
          if (!entries)
            return route.fulfill({ status: 404, json: { messageKey: 'viewer.unavailable' } });
          const query = (url.searchParams.get('query') ?? '').toLowerCase();
          const filtered = entries.filter((entry) => entry.name.toLowerCase().includes(query));
          const offset = Number(url.searchParams.get('offset') ?? 0);
          return route.fulfill({
            json: {
              directory,
              offset,
              limit: 200,
              total: filtered.length,
              entries: filtered.slice(offset, offset + 200),
            },
          });
        }
        return route.fulfill({ status: 404, json: { messageKey: 'viewer.unavailable' } });
      },
    );
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  async function open() {
    await page.goto(base);
    await page.locator('.fm-breadcrumb').getByRole('button', { name: 'root', exact: true }).click();
    await page.locator('.fm-filename').getByText('virtual.zip', { exact: true }).click();
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
  }
  async function path() {
    await page.keyboard.press('Alt+g');
    const input = page.getByRole('combobox', { name: 'Path', exact: true });
    await browserExpect(input).toBeFocused();
    return input;
  }
  it('shows the full virtual path, completes folders and opens members while keeping real paths separate', async () => {
    await open();
    await page.locator('.fm-filename').getByText('config', { exact: true }).click();
    const input = await path();
    await browserExpect(input).toHaveValue('/virtual.zip/config/');
    await input.fill('/virtual.zip/nest');
    await browserExpect(page.getByRole('option', { name: 'nested.zip/' })).toBeVisible();
    await input.press('ArrowDown');
    await input.press('Enter');
    await browserExpect(input).toHaveValue('/virtual.zip/nested.zip/');
    await browserExpect(page.getByRole('option', { name: 'inner/' })).toBeVisible();
    await input.press('ArrowDown');
    await input.press('Enter');
    await browserExpect(input).toHaveValue('/virtual.zip/nested.zip/inner/');
    await browserExpect(page.getByRole('option', { name: 'deep.json', exact: true })).toBeVisible();
    await input.press('Enter');
    await browserExpect(input).toHaveCount(0);
    await browserExpect(page.locator('.ve-archive .fm-filename')).toHaveText('deep.json');
    const member = await path();
    await member.fill('/virtual.zip/nested.zip/inner/deep');
    await browserExpect(page.getByRole('option', { name: 'deep.json', exact: true })).toBeVisible();
    await member.press('Enter');
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    const current = await path();
    await browserExpect(current).toHaveValue('/virtual.zip/nested.zip/inner/deep.json');
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/atlas-path-member-desktop.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/atlas-path-member-mobile.png',
      fullPage: true,
    });
    await current.fill('/virtual.zip/missing/');
    await browserExpect(page.getByRole('status')).toContainText('Could not');
    await current.press('Escape');
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    const leave = await path();
    await leave.fill('/');
    await browserExpect(
      page.getByRole('option', { name: 'virtual.zip', exact: true }),
    ).toBeVisible();
    await leave.press('Enter');
    await browserExpect(page.locator('.ve-engine')).toHaveCount(0);
    await browserExpect(await path()).toHaveValue('/');
    await page.keyboard.press('Escape');
    const physicalReads = reads.filter((url) => url.pathname.endsWith('/files'));
    expect(
      physicalReads.every((url) => !url.searchParams.get('path')?.startsWith('virtual.zip')),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
  it('completes beyond the first page and navigates newly typed compressed nested containers with hidden aliases', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open();
    let input = await path();
    await input.fill('/virtual.zip/many/target');
    await browserExpect(
      page.getByRole('option', { name: 'target.json', exact: true }),
    ).toBeVisible();
    expect(
      reads.some(
        (url) =>
          url.searchParams.get('query') === 'target' && url.searchParams.get('offset') === '200',
      ),
    ).toBe(true);
    await input.press('Enter');
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    input = await path();
    await input.fill('/virtual.zip/packed.zip.gz/data/');
    await browserExpect(
      page.getByRole('option', { name: 'inside.json', exact: true }),
    ).toBeVisible();
    await input.press('Enter');
    await browserExpect(page.locator('.ve-archive .fm-filename')).toHaveText('inside.json');
    await browserExpect(input).toHaveCount(0);
    input = await path();
    await browserExpect(input).toHaveValue('/virtual.zip/packed.zip.gz/data/');
    await input.press('ArrowDown');
    await input.press('Enter');
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    input = await path();
    await browserExpect(input).toHaveValue('/virtual.zip/packed.zip.gz/data/inside.json');
    await input.press('Escape');
    expect(errors).toEqual([]);
  });
  it('uses parent rows inside folders and nested archives and exits the outer archive to its containing real folder', async () => {
    await page.goto(base);
    await page.locator('.fm-breadcrumb').getByRole('button', { name: 'root', exact: true }).click();
    await page.locator('.fm-filename').getByText('backups', { exact: true }).click();
    await page.locator('.fm-filename').getByText('world.zip', { exact: true }).click();
    const archive = page.locator('.ve-archive');
    const parent = archive.getByRole('button', { name: 'Parent folder', exact: true });
    await browserExpect(parent).toBeVisible();
    const extract = page
      .locator('.fm-toolbar')
      .getByRole('button', { name: 'Extract', exact: true });
    await browserExpect(extract).toBeVisible();
    const icon = await extract.locator('svg').boundingBox();
    expect(icon?.width).toBeGreaterThanOrEqual(16);
    expect(icon?.height).toBeGreaterThanOrEqual(16);
    await extract.click();
    await browserExpect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    await browserExpect(parent).toBeVisible();
    await harness.screenshot(page, 'atlas-parent-root-desktop');
    await archive.locator('.fm-filename').getByText('config', { exact: true }).click();
    await browserExpect(archive.locator('.fm-filename')).toHaveText('settings.json');
    await parent.click();
    await archive.locator('.fm-filename').getByText('nested.zip', { exact: true }).click();
    await browserExpect(archive.locator('.fm-filename')).toHaveText('inner');
    await parent.click();
    await browserExpect(
      archive.locator('.fm-filename').getByText('nested.zip', { exact: true }),
    ).toBeVisible();
    await parent.click();
    await browserExpect(page.locator('.ve-engine')).toHaveCount(0);
    await browserExpect(page.locator('.fm-breadcrumb [aria-current="page"]')).toHaveText('backups');
    await browserExpect(page.locator('.fm-filename')).toHaveText('world.zip');
    await browserExpect(page.locator('.fm-filename')).toBeFocused();
    expect(errors).toEqual([]);
  });
});
