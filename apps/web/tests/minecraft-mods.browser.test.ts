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
  ModCatalogProject,
  ModCatalogVersion,
} from '../../../packages/content-providers/src/mod-catalog.js';
import { en, it as italian } from '../../../packages/i18n/src/catalogs.js';

const serverId = '10000000-0000-4000-8000-000000000001';
const base = `/v1/servers/${serverId}/minecraft/mods`;
const project = (
  id: string,
  name: string,
  side: 'server' | 'client' | 'both' = 'both',
): ModCatalogProject => ({
  provider: 'modrinth',
  id,
  name,
  summary: `Explore ${name}: tools for your Minecraft world.`,
  websiteUrl: `https://modrinth.com/mod/${id}`,
  authors: ['Fixture authors'],
  downloads: 12453,
  tags: [{ id: 'utility', label: 'Utility', source: 'modrinth', original: 'utility' }],
  environment: { kind: side, source: 'modrinth', original: [side] },
});
const catalog = [
  project('evergreen', 'Evergreen'),
  project('copper', 'Copper Toolkit'),
  project('overlay', 'Map Overlay', 'client'),
];
const file = (
  item: ModCatalogProject,
  version: string,
  channel: ModCatalogVersion['channel'] = 'release',
  incompatible = false,
): ModCatalogVersion => ({
  provider: item.provider,
  id: `${item.id}-${version}`,
  projectId: item.id,
  name: `${item.name} ${version}`,
  version,
  filename: `${item.id}-${version}.jar`,
  gameVersions: [incompatible ? '1.20.1' : '26.1'],
  loaders: ['fabric'],
  publishedAt: '2026-10-20T12:00:00Z',
  bytes: 1048576,
  channel,
  available: true,
  compatibility: incompatible
    ? ['minecraft-version']
    : item.environment.kind === 'client'
      ? ['client-only']
      : [],
  environment: item.environment,
});
function metadata(item: ModCatalogProject, version: ModCatalogVersion): MinecraftModMetadata {
  return {
    provider: item.provider,
    projectId: item.id,
    versionId: version.id,
    name: item.name,
    version: version.version,
    channel: version.channel,
    side: item.environment.kind,
    tags: item.tags.map(({ id, label }) => ({ id, label })),
    minecraftVersions: version.gameVersions,
    loaders: version.loaders,
  };
}

