import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  expect as check,
  firefox,
  type Page,
} from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { minecraftManifest } from '../../../games/minecraft/src/index.js';

const endpoint = '/v1/owner/minecraft/forge/catalog';
const screenshots = '.codex/local/m5-browser/screenshots';
/** Real Owner workspace and catalog, with isolated API responses and no provider access. */
describe('Forge Owner catalog (real Firefox, isolated responses)', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let reads: string[], writes: Array<{ path: string; body: unknown }>, errors: string[];
  let synced: boolean, syncFails: boolean, getFails: boolean, postFails: boolean;
  let stage: 'idle' | 'queued' | 'refreshing';
  let hold: Promise<void> | undefined;
  const versions = () => [
    {
      minecraftVersion: '1.20.1',
      javaMajor: 17,
      loaders: Array.from({ length: 31 }, (_, index) => ({
        version: `47.4.${30 - index}`,
        coordinate: `1.20.1-47.4.${30 - index}`,
        recommended: index === 3,
        latest: index === 0,
      })),
    },
    {
      minecraftVersion: '1.7.10',
      javaMajor: 8,
      loaders: [
        {
          version: '10.13.4.1614-1.7.10',
          coordinate: '1.7.10-10.13.4.1614-1.7.10',
          recommended: true,
          latest: true,
        },
      ],
    },
  ];
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/forge-catalog-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await vite.listen();
    origin = vite.resolvedUrls?.local[0] ?? '';
    browser = await firefox.launch({
      headless: true,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
      },
    });
    await mkdir(screenshots, { recursive: true });
  });
  beforeEach(async () => {
    reads = [];
    writes = [];
    errors = [];
    synced = false;
    syncFails = false;
    getFails = false;
    postFails = false;
    stage = 'idle';
    hold = undefined;
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
    });
    await page.route('**/owner/integrations**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Forge versions</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/owner-integration-workspace.tsx"></script></body></html>',
      }),
    );
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (method === 'GET') reads.push(path);
      else writes.push({ path, body: route.request().postDataJSON() });
      const response = (json: unknown) => route.fulfill({ json });
      if (path === endpoint) {
        if (hold) await hold;
        if ((method === 'GET' && getFails) || (method === 'POST' && postFails))
          return route.fulfill({
            status: 503,
            json: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
          });
        if (method === 'POST') stage = 'queued';
        else if (stage === 'queued') stage = 'refreshing';
        else if (stage === 'refreshing') {
          stage = 'idle';
          if (!syncFails) synced = true;
        }
        return response({
          versions: synced ? versions() : [],
          synced,
          status: {
            syncState: stage,
            lastCheckedAt: synced ? '2026-10-21T10:00:00Z' : null,
            lastSuccessAt: synced ? '2026-10-21T10:00:00Z' : null,
            nextCheckAt: null,
            lastError: syncFails ? 'forge_metadata_refresh_failed' : null,
            stale: syncFails || !synced,
          },
        });
      }
      if (path === '/v1/owner/game-modules')
        return response([{ id: 'minecraft', manifest: minecraftManifest }]);
      if (path === '/v1/platform/owner/games')
        return response([
          { id: 'minecraft', state: 'public', allowlist: [], manifest: minecraftManifest },
        ]);
      if (path === '/v1/owner/runtime-mappings' || path === '/v1/owner/nodes') return response([]);
      if (path === '/v1/owner/infrastructure') return response({ nodes: [], nests: [] });
      if (path === '/v1/owner/settings')
        return response({ config: { values: { minecraftProtocolSource: {} }, lockedKeys: [] } });
      errors.push(`Unexpected ${method} ${path}`);
      return route.fulfill({ status: 404, json: { code: 'not_found' } });
    });
  });
  afterEach(async () => {
    await context.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  const open = () => page.goto(`${origin}owner/integrations/minecraft/versions?runtime=forge`);
  const rows = () => page.locator('.forge-catalog-table tbody tr');

  it('syncs without a mapping, preserves newest Minecraft ordering, and filters locally', async () => {
    await open();
    await check(page.getByText('The Forge catalog has not been synced yet.')).toBeVisible();
    await page.screenshot({ path: `${screenshots}/forge-catalog-empty-en.png`, fullPage: true });
    await page.getByRole('button', { name: 'Sync versions', exact: true }).click();
    await check(page.getByRole('button', { name: 'Queued…', exact: true })).toBeDisabled();
    await page.screenshot({ path: `${screenshots}/forge-catalog-queued-en.png`, fullPage: true });
    await check(page.getByRole('button', { name: 'Syncing…', exact: true })).toBeDisabled();
    await check(rows()).toHaveCount(25);
    await check(rows().first().locator('td').first()).toHaveText('47.4.30');
    await check(rows().nth(1).locator('td').first()).toHaveText('47.4.29');
    await check(rows().nth(6).locator('td').first()).toHaveText('47.4.24');
    await check(rows().nth(7).locator('td').first()).toHaveText('47.4.23');
    await check(page.getByText('31 versions', { exact: true })).toBeVisible();
    const table = page.locator('.forge-catalog-table');
    await table.focus();
    await page.keyboard.press('PageDown');
    await check.poll(() => table.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await check(rows()).toHaveCount(6);
    const localReads = reads.filter((path) => path === endpoint).length;
    await page.getByRole('searchbox').fill('47.4.15');
    await check(rows()).toHaveCount(1);
    await check(rows().first()).toContainText('47.4.15');
    await check(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
    await page.getByRole('searchbox').fill('missing');
    await check(page.getByText('No matching versions.', { exact: true })).toBeVisible();
    await page.getByRole('searchbox').fill('');
    await check(rows()).toHaveCount(25);
    expect(reads.filter((path) => path === endpoint)).toHaveLength(localReads);
    await page.getByLabel('Minecraft', { exact: true }).selectOption('1.7.10');
    await check(rows()).toHaveCount(1);
    await check(rows().first()).toContainText('10.13.4.1614-1.7.10');
    await page.getByLabel('Minecraft', { exact: true }).selectOption('1.20.1');
    expect(reads.some((path) => path.includes('/compatibility'))).toBe(false);
    expect(writes).toEqual([{ path: endpoint, body: {} }]);
    await check(page.getByRole('checkbox')).toHaveCount(0);
    await page.screenshot({ path: `${screenshots}/forge-catalog-desktop-en.png`, fullPage: true });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });

  it('keeps the saved catalog visible on failed refresh and offers a retry for rejected requests', async () => {
    synced = true;
    syncFails = true;
    postFails = true;
    await open();
    await check(rows()).toHaveCount(25);
    await check(
      page.getByText('Sync failed. The last saved catalog is shown, if available.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Sync versions', exact: true }).click();
    await check(page.getByRole('alert')).toBeVisible();
    await check(rows().first().locator('td').first()).toHaveText('47.4.30');
    await page.screenshot({ path: `${screenshots}/forge-catalog-error-en.png`, fullPage: true });
    postFails = false;
    syncFails = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await check(page.getByRole('button', { name: 'Sync versions', exact: true })).toBeEnabled();
    await check(page.getByRole('alert')).toHaveCount(0);
    await check(page.getByText('Update pending', { exact: false })).toHaveCount(0);
  });

  it('shows loading and read failure truthfully before a successful retry', async () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    getFails = true;
    await open();
    await check(page.locator('.forge-catalog-table')).toHaveAttribute('aria-busy', 'true');
    await page.screenshot({ path: `${screenshots}/forge-catalog-loading-en.png`, fullPage: true });
    release();
    hold = undefined;
    await check(page.getByRole('alert')).toBeVisible();
    await check(page.getByText('The Forge catalog has not been synced yet.')).toHaveCount(0);
    getFails = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await check(page.getByText('The Forge catalog has not been synced yet.')).toBeVisible();
  });

  it('keeps all informational columns accessible in Italian on mobile', async () => {
    synced = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await open();
    await check(rows()).toHaveCount(25);
    await check(page.getByRole('columnheader', { name: 'Build Forge', exact: true })).toBeVisible();
    await check(page.getByRole('columnheader', { name: 'Java', exact: true })).toBeVisible();
    await check(page.getByText('Consigliata', { exact: true })).toBeVisible();
    await check(
      page.getByText(
        'Build consigliata come predefinita, oppure la più recente se non è indicata una preferenza.',
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${screenshots}/forge-catalog-mobile-it.png`, fullPage: true });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
});
