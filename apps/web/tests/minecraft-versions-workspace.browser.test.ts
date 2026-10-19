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

const mappingId = '00000000-0000-4000-8000-000000000001';
const otherMappingId = '00000000-0000-4000-8000-000000000002';
const makeChoice = (n: number, release = '26.1', enabled = true) => ({
  id: `00000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`,
  mappingId,
  enabled,
  mappingEnabled: true,
  support: 'unverified',
  supportAuthority: 'integration',
  image: 'registry.example.test/java:25',
  creation: {
    state: enabled ? 'available' : 'blocked',
    reason: enabled ? null : 'choice-disabled',
  },
  releaseTime: '2026-03-24T12:00:00Z',
  releaseTimeStatus: 'available',
  combination: {
    release,
    releaseType: 'release',
    profile: 'vanilla',
    javaMajor: 25,
    protocolId: 775,
    family: 'netty',
    buildId: String(n),
  },
  capabilities: {
    installation: true,
    directConnection: true,
    gateway: true,
    readiness: true,
    playerIdle: true,
    sleepWake: true,
    playerManagement: true,
  },
  evidence: [],
});

describe('Minecraft Versions workspace (real Firefox, isolated responses)', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let choices: ReturnType<typeof makeChoice>[],
    reads: URL[],
    writes: Array<{ path: string; body: Record<string, unknown> }>,
    errors: string[];
  let multipleMappings: boolean, bulkFails: boolean;
  let fabricSynced: boolean, fabricSyncFails: boolean, fabricQueued: boolean;
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/minecraft-versions-vite`,
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
    choices = [
      makeChoice(1),
      makeChoice(2, '1.21.11', false),
      makeChoice(3, '1.5.2'),
      makeChoice(4, '1.5.2'),
    ];
    reads = [];
    writes = [];
    errors = [];
    multipleMappings = false;
    bulkFails = false;
    fabricQueued = false;
    fabricSynced = false;
    fabricSyncFails = false;
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
    });
    await page.route('**/owner/integrations**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Versions</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/owner-integration-workspace.tsx"></script></body></html>',
      }),
    );
    await page.route('**/v1/**', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname,
        method = route.request().method();
      const response = (json: unknown) => route.fulfill({ json });
      if (method === 'GET') reads.push(url);
      else writes.push({ path, body: route.request().postDataJSON() ?? {} });
      if (path === '/v1/owner/minecraft/fabric/catalog') {
        if (method === 'POST') fabricQueued = true;
        if (method === 'GET' && fabricQueued) {
          fabricQueued = false;
          if (!fabricSyncFails) fabricSynced = true;
        }
        const list = (prefix: string) =>
          fabricSynced
            ? Array.from({ length: 130 }, (_, i) => ({
                version: `${prefix}${130 - i}`,
                stable: i % 3 !== 1,
              }))
            : [];
        return response({
          games: list('1.21.'),
          loaders: list('0.19.'),
          installers: fabricSynced
            ? [
                { version: '1.1.2', stable: false },
                { version: '1.1.1', stable: true },
              ]
            : [],
          latestInstallerVersion: fabricSynced ? '1.1.2' : null,
          synced: fabricSynced,
          relations: fabricSynced
            ? {
                checkedAt: '2026-10-19T10:00:00Z',
                loaderSets: [list('0.19.').map((item) => item.version), ['0.19.128']],
                gameLoaderSets: Object.fromEntries(
                  list('1.21.').map((item) => [item.version, item.version === '1.21.130' ? 1 : 0]),
                ),
              }
            : undefined,
          status: {
            syncState: fabricQueued ? 'queued' : 'idle',
            lastCheckedAt: fabricSynced ? '2026-10-19T10:00:00Z' : null,
            lastSuccessAt: fabricSynced ? '2026-10-19T10:00:00Z' : null,
            nextCheckAt: null,
            stale: fabricSyncFails || !fabricSynced,
            lastError: fabricSyncFails ? 'fabric_metadata_refresh_failed' : null,
          },
        });
      }
      if (path === '/v1/owner/game-modules')
        return response([{ id: 'minecraft', manifest: minecraftManifest }]);
      if (path === '/v1/platform/owner/games')
        return response([
          { id: 'minecraft', state: 'public', allowlist: [], manifest: minecraftManifest },
        ]);
      if (path === '/v1/owner/runtime-mappings') {
        const mapping = {
          id: mappingId,
          game_id: 'minecraft',
          runtime_id: 'vanilla',
          node_id: 'node-one',
          nest_id: 1,
          egg_id: 2,
          docker_image: '',
          image_mode: 'integration',
          environment: {},
          enabled: true,
        };
        return response(
          multipleMappings ? [mapping, { ...mapping, id: otherMappingId, egg_id: 3 }] : [mapping],
        );
      }
      if (path === '/v1/owner/nodes') return response([{ id: 'node-one', pterodactyl_node_id: 7 }]);
      if (path === '/v1/owner/infrastructure')
        return response({
          nodes: [{ id: 7, name: 'Game node' }],
          nests: [{ id: 1, name: 'Minecraft' }],
        });
      if (path === '/v1/owner/nests/1/eggs')
        return response([
          { id: 2, name: 'Vanilla server' },
          { id: 3, name: 'Alternative server' },
        ]);
      if (path === '/v1/owner/settings')
        return response({ config: { values: { minecraftProtocolSource: {} }, lockedKeys: [] } });
      if (path === '/v1/owner/minecraft/compatibility/availability') {
        if (bulkFails)
          return route.fulfill({
            status: 409,
            json: { code: 'conflict', messageKey: 'errors.conflict' },
          });
        const body = route.request().postDataJSON() as { ids: string[]; enabled: boolean };
        choices = choices.map((c) =>
          body.ids.includes(c.id)
            ? {
                ...c,
                enabled: body.enabled,
                creation: {
                  state: body.enabled ? 'available' : 'blocked',
                  reason: body.enabled ? null : 'choice-disabled',
                },
              }
            : c,
        );
        return route.fulfill({ status: 204 });
      }
      if (path === '/v1/owner/minecraft/compatibility') {
        const params = url.searchParams;
        let filtered = choices.filter(
          (c) =>
            (!params.get('release') || c.combination.release === params.get('release')) &&
            (!params.get('search') || c.combination.release.includes(params.get('search') ?? '')) &&
            (!params.get('availability') ||
              c.enabled === (params.get('availability') === 'enabled')),
        );
        if (params.get('mappingId') === otherMappingId) filtered = [];
        const groups = [...new Set(filtered.map((c) => c.combination.release))].map((release) => {
          const variants = filtered.filter((c) => c.combination.release === release),
            first = variants[0];
          return {
            release,
            releaseType: 'release',
            releaseTime: first?.releaseTime,
            releaseTimeStatus: 'available',
            variantCount: variants.length,
            ...(variants.length === 1 ? { choice: first } : {}),
          };
        });
        const items = params.get('view') === 'workspace' ? groups : filtered;
        return response({
          items,
          total: items.length,
          page: 1,
          pageSize: 25,
          runtimes: ['vanilla'],
          metadataStatus: { lastSuccessAt: '2026-10-16T00:00:00Z', stale: false },
        });
      }
      const availabilityId = /^\/v1\/owner\/minecraft\/compatibility\/([^/]+)\/availability$/.exec(
        path,
      )?.[1];
      if (availabilityId) {
        const enabled = route.request().postDataJSON().enabled as boolean;
        choices = choices.map((c) =>
          c.id === availabilityId
            ? {
                ...c,
                enabled,
                creation: {
                  state: enabled ? 'available' : 'blocked',
                  reason: enabled ? null : 'choice-disabled',
                },
              }
            : c,
        );
        return route.fulfill({ status: 204 });
      }
      const id = /^\/v1\/owner\/minecraft\/compatibility\/([^/]+)$/.exec(path)?.[1];
      if (id) return response(choices.find((c) => c.id === id));
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
  it('discovers Fabric catalogs without a mapping or registering combinations, with local filtering and pagination', async () => {
    await page.goto(`${origin}owner/integrations/minecraft/versions?runtime=fabric`);
    await check(page.getByText('The Fabric catalog has not been synced yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Sync versions', exact: true }).click();
    await check(page.locator('.fabric-catalog-table tbody tr')).toHaveCount(25);
    const height = await page.locator('.fabric-catalog-table').evaluate((el) => el.clientHeight);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await check(page.locator('.fabric-catalog-table tbody tr')).toHaveCount(25);
    await page.getByLabel('Version type', { exact: true }).selectOption('all');
    await check(page.getByText('130 versions', { exact: true })).toBeVisible();
    await page.getByLabel('Version type', { exact: true }).selectOption('release');
    await check(page.getByText('87 versions', { exact: true })).toBeVisible();
    await page.getByRole('searchbox').fill('1.21.130');
    await check(page.locator('.fabric-catalog-table tbody tr')).toHaveCount(1);
    await page.getByRole('button', { name: 'Loader', exact: true }).click();
    await check(
      page.locator('.fabric-catalog-table').getByText('0.19.130', { exact: true }),
    ).toBeVisible();
    await check(page.getByRole('searchbox')).toHaveValue('');
    await page.getByRole('button', { name: 'Installer', exact: true }).click();
    await check(
      page.locator('.fabric-catalog-table tbody tr').filter({ hasText: '1.1.2' }),
    ).toBeVisible();
    await check(page.locator('.fabric-latest')).toHaveText('Latest');
    expect(await page.locator('.fabric-catalog-table').evaluate((el) => el.clientHeight)).toBe(
      height,
    );
    expect(reads.filter((u) => u.pathname.endsWith('/fabric/catalog'))).toHaveLength(2);
    expect(reads.some((u) => u.pathname.includes('/compatibility'))).toBe(false);
    expect(writes.map((w) => w.path)).toEqual(['/v1/owner/minecraft/fabric/catalog']);
    await axe();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/fabric-discovery-desktop-en.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Vanilla', exact: true }).click();
    await check(page.getByRole('button', { name: 'Sync versions', exact: true })).toBeVisible();
  });
  it('filters compatible Loaders from the saved associations without more requests', async () => {
    fabricSynced = true;
    await page.goto(`${origin}owner/integrations/minecraft/versions?runtime=fabric`);
    await page.getByRole('button', { name: 'Loaders for 1.21.130', exact: true }).click();
    await check(page.getByLabel('Minecraft version', { exact: true })).toHaveValue('1.21.130');
    await check(page.getByLabel('Minecraft version', { exact: true })).toBeFocused();
    await check(page.locator('.fabric-catalog-table tbody tr')).toHaveCount(1);
    await check(page.locator('.fabric-catalog-table tbody tr')).toContainText('0.19.128');
    await page.getByLabel('Minecraft version', { exact: true }).selectOption('1.21.129');
    await check(page.locator('.fabric-catalog-table tbody tr')).toHaveCount(25);
    expect(reads.filter((u) => u.pathname.endsWith('/fabric/catalog'))).toHaveLength(1);
    expect(writes).toHaveLength(0);
    await axe();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/fabric-associations-desktop-en.png',
      fullPage: true,
    });
  });
  it('keeps the global Loader list usable when a bookmarked game has left the catalog', async () => {
    fabricSynced = true;
    await page.goto(
      `${origin}owner/integrations/minecraft/versions?runtime=fabric&fabricKind=loaders&fabricGame=removed`,
    );
    await check(page.getByLabel('Minecraft version', { exact: true })).toHaveValue('');
    await check(page.locator('.fabric-catalog-table tbody tr')).toHaveCount(25);
    await check(page.locator('.fabric-catalog-table tbody tr').first()).toContainText('0.19.130');
  });
  it('keeps the last catalog visible after a failed refresh and exposes registered Fabric view', async () => {
    fabricSynced = true;
    await page.goto(`${origin}owner/integrations/minecraft/versions?runtime=fabric`);
    await check(page.locator('.fabric-catalog-table tbody tr')).toHaveCount(25);
    fabricSyncFails = true;
    await page.getByRole('button', { name: 'Sync versions', exact: true }).click();
    await check(
      page.getByText('Sync failed. The last saved catalog is shown, if available.'),
    ).toBeVisible();
    expect(
      await page
        .getByText('Sync failed. The last saved catalog is shown, if available.')
        .evaluate((el) => el.clientHeight),
    ).toBeLessThan(80);
    await check(page.locator('.fabric-catalog-table tbody tr')).toHaveCount(25);
    await page.getByRole('button', { name: 'Registered combinations', exact: true }).click();
    await check(page.locator('.fabric-version-catalog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Loader', exact: true }).click();
    await check(page.locator('.fabric-catalog-table tbody tr').first()).toContainText('0.19.130');
    await page.reload();
    await check(page.getByRole('button', { name: 'Loader', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await check(page.locator('.fabric-catalog-table tbody tr').first()).toContainText('0.19.130');
  });
  it('renders Italian Fabric discovery on mobile with bounded rows and keyboard controls', async () => {
    fabricSynced = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await page.goto(`${origin}owner/integrations/minecraft/versions?runtime=fabric`);
    await check(page.getByRole('searchbox', { name: 'Cerca versioni' })).toBeVisible();
    const loaders = page.getByRole('button', { name: 'Loader', exact: true });
    await loaders.focus();
    await page.keyboard.press('Enter');
    await check(loaders).toHaveAttribute('aria-pressed', 'true');
    await check(page.locator('.fabric-catalog-table tbody tr')).toHaveCount(25);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await axe();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/fabric-discovery-mobile-it.png',
      fullPage: true,
    });
  });
  async function open() {
    await page.goto(`${origin}owner/integrations/minecraft/versions`);
    await check(page.getByRole('searchbox')).toBeVisible();
  }
  async function axe() {
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  }
  it('uses mapping context, loads variants only on expansion and keeps capability evidence separate', async () => {
    await open();
    await check(page.getByText('Game node · Vanilla server', { exact: true })).toBeVisible();
    await check(page.getByRole('combobox', { name: 'Runtime mapping', exact: true })).toHaveCount(
      0,
    );
    const table = page.locator('.minecraft-versions-table');
    await check(table.locator('tr[data-release]')).toHaveCount(3);
    expect(reads.filter((u) => u.searchParams.get('view') === 'summary')).toHaveLength(0);
    const grouped = table.locator('tr[data-release="1.5.2"]');
    await check(grouped.getByRole('checkbox')).toHaveCount(0);
    await grouped.getByRole('button').click();
    await check(table.locator('.minecraft-variant-row')).toHaveCount(2);
    expect(reads.filter((u) => u.searchParams.get('view') === 'summary')).toHaveLength(1);
    expect(
      reads.find((u) => u.searchParams.get('view') === 'summary')?.searchParams.get('mappingId'),
    ).toBe(mappingId);
    await table.locator('tr[data-release="26.1"]').getByRole('button').click();
    const drawer = page.getByRole('dialog', { name: '26.1', exact: true });
    await check(drawer).toBeVisible();
    await check(drawer.getByText('registry.example.test/java:25', { exact: true })).toBeVisible();
    await check(drawer.getByText('Automatic sleep/wake', { exact: true })).toBeVisible();
    await check(
      drawer.getByRole('textbox', { name: 'Signed verification report', exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/versions-detail-desktop-en.png',
      fullPage: true,
    });
    await axe();
    await page.keyboard.press('Escape');
    await check(drawer).not.toBeVisible();
    await check(table.locator('tr[data-release="26.1"]').getByRole('button')).toBeFocused();
  });
  it('sends one scoped bulk request and retains concrete selection on failure', async () => {
    await open();
    await page.getByRole('checkbox', { name: 'Select 26.1', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select 1.21.11', exact: true }).check();
    bulkFails = true;
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await check.poll(() => writes.length).toBe(1);
    await check(page.getByRole('checkbox', { name: 'Select 26.1', exact: true })).toBeChecked();
    await check(page.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
    bulkFails = false;
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await check(page.getByRole('region', { name: 'Selected versions', exact: true })).toHaveCount(
      0,
    );
    expect(writes).toEqual(
      [0, 1].map(() => ({
        path: '/v1/owner/minecraft/compatibility/availability',
        body: { mappingId, ids: [choices[0]?.id, choices[1]?.id], enabled: true },
      })),
    );
    await check(page.locator('tr[data-release="1.21.11"]')).toContainText('Available');
  });
  it('uses bounded selection for loaded variants and clears it when mapping changes', async () => {
    multipleMappings = true;
    await open();
    const selector = page.locator('.minecraft-versions-mapping select');
    await check(selector.locator('option')).toHaveCount(2);
    await page.locator('tr[data-release="1.5.2"]').getByRole('button').click();
    await check(page.locator('.minecraft-variant-row')).toHaveCount(2);
    await page.getByRole('checkbox', { name: 'Select visible versions', exact: true }).check();
    await page.getByRole('button', { name: 'Disable', exact: true }).click();
    await check.poll(() => writes.length).toBe(1);
    expect(writes[0]?.body.ids).toEqual(choices.map((c) => c.id));
    await check(page.getByRole('region', { name: 'Selected versions', exact: true })).toHaveCount(
      0,
    );
    await page.getByRole('checkbox', { name: 'Select 26.1', exact: true }).check();
    await selector.selectOption(otherMappingId);
    await check(page.getByRole('region', { name: 'Selected versions', exact: true })).toHaveCount(
      0,
    );
    await check(page.locator('tr[data-release]')).toHaveCount(0);
  });
  it('keeps technical settings on demand and renders a compact Italian mobile catalog', async () => {
    await open();
    expect(reads.filter((u) => u.pathname === '/v1/owner/settings')).toHaveLength(0);
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await page.getByRole('button', { name: 'Protocol metadata source', exact: true }).click();
    await check(page.getByRole('dialog').getByRole('textbox')).toHaveCount(2);
    expect(reads.filter((u) => u.pathname === '/v1/owner/settings')).toHaveLength(1);
    await page.keyboard.press('Escape');
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/versions-catalog-desktop-en.png',
      fullPage: true,
    });
    await axe();
    await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await check(page.getByRole('searchbox', { name: 'Cerca versioni', exact: true })).toBeVisible();
    await check(page.locator('tr[data-release]')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByLabel('Ordina per', { exact: true }).selectOption('oldest');
    await check
      .poll(() => reads.filter((u) => u.searchParams.get('order') === 'oldest').length)
      .toBeGreaterThan(0);
    await check(page.locator('tr[data-release="26.1"] .version-catalog-mobile-date')).toBeVisible();
    await check(page.locator('tr[data-release="26.1"] .minecraft-creation-state')).toBeInViewport();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/versions-catalog-mobile-it.png',
      fullPage: true,
    });
    await axe();
    await page.locator('tr[data-release="26.1"]').getByRole('button').click();
    await check(page.getByRole('dialog')).toBeVisible();
    expect(await page.getByRole('dialog').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/versions-detail-mobile-it.png',
      fullPage: true,
    });
    await axe();
  });
  it('resumes an interrupted scan from the last acknowledged batch without reenabling choices', async () => {
    const batches: Record<string, unknown>[] = [];
    let fail = true;
    await page.route('**/v1/owner/minecraft/catalog/sync', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      batches.push(body);
      if (body.cursor === 1 && fail) {
        fail = false;
        await route.fulfill({ status: 503, json: { code: 'integration_unavailable' } });
        return;
      }
      await route.fulfill({
        json: {
          items: [
            {
              version: body.cursor === 1 ? '26.2' : '26.1',
              releaseType: 'release',
              status: 'registered',
            },
          ],
          total: 2,
          nextCursor: body.cursor === 1 ? null : 1,
        },
      });
    });
    await open();
    await page.getByRole('button', { name: 'Sync versions', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Sync versions', exact: true })
      .click();
    await check(page.getByRole('button', { name: 'Resume discovery', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resume discovery', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Resume discovery', exact: true })
      .click();
    await check.poll(() => batches.length).toBe(3);
    expect(batches.map((b) => b.cursor)).toEqual([0, 1, 1]);
    expect(batches.every((b) => b.mappingId === mappingId && b.enableSupported === false)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'View scan log', exact: true }).click();
    await check(page.getByRole('log')).toContainText('26.1');
    await check(page.getByRole('log')).toContainText('26.2');
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/versions-scan-desktop-en.png',
      fullPage: true,
    });
    await axe();
  });

  it('restores search focus when disabling a filtered version removes its original row', async () => {
    await open();
    await page.getByLabel('Availability', { exact: true }).selectOption('enabled');
    await page.locator('tr[data-release="26.1"]').getByRole('button').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disable', exact: true }).click();
    await check(
      page.getByRole('dialog').getByRole('button', { name: 'Enable', exact: true }),
    ).toBeEnabled();
    await check(page.locator('tr[data-release="26.1"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await check(page.getByRole('searchbox')).toBeFocused();
  });
});
