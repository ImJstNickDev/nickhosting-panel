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
  MinecraftModUpdates,
} from '../../../games/minecraft/src/mod-contracts.js';
import { minecraftModsMessages } from '../../../games/minecraft/src/ui/mods-catalog.js';
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
  id: `${item.id}-${version.replaceAll('.', '_')}`,
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
  let updateItems: MinecraftModUpdates['items'] | undefined;
  let updateReads = 0;
  let updatesLimited = false;
  let alternativeReads = 0;
  let delayUpdates: Promise<void> | undefined;
  let releaseUpdates: (() => void) | undefined;
  let failedProvider = false;
  let completed = true;
  let fallbackToPrevious = false;
  let fallbackRequestedVersion: string | undefined;
  let delayToggle: Promise<void> | undefined;
  let releaseToggle: (() => void) | undefined;
  let failToggle: string | undefined;
  let uncertainToggle = false;
  let persistUncertainToggle = false;
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
      const version =
        (fallbackToPrevious && !root.versionId && !input.preferBeta) ||
        (fallbackRequestedVersion !== undefined && root.versionId === fallbackRequestedVersion)
          ? file(item, '0.9')
          : root.versionId?.endsWith('-old')
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
              if (url.pathname === `${base}/updates`) {
                updateReads++;
                await delayUpdates;
                return json({
                  checkedAt: '2026-10-20T12:00:00Z',
                  limited: updatesLimited,
                  items:
                    updateItems ??
                    snapshot.packs.flatMap((pack) =>
                      pack.metadata
                        ? [
                            {
                              path: pack.path,
                              provider: pack.metadata.provider,
                              projectId: pack.metadata.projectId,
                              currentVersionId: pack.metadata.versionId,
                              status: 'current',
                            },
                          ]
                        : [],
                    ),
                });
              }
              if (url.pathname.startsWith(`${base}/alternatives/`)) {
                alternativeReads++;
                const projectId = url.pathname.split('/').at(-1) ?? '';
                const item =
                  catalog.find((item) => item.id === projectId) ?? project(projectId, projectId);
                return json({
                  revision: Number(url.searchParams.get('revision')),
                  provider: item.provider,
                  projectId,
                  items: [file(item, '1.0')],
                  checked: 3,
                  limited: false,
                });
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
              if (url.pathname === `${base}/toggle`) {
                await delayToggle;
                if (failToggle) {
                  const code = failToggle;
                  failToggle = undefined;
                  return json({ code, messageKey: `errors.${code}` }, 409);
                }
                const target = `${String(body.path).replace(/\.disabled$/, '')}${body.action === 'disable' ? '.disabled' : ''}`;
                if (uncertainToggle) {
                  uncertainToggle = false;
                  if (persistUncertainToggle) {
                    const pack = snapshot.packs.find((item) => item.path === body.path);
                    if (!pack) return json({ code: 'not_found' }, 404);
                    snapshot.changes.push({
                      ...pack,
                      id: generated(),
                      action: body.action as 'disable',
                      state: 'uncertain',
                      immediate: true,
                      dependency: false,
                      requiredBy: [],
                      forceIncompatible: false,
                      incompatibilities: [],
                    });
                    snapshot.revision++;
                  }
                  return json({ state: 'uncertain', path: target, restartRequired: true });
                }
                snapshot.packs = snapshot.packs.map((pack) =>
                  pack.path === body.path
                    ? {
                        ...pack,
                        path: target,
                        state: body.action === 'disable' ? 'disabled' : 'enabled',
                      }
                    : pack,
                );
                snapshot.revision++;
                snapshot.restart = { required: true };
                return json({ state: 'published', path: target, restartRequired: true });
              }
              if (url.pathname === `${base}/recover`) {
                for (const change of snapshot.changes.filter((item) => item.immediate)) {
                  const target = `${change.path.replace(/\.disabled$/, '')}${change.action === 'disable' ? '.disabled' : ''}`;
                  snapshot.packs = snapshot.packs.map((pack) =>
                    pack.path === change.path
                      ? {
                          ...pack,
                          path: target,
                          state: change.action === 'disable' ? 'disabled' : 'enabled',
                        }
                      : pack,
                  );
                }
                snapshot.changes = snapshot.changes.filter((change) => !change.immediate);
                snapshot.revision++;
                snapshot.restart = { required: true };
                return json({ state: 'published', restartRequired: true });
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
    fallbackToPrevious = false;
    fallbackRequestedVersion = undefined;
    delayToggle = undefined;
    releaseToggle = undefined;
    failToggle = undefined;
    uncertainToggle = false;
    persistUncertainToggle = false;
    delaySelection = undefined;
    delaySnapshot = undefined;
    releaseSnapshot = undefined;
    snapshotReads = 0;
    updateItems = undefined;
    updateReads = 0;
    updatesLimited = false;
    alternativeReads = 0;
    delayUpdates = undefined;
    releaseUpdates = undefined;
    context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
    });
  });
  afterEach(async () => {
    releaseToggle?.();
    releaseSnapshot?.();
    releaseUpdates?.();
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
  function installFixtures() {
    snapshot.packs = catalog.map((item) => ({
      id: item.id,
      name: item.name,
      path: `mods/${item.id}.jar`,
      size: 1048576,
      state: 'enabled',
      metadata: metadata(item, file(item, '1.0')),
    }));
  }
  function pauseToggles() {
    delayToggle = new Promise<void>((resolve) => {
      releaseToggle = resolve;
    });
  }
  function finishToggles() {
    delayToggle = undefined;
    releaseToggle?.();
  }
  const toggleWrites = () => writes.filter((write) => write.path === `${base}/toggle`);
  const installedRow = (name: string) =>
    page.locator('.mods-installed-row').filter({ has: page.getByText(name, { exact: true }) });
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
    await page.locator('.catalog-back').click();
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
      await check(description.locator('img')).toHaveCount(1);
      await check(description.locator('img')).toHaveAttribute('loading', 'lazy');
      await check(description.getByRole('link', { name: 'documentation' })).toHaveAttribute(
        'rel',
        'noopener noreferrer',
      );
      await check(description.getByRole('button')).toHaveCount(0);
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
    releaseUpdates?.();
    delaySnapshot = undefined;
    await check.poll(() => snapshot.roots.length).toBe(2);
    await page.reload();
    await check(page.getByRole('button', { name: 'Install (2)' })).toBeVisible({ timeout: 10000 });
  });
  it.each(['en', 'it'] as const)(
    'shows the resolved automatic version without pinning the requested choice (%s)',
    async (locale) => {
      fallbackToPrevious = true;
      if (locale === 'it') await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('nh.locale', value), locale);
      const text = (key: string) =>
        minecraftModsMessages[`mods.${key}`]?.[locale === 'it' ? 1 : 0] ?? key;
      await page.goto(`${origin}mods-fixture`);
      await page
        .getByRole('checkbox', { name: text('select').replace('{name}', 'Evergreen'), exact: true })
        .check();
      await page
        .getByRole('button', { name: text('install').replace('{count}', '1'), exact: true })
        .click();
      await check(page.getByRole('button', { name: text('apply'), exact: true })).toBeEnabled();
      await check(page.locator('.mods-review-controls')).toContainText('0.9');
      await check(page.locator('.mods-blockers')).toHaveCount(0);
      expect(snapshot.roots[0]?.versionId).toBeUndefined();
      expect(snapshot.changes[0]?.metadata?.versionId).toBe('evergreen-0_9');
      expect(writes.filter((write) => write.path.endsWith('/selection'))).toHaveLength(1);
      await capture(`mods-automatic-version-${locale}-${locale === 'it' ? 'mobile' : 'desktop'}`);
      await page.getByRole('button', { name: text('back'), exact: true }).click();
      await page
        .getByRole('checkbox', { name: text('select').replace('{name}', 'Copper Toolkit') })
        .check();
      await check.poll(() => snapshot.roots.length).toBe(2);
      expect(snapshot.roots.every((root) => root.versionId === undefined)).toBe(true);
      await page.getByRole('button', { name: text('betaPreference'), exact: true }).click();
      await check.poll(() => snapshot.preferBeta).toBe(true);
      await check
        .poll(
          () =>
            snapshot.changes.find((change) => change.metadata?.projectId === 'evergreen')?.metadata
              ?.channel,
        )
        .toBe('beta');
      await page.reload();
      await page
        .getByRole('button', { name: text('install').replace('{count}', '2'), exact: true })
        .click();
      await check(page.locator('.mods-review')).toContainText('BETA');
      expect(snapshot.roots.every((root) => root.versionId === undefined)).toBe(true);
    },
  );
  it('preserves a newer manual version chosen during an automatic selection refresh', async () => {
    fallbackToPrevious = true;
    await open();
    await page.getByRole('button', { name: 'About Evergreen' }).click();
    const reads = snapshotReads;
    delaySnapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    await page.getByRole('checkbox', { name: 'Select Evergreen', exact: true }).first().check();
    await check.poll(() => snapshotReads).toBeGreaterThan(reads);
    await page.getByRole('button', { name: 'Select version', exact: true }).click();
    await page.locator('.mods-version-option').filter({ hasText: 'beta' }).click();
    expect(writes).toHaveLength(1);
    releaseSnapshot?.();
    delaySnapshot = undefined;
    await check.poll(() => snapshot.roots[0]?.versionId).toBe('evergreen-beta');
    await page.getByRole('button', { name: 'Install (1)', exact: true }).click();
    await check(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    await check(page.locator('.mods-review-controls')).toContainText('beta');
    await page.getByRole('button', { name: 'Back to Discover' }).click();
    await page.locator('.catalog-back').click();
    await page.getByRole('checkbox', { name: 'Select Copper Toolkit' }).check();
    await check.poll(() => snapshot.roots.length).toBe(2);
    expect(snapshot.roots[0]?.versionId).toBe('evergreen-beta');
    expect(writes[1]?.body.idempotencyKey).not.toBe(writes[0]?.body.idempotencyKey);
  });
  it('adopts a newer settled snapshot after the selection refetch finishes', async () => {
    await open();
    await page.route(`**${base}`, async (route) => {
      // Another view cleared the draft while this selection's refresh was in flight.
      const settled = { ...snapshot, revision: snapshot.revision + 1, roots: [], changes: [] };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(settled) });
    });
    await page.getByRole('checkbox', { name: 'Select Evergreen', exact: true }).check();
    await check(
      page.getByRole('checkbox', { name: 'Select Evergreen', exact: true }),
    ).not.toBeChecked();
    expect(writes).toHaveLength(1);
  });
  it('does not replace newer selection intent with a stale snapshot', async () => {
    const stale = structuredClone(snapshot);
    await open();
    await page.getByRole('checkbox', { name: 'Select Evergreen', exact: true }).check();
    await page.getByRole('button', { name: 'Install (1)', exact: true }).click();
    await check(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Back to Discover' }).click();
    await page.route(
      `**${base}`,
      async (route) => {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(stale) });
      },
      { times: 1 },
    );
    const response = page.waitForResponse((response) => response.url().endsWith(base));
    await page.getByRole('button', { name: 'Refresh mods', exact: true }).click();
    await response;
    await check(
      page.getByRole('checkbox', { name: 'Select Evergreen', exact: true }),
    ).toBeChecked();
    await page.getByRole('checkbox', { name: 'Select Copper Toolkit' }).check();
    await check.poll(() => snapshot.roots.length).toBe(2);
    expect(snapshot.roots.map((root) => root.projectId)).toEqual(['evergreen', 'copper']);
  });
  it('hides previous dependency blockers while a new selection is saving or preparing', async () => {
    snapshot.roots = [
      {
        provider: 'modrinth',
        projectId: 'evergreen',
        optionalProjectIds: [],
        forceIncompatible: false,
      },
    ];
    snapshot.blockers = [{ projectId: 'config', name: 'Config', reason: 'unavailable' }];
    const previousBlockers = structuredClone(snapshot.blockers);
    await open();
    await page.getByRole('button', { name: 'Install (1)', exact: true }).click();
    await check(page.locator('.mods-blockers')).toBeVisible();
    let releaseSelection: (() => void) | undefined;
    delaySelection = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    try {
      await page.getByRole('button', { name: 'Recheck dependencies', exact: true }).click();
      await check(page.locator('.mods-blockers')).toHaveCount(0);
      completed = false;
      releaseSelection?.();
      await check.poll(() => snapshot.preparing).toBe(true);
      snapshot.blockers = previousBlockers;
      await page.evaluate(
        `import('/src/api/client.ts').then(({ queryClient }) => queryClient.invalidateQueries({ queryKey: ['minecraft-mods', '${serverId}'] }))`,
      );
      await check(page.locator('.mods-blockers')).toHaveCount(0);
      await check(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
      snapshot.preparing = false;
      snapshot.changes = snapshot.changes.map((change) => ({ ...change, state: 'ready' }));
      await page.evaluate(
        `import('/src/api/client.ts').then(({ queryClient }) => queryClient.invalidateQueries({ queryKey: ['minecraft-mods', '${serverId}'] }))`,
      );
      await check(page.locator('.mods-blockers')).toBeVisible();
    } finally {
      releaseSelection?.();
    }
  });
  it('marks an unchanged installed selection as already installed instead of preparing forever', async () => {
    const item = catalog[0];
    if (!item) throw new Error('Missing fixture');
    snapshot.packs.push({
      id: 'installed',
      name: item.name,
      path: 'mods/evergreen-1_0.jar',
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
  it('shows the installed fallback for an explicit pin as already installed without another download', async () => {
    const item = catalog[0] as ModCatalogProject;
    fallbackRequestedVersion = 'evergreen-beta';
    snapshot.packs.push({
      id: 'installed',
      name: item.name,
      path: 'mods/evergreen-0.9.jar',
      size: 12,
      state: 'enabled',
      metadata: metadata(item, file(item, '0.9')),
    });
    await open();
    await page.getByRole('button', { name: 'About Evergreen' }).click();
    await page.getByRole('button', { name: 'Selected version: 0.9', exact: true }).click();
    await page.locator('.mods-version-option').filter({ hasText: 'beta' }).click();
    await page.getByRole('button', { name: 'Install (1)', exact: true }).click();
    await check(page.locator('.mods-review')).toContainText('Already installed');
    await check(
      page.getByRole('button', { name: 'Selected version: 0.9', exact: true }),
    ).toBeVisible();
    await check(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    expect(snapshot.roots[0]?.versionId).toBe('evergreen-beta');
    expect(snapshot.changes).toHaveLength(0);
    expect(writes.filter((write) => write.path.endsWith('/selection'))).toHaveLength(1);
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
  it('filters installed metadata, toggles immediately and only queues removal for review', async () => {
    installFixtures();
    const first = snapshot.packs[0]?.metadata;
    if (!first) throw new Error('Missing fixture metadata');
    first.side = 'server';
    await open();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await page.getByRole('combobox', { name: 'Environment' }).click();
    await page.getByRole('option', { name: 'Server only' }).click();
    await check(page.locator('.mods-installed-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Disable Evergreen' }).click();
    await check(installedRow('Evergreen')).toHaveAttribute('data-disabled', 'true');
    await check(page.getByRole('button', { name: 'Install (1)' })).toHaveCount(0);
    await check.poll(() => snapshot.packs[0]?.state).toBe('disabled');
    await page.getByRole('combobox', { name: 'Environment' }).click();
    await page.getByRole('option', { name: 'All environments' }).click();
    await capture('mods-installed-en');
    await page.getByRole('button', { name: 'Remove Map Overlay', exact: true }).click();
    await page.getByRole('button', { name: 'Install (1)' }).click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await check
      .poll(() => snapshot.packs.find((item) => item.id === 'evergreen')?.state)
      .toBe('disabled');
    expect(snapshot.packs.some((item) => item.id === 'overlay')).toBe(false);
    expect(snapshot.running).toBe(true);
  });
  it.each(['en', 'it'] as const)(
    'shows a pending disable immediately without a queue and keeps navigation usable (%s)',
    async (locale) => {
      installFixtures();
      pauseToggles();
      if (locale === 'it') await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('nh.locale', value), locale);
      const text = (key: string) =>
        minecraftModsMessages[`mods.${key}`]?.[locale === 'it' ? 1 : 0] ?? key;
      await page.goto(`${origin}mods-fixture`);
      await page
        .getByRole('button', { name: text('installed'), exact: false })
        .first()
        .click();
      await page
        .getByRole('button', { name: text('disable').replace('{name}', 'Evergreen') })
        .click();
      await check(installedRow('Evergreen')).toHaveAttribute('data-disabled', 'true');
      await check(installedRow('Evergreen')).toHaveAttribute('aria-busy', 'true');
      await check(
        page.getByRole('button', { name: text('enable').replace('{name}', 'Evergreen') }),
      ).toBeDisabled();
      await check(
        page.getByRole('button', { name: text('disable').replace('{name}', 'Copper Toolkit') }),
      ).toBeEnabled();
      expect(snapshot.packs[0]?.state).toBe('enabled');
      expect(snapshot.changes).toHaveLength(0);
      await check(
        page.getByRole('button', { name: text('install').replace('{count}', '1'), exact: true }),
      ).toHaveCount(0);
      await capture(`mods-immediate-toggle-${locale}-${locale === 'it' ? 'mobile' : 'desktop'}`);
      await page.getByRole('button', { name: text('discover'), exact: true }).click();
      await check(
        page.getByRole('button', { name: text('details').replace('{name}', 'Copper Toolkit') }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: text('installed'), exact: false })
        .first()
        .click();
      const stale = structuredClone(snapshot);
      await page.route(
        `**${base}`,
        async (route) =>
          route.fulfill({ contentType: 'application/json', body: JSON.stringify(stale) }),
        { times: 1 },
      );
      const response = page.waitForResponse((value) => value.url().endsWith(base));
      await page.getByRole('button', { name: text('refresh'), exact: true }).click();
      await response;
      await check(installedRow('Evergreen')).toHaveAttribute('data-disabled', 'true');
      finishToggles();
      await check(
        page.getByRole('button', { name: text('enable').replace('{name}', 'Evergreen') }),
      ).toBeEnabled();
      expect(snapshot.packs[0]?.path).toBe('mods/evergreen.jar.disabled');
      expect(toggleWrites()).toHaveLength(1);
      expect(writes).toHaveLength(1);
      await page
        .getByRole('button', { name: text('enable').replace('{name}', 'Evergreen') })
        .click();
      await check.poll(() => snapshot.packs[0]?.path).toBe('mods/evergreen.jar');
      await check(installedRow('Evergreen')).not.toHaveAttribute('data-disabled');
      expect(toggleWrites()[1]?.body.path).toBe('mods/evergreen.jar.disabled');
    },
  );
  it('serializes pending toggles across rows without blocking either optimistic change', async () => {
    installFixtures();
    pauseToggles();
    await open();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await page.getByRole('button', { name: 'Disable Evergreen' }).click();
    await page.getByRole('button', { name: 'Disable Copper Toolkit' }).click();
    await check(installedRow('Evergreen')).toHaveAttribute('data-disabled', 'true');
    await check(installedRow('Copper Toolkit')).toHaveAttribute('data-disabled', 'true');
    await check.poll(() => toggleWrites().length).toBe(1);
    await check(page.getByRole('button', { name: 'Disable Map Overlay' })).toBeEnabled();
    expect(snapshot.changes).toHaveLength(0);
    finishToggles();
    await check.poll(() => toggleWrites().length).toBe(2);
    await check
      .poll(() => snapshot.packs.filter((pack) => pack.state === 'disabled').length)
      .toBe(2);
    await check(page.getByRole('button', { name: 'Enable Evergreen' })).toBeEnabled();
    await check(page.getByRole('button', { name: 'Enable Copper Toolkit' })).toBeEnabled();
    expect(toggleWrites().map((write) => write.body.path)).toEqual([
      'mods/evergreen.jar',
      'mods/copper.jar',
    ]);
  });
  it('rolls a rejected disable back, reports its reason and preserves the queued installation', async () => {
    installFixtures();
    select({
      roots: [
        {
          provider: 'modrinth',
          projectId: 'new-mod',
          optionalProjectIds: [],
          forceIncompatible: false,
        },
      ],
      preferBeta: false,
      idempotencyKey: 'other-queue',
    });
    const queued = structuredClone(snapshot.changes);
    failToggle = 'content_dependency_missing';
    pauseToggles();
    await open();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await page.getByRole('button', { name: 'Disable Evergreen' }).click();
    await check(installedRow('Evergreen')).toHaveAttribute('data-disabled', 'true');
    finishToggles();
    await check(page.getByRole('alert')).toContainText(en['errors.content_dependency_missing']);
    await check(installedRow('Evergreen')).not.toHaveAttribute('data-disabled');
    await check(page.getByRole('button', { name: 'Disable Evergreen' })).toBeEnabled();
    expect(snapshot.changes).toEqual(queued);
    await check(page.getByRole('button', { name: 'Install (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await check.poll(() => toggleWrites().length).toBe(2);
    expect(toggleWrites()[1]?.body).toEqual(toggleWrites()[0]?.body);
    await check(page.getByRole('alert')).toHaveCount(0);
    await check(installedRow('Evergreen')).toHaveAttribute('data-disabled', 'true');
    expect(snapshot.changes).toEqual(queued);
  });
  it('retains an uncertain toggle and retries its exact identity without adding it to the queue', async () => {
    installFixtures();
    uncertainToggle = true;
    await open();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await page.getByRole('button', { name: 'Disable Evergreen' }).click();
    await check(page.getByRole('alert')).toContainText(en['errors.operation_uncertain']);
    await check(installedRow('Evergreen')).toHaveAttribute('data-disabled', 'true');
    await check(page.getByRole('button', { name: 'Enable Evergreen' })).toBeDisabled();
    await check(page.getByRole('button', { name: 'Disable Copper Toolkit' })).toBeEnabled();
    expect(snapshot.changes).toHaveLength(0);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await check(page.getByRole('button', { name: 'Enable Evergreen' })).toBeEnabled();
    await check(page.getByRole('alert')).toHaveCount(0);
    expect(toggleWrites()).toHaveLength(2);
    expect(toggleWrites()[1]?.body).toEqual(toggleWrites()[0]?.body);
    expect(snapshot.packs[0]?.path).toBe('mods/evergreen.jar.disabled');
  });
  it.each([false, true])(
    'recovers a durable immediate change outside the installation queue (reload: %s)',
    async (reload) => {
      installFixtures();
      select({
        roots: [
          {
            provider: 'modrinth',
            projectId: 'new-mod',
            optionalProjectIds: [],
            forceIncompatible: false,
          },
        ],
        preferBeta: false,
        idempotencyKey: 'other-queue',
      });
      const queued = structuredClone(snapshot.changes);
      uncertainToggle = true;
      persistUncertainToggle = true;
      await open();
      await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
      const refresh = page.waitForResponse((response) => response.url().endsWith(base));
      await page.getByRole('button', { name: 'Disable Evergreen' }).click();
      await refresh;
      await check(page.getByRole('alert')).toContainText(en['errors.operation_uncertain']);
      expect(snapshot.changes.some((change) => change.immediate)).toBe(true);
      if (reload) {
        await page.reload();
        await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
        await check(page.getByRole('button', { name: 'Disable Evergreen' })).toBeDisabled();
      } else {
        await check(page.getByRole('button', { name: 'Enable Evergreen' })).toBeDisabled();
      }
      await check(page.getByRole('button', { name: 'Install (1)', exact: true })).toBeVisible();
      await check(page.getByRole('button', { name: 'Install (2)', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await check(page.getByRole('button', { name: 'Enable Evergreen' })).toBeEnabled();
      await check(page.getByRole('alert')).toHaveCount(0);
      expect(snapshot.changes).toEqual(queued);
      expect(snapshot.packs[0]?.path).toBe('mods/evergreen.jar.disabled');
      expect(writes.map((write) => write.path)).toEqual(
        reload
          ? [`${base}/toggle`, `${base}/recover`]
          : [`${base}/toggle`, `${base}/recover`, `${base}/toggle`],
      );
      if (!reload) expect(toggleWrites()[1]?.body).toEqual(toggleWrites()[0]?.body);
    },
  );
  it('keeps a pending rename across leaving and remounting Mods', async () => {
    installFixtures();
    pauseToggles();
    await page.goto(`${origin}mods-fixture?remount`);
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await page.getByRole('button', { name: 'Disable Evergreen' }).click();
    await check(installedRow('Evergreen')).toHaveAttribute('data-disabled', 'true');
    await page.getByRole('button', { name: 'Leave Mods', exact: true }).click();
    await check(page.locator('.mods-installed-list')).toHaveCount(0);
    await page.getByRole('button', { name: 'Return to Mods', exact: true }).click();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await check(installedRow('Evergreen')).toHaveAttribute('data-disabled', 'true');
    finishToggles();
    await check(page.getByRole('button', { name: 'Enable Evergreen' })).toBeEnabled();
    expect(toggleWrites()).toHaveLength(1);
    expect(snapshot.packs[0]?.state).toBe('disabled');
  });
  it('does not allow read-only users to toggle installed mods', async () => {
    installFixtures();
    await page.goto(`${origin}mods-fixture?readonly`);
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await check(page.getByRole('button', { name: 'Disable Evergreen' })).toBeDisabled();
    await check(page.getByRole('button', { name: 'Remove Evergreen' })).toBeDisabled();
    expect(toggleWrites()).toHaveLength(0);
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
  it.each(['en', 'it'] as const)(
    'explains dependency requirements and offers an explicit alternative (%s)',
    async (locale) => {
      if (locale === 'it') await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('nh.locale', value), locale);
      snapshot.roots = [
        {
          provider: 'modrinth',
          projectId: 'evergreen',
          optionalProjectIds: [],
          forceIncompatible: false,
        },
      ];
      snapshot.blockers = [
        {
          provider: 'modrinth',
          projectId: 'evergreen-config',
          name: 'Evergreen Config',
          reason: 'incompatible-version',
          requiredBy: 'evergreen',
          requiredByName: 'Evergreen',
          roots: [{ projectId: 'evergreen', name: 'Evergreen' }],
          availableMinecraftVersions: ['26.1.2'],
          availableLoaders: ['fabric'],
          availableChannels: ['beta'],
        },
      ];
      const text = (key: string) =>
        minecraftModsMessages[`mods.${key}`]?.[locale === 'it' ? 1 : 0] ?? key;
      await page.goto(`${origin}mods-fixture`);
      await page
        .getByRole('button', { name: text('install').replace('{count}', '1'), exact: true })
        .click();
      await check(page.locator('.mods-blockers')).toContainText('26.1.2');
      await check(page.locator('.mods-blockers')).toContainText('Minecraft 26.1 · fabric');
      expect(writes).toHaveLength(0);
      expect(alternativeReads).toBe(0);
      await page
        .getByRole('button', { name: text('alternative.find').replace('{name}', 'Evergreen') })
        .click();
      const use = page.getByRole('button', {
        name: text('alternative.use').replace('{version}', '1.0'),
        exact: true,
      });
      await check(use).toBeVisible();
      expect(alternativeReads).toBe(1);
      expect(writes).toHaveLength(0);
      await capture(
        `mods-dependency-alternative-${locale}-${locale === 'it' ? 'mobile' : 'desktop'}`,
      );
      await use.focus();
      await page.keyboard.press('Enter');
      await check.poll(() => snapshot.roots[0]?.versionId).toBe('evergreen-1_0');
      await check(page.getByRole('button', { name: text('apply'), exact: true })).toBeEnabled();
      expect(writes.filter((write) => write.path.endsWith('/apply'))).toHaveLength(0);
    },
  );
  it('keeps the inventory usable during background update checks and prepares exact updates in one selection', async () => {
    snapshot.packs = catalog.slice(0, 2).map((item) => ({
      id: item.id,
      path: `mods/${item.id}.jar`,
      name: item.name,
      size: 1048576,
      state: item.id === 'copper' ? 'disabled' : 'enabled',
      metadata: metadata(item, file(item, '0.9')),
    }));
    updateItems = snapshot.packs.map((pack) => ({
      path: pack.path,
      provider: 'modrinth',
      projectId: pack.metadata?.projectId ?? '',
      currentVersionId: pack.metadata?.versionId ?? '',
      status: 'update',
      version: file(catalog.find((item) => item.id === pack.id) as ModCatalogProject, '1.0'),
    }));
    delayUpdates = new Promise<void>((resolve) => {
      releaseUpdates = resolve;
    });
    await open();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await check(page.locator('.mods-installed-row')).toHaveCount(2);
    await check(page.getByText('Checking updates…', { exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: 'Disable Evergreen', exact: true })).toBeEnabled();
    expect(writes).toHaveLength(0);
    releaseUpdates?.();
    await check(page.getByRole('button', { name: 'Prepare updates (2)' })).toBeVisible();
    await capture('mods-updates-en-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('mods-updates-en-mobile');
    await page.getByRole('button', { name: 'Prepare updates (2)' }).click();
    await check.poll(() => snapshot.roots.length).toBe(2);
    const selections = writes.filter((write) => write.path.endsWith('/selection'));
    expect(selections).toHaveLength(1);
    expect(snapshot.roots.map((root) => root.versionId)).toEqual(['evergreen-1_0', 'copper-1_0']);
    await check(page.getByRole('heading', { name: 'Review changes', exact: false })).toBeVisible();
    expect(writes.some((write) => write.path.endsWith('/apply'))).toBe(false);
    expect(updateReads).toBe(1);
  });
  it('does not call a partial update check up-to-date or replace manually queued choices', async () => {
    const item = catalog[0] as ModCatalogProject;
    snapshot.packs = [
      {
        id: item.id,
        path: 'mods/evergreen.jar',
        name: item.name,
        size: 12,
        state: 'enabled',
        metadata: metadata(item, file(item, '0.9')),
      },
    ];
    snapshot.roots = [
      {
        provider: 'modrinth',
        projectId: 'evergreen',
        versionId: 'evergreen-beta',
        forceIncompatible: false,
        optionalProjectIds: ['chosen-option'],
      },
    ];
    updateItems = [
      {
        path: 'mods/evergreen.jar',
        provider: 'modrinth',
        projectId: 'evergreen',
        currentVersionId: 'evergreen-0_9',
        status: 'limited',
      },
    ];
    await open();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await check(page.getByText('Some updates could not be checked', { exact: true })).toBeVisible();
    await check(page.getByText('Catalog mods are up to date')).toHaveCount(0);
    updateItems[0] = {
      ...(updateItems[0] as MinecraftModUpdates['items'][number]),
      status: 'update',
      version: file(item, '1.0'),
    };
    await page.getByRole('button', { name: 'Check updates', exact: true }).click();
    await check(page.getByText('Updates available: 1', { exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: 'Prepare updates (1)' })).toHaveCount(0);
    expect(snapshot.roots[0]?.versionId).toBe('evergreen-beta');
    expect(writes).toHaveLength(0);
  });
  it('checks again when Minecraft or Loader changes even if installed receipts are unchanged', async () => {
    const item = catalog[0] as ModCatalogProject;
    snapshot.packs = [
      {
        id: item.id,
        path: 'mods/evergreen.jar',
        name: item.name,
        size: 12,
        state: 'enabled',
        metadata: metadata(item, file(item, '0.9')),
      },
    ];
    await open();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await check(page.getByText('Catalog mods are up to date', { exact: true })).toBeVisible();
    expect(updateReads).toBe(1);
    snapshot.version = '26.1.2';
    await page.getByRole('button', { name: 'Refresh mods', exact: true }).click();
    await check.poll(() => updateReads).toBe(2);
    snapshot.loader = 'quilt';
    await page.getByRole('button', { name: 'Refresh mods', exact: true }).click();
    await check.poll(() => updateReads).toBe(3);
    expect(writes).toHaveLength(0);
  });
  it('does not reuse an alternative after the server target changes and groups shared roots accurately', async () => {
    snapshot.roots = ['evergreen', 'copper'].map((projectId) => ({
      provider: 'modrinth',
      projectId,
      optionalProjectIds: [],
      forceIncompatible: false,
    }));
    snapshot.blockers = [
      {
        provider: 'modrinth',
        projectId: 'shared',
        name: 'Shared Config',
        reason: 'incompatible-version',
        requiredBy: 'evergreen',
        requiredByName: 'Evergreen',
        roots: [
          { projectId: 'evergreen', name: 'Evergreen' },
          { projectId: 'copper', name: 'Copper Toolkit' },
        ],
      },
    ];
    await open();
    await page.getByRole('button', { name: 'Install (2)', exact: true }).click();
    await check(page.locator('.mods-blocker-chain')).toContainText('Evergreen, Copper Toolkit');
    await check(page.locator('.mods-blocker-chain')).not.toContainText(
      'Evergreen → Copper Toolkit',
    );
    await page.getByRole('button', { name: 'Find alternative for Evergreen', exact: true }).click();
    await check(page.getByRole('button', { name: 'Use 1.0', exact: true })).toBeVisible();
    expect(alternativeReads).toBe(1);
    await page.getByRole('button', { name: 'Back to Discover' }).click();
    snapshot.version = '26.1.2';
    await page.getByRole('button', { name: 'Refresh mods', exact: true }).click();
    await check.poll(() => snapshotReads).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Install (2)', exact: true }).click();
    await check(page.getByRole('button', { name: 'Use 1.0', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Find alternative for Evergreen', exact: true }).click();
    await check.poll(() => alternativeReads).toBe(2);
    expect(writes).toHaveLength(0);
  });
  it('reports a bounded update scan as partial even if every returned item is current', async () => {
    const item = catalog[0] as ModCatalogProject;
    snapshot.packs = [
      {
        id: item.id,
        path: 'mods/evergreen.jar',
        name: item.name,
        size: 12,
        state: 'enabled',
        metadata: metadata(item, file(item, '0.9')),
      },
    ];
    updatesLimited = true;
    await open();
    await page.getByRole('button', { name: 'Installed', exact: false }).first().click();
    await check(page.getByText('Some updates could not be checked', { exact: true })).toBeVisible();
    await check(page.getByText('Catalog mods are up to date')).toHaveCount(0);
  });
  it('rechecks old dependency diagnostics only after an explicit request', async () => {
    snapshot.roots = [
      {
        provider: 'modrinth',
        projectId: 'evergreen',
        optionalProjectIds: ['optional-choice'],
        forceIncompatible: false,
      },
    ];
    snapshot.blockers = [{ projectId: 'old-config', name: 'Old Config', reason: 'unavailable' }];
    await open();
    await page.getByRole('button', { name: 'Install (1)', exact: true }).click();
    await check(page.getByRole('button', { name: 'Recheck dependencies' })).toBeVisible();
    expect(writes).toHaveLength(0);
    await page.getByRole('button', { name: 'Recheck dependencies' }).click();
    await check(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    expect(snapshot.roots[0]?.optionalProjectIds).toEqual(['optional-choice']);
    expect(writes.filter((write) => write.path.endsWith('/selection'))).toHaveLength(1);
  });
});