/** Actual Mods UI in Firefox; catalog/staging endpoints are deterministic isolated transport fixtures. */
describe('Minecraft Mods discovery, durable preparation and inline review', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let snapshot: MinecraftModsSnapshot;
  let writes: { path: string; method: string; body: Record<string, unknown> }[];
  let errors: string[];
  let failSelection = false;
  let delaySelection: Promise<void> | undefined;
  let delaySnapshot: Promise<void> | undefined;
  let releaseSnapshot: (() => void) | undefined;
  let snapshotReads = 0;
  let failedProvider = false;
  let completed = true;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const generated = () =>
    `20000000-0000-4000-8000-${String(snapshot.changes.length + 1).padStart(12, '0')}`;
  function select(input: MinecraftModSelection) {
    snapshot.revision++;
    snapshot.roots = input.roots;
    snapshot.preferBeta = input.preferBeta;
    snapshot.preparing = !completed;
    snapshot.blockers = [];
    snapshot.changes = snapshot.changes.filter((change) => change.action !== 'install');
    for (const root of input.roots) {
      const item = {
        ...(catalog.find((item) => item.id === root.projectId) ??
          project(root.projectId, root.projectId)),
        provider: root.provider,
      };
      const version = root.versionId?.endsWith('-old')
        ? file(item, 'old', 'release', true)
        : item.id === 'copper' ||
            root.versionId?.endsWith('-beta') ||
            (!root.versionId && input.preferBeta)
          ? file(item, 'beta', 'beta')
          : file(item, '1.0');
      if (version.compatibility.length && !root.forceIncompatible) {
        snapshot.blockers.push({
          projectId: item.id,
          name: item.name,
          reason: 'incompatible-version',
        });
        continue;
      }
      if (
        snapshot.packs.some(
          (pack) =>
            pack.metadata?.provider === item.provider &&
            pack.metadata.projectId === item.id &&
            pack.metadata.versionId === version.id,
        )
      )
        continue;
      snapshot.changes.push({
        id: generated(),
        name: item.name,
        action: 'install',
        path: `mods/${version.filename}`,
        size: version.bytes,
        metadata: metadata(item, version),
        dependency: false,
        requiredBy: [],
        forceIncompatible: root.forceIncompatible,
        incompatibilities: version.compatibility.map((reason) =>
          reason === 'minecraft-version'
            ? 'minecraft'
            : reason === 'loader'
              ? 'loader'
              : 'client-only',
        ),
        state: completed ? 'ready' : 'preparing',
      });
      if (item.id === 'copper') {
        const dependency = project('copper-api', 'Copper API', 'server');
        snapshot.changes.push({
          id: generated(),
          name: 'Copper API',
          action: 'install',
          path: 'mods/copper-api.jar',
          size: 32768,
          metadata: metadata(dependency, file(dependency, '2.0')),
          dependency: true,
          requiredBy: ['copper'],
          forceIncompatible: false,
          incompatibilities: [],
          state: completed ? 'ready' : 'preparing',
        });
      }
    }
    snapshot.optional = input.roots.some((root) => root.projectId === 'copper')
      ? [{ provider: 'modrinth', projectId: 'compass', name: 'Compass', requiredBy: ['copper'] }]
      : [];
  }
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/mods-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [
        {
          name: 'mods-browser-fixture',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              const url = new URL(req.url ?? '/', 'http://fixture');
              if (url.pathname === '/mods-fixture') {
                res.setHeader('Content-Type', 'text/html');
                res.end(
                  '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mods</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/minecraft-mods-page.tsx"></script></body></html>',
                );
                return;
              }
              if (!url.pathname.startsWith('/v1/')) return next();
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
                writes.push({ path: url.pathname, method: req.method ?? '', body });
              }
              if (url.pathname === base) {
                snapshotReads++;
                await delaySnapshot;
                return json(snapshot);
              }
              if (url.pathname === `${base}/catalog`)
                return json({
                  providers: [
                    { id: 'modrinth', available: true },
                    { id: 'curseforge', available: true },
                  ],
                });
              if (url.pathname === `${base}/catalog/search`) {
                if (failedProvider)
                  return json(
                    { code: 'integration_unavailable', messageKey: 'web.errors.request' },
                    503,
                  );
                const provider = url.searchParams.get('provider') as 'modrinth' | 'curseforge';
                const items = catalog
                  .filter((item) =>
                    item.name
                      .toLowerCase()
                      .includes((url.searchParams.get('query') ?? '').toLowerCase()),
                  )
                  .map((item) => ({ ...item, provider }));
                return json({ items, offset: 0, limit: 20, total: items.length });
              }
              if (url.pathname === `${base}/selection`) {
                await delaySelection;
                if (failSelection) {
                  failSelection = false;
                  return json({ code: 'internal_error', messageKey: 'web.errors.request' }, 503);
                }
                select(body as unknown as MinecraftModSelection);
                return json({ revision: snapshot.revision });
              }
              if (url.pathname === `${base}/apply`) {
                for (const change of snapshot.changes) {
                  if (change.action === 'install')
                    snapshot.packs.push({
                      id: change.id,
                      path: change.path,
                      name: change.name,
                      size: change.size,
                      state: 'enabled',
                      metadata: change.metadata,
                    });
                  else if (change.action === 'delete')
                    snapshot.packs = snapshot.packs.filter((pack) => pack.path !== change.path);
                  else
                    snapshot.packs = snapshot.packs.map((pack) =>
                      pack.path === change.path
                        ? { ...pack, state: change.action === 'enable' ? 'enabled' : 'disabled' }
                        : pack,
                    );
                }
                snapshot.roots = [];
                snapshot.changes = [];
                snapshot.optional = [];
                snapshot.revision++;
                snapshot.restart = { required: true };
                return json({ state: 'published', restartRequired: true });
              }
              if (url.pathname === `${base}/changes`) {
                const pack = snapshot.packs.find((item) => item.path === body.path);
                if (!pack) return json({ code: 'not_found' }, 404);
                snapshot.changes.push({
                  ...pack,
                  id: generated(),
                  action: body.action as 'disable',
                  state: 'ready',
                  dependency: false,
                  requiredBy: [],
                  forceIncompatible: false,
                  incompatibilities: [],
                });
                snapshot.revision++;
                return json({ id: snapshot.changes.at(-1)?.id });
              }
              if (url.pathname.startsWith(`${base}/changes/`)) {
                snapshot.changes = snapshot.changes.filter(
                  (change) => change.id !== url.pathname.split('/').at(-1),
                );
                snapshot.revision++;
                return json({ state: 'discarded' });
              }
              if (url.pathname.startsWith(`${base}/catalog/`)) {
                const [, providerId, projectId, suffix] = url.pathname
                  .slice(base.length)
                  .split('/')
                  .slice(1);
                const item = {
                  ...(catalog.find((item) => item.id === projectId) ??
                    project(projectId ?? '', projectId ?? '')),
                  provider: providerId as 'modrinth' | 'curseforge',
                };
                if (suffix === 'versions') {
                  const all = url.searchParams.get('includeIncompatible') === 'true';
                  const versions =
                    item.id === 'copper'
                      ? [file(item, 'beta', 'beta')]
                      : [
                          file(item, '1.0'),
                          file(item, 'beta', 'beta'),
                          ...(all ? [file(item, 'old', 'release', true)] : []),
                        ];
                  const items = all
                    ? versions
                    : versions.filter((version) => !version.compatibility.length);
                  return json({
                    items,
                    offset: 0,
                    limit: 20,
                    total: items.length,
                    recommendedId: items[0]?.id,
                  });
                }
                return json({
                  ...item,
                  description:
                    item.provider === 'curseforge'
                      ? `<h2>${item.name}</h2><p>A useful addition<br onclick="window.fixtureInjection=true">to your world.</p><hr><p>Read the <a href="https://example.test/docs">documentation</a>.</p><img src="https://example.test/banner.png" alt="Project banner" onerror="window.fixtureInjection=true"><img src="javascript:window.fixtureInjection=true"><script>window.fixtureInjection=true</script>`
                      : `# ${item.name}\nA useful addition to your world.\n\n## Features\n- Explore new possibilities\n- Configure your play style\n\n[Documentation](https://example.test/docs)\n<script>window.fixtureInjection=true</script>`,
                  descriptionFormat: item.provider === 'curseforge' ? 'html' : 'markdown',
                });
              }
              errors.push(`Unexpected endpoint ${req.method} ${url.pathname}`);
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
      version: '26.1',
      loader: 'fabric',
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
    writes = [];
    errors = [];
    failedProvider = false;
    failSelection = false;
    completed = true;
    delaySelection = undefined;
    delaySnapshot = undefined;
    releaseSnapshot = undefined;
    snapshotReads = 0;
    context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
    });
  });
  afterEach(async () => {
    releaseSnapshot?.();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await context.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  async function capture(name: string) {
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: `.codex/local/m5-browser/screenshots/${name}.png`,
      fullPage: true,
    });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  async function open() {
    await page.goto(`${origin}mods-fixture`);
    await check(page.getByRole('button', { name: 'About Evergreen' })).toBeVisible({
      timeout: 15000,
    });
  }
  it('opens details separately, prepares stable/beta selections and applies without power commands', async () => {
    await open();
    await page.getByRole('button', { name: 'About Evergreen' }).click();
    await check(
      page.getByRole('heading', { name: 'Evergreen', exact: true }).first(),
    ).toBeVisible();
    expect(writes).toHaveLength(0);
    await check(page.locator('.mods-description')).toContainText('A useful addition');
    expect(await page.evaluate(() => 'fixtureInjection' in window)).toBe(false);
    await capture('mods-discover-en-desktop');
    await page.getByRole('checkbox', { name: 'Select Evergreen', exact: true }).first().check();
    await check
      .poll(() => snapshot.changes.find((item) => item.name === 'Evergreen')?.metadata?.channel)
      .toBe('release');
    await page.getByRole('checkbox', { name: 'Select Copper Toolkit', exact: true }).check();
    await check(page.getByRole('button', { name: 'Install (2)', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Install (2)', exact: true }).click();
    await check(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    await check(page.locator('.mods-review')).toContainText('BETA');
    await check(page.locator('.mods-review')).toContainText('Copper API');
    await capture('mods-review-en-desktop');
    await page.getByRole('button', { name: 'Back to Discover' }).click();
    await check(page.getByRole('checkbox', { name: 'Select Copper Toolkit' })).toBeChecked();
    await page.reload();
    await check(page.getByRole('button', { name: 'Install (2)', exact: true })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole('button', { name: 'Install (2)', exact: true }).click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await check(page.getByText('Changes applied', { exact: true })).toBeVisible();
    await check(page.locator('.mods-installed-list')).toContainText('Evergreen');
    expect(snapshot.running).toBe(true);
    expect(
      writes.every((item) => item.path === `${base}/selection` || item.path === `${base}/apply`),
    ).toBe(true);
  });
  it.each(['en', 'it'] as const)(
    'renders CurseForge HTML void tags and gated images without crashing (%s)',
    async (locale) => {
      if (locale === 'it') await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('nh.locale', value), locale);
      let imageRequests = 0;
      await page.route('https://example.test/banner.png', async (route) => {
        imageRequests++;
        await route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
            'base64',
          ),
        });
      });
      await page.goto(`${origin}mods-fixture`);
      await page
        .getByRole('combobox', { name: locale === 'it' ? 'Catalogo' : 'Catalog', exact: true })
        .click();
      await page.getByRole('option', { name: 'CurseForge', exact: true }).click();
      await page
        .getByRole('button', {
          name: locale === 'it' ? 'Informazioni su Evergreen' : 'About Evergreen',
        })
        .click();
      const description = page.locator('.mods-description');
      await check(description).toContainText('to your world.');
      await check(description.locator('br')).toHaveCount(1);
      await check(description.locator('hr')).toHaveCount(1);
      await check(description.locator('img')).toHaveCount(0);
      expect(imageRequests).toBe(0);
      await check(description.getByRole('link', { name: 'documentation' })).toHaveAttribute(
        'rel',
        'noopener noreferrer',
      );
      await description
        .getByRole('button', { name: locale === 'it' ? 'Carica immagini' : 'Load images' })
        .click();
      await check(description.getByRole('img', { name: 'Project banner' })).toBeVisible();
      await check.poll(() => imageRequests).toBe(1);
      expect(await description.locator('img').getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(await page.evaluate(() => 'fixtureInjection' in window)).toBe(false);
      expect(writes).toHaveLength(0);
      await capture(
        `mods-curseforge-description-${locale}-${locale === 'it' ? 'mobile' : 'desktop'}`,
      );
    },
  );
  it('requires an explicit inline confirmation for a version mismatch', async () => {
    await open();
    await page.getByRole('button', { name: 'About Evergreen' }).click();
    await page.getByRole('button', { name: 'Select version', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Show incompatible versions' }).check();
    await page.locator('.mods-version-option').filter({ hasText: 'old' }).click();
    await check(page.getByRole('alert')).toContainText('Install an incompatible version?');
    expect(writes).toHaveLength(0);
    await capture('mods-incompatible-en');
    await page.getByRole('button', { name: 'Use anyway', exact: true }).click();
    await check.poll(() => snapshot.roots[0]?.forceIncompatible).toBe(true);
    expect(snapshot.roots[0]?.versionId).toBe('evergreen-old');
    await page.getByRole('button', { name: 'Install (1)', exact: true }).click();
    await check(page.locator('.mods-review')).toContainText('Forced');
    await page.getByRole('button', { name: 'Remove Evergreen from queue' }).click();
    await check(page.getByText('Your queue is empty')).toBeVisible();
    await check.poll(() => snapshot.roots.length).toBe(0);
  });
  it('keeps failed selections and retries the same frozen request before later edits', async () => {
    await open();
    failSelection = true;
    await page.getByRole('checkbox', { name: 'Select Evergreen' }).check();
    await check(
      page.getByText('Selection was not saved. Try again before leaving this page.'),
    ).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select Copper Toolkit' }).check();
    expect(writes).toHaveLength(1);
    await page.locator('.mods-selection-error').getByRole('button', { name: 'Try again' }).click();
    await check.poll(() => snapshot.roots.length).toBe(2);
    expect(writes[0]?.body).toEqual(writes[1]?.body);
    expect(writes[2]?.body.idempotencyKey).not.toBe(writes[0]?.body.idempotencyKey);
    await check(page.locator('.mods-selection-error')).toHaveCount(0);
  });
  it('persists a second checkbox clicked during the first snapshot refresh', async () => {
    await open();
    const reads = snapshotReads;
    delaySnapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    await page.getByRole('checkbox', { name: 'Select Evergreen' }).check();
    await check.poll(() => snapshotReads).toBeGreaterThan(reads);
    await page.getByRole('checkbox', { name: 'Select Copper Toolkit' }).check();
    expect(writes).toHaveLength(1);
    releaseSnapshot?.();
    delaySnapshot = undefined;
    await check.poll(() => snapshot.roots.length).toBe(2);
    await page.reload();
    await check(page.getByRole('button', { name: 'Install (2)' })).toBeVisible({ timeout: 10000 });
  });
  it('marks an unchanged installed selection as already installed instead of preparing forever', async () => {
    const item = catalog[0];
    if (!item) throw new Error('Missing fixture');
    snapshot.packs.push({
      id: 'installed',
      name: item.name,
      path: 'mods/evergreen-1.0.jar',
      size: 12,
      state: 'enabled',
      metadata: metadata(item, file(item, '1.0')),
    });
    await open();
    await page.getByRole('checkbox', { name: 'Select Evergreen' }).check();
    await page.getByRole('button', { name: 'Install (1)' }).click();
    await check(page.locator('.mods-review')).toContainText('Already installed');
    await check(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    expect(snapshot.changes).toHaveLength(0);
  });
  it('shows localized preparation reasons for failed roots, dependencies and the durable selection', async () => {
    select({
      roots: [
        {
          provider: 'modrinth',
          projectId: 'copper',
          optionalProjectIds: [],
          forceIncompatible: false,
        },
      ],
      preferBeta: false,
      idempotencyKey: 'failed-preparation',
    });
    const root = snapshot.changes.find((change) => !change.dependency);
    const dependency = snapshot.changes.find((change) => change.dependency);
    if (!root || !dependency) throw new Error('Missing queued fixture');
    root.state = 'failed';
    root.error = 'content_storage_unavailable';
    dependency.state = 'failed';
    dependency.error = 'rate_limited';
    snapshot.error = 'content_storage_unavailable';
    await open();
    await page.getByRole('button', { name: 'Install (1)' }).click();
    await check(page.locator('.mods-review-row').first()).toContainText(
      en['errors.content_storage_unavailable'],
    );
    await check(page.locator('.mods-dependency-row')).toContainText(en['errors.rate_limited']);
    await check(page.locator('.mods-review > [role=alert]')).toContainText(
      en['errors.content_storage_unavailable'],
    );
    await check(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await capture('mods-preparation-error-en');
    await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await page.reload();
    await page.getByRole('button', { name: 'Installa (1)' }).click();
    await check(page.locator('.mods-review-row').first()).toContainText(
      italian['errors.content_storage_unavailable'],
    );
    await check(page.locator('.mods-dependency-row')).toContainText(italian['errors.rate_limited']);
  });
  it('filters installed metadata and stages disable/remove operations for review', async () => {
    for (const item of catalog)
      snapshot.packs.push({
        id: item.id,
        name: item.name,
        path: `mods/${item.id}.jar`,
        size: 1048576,
        state: 'enabled',
        metadata: metadata(item, file(item, '1.0')),
      });
    const first = snapshot.packs[0]?.metadata;
    if (!first) throw new Error('Missing fixture metadata');
    first.side = 'server';
    await open();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await page.getByRole('combobox', { name: 'Environment' }).click();
    await page.getByRole('option', { name: 'Server only' }).click();
    await check(page.locator('.mods-installed-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Disable Evergreen' }).click();
    await check(page.getByRole('button', { name: 'Install (1)' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Environment' }).click();
    await page.getByRole('option', { name: 'All environments' }).click();
    await capture('mods-installed-en');
    await page.getByRole('button', { name: 'Remove Map Overlay', exact: true }).click();
    await page.getByRole('button', { name: 'Install (2)' }).click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await check
      .poll(() => snapshot.packs.find((item) => item.id === 'evergreen')?.state)
      .toBe('disabled');
    expect(snapshot.packs.some((item) => item.id === 'overlay')).toBe(false);
    expect(snapshot.running).toBe(true);
  });
  it('keeps mobile details/review inline and preserves beta preference without overwriting a selected version', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await page.goto(`${origin}mods-fixture`);
    await check(page.getByRole('button', { name: 'Informazioni su Evergreen' })).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: 'Preferisci versioni beta' }).click();
    await page.getByRole('button', { name: 'Informazioni su Evergreen' }).click();
    await check(page.locator('.mods-description')).toContainText('A useful addition');
    await capture('mods-details-it-mobile');
    await page.getByRole('checkbox', { name: 'Seleziona Evergreen' }).check();
    await check.poll(() => snapshot.changes[0]?.metadata?.channel).toBe('beta');
    await page.getByRole('button', { name: 'Installa (1)' }).click();
    await check(page.getByRole('button', { name: 'Applica', exact: true })).toBeEnabled();
    await capture('mods-review-it-mobile');
  });
  it('shows catalog failures with retry and keeps read-only actions disabled', async () => {
    failedProvider = true;
    await page.goto(`${origin}mods-fixture?readonly`);
    await check(page.getByRole('alert')).toBeVisible({ timeout: 15000 });
    await capture('mods-unavailable-en');
    failedProvider = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await check(page.getByRole('checkbox', { name: 'Select Evergreen' })).toBeDisabled();
    await page.getByRole('button', { name: 'About Evergreen' }).click();
    await check(page.getByRole('button', { name: 'Select version', exact: true })).toBeDisabled();
    expect(writes).toHaveLength(0);
  });
});
