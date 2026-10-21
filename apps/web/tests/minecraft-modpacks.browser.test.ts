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
  MinecraftModpackOperation,
  MinecraftModpackSelection,
  MinecraftModpacksSnapshot,
} from '../../../games/minecraft/src/modpack-contracts.js';
import type {
  ModpackCatalogProject,
  ModpackCatalogVersion,
  ModpackProvider,
} from '../../../packages/content-providers/src/modpack-catalog.js';

const server = '10000000-0000-4000-8000-000000000001';
const base = `/v1/servers/${server}/minecraft/modpacks`;
const op = '20000000-0000-4000-8000-000000000001';
const target = { minecraftVersion: '1.21.1', loader: 'fabric' as const, loaderVersion: '0.16.14' };
const providers: ModpackProvider[] = [
  'modrinth',
  'curseforge',
  'ftb',
  'technic',
  'voidswrath',
  'atlauncher',
];
const project = (
  provider: ModpackProvider = 'modrinth',
  id = 'copper-valley',
): ModpackCatalogProject => ({
  provider,
  id,
  name: id === '318032' ? 'Antimatter Chemistry' : 'Copper Valley',
  summary:
    id === '318032'
      ? 'A quest-driven pack about chemistry and antimatter.'
      : 'A carefully balanced world of exploration, automation and small discoveries.',
  websiteUrl: 'https://example.test/copper-valley',
  authors: ['Valley team'],
  downloads: 123456,
});
const version = (
  id = '2.4',
  channel: ModpackCatalogVersion['channel'] = 'release',
): ModpackCatalogVersion => ({
  id,
  projectId: 'copper-valley',
  name: `Copper Valley ${id}`,
  version: id,
  minecraftVersions: ['1.21.1'],
  loaders: ['fabric'],
  channel,
  publishedAt: channel === 'beta' ? '2026-10-21T12:00:00Z' : '2026-10-20T12:00:00Z',
  bytes: 123456789,
  available: true,
  source: 'modrinth-index',
  target: { minecraftVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.14' },
});
describe('Minecraft Modpacks full-page experience', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let snapshot: MinecraftModpacksSnapshot;
  let writes: { path: string; body: Record<string, unknown> }[];
  let errors: string[];
  let providerAvailable = true;
  let pending = false;
  let prepareState: 'ready' | 'blocked' | 'uncertain' | 'failed' | 'error' = 'ready';
  let count = 0;
  let core: { activeOperationId: string; manage: boolean; state: string };
  let recoveryGate: Promise<void> | undefined;
  let recoveryResumes = false;
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/modpacks-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [
        {
          name: 'modpacks-fixture',
          configureServer(viteServer) {
            viteServer.middlewares.use(async (req, res, next) => {
              const url = new URL(req.url ?? '/', 'http://fixture');
              if (url.pathname === '/modpacks-fixture') {
                res.setHeader('Content-Type', 'text/html');
                res.end(
                  '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Modpacks</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/minecraft-modpacks-page.tsx"></script></body></html>',
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
                for await (const part of req) raw += part;
                body = raw ? JSON.parse(raw) : {};
                writes.push({ path: `${req.method} ${url.pathname}`, body });
              }
              if (url.pathname === `/v1/platform/servers/${server}`)
                return json({
                  id: server,
                  name: 'Fixture',
                  gameId: 'minecraft',
                  runtimeId: 'fabric',
                  runtimeState: 'stopped',
                  permissions: { read: true, manage: core.manage },
                  capabilities: { files: true },
                  activeOperationId: core.activeOperationId,
                });
              if (url.pathname === `/v1/platform/jobs/${core.activeOperationId}`)
                return json({ serverId: server, state: core.state, effectState: null });
              if (url.pathname === `/v1/servers/${server}/events/stream`) {
                res.statusCode = 204;
                return res.end();
              }
              if (url.pathname === base) return json(snapshot);
              if (url.pathname === `${base}/catalog`)
                return json({
                  providers: providers.map((id) => ({ id, available: providerAvailable })),
                });
              if (url.pathname === `${base}/catalog/categories`)
                return json({ items: [{ id: 'adventure', name: 'Adventure' }] });
              if (url.pathname === `${base}/catalog/search`)
                return json({
                  items: [project(url.searchParams.get('provider') as ModpackProvider)],
                  offset: 0,
                  limit: 20,
                  total: 1,
                });
              if (url.pathname.startsWith(`${base}/catalog/`)) {
                const [provider, projectId] = url.pathname
                  .slice(`${base}/catalog/`.length)
                  .split('/') as [ModpackProvider, string];
                if (url.pathname.endsWith('/versions'))
                  return json({
                    items: [version('2.5-beta', 'beta'), version(), version('2.3')],
                    offset: 0,
                    limit: 20,
                    total: 3,
                  });
                return json({
                  ...project(provider, projectId),
                  description:
                    '## A world worth exploring\n\nBuild a workshop, follow the rivers and discover new biomes.\n\n- Exploration and transport\n- Balanced progression\n- Cooperative play',
                  descriptionFormat: 'markdown',
                });
              }
              if (url.pathname === `${base}/prepare`) {
                count++;
                if (prepareState === 'error')
                  return json(
                    { code: 'internal_error', message: 'Failed', requestId: 'fixture' },
                    500,
                  );
                const selection = body as unknown as MinecraftModpackSelection;
                const provider = selection.provider;
                snapshot.operation = {
                  id: `20000000-0000-4000-8000-${String(count).padStart(12, '0')}`,
                  selection,
                  state: pending ? 'preparing' : prepareState,
                  phase: pending ? 'downloading' : 'ready',
                  progress: {
                    completedFiles: pending ? 24 : 104,
                    totalFiles: 104,
                    completedBytes: pending ? 40000000 : 123456789,
                    totalBytes: 123456789,
                  },
                  pack:
                    pending || prepareState === 'failed'
                      ? null
                      : {
                          project: project(provider, selection.projectId),
                          version: version(selection.versionId),
                        },
                  target:
                    prepareState === 'blocked'
                      ? { ...target, loader: 'forge', loaderVersion: '52.1.0' }
                      : target,
                  runtimeSupported: prepareState !== 'blocked',
                  planDigest: 'a'.repeat(64),
                  changes: {
                    write: 104,
                    remove: selection.mode === 'replace' ? 12 : 0,
                    preserve: 8,
                    bytes: 123456789,
                  },
                  deletePaths: selection.mode === 'replace' ? ['mods/old.jar'] : [],
                  blockers: prepareState === 'blocked' ? [{ reason: 'runtime' }] : [],
                  error: null,
                  backupId: null,
                  restartRequired: false,
                  createdAt: '2026-10-21T12:00:00Z',
                  updatedAt: '2026-10-21T12:00:00Z',
                };
                return json(snapshot);
              }
              if (url.pathname === `${base}/apply`) {
                const operation = snapshot.operation;
                if (!operation?.pack || !operation.target) return json({}, 409);
                operation.state = 'applied';
                operation.phase = 'complete';
                snapshot.installed = {
                  pack: operation.pack,
                  target: operation.target,
                  installedAt: '2026-10-21T12:00:00Z',
                  operationId: op,
                };
                return json(snapshot);
              }
              if (
                req.method === 'DELETE' &&
                url.pathname === `${base}/operations/${snapshot.operation?.id}`
              ) {
                snapshot.operation = null;
                return json(snapshot);
              }
              if (url.pathname.endsWith('/recover')) {
                await recoveryGate;
                if (recoveryResumes && snapshot.operation) {
                  snapshot.operation.state = 'apply_queued';
                  core.state = 'queued';
                }
                return json(snapshot);
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
    snapshot = { installed: null, operation: null };
    writes = [];
    errors = [];
    providerAvailable = true;
    pending = false;
    prepareState = 'ready';
    count = 0;
    core = { activeOperationId: op, manage: true, state: 'uncertain' };
    recoveryGate = undefined;
    recoveryResumes = false;
    context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('nh.locale', 'en');
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
  async function open() {
    await page.goto(`${origin}modpacks-fixture`);
    await check(
      page.getByRole('button', { name: 'About Copper Valley', exact: true }),
    ).toBeVisible();
  }
  async function details() {
    await page.getByRole('button', { name: 'About Copper Valley', exact: true }).click();
    await check(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
  }
  async function openPausedCore() {
    snapshot.operation = {
      id: op,
      selection: {
        provider: 'modrinth',
        projectId: 'copper-valley',
        versionId: '2.4',
        mode: 'install',
        worldPolicy: 'preserve',
        fileDecisions: {},
        idempotencyKey: 'paused-installation',
      },
      state: 'uncertain',
      phase: 'runtime',
      progress: null,
      pack: { project: project(), version: version() },
      target,
      runtimeSupported: true,
      planDigest: 'a'.repeat(64),
      changes: { write: 104, remove: 0, preserve: 8, bytes: 123456789 },
      deletePaths: [],
      blockers: [],
      error: 'runtime_transition_uncertain',
      backupId: null,
      restartRequired: false,
      createdAt: '2026-10-21T12:00:00Z',
      updatedAt: '2026-10-21T12:00:00Z',
    };
    await page.goto(`${origin}modpacks-fixture?core&operation=${op}`);
    await check(page.locator('.modpacks-recovery button')).toBeVisible();
  }
  it('recovers the exact paused active operation through Core without unlocking other mutations', async () => {
    await openPausedCore();
    const recover = page.getByRole('button', { name: 'Verify and resume', exact: true });
    await check(recover).toBeEnabled();
    await check(page.getByRole('button', { name: 'Discard preparation' })).toBeDisabled();
    await check(page.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-core-recovery-desktop-en.png',
      fullPage: true,
    });
    let release = () => {};
    recoveryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    recoveryResumes = true;
    try {
      await recover.click();
      await check(recover).toBeDisabled();
      await recover.evaluate((button: HTMLButtonElement) => button.click());
      expect(writes).toHaveLength(1);
      expect(writes[0]?.path).toBe(`POST ${base}/operations/${op}/recover`);
    } finally {
      release();
    }
    await check(recover).toHaveCount(0);
    await check(page.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
    expect(writes).toHaveLength(1);
  });
  it.each(['different-operation', 'running', 'read-only'] as const)(
    'keeps recovery locked through Core for %s',
    async (scenario) => {
      if (scenario === 'different-operation')
        core.activeOperationId = '20000000-0000-4000-8000-000000000002';
      if (scenario === 'running') core.state = 'running';
      if (scenario === 'read-only') core.manage = false;
      await openPausedCore();
      await check(
        page.getByRole('button', { name: 'Verify and resume', exact: true }),
      ).toBeDisabled();
      expect(writes).toEqual([]);
    },
  );
  it.each(['server', 'game-section', 'game-operation', 'minecraft-modpacks'] as const)(
    'locks paused recovery after a failed %s refresh',
    async (query) => {
      await openPausedCore();
      const recover = page.getByRole('button', { name: 'Verify and resume', exact: true });
      await check(recover).toBeEnabled();
      const path =
        query === 'server'
          ? `/v1/platform/servers/${server}`
          : query === 'game-operation'
            ? `/v1/platform/jobs/${op}`
            : base;
      await page.route(`**${path}`, (route) =>
        route.fulfill({ status: 503, json: { code: 'internal_error' } }),
      );
      await page.evaluate(
        `import('/src/api/client.ts').then(({ queryClient }) => queryClient.invalidateQueries({ queryKey: ['${query}'] }))`,
      );
      await check(page.getByRole('alert')).toBeVisible();
      await check(recover).toBeDisabled();
      expect(writes).toEqual([]);
    },
  );
  it('keeps paused Core recovery usable on Italian mobile', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await openPausedCore();
    await check(
      page.getByRole('button', { name: 'Verifica e riprendi', exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-core-recovery-mobile-it.png',
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
    expect(writes).toEqual([]);
  });
  it('browses six catalogs and details without preparing; stable is selected by default', async () => {
    await open();
    await details();
    await check(page.getByText('Latest stable', { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await check(page.getByRole('heading', { name: 'A world worth exploring' })).toBeVisible();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-discover-desktop-en.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Back to Discover' }).click();
    await page.getByRole('combobox', { name: 'Catalog', exact: true }).click();
    await check(page.getByRole('option')).toHaveCount(6);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-providers-desktop-en.png',
      fullPage: true,
    });
    expect(
      (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
        ['serious', 'critical'].includes(item.impact ?? ''),
      ),
    ).toEqual([]);
  });
  it('filters categories in the catalog and retains the chosen category on Back', async () => {
    await open();
    const request = page.waitForRequest(
      (request) =>
        request.url().includes('/catalog/search?') &&
        new URL(request.url()).searchParams.get('category') === 'adventure',
    );
    await page.getByRole('button', { name: 'Adventure', exact: true }).click();
    await request;
    await details();
    await page.getByRole('button', { name: 'Back to Discover' }).click();
    await check(page.getByRole('button', { name: 'Adventure', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-categories-desktop-en.png',
      fullPage: true,
    });
    expect(writes).toEqual([]);
  });
  it('installs the stable version with a durable intent and goes directly to Console', async () => {
    await open();
    await details();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await check(page).toHaveURL(new RegExp(`/servers/${server}/console$`));
    expect(await page.evaluate(() => window.history.state.usr.provisioningJobId)).toBe(
      snapshot.operation?.id,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({
      versionId: '2.4',
      worldPolicy: 'reset',
      install: { backupBefore: false },
    });
  });
  it('supports keyboard provider choice and restores focus after closing details', async () => {
    await open();
    await page.getByRole('searchbox', { name: 'Search modpacks' }).focus();
    await page.keyboard.press('Tab');
    const catalog = page.getByRole('combobox', { name: 'Catalog', exact: true });
    await check(catalog).toBeFocused();
    await page.keyboard.press('Enter');
    await check(page.getByRole('option')).toHaveCount(6);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await check(catalog).toHaveText('CurseForge');
    await check(catalog).toBeFocused();
    await check(page.locator('.mods-results')).toHaveAttribute('aria-busy', 'false');
    const opener = page.getByRole('button', { name: 'About Copper Valley', exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    await check(page.getByRole('heading', { name: 'Copper Valley', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await check(page.getByRole('complementary', { name: 'About Copper Valley' })).toHaveCount(0);
    await check(opener).toBeFocused();
    expect(writes).toEqual([]);
  });
  it('preserves search and focus when returning from full-page details', async () => {
    await open();
    await page.getByRole('searchbox').fill('Copper');
    await details();
    await check(page.getByRole('searchbox')).toBeHidden();
    await page.getByRole('button', { name: 'Back to Discover' }).click();
    await check(page.getByRole('searchbox')).toHaveValue('Copper');
    await check(
      page.getByRole('button', { name: 'About Copper Valley', exact: true }),
    ).toBeFocused();
    expect(writes).toEqual([]);
  });
  it('restores unresolved pack metadata after reload and retries every original choice with safe intent keys', async () => {
    const failed: MinecraftModpackOperation = {
      id: '20000000-0000-4000-8000-000000000099',
      selection: {
        provider: 'curseforge',
        projectId: '318032',
        versionId: '5871978',
        mode: 'replace',
        worldPolicy: 'reset',
        fileDecisions: { 'config/custom.cfg': 'keep-local', 'config/pack.cfg': 'use-pack' },
        idempotencyKey: 'failed-intent',
      },
      state: 'failed',
      phase: 'downloading',
      progress: null,
      pack: null,
      target: null,
      runtimeSupported: false,
      planDigest: null,
      changes: null,
      deletePaths: [],
      blockers: [],
      error: 'validation_failed',
      backupId: null,
      restartRequired: false,
      createdAt: '2026-10-21T12:00:00Z',
      updatedAt: '2026-10-21T12:00:00Z',
    };
    snapshot.operation = failed;
    await page.goto(`${origin}modpacks-fixture`);
    await check(page.locator('.modpacks-selection-strip')).toContainText('Antimatter Chemistry');
    await page.getByRole('button', { name: 'Review installation', exact: true }).click();
    await check(
      page.getByRole('heading', { name: 'Antimatter Chemistry', exact: true }),
    ).toBeVisible();
    await check(page.getByText(project('curseforge', '318032').summary)).toBeVisible();
    expect(writes).toEqual([]);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-failed-metadata-desktop-en.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-failed-metadata-mobile-en.png',
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
        ['serious', 'critical'].includes(item.impact ?? ''),
      ),
    ).toEqual([]);
    const retry = page
      .locator('.modpacks-recovery')
      .getByRole('button', { name: 'Try again', exact: true });
    prepareState = 'error';
    await retry.click();
    await check(page.getByRole('alert')).toBeVisible();
    await check(retry).toBeEnabled();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`POST ${base}/prepare`);
    const retryKey = writes[0]?.body.idempotencyKey;
    expect(retryKey).not.toBe(failed.selection.idempotencyKey);
    expect(writes[0]?.body).toEqual({ ...failed.selection, idempotencyKey: retryKey });
    expect(snapshot.operation?.id).toBe(failed.id);

    prepareState = 'failed';
    await retry.click();
    await check(page.getByRole('alert')).toHaveCount(0);
    await check(retry).toBeEnabled();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(snapshot.operation?.id).not.toBe(failed.id);

    pending = true;
    prepareState = 'ready';
    await retry.click();
    await check(page.getByText('24 / 104 files')).toBeVisible();
    expect(writes).toHaveLength(3);
    expect(writes[2]?.body.idempotencyKey).not.toBe(retryKey);
    expect(writes[2]?.body).toEqual({
      ...failed.selection,
      idempotencyKey: writes[2]?.body.idempotencyKey,
    });
    await check(
      page.getByRole('heading', { name: 'Antimatter Chemistry', exact: true }),
    ).toBeVisible();
    await check(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  });
  it('defaults replacement to reset without backup, with explicit opt-ins', async () => {
    snapshot.installed = {
      pack: {
        project: { ...project(), id: 'previous', name: 'Previous pack' },
        version: version('1.0'),
      },
      target,
      installedAt: '2026-10-01T12:00:00Z',
      operationId: op,
    };
    await page.goto(`${origin}modpacks-fixture`);
    await page.getByRole('button', { name: 'Replace pack', exact: true }).click();
    await details();
    await check(page.getByRole('checkbox', { name: 'Keep worlds', exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await check(page).toHaveURL(new RegExp(`/servers/${server}/console$`));
    expect(writes[0]?.body).toMatchObject({
      mode: 'replace',
      worldPolicy: 'reset',
      install: { backupBefore: false },
    });
  });
  it('supports Italian mobile review without overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await page.goto(`${origin}modpacks-fixture`);
    await page.getByRole('button', { name: 'Informazioni su Copper Valley', exact: true }).click();
    await check(page.getByRole('button', { name: 'Installa', exact: true })).toBeEnabled();
    await check(page.getByRole('heading', { name: 'A world worth exploring' })).toBeVisible();
    await page.mouse.click(380, 20);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-review-mobile-it.png',
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
        ['serious', 'critical'].includes(item.impact ?? ''),
      ),
    ).toEqual([]);
  });
  it('keeps the loading footprint and exposes the installed empty state', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${base}`, async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto(`${origin}modpacks-fixture`);
      await check(
        page.getByRole('status', { name: 'Loading modpacks', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: '.codex/local/m5-browser/screenshots/modpacks-loading-desktop-en.png',
        fullPage: true,
      });
    } finally {
      release();
    }
    await check(
      page.getByRole('button', { name: 'About Copper Valley', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Installed pack', exact: true }).click();
    await check(page.getByText('No modpack installed', { exact: true })).toBeVisible();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-empty-desktop-en.png',
      fullPage: true,
    });
    expect(writes).toEqual([]);
  });
  it('shows unavailable catalogs without starting writes', async () => {
    providerAvailable = false;
    await page.goto(`${origin}modpacks-fixture`);
    await check(page.getByText('This catalog is unavailable.')).toBeVisible();
    expect(writes).toEqual([]);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-unavailable-desktop-en.png',
      fullPage: true,
    });
  });
  it('shows an unsupported runtime without offering apply', async () => {
    prepareState = 'blocked';
    await open();
    await details();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await page.goto(`${origin}modpacks-fixture?operation=${op}`);
    await check(page.getByText('Forge is not available yet.', { exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-blocked-desktop-en.png',
      fullPage: true,
    });
    expect(writes.filter((write) => write.path.endsWith('/apply'))).toHaveLength(0);
  });
  it('keeps uncertain effects separate from retrying installation', async () => {
    prepareState = 'uncertain';
    await open();
    await details();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await page.goto(`${origin}modpacks-fixture?operation=${op}`);
    await check(page.getByRole('button', { name: 'Verify and resume', exact: true })).toBeVisible();
    expect(writes).toHaveLength(1);
    await check(
      page.getByText('Verify the last step and resume this installation when possible.'),
    ).toBeVisible();
    await check(page.getByRole('button', { name: 'Discard preparation' })).toBeDisabled();
    await page.getByRole('button', { name: 'Verify and resume', exact: true }).click();
    expect(writes.at(-1)?.path).toBe(`POST ${base}/operations/${op}/recover`);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-uncertain-desktop-en.png',
      fullPage: true,
    });
  });
  it('retains user selection and reports preparation failures', async () => {
    prepareState = 'error';
    await open();
    await details();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await check(page.getByRole('alert')).toBeVisible();
    await check(page.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/modpacks-error-desktop-en.png',
      fullPage: true,
    });
    expect(writes).toHaveLength(1);
  });
  it('checks for updates without entering details when already current', async () => {
    snapshot.installed = {
      pack: { project: project(), version: version() },
      target,
      installedAt: '2026-10-01T12:00:00Z',
      operationId: op,
    };
    await page.goto(`${origin}modpacks-fixture`);
    await page.getByRole('button', { name: 'Check for Updates', exact: true }).click();
    await check(page.getByText('You’re up to date', { exact: true })).toBeVisible();
    await check(page.locator('.modpacks-details')).toHaveCount(0);
    expect(writes).toEqual([]);
  });
  it('opens an available update directly and installs an explicitly selected version', async () => {
    snapshot.installed = {
      pack: {
        project: project(),
        version: { ...version('2.3'), publishedAt: '2026-09-01T12:00:00Z' },
      },
      target,
      installedAt: '2026-10-01T12:00:00Z',
      operationId: op,
    };
    await page.goto(`${origin}modpacks-fixture`);
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await details();
    await page.getByRole('button', { name: 'Version', exact: true }).click();
    await page.locator('.mods-version-option').filter({ hasText: '2.3' }).click();
    await page.getByRole('button', { name: 'Installed pack', exact: true }).click();
    await page.getByRole('button', { name: 'Check for Updates', exact: true }).click();
    await check(page.locator('.modpacks-details')).toBeVisible();
    await check(page.getByRole('button', { name: 'Version', exact: true })).toHaveText('2.4');
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Version', exact: true }).click();
    await page.locator('.mods-version-option').filter({ hasText: '2.5-beta' }).click();
    await page.getByRole('checkbox', { name: 'Keep worlds', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Create a backup first', exact: true }).check();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await check(page).toHaveURL(new RegExp(`/servers/${server}/console$`));
    expect(writes[0]?.body).toMatchObject({
      mode: 'update',
      versionId: '2.5-beta',
      worldPolicy: 'preserve',
      install: { backupBefore: true },
    });
  });
  it('keeps read-only viewers from preparing a pack', async () => {
    await page.goto(`${origin}modpacks-fixture?readonly`);
    await details();
    await check(page.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
    expect(writes).toEqual([]);
  });
});
