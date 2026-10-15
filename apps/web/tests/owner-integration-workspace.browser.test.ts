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

describe('Owner integration workspace (real components, isolated API responses)', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let reads: string[],
    writes: Array<{ path: string; body: Record<string, unknown> }>,
    errors: string[],
    syncCount: number;
  let finishScan: (() => void) | undefined;
  const mapping = {
    id: 'mapping-one',
    game_id: 'minecraft',
    runtime_id: 'vanilla',
    node_id: 'node-one',
    nest_id: 1,
    egg_id: 2,
    docker_image: '',
    image_mode: 'integration',
    startup: 'java -jar server.jar',
    environment: { VERSION: '26.1' },
    port_roles: [{ role: 'game', protocols: ['tcp'], primary: true }],
    feature_limits: { databases: 0, allocations: 1, backups: 1 },
    enabled: true,
    inUse: true,
  };
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/owner-workspace-vite`,
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
    await mkdir('.codex/local/m5-browser/screenshots', { recursive: true });
  });
  beforeEach(async () => {
    reads = [];
    writes = [];
    errors = [];
    syncCount = 0;
    finishScan = undefined;
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('nh.locale', 'en');
    });
    await page.route('**/owner/integrations**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Integration workspace</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/owner-integration-workspace.tsx"></script></body></html>',
      }),
    );
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname,
        method = route.request().method();
      if (method === 'GET') reads.push(path);
      else writes.push({ path, body: route.request().postDataJSON() ?? {} });
      const response = (json: unknown) => route.fulfill({ json });
      if (path === '/v1/owner/game-modules')
        return response([
          { id: 'minecraft', manifest: minecraftManifest },
          {
            id: 'fixture-game',
            manifest: {
              ...minecraftManifest,
              id: 'fixture-game',
              nameKey: 'web.integrations',
              capabilities: { ...minecraftManifest.capabilities, wake: 'unsupported' },
              connection: { mode: 'static-host-port' },
            },
          },
        ]);
      if (path === '/v1/platform/owner/games')
        return response([
          {
            id: 'minecraft',
            state: 'disabled-for-new-servers',
            allowlist: [],
            manifest: minecraftManifest,
          },
        ]);
      if (path === '/v1/owner/runtime-mappings') return response([mapping]);
      if (path === '/v1/owner/nodes') return response([{ id: 'node-one', pterodactyl_node_id: 7 }]);
      if (path === '/v1/owner/infrastructure')
        return response({
          nodes: [{ id: 7, name: 'Game node' }],
          nests: [{ id: 1, name: 'Minecraft' }],
        });
      if (path === '/v1/owner/nests/1/eggs')
        return response([
          {
            id: 2,
            name: 'Vanilla',
            docker_image: 'java:25',
            docker_images: { java25: 'java:25' },
            startup: 'java -jar server.jar',
          },
        ]);
      if (path === '/v1/owner/games') return response({});
      if (path === '/v1/owner/settings')
        return response({
          config: {
            values: { minecraftGatewayResponses: {}, minecraftProtocolSource: {} },
            lockedKeys: [],
          },
        });
      if (path.endsWith('/domain-policy'))
        return response({
          gameId: 'minecraft',
          policy: { selection: 'all', domainIds: [] },
          domains: [{ id: 'main', hostname: 'games.example.test', enabled: true }],
          inheritedDefaultDomainId: 'main',
          locked: false,
        });
      if (path.endsWith('/sleep-policy'))
        return response({
          gameId: 'minecraft',
          gameTimeoutSeconds: null,
          effectiveGameSeconds: 600,
          runtimeTimeouts: {},
          userAccess: null,
          runtimeUserAccess: {},
          effectiveUserAccess: 'hidden',
          inheritedGameSeconds: 600,
          inheritedUserAccess: 'hidden',
          runtimes: [{ id: 'vanilla', name: 'Vanilla' }],
          locked: false,
        });
      if (path.endsWith('/compatibility'))
        return response({
          items: [],
          total: 0,
          page: 1,
          pageSize: 25,
          runtimes: ['vanilla'],
          metadataStatus: { lastSuccessAt: '2026-10-16T00:00:00Z', stale: false },
        });
      if (path.endsWith('/catalog/sync')) {
        syncCount++;
        if (syncCount === 1) {
          await new Promise<void>((resolve) => {
            finishScan = resolve;
          });
          return response({
            items: [{ version: '26.1', releaseType: 'release', status: 'registered' }],
            nextCursor: 1,
            total: 2,
          });
        }
        return response({
          items: [{ version: '26.2', releaseType: 'release', status: 'registered' }],
          nextCursor: null,
          total: 2,
        });
      }
      errors.push(`Unexpected API ${method} ${path}`);
      return route.fulfill({ status: 404, json: { code: 'not_found' } });
    });
  });
  afterEach(async () => {
    finishScan?.();
    await context.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  it('keeps the index compact and generic setup available even without a bespoke game renderer', async () => {
    await page.goto(`${origin}owner/integrations`);
    await check(page.getByRole('link', { name: /Minecraft/ })).toBeVisible();
    await check(page.getByLabel('Availability', { exact: true })).toHaveCount(0);
    expect(reads).not.toContain('/v1/owner/runtime-mappings');
    await page.getByRole('link', { name: /Minecraft/ }).click();
    await check(page.getByRole('heading', { name: 'Minecraft', exact: true })).toBeVisible();
    await check(page.getByLabel('Availability', { exact: true })).toHaveValue(
      'disabled-for-new-servers',
    );
    expect(
      reads.some((path) => path.includes('/compatibility') || path.includes('/sleep-policy')),
    ).toBe(false);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/integration-general-desktop-en.png',
      fullPage: true,
    });
    await page.goto(`${origin}owner/integrations/fixture-game`);
    await check(
      page.getByRole('navigation').getByRole('link', { name: 'General', exact: true }),
    ).toBeVisible();
    await check(
      page.getByRole('navigation').getByRole('link', { name: 'Versions', exact: true }),
    ).toHaveCount(0);
    await check(
      page.getByRole('navigation').getByRole('link', { name: 'Sleep/Wake', exact: true }),
    ).toHaveCount(0);
  });
  it('uses the sole runtime editor and preserves immutable used mapping fields', async () => {
    await page.goto(`${origin}owner/integrations/minecraft/runtime`);
    await check(page.getByRole('rowheader', { name: 'Game node', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await check(dialog.getByLabel('Runtime', { exact: true })).toBeDisabled();
    await check(dialog.getByLabel('Enabled', { exact: true })).toBeEnabled();
    await dialog.getByLabel('Enabled', { exact: true }).uncheck();
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check(dialog).not.toBeVisible();
    const sent = writes.find((item) => item.path.endsWith('/runtime-mappings'))?.body;
    expect(sent).toMatchObject({
      id: mapping.id,
      gameId: 'minecraft',
      nodeId: 'node-one',
      enabled: false,
      startup: mapping.startup,
      environment: mapping.environment,
      portRoles: mapping.port_roles,
    });
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/integration-runtime-desktop-en.png',
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
  it('keeps a running scan and catalog filters across tabs without fetching heavy pages twice', async () => {
    await page.goto(`${origin}owner/integrations/minecraft/versions?catalogSearch=26.1`);
    await check(page.getByRole('searchbox')).toHaveValue('26.1');
    await page.getByRole('button', { name: 'Discover Vanilla versions', exact: true }).click();
    await check.poll(() => syncCount).toBe(1);
    await page.getByRole('navigation').getByRole('link', { name: 'General', exact: true }).click();
    finishScan?.();
    await check.poll(() => syncCount).toBe(2);
    await page.getByRole('navigation').getByRole('link', { name: 'Versions', exact: true }).click();
    await check(page.getByRole('searchbox')).toHaveValue('26.1');
    await check(page.getByText('26.2:', { exact: false })).toBeVisible();
    expect(reads.filter((path) => path === '/v1/owner/runtime-mappings')).toHaveLength(1);
  });
  it('preserves rapid keyboard clears and independent filter changes', async () => {
    await page.goto(`${origin}owner/integrations/minecraft/versions`);
    const search = page.getByRole('searchbox');
    await check(search).toBeVisible();
    await search.pressSequentially('26.1', { delay: 0 });
    await search.press('ControlOrMeta+A');
    await search.press('Backspace');
    await page.getByLabel('Version type', { exact: true }).selectOption('release');
    await page.getByLabel('Version type', { exact: true }).selectOption('');
    await page.getByLabel('Sort by', { exact: true }).selectOption('oldest');
    await check.poll(() => new URL(page.url()).searchParams.get('catalogOrder')).toBe('oldest');
    expect(new URL(page.url()).searchParams.get('catalogSearch')).toBe('');
    expect(new URL(page.url()).searchParams.get('catalog-releaseType')).toBe('');
    await check(search).toHaveValue('');
    await check(page.getByLabel('Version type', { exact: true })).toHaveValue('');
  });
  it('renders compact mobile Italian sections without horizontal page overflow', async () => {
    await page.addInitScript(() => {
      localStorage.setItem('nh.locale', 'it');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}owner/integrations/minecraft/sleep`);
    await check(page.getByRole('heading', { name: 'Minecraft', exact: true })).toBeVisible();
    await check(page.getByTestId('sleep-settings-minecraft')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/integration-sleep-mobile-it.png',
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
});
