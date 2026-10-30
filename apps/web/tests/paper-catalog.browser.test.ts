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

const endpoint = '/v1/owner/minecraft/paper/catalog';
const screenshots = '.codex/local/m5-browser/screenshots';
/** Real Owner workspace and catalog, with isolated API responses and no provider access. */
describe('Paper Owner catalog (real Firefox, isolated responses)', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let reads: string[], writes: Array<{ path: string; body: unknown }>, errors: string[];
  let synced: boolean, syncFails: boolean, getFails: boolean, postFails: boolean;
  let stage: 'idle' | 'queued' | 'refreshing';
  let hold: Promise<void> | undefined;
  const versions = () =>
    [
      '26.3',
      '26.3-rc-3',
      '26.2',
      '26.2-rc-2',
      '26.1.2',
      '26.1.1',
      '1.21.11',
      '1.21.11-rc3',
      '1.21.11-rc2',
      '1.21.11-rc1',
      '1.21.11-pre5',
      '1.21.11-pre4',
      '1.21.11-pre3',
      '1.21.10',
      '1.21.9',
      '1.21.9-rc1',
      '1.21.9-pre4',
      '1.21.9-pre3',
      '1.21.9-pre2',
      '1.21.8',
      '1.21.7',
      '1.21.6',
      '1.21.5',
      '1.21.4',
      '1.21.3',
      '1.21.1',
      '1.21',
      '1.20.6',
      '1.20.5',
      '1.20.4',
      '1.20.2',
    ].map((version, index) => ({
      version,
      buildId: 42 + index,
      javaMajor: version.startsWith('26.') ? 25 : 21,
      channel: index === 0 ? 'RECOMMENDED' : version.includes('-') ? 'EXPERIMENTAL' : 'STABLE',
      // Maintenance build dates must not determine Minecraft version ordering.
      buildTime: `2026-10-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
    }));
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/paper-catalog-vite`,
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
        body: '<!doctype html><html lang="en"><head><title>Paper versions</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/owner-integration-workspace.tsx"></script></body></html>',
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
            lastError: syncFails ? 'paper_metadata_refresh_failed' : null,
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
  const open = () => page.goto(`${origin}owner/integrations/minecraft/versions?runtime=paper`);
  const rows = () => page.locator('.paper-catalog-table tbody tr');

  it('syncs without a mapping, preserves newest Minecraft ordering, and filters locally', async () => {
    await open();
    await check(page.getByText('The Paper catalog has not been synced yet.')).toBeVisible();
    await page.screenshot({ path: `${screenshots}/paper-catalog-empty-en.png`, fullPage: true });
    await page.getByRole('button', { name: 'Sync versions', exact: true }).click();
    await check(page.getByRole('button', { name: 'Queued…', exact: true })).toBeDisabled();
    await page.screenshot({ path: `${screenshots}/paper-catalog-queued-en.png`, fullPage: true });
    await check(page.getByRole('button', { name: 'Syncing…', exact: true })).toBeDisabled();
    await check(rows()).toHaveCount(25);
    await check(rows().first().locator('td').first()).toHaveText('26.3');
    await check(rows().nth(1).locator('td').first()).toHaveText('26.3-rc-3');
    await check(rows().nth(6).locator('td').first()).toHaveText('1.21.11');
    await check(rows().nth(7).locator('td').first()).toHaveText('1.21.11-rc3');
    await check(page.getByText('31 versions', { exact: true })).toBeVisible();
    const table = page.locator('.paper-catalog-table');
    await table.focus();
    await page.keyboard.press('PageDown');
    await check.poll(() => table.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await check(rows()).toHaveCount(6);
    const localReads = reads.filter((path) => path === endpoint).length;
    await page.getByRole('searchbox').fill('26.1.2');
    await check(rows()).toHaveCount(1);
    await check(rows().first()).toContainText('46');
    await check(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
    await page.getByRole('searchbox').fill('missing');
    await check(page.getByText('No matching versions.', { exact: true })).toBeVisible();
    await page.getByRole('searchbox').fill('');
    await check(rows()).toHaveCount(25);
    expect(reads.filter((path) => path === endpoint)).toHaveLength(localReads);
    expect(reads.some((path) => path.includes('/compatibility'))).toBe(false);
    expect(writes).toEqual([{ path: endpoint, body: {} }]);
    await check(page.getByRole('checkbox')).toHaveCount(0);
    await page.screenshot({ path: `${screenshots}/paper-catalog-desktop-en.png`, fullPage: true });
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
    await check(rows().first().locator('td').first()).toHaveText('26.3');
    await page.screenshot({ path: `${screenshots}/paper-catalog-error-en.png`, fullPage: true });
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
    await check(page.locator('.paper-catalog-table')).toHaveAttribute('aria-busy', 'true');
    await page.screenshot({ path: `${screenshots}/paper-catalog-loading-en.png`, fullPage: true });
    release();
    hold = undefined;
    await check(page.getByRole('alert')).toBeVisible();
    await check(page.getByText('The Paper catalog has not been synced yet.')).toHaveCount(0);
    getFails = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await check(page.getByText('The Paper catalog has not been synced yet.')).toBeVisible();
  });

  it('keeps all informational columns accessible in Italian on mobile', async () => {
    synced = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await open();
    await check(rows()).toHaveCount(25);
    await check(
      page.getByRole('columnheader', { name: 'Ultima build', exact: true }),
    ).toBeVisible();
    await check(page.getByRole('columnheader', { name: 'Java', exact: true })).toBeVisible();
    await check(page.getByText('Consigliata', { exact: true })).toBeVisible();
    await check(
      page.getByText(
        'Alla creazione del server viene selezionata automaticamente la build più recente.',
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${screenshots}/paper-catalog-mobile-it.png`, fullPage: true });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
});
