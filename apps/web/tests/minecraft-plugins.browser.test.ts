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
import type {
  MinecraftModMetadata,
  MinecraftModSelection,
  MinecraftModsSnapshot,
} from '../../../games/minecraft/src/mod-contracts.js';
import type {
  ContentCatalogProvider,
  ModCatalogProject,
  ModCatalogVersion,
} from '../../../packages/content-providers/src/mod-catalog.js';

const serverId = '10000000-0000-4000-8000-000000000001';
const base = `/v1/servers/${serverId}/minecraft/plugins`;
const providers: ContentCatalogProvider[] = ['modrinth', 'hangar', 'spiget', 'curseforge'];
const labels = {
  modrinth: 'Modrinth',
  hangar: 'Hangar',
  spiget: 'SpigotMC',
  curseforge: 'CurseForge',
};
function project(provider: ContentCatalogProvider): ModCatalogProject {
  return {
    provider,
    id: 'world-tools',
    name: 'World Tools',
    summary: 'Build, protect and manage your server worlds.',
    authors: ['Fixture team'],
    downloads: 123456,
    websiteUrl: 'https://example.test/world-tools',
    environment: { kind: 'server', source: provider, original: ['server'] },
    tags: [{ id: 'utility', label: 'Utility', source: provider, original: 'utility' }],
  };
}
function version(provider: ContentCatalogProvider, incompatible = false): ModCatalogVersion {
  return {
    provider,
    projectId: 'world-tools',
    id: incompatible ? 'old' : '2.0',
    version: incompatible ? '1.0' : '2.0',
    name: 'World Tools',
    filename: 'world-tools.jar',
    gameVersions: [incompatible ? '1.20.1' : '26.3'],
    loaders: ['paper'],
    publishedAt: '2026-10-20T12:00:00Z',
    bytes: 122880,
    channel: 'release',
    available: true,
    compatibility: incompatible ? ['minecraft-version'] : [],
    environment: project(provider).environment,
  };
}
function metadata(
  provider: ContentCatalogProvider,
  file = version(provider),
): MinecraftModMetadata {
  return {
    provider,
    projectId: 'world-tools',
    versionId: file.id,
    name: 'World Tools',
    version: file.version,
    channel: file.channel,
    side: 'server',
    tags: [{ id: 'utility', label: 'Utility' }],
    minecraftVersions: file.gameVersions,
    loaders: file.loaders,
  };
}
/** Real UI in Firefox; only the same-origin server transport is replaced by isolated fixtures. */
describe('Minecraft Plugins shared catalog experience', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let snapshot: MinecraftModsSnapshot;
  let requests: string[],
    errors: string[],
    writes: { path: string; body: Record<string, unknown> }[];
  let releaseToggle: (() => void) | undefined;
  let toggleWait: Promise<void> | undefined;
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/plugins-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [
        {
          name: 'plugins-browser-fixture',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              const url = new URL(req.url ?? '/', 'http://fixture');
              if (url.pathname === '/plugins-fixture') {
                res.setHeader('Content-Type', 'text/html');
                res.end(
                  '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plugins</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/minecraft-mods-page.tsx"></script></body></html>',
                );
                return;
              }
              if (!url.pathname.startsWith('/v1/')) return next();
              requests.push(`${req.method} ${url.pathname}${url.search}`);
              const json = (data: unknown, status = 200) => {
                res.statusCode = status;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(data));
              };
              let body: Record<string, unknown> = {};
              if (req.method !== 'GET') {
                let raw = '';
                for await (const chunk of req) raw += chunk;
                body = raw ? JSON.parse(raw) : {};
                writes.push({ path: url.pathname, body });
              }
              if (url.pathname === base) return json(snapshot);
              if (url.pathname === `${base}/catalog`)
                return json({
                  providers: [
                    ...providers.map((id) => ({ id, available: true })),
                    { id: 'voxel', available: false, comingSoon: true },
                    { id: 'builtbybit', available: false, comingSoon: true },
                  ],
                });
              if (url.pathname === `${base}/catalog/search`) {
                const provider = url.searchParams.get('provider') as ContentCatalogProvider;
                if (!providers.includes(provider)) {
                  errors.push(`Placeholder request ${provider}`);
                  return json({}, 400);
                }
                return json({ items: [project(provider)], offset: 0, limit: 20, total: 1 });
              }
              if (url.pathname.startsWith(`${base}/catalog/`)) {
                const provider = url.pathname
                  .slice(`${base}/catalog/`.length)
                  .split('/')[0] as ContentCatalogProvider;
                if (url.pathname.endsWith('/versions')) {
                  const items = [
                    version(provider),
                    ...(url.searchParams.get('includeIncompatible') === 'true'
                      ? [version(provider, true)]
                      : []),
                  ];
                  return json({
                    items,
                    offset: 0,
                    limit: 20,
                    total: items.length,
                    recommendedId: '2.0',
                  });
                }
                return json({
                  ...project(provider),
                  description:
                    '## World Tools\n\nTools for your Paper server.\n\n- Manage worlds\n- Protect builds\n\n[Documentation](https://example.test/docs)',
                  descriptionFormat: 'markdown',
                });
              }
              if (url.pathname === `${base}/selection`) {
                const selection = body as unknown as MinecraftModSelection;
                snapshot.roots = selection.roots;
                snapshot.preferBeta = selection.preferBeta;
                snapshot.revision++;
                snapshot.changes = selection.roots.map((root, index) => ({
                  id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                  action: 'install',
                  name: 'world-tools.jar',
                  path: 'plugins/world-tools.jar',
                  size: 122880,
                  metadata: metadata(
                    root.provider,
                    version(root.provider, root.versionId === 'old'),
                  ),
                  dependency: false,
                  requiredBy: [],
                  forceIncompatible: root.forceIncompatible,
                  incompatibilities: root.versionId === 'old' ? ['minecraft'] : [],
                  state: 'ready',
                }));
                return json({ revision: snapshot.revision });
              }
              if (url.pathname === `${base}/apply`) {
                snapshot.packs = snapshot.changes.map((item) => ({
                  id: item.id,
                  path: item.path,
                  name: item.name,
                  size: item.size,
                  metadata: item.metadata,
                  state: 'enabled',
                }));
                snapshot.changes = [];
                snapshot.roots = [];
                snapshot.revision++;
                snapshot.restart = { required: true };
                return json({ state: 'published', restartRequired: true });
              }
              if (url.pathname === `${base}/updates`)
                return json({
                  checkedAt: '2026-10-21T12:00:00Z',
                  items: snapshot.packs.map((item) => ({
                    path: item.path,
                    provider: item.metadata?.provider,
                    projectId: item.metadata?.projectId,
                    currentVersionId: item.metadata?.versionId,
                    status: 'current',
                  })),
                });
              if (url.pathname === `${base}/toggle`) {
                await toggleWait;
                const path = `${String(body.path).replace(/\.disabled$/, '')}${body.action === 'disable' ? '.disabled' : ''}`;
                snapshot.packs = snapshot.packs.map((item) =>
                  item.path === body.path
                    ? { ...item, path, state: body.action === 'disable' ? 'disabled' : 'enabled' }
                    : item,
                );
                snapshot.restart = { required: true };
                return json({ state: 'published', path, restartRequired: true });
              }
              errors.push(`Unexpected ${req.method} ${url.pathname}`);
              return json({ code: 'not_found' }, 404);
            });
          },
        },
      ],
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
    snapshot = {
      supported: true,
      installed: true,
      running: true,
      version: '26.3',
      loader: 'paper',
      revision: 0,
      preferBeta: false,
      roots: [],
      preparing: false,
      packs: [],
      changes: [],
      blockers: [],
      optional: [],
      restart: { required: false },
    };
    requests = [];
    errors = [];
    writes = [];
    toggleWait = undefined;
    releaseToggle = undefined;
    context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
    });
  });
  afterEach(async () => {
    releaseToggle?.();
    await context.close();
    expect(errors).toEqual([]);
    expect(requests.every((value) => !value.includes('/minecraft/mods'))).toBe(true);
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  async function open() {
    await page.goto(`${origin}plugins-fixture?plugins`);
    await check(
      page.getByRole('checkbox', { name: 'Select World Tools', exact: true }),
    ).toBeVisible();
  }
  async function chooseProvider(label: string) {
    await page.getByRole('combobox', { name: /Catalog|Catalogo/, exact: true }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
  }
  async function capture(name: string) {
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: `.codex/local/m5-browser/screenshots/${name}.png`,
      fullPage: true,
    });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  }
  it('offers all requested catalogs and keeps future providers quiet, on desktop and mobile', async () => {
    await open();
    await page.getByRole('combobox', { name: /Catalog|Catalogo/, exact: true }).click();
    await check(page.getByRole('option')).toHaveCount(6);
    await capture('minecraft-plugins-providers');
    await page.getByRole('option', { name: 'Voxel', exact: true }).click();
    await check(page.getByText('Coming soon', { exact: true })).toBeVisible();
    await capture('minecraft-plugins-coming-soon');
    const count = requests.length;
    await page.waitForTimeout(300);
    expect(requests.length).toBe(count);
    expect(writes).toHaveLength(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await chooseProvider('builtbybit');
    await check(page.getByText('Coming soon', { exact: true })).toBeVisible();
    await capture('minecraft-plugins-coming-soon-mobile');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (const provider of providers) {
      await chooseProvider(labels[provider]);
      await check(
        page.getByRole('checkbox', { name: 'Select World Tools', exact: true }),
      ).toBeVisible();
    }
    expect(requests.filter((value) => /provider=(?:voxel|builtbybit)/.test(value))).toEqual([]);
  });
  it('inspects, prepares, reviews and applies inline; installed toggles stay immediately responsive', async () => {
    await open();
    await chooseProvider('Hangar');
    await page.getByRole('button', { name: 'About World Tools', exact: true }).click();
    await check(page.locator('.mods-description')).toContainText('Manage worlds');
    await capture('minecraft-plugins-discover');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('minecraft-plugins-discover-mobile');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.setViewportSize({ width: 1360, height: 1000 });
    await page.getByRole('checkbox', { name: 'Select World Tools', exact: true }).first().check();
    await check(page.getByRole('button', { name: 'Install (1)', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Install (1)', exact: true }).click();
    await check(page.getByRole('heading', { name: 'Review changes1' })).toBeVisible();
    await check(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    await capture('minecraft-plugins-review');
    await page.getByRole('button', { name: 'Back to Discover', exact: true }).click();
    await check(page.getByRole('button', { name: 'Install (1)', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Install (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await check(
      page.getByRole('button', { name: 'Disable World Tools', exact: true }),
    ).toBeVisible();
    toggleWait = new Promise((resolve) => {
      releaseToggle = resolve;
    });
    await page.getByRole('button', { name: 'Disable World Tools', exact: true }).click();
    await check(page.locator('.mods-installed-row')).toHaveAttribute('data-disabled', 'true');
    expect(snapshot.packs[0]?.state).toBe('enabled');
    releaseToggle?.();
    await check(
      page.getByRole('button', { name: 'Enable World Tools', exact: true }),
    ).toBeEnabled();
    await check(page.getByText('Catalog plugins are up to date', { exact: true })).toBeVisible();
    await capture('minecraft-plugins-installed');
    expect(writes.map((value) => value.path)).toEqual([
      `${base}/selection`,
      `${base}/apply`,
      `${base}/toggle`,
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('minecraft-plugins-installed-mobile');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
  it('keeps explicit incompatible version consent and localizes plugin terminology', async () => {
    await open();
    await chooseProvider('SpigotMC');
    await page.getByRole('button', { name: 'About World Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Select version', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Show incompatible versions', exact: true }).check();
    await page.getByRole('button', { name: /1.0.*Different Minecraft version/ }).click();
    await check(page.getByRole('alert')).toContainText('load this plugin');
    expect(writes).toHaveLength(0);
    await page.getByRole('button', { name: 'Use anyway', exact: true }).click();
    await check(page.getByRole('button', { name: 'Install (1)', exact: true })).toBeVisible();
    expect(snapshot.roots[0]?.forceIncompatible).toBe(true);
    await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await page.reload();
    await check(page.getByRole('searchbox', { name: 'Cerca plugin', exact: true })).toBeVisible();
    await chooseProvider('Voxel');
    await check(page.getByText('In arrivo', { exact: true })).toBeVisible();
  });
});
