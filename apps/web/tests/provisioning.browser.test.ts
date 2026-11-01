import { mkdir } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
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
import type { ProvisioningSnapshot } from '../src/features/provisioning.api.js';

const id = '10000000-0000-4000-8000-000000000001';
const stages = ['preparing', 'installing', 'configuring', 'starting', 'ready'] as const;
/** Actual Console + SSE/fetch in Firefox; only the provider/backend responses are isolated. */
describe('post-create installation journey', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let snapshot: ProvisioningSnapshot;
  let installState = 'installing';
  let unavailable = false;
  let operationCleared = false;
  let holdNextRead = false;
  let releaseRead: (() => void) | undefined;
  let operationId: string | null | undefined;
  let runtimeState: string | undefined;
  let hideProvisioning = false;
  let holdOperation = false;
  let rejectOperation = false;
  let suppressOperationProgress = false;
  let releaseOperation: (() => void) | undefined;
  let reads: string[];
  let writes: Array<{ path: string; body: Record<string, unknown> }>;
  let errors: string[];
  const streams = new Set<ServerResponse>();
  function advance(
    stage: ProvisioningSnapshot['stage'],
    state: ProvisioningSnapshot['state'] = 'active',
  ) {
    snapshot = {
      ...snapshot,
      stage,
      state,
      updatedAt: new Date().toISOString(),
      completedAt: state === 'active' || state === 'uncertain' ? null : new Date().toISOString(),
      stages: stages.map((entry, index) => ({
        id: entry,
        state:
          state === 'completed' || index < stages.indexOf(stage)
            ? 'completed'
            : index > stages.indexOf(stage)
              ? 'pending'
              : state === 'failed'
                ? 'failed'
                : state === 'start-denied'
                  ? 'pending'
                  : 'active',
      })),
    };
    if (stage === 'starting' || state === 'completed' || state === 'start-denied')
      installState = 'installed';
    if (state === 'failed') installState = 'failed';
    for (const stream of streams)
      stream.write(`event: provisioning\ndata: ${JSON.stringify({ provisioning: snapshot })}\n\n`);
  }
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/provisioning-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [
        {
          name: 'installation-browser-fixture',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              const path = new URL(req.url ?? '/', 'http://fixture').pathname;
              if (path.startsWith('/provisioning-')) {
                res.setHeader('Content-Type', 'text/html');
                res.end(
                  '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Server setup</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/provisioning-page.tsx"></script></body></html>',
                );
                return;
              }
              if (!path.startsWith('/v1/')) return next();
              reads.push(path);
              if (path.endsWith('/provisioning/stream')) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.write(
                  `event: provisioning\ndata: ${JSON.stringify({ provisioning: snapshot })}\n\n`,
                );
                streams.add(res);
                req.on('close', () => streams.delete(res));
                return;
              }
              const json = (value: unknown) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(value));
              };
              if (path === '/v1/web/session') {
                const user = {
                  id,
                  name: 'Fixture',
                  email: 'fixture@example.test',
                  emailVerified: true,
                  locale: 'en',
                  role: 'user',
                  twoFactorEnabled: false,
                };
                return json({
                  context: {
                    actorUserId: id,
                    subjectUserId: id,
                    role: 'user',
                    sessionType: 'regular',
                    ownerElevation: false,
                  },
                  actor: user,
                  subject: user,
                });
              }
              if (path.endsWith('/provisioning')) {
                if (holdNextRead) {
                  holdNextRead = false;
                  const held = snapshot;
                  releaseRead = () => {
                    releaseRead = undefined;
                    json({ provisioning: held });
                  };
                  return;
                }
                if (unavailable) {
                  res.statusCode = 503;
                  return json({ code: 'integration_unavailable' });
                }
                return json({ provisioning: hideProvisioning ? null : snapshot });
              }
              if (path === `/v1/platform/servers/${id}`)
                return json({
                  id,
                  name: 'Panda valley',
                  gameId: 'minecraft',
                  runtimeId: 'fabric',
                  installationState: installState,
                  runtimeState:
                    runtimeState ?? (snapshot.state === 'completed' ? 'running' : 'offline'),
                  readiness: 'ready',
                  activeOperationId:
                    operationId !== undefined
                      ? operationId
                      : snapshot.state === 'active' && !operationCleared
                        ? snapshot.jobId
                        : null,
                  capabilities: { console: true },
                  permissions: { manage: true, operate: true },
                  permissionKeys: [
                    'console.read',
                    'console.power',
                    'console.command',
                    'files.read',
                    'settings.read',
                  ],
                  availableActions: {
                    console: installState === 'installed',
                    start: true,
                    stop: true,
                    restart: true,
                    kill: false,
                  },
                  limits: { memory: 2048, cpu: 100, disk: 4096 },
                });
              if (path.endsWith('/console')) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.write(
                  snapshot.state === 'start-denied'
                    ? 'event: status\ndata: {"type":"status","data":"offline"}\n\n'
                    : 'event: console\ndata: {"type":"console","data":"Starting net.minecraft.server.Main"}\n\nevent: status\ndata: {"type":"status","data":"running"}\n\n',
                );
                req.on('close', () => res.end());
                return;
              }
              if (path.endsWith('/connections'))
                return json({ ports: [], addressState: 'pending' });
              if (path.endsWith('/resources'))
                return json({
                  current_state: snapshot.state === 'start-denied' ? 'offline' : 'running',
                  resources: {
                    cpu_absolute: 1,
                    memory_bytes: 1024,
                    disk_bytes: 4096,
                    uptime: 2000,
                    network_rx_bytes: 0,
                    network_tx_bytes: 0,
                  },
                });
              if (path.endsWith('/metrics')) return json({ items: [], nextCursor: null });
              if (path.endsWith('/operations')) {
                let body = '';
                for await (const chunk of req) body += chunk;
                const input = JSON.parse(body) as Record<string, unknown>;
                writes.push({ path, body: input });
                if (holdOperation)
                  await new Promise<void>((resolve) => {
                    releaseOperation = resolve;
                  });
                if (rejectOperation) {
                  res.statusCode = 503;
                  return json({ code: 'integration_unavailable' });
                }
                const retryJobId = '10000000-0000-4000-8000-000000000004';
                if (suppressOperationProgress) return json({ jobId: retryJobId, serverId: id });
                snapshot = {
                  ...snapshot,
                  canReinstall: false,
                  canRetryProvision: false,
                  logs: [],
                  ...(input.action === 'retry-provision' ? { jobId: retryJobId } : {}),
                };
                advance('preparing');
                installState = 'installing';
                return json({ jobId: snapshot.jobId, serverId: id });
              }
              errors.push(`Unexpected endpoint: ${path}`);
              res.statusCode = 404;
              return json({ code: 'not_found' });
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
    reads = [];
    writes = [];
    errors = [];
    installState = 'installing';
    unavailable = false;
    operationCleared = false;
    holdNextRead = false;
    releaseRead = undefined;
    operationId = undefined;
    runtimeState = undefined;
    hideProvisioning = false;
    holdOperation = false;
    rejectOperation = false;
    suppressOperationProgress = false;
    releaseOperation = undefined;
    snapshot = {
      jobId: id,
      action: 'provision',
      stage: 'installing',
      state: 'active',
      startedAt: new Date(Date.now() - 19000).toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      errorCode: null,
      canReinstall: false,
      stages: [],
      logsAvailable: true,
      logs: [
        { id: '1', at: new Date().toISOString(), text: '[Installer] Downloading Minecraft 26.1' },
        {
          id: '2',
          at: new Date().toISOString(),
          text: '[Installer] Installing Fabric Loader 0.19.5',
        },
      ],
    };
    advance('installing');
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
    });
  });
  afterEach(async () => {
    releaseOperation?.();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/provisioning-last.png',
      fullPage: true,
    });
    await context.close();
    for (const stream of streams) stream.end();
    streams.clear();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  async function screenshot(name: string) {
    await page.screenshot({
      path: `.codex/local/m5-browser/screenshots/${name}.png`,
      fullPage: true,
    });
    const audit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      audit.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  it('shows installer output immediately, resumes after reload/navigation and hands off to runtime without focus theft', async () => {
    await page.goto(`${origin}provisioning-fixture`);
    await check(page.getByRole('heading', { name: 'Installing', exact: true })).toBeVisible();
    await check(page.getByRole('log')).toContainText('Installing Fabric Loader');
    expect(reads.filter((p) => p.endsWith('/console') || p.endsWith('/resources'))).toEqual([]);
    await screenshot('provisioning-installing-en-desktop');
    await page.getByRole('link', { name: 'Files', exact: true }).click();
    await page.getByRole('link', { name: 'Console', exact: true }).click();
    await check(page.getByRole('log')).toContainText('Downloading Minecraft');
    await page.reload();
    await check(page.getByRole('heading', { name: 'Installing', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Files', exact: true }).focus();
    advance('configuring');
    await check(
      page.getByRole('heading', { name: 'Applying your settings', exact: true }),
    ).toBeVisible();
    await check(page.getByRole('link', { name: 'Files', exact: true })).toBeFocused();
    operationCleared = true; // Server metadata can complete ahead of the final progress frame.
    advance('starting');
    await check(page.getByRole('log')).toContainText('Starting net.minecraft.server.Main');
    await check.poll(() => streams.size).toBe(1);
    advance('ready', 'completed');
    await check(page.getByText('Setup complete', { exact: true })).toBeVisible();
    await check(page.getByRole('textbox', { name: 'Command', exact: true })).toBeVisible();
    await check(page.locator('.provisioning-panel')).toHaveCount(0);
    await check(page.locator('.provisioning-log-history')).toHaveCount(0);
    expect(
      await page.locator('.provisioning-complete').evaluate((element) => ({
        position: getComputedStyle(element).position,
        pointerEvents: getComputedStyle(element).pointerEvents,
      })),
    ).toEqual({ position: 'fixed', pointerEvents: 'none' });
    await screenshot('provisioning-completed-en-desktop');
    await check(page.getByText('Setup complete', { exact: true })).toHaveCount(0, {
      timeout: 7000,
    });
    await page.getByRole('link', { name: 'Status', exact: true }).click();
    await page.locator('.provisioning-log-history summary').click();
    await check(page.locator('.provisioning-log-history')).toContainText(
      'Installing Fabric Loader',
    );
    await screenshot('provisioning-history-en-desktop');
    await page.reload();
    await page.locator('.provisioning-log-history summary').click();
    await check(page.locator('.provisioning-log-history')).toContainText(
      'Installing Fabric Loader',
    );
    await page.getByRole('link', { name: 'Console', exact: true }).click();
    await check(page.getByRole('textbox', { name: 'Command', exact: true })).toBeVisible();
    await check(page.getByText('Setup complete', { exact: true })).toHaveCount(0);
    await page.reload();
    await check(page.getByRole('textbox', { name: 'Command', exact: true })).toBeVisible();
    await check(page.getByText('Setup complete', { exact: true })).toHaveCount(0);
  });
  it('fades the live completion in place and leaves no historical confirmation after refresh', async () => {
    await page.goto(`${origin}provisioning-fixture`);
    await check(page.getByRole('heading', { name: 'Installing', exact: true })).toBeVisible();
    await check.poll(() => streams.size).toBe(1);
    await page.clock.install();
    advance('ready', 'completed');
    await check(page.locator('.provisioning-complete')).toHaveAttribute('data-leaving', 'false');
    await page.clock.fastForward(5001);
    await check(page.locator('.provisioning-complete')).toHaveAttribute('data-leaving', 'true');
    await page.clock.fastForward(240);
    await check(page.locator('.provisioning-complete')).toHaveCount(0);
  });
  it('keeps uncertain results separate from failure and offers only authorized confirmed reinstall', async () => {
    snapshot = { ...snapshot, errorCode: 'operation_uncertain' };
    advance('installing', 'uncertain');
    await page.goto(`${origin}provisioning-fixture`);
    await check(page.getByRole('heading', { name: 'Checking the outcome' })).toBeVisible();
    await screenshot('provisioning-uncertain-en-desktop');
    await check(page.getByRole('button', { name: 'Reinstall', exact: true })).toHaveCount(0);
    snapshot = { ...snapshot, errorCode: 'integration_unavailable', canReinstall: true };
    advance('installing', 'failed');
    await check(
      page.getByRole('heading', { name: 'Installation failed', exact: true }),
    ).toBeVisible();
    await screenshot('provisioning-failed-en-desktop');
    await page.getByRole('button', { name: 'Reinstall', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await check(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Reinstall', exact: true }).click();
    await dialog.getByRole('button', { name: 'Reinstall', exact: true }).click();
    await check(
      page.getByRole('heading', { name: 'Preparing your server', exact: true }),
    ).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({ action: 'reinstall', confirm: true });
  });
  it('retries failed preparation without reinstall or confirmation and resumes the new job', async () => {
    snapshot = {
      ...snapshot,
      canRetryProvision: true,
      canReinstall: false,
      errorCode: 'integration_unavailable',
      logs: [],
      logsAvailable: false,
    };
    advance('preparing', 'failed');
    await page.goto(`${origin}provisioning-fixture`);
    const button = page.getByRole('button', { name: 'Retry installation', exact: true });
    await check(button).toBeVisible();
    await check(page.getByRole('button', { name: 'Reinstall', exact: true })).toHaveCount(0);
    await check(
      page.getByText('Server creation did not start. You can retry installation.', { exact: true }),
    ).toBeVisible();
    await screenshot('provisioning-retry-before-provider-en-desktop');
    await button.focus();
    await page.keyboard.press('Enter');
    await check(
      page.getByRole('heading', { name: 'Preparing your server', exact: true }),
    ).toBeVisible();
    await check(page.getByRole('dialog')).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({
      action: 'retry-provision',
      failedJobId: id,
      idempotencyKey: expect.any(String),
    });
    expect(snapshot.jobId).not.toBe(id);
    await check(button).toHaveCount(0);
    expect(reads.filter((path) => path.endsWith('/console'))).toEqual([]);
  });
  it.each(['uncertain', 'failed'] as const)(
    'does not offer unauthorized retry for %s preparation',
    async (state) => {
      snapshot = {
        ...snapshot,
        canRetryProvision: state === 'uncertain',
        canReinstall: false,
        errorCode: state === 'uncertain' ? 'operation_uncertain' : 'integration_unavailable',
      };
      advance('preparing', state);
      await page.goto(`${origin}provisioning-fixture`);
      await check(
        page.getByRole('heading', {
          name: state === 'uncertain' ? 'Checking the outcome' : 'Installation failed',
          exact: true,
        }),
      ).toBeVisible();
      await check(
        page.getByRole('button', { name: 'Retry installation', exact: true }),
      ).toHaveCount(0);
      expect(writes).toEqual([]);
    },
  );
  it('shows rejected retry, blocks duplicate submits and reuses its idempotency key', async () => {
    snapshot = {
      ...snapshot,
      canRetryProvision: true,
      canReinstall: false,
      errorCode: 'integration_unavailable',
    };
    advance('preparing', 'failed');
    holdOperation = true;
    rejectOperation = true;
    await page.goto(`${origin}provisioning-fixture`);
    await page
      .getByRole('button', { name: 'Retry installation', exact: true })
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
    await check.poll(() => writes.length).toBe(1);
    await check(
      page.getByRole('button', { name: 'Requesting installation…', exact: true }),
    ).toBeDisabled();
    releaseOperation?.();
    await check(page.getByRole('alert')).toBeVisible();
    await check(
      page.getByRole('button', { name: 'Retry installation', exact: true }),
    ).toBeEnabled();
    await screenshot('provisioning-retry-rejected-en-desktop');
    holdOperation = false;
    rejectOperation = false;
    suppressOperationProgress = true;
    await page.getByRole('button', { name: 'Retry installation', exact: true }).click();
    await check.poll(() => writes.length).toBe(2);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    await check(page.getByRole('alert')).toHaveCount(0);
    await check(
      page.getByRole('button', { name: 'Retry installation', exact: true }),
    ).toBeDisabled();
    snapshot = {
      ...snapshot,
      jobId: '10000000-0000-4000-8000-000000000004',
      canRetryProvision: false,
    };
    installState = 'installing';
    operationId = snapshot.jobId;
    advance('preparing');
    // The terminal snapshot has no active stream. The accepted operation's next
    // authoritative server refresh discovers the new installation journey.
    await page.evaluate(
      "void import('/src/api/client.ts').then(({ queryClient }) => queryClient.invalidateQueries({ queryKey: ['server'] }))",
    );
    await check(
      page.getByRole('heading', { name: 'Preparing your server', exact: true }),
    ).toBeVisible();
  });
  it('offers the same non-destructive retry in Italian on mobile', async () => {
    snapshot = {
      ...snapshot,
      canRetryProvision: true,
      canReinstall: false,
      errorCode: 'integration_unavailable',
      logs: [],
      logsAvailable: false,
    };
    advance('preparing', 'failed');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await page.goto(`${origin}provisioning-fixture`);
    const button = page.getByRole('button', { name: 'Riprova installazione', exact: true });
    await check(button).toBeVisible();
    await check(page.getByRole('button', { name: 'Reinstalla', exact: true })).toHaveCount(0);
    await check(
      page.getByText('La creazione del server non è iniziata. Puoi riprovare l’installazione.', {
        exact: true,
      }),
    ).toBeVisible();
    await screenshot('provisioning-retry-before-provider-it-mobile');
    await button.click();
    await check(page.locator('.provisioning-panel')).toHaveAttribute('data-state', 'active');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({ action: 'retry-provision', failedJobId: id });
  });
  it('discovers durable modpack preparation on direct Console entry and refresh before an apply job exists', async () => {
    advance('preparing');
    installState = 'installed';
    operationId = null;
    snapshot = {
      ...snapshot,
      action: 'reinstall',
      stages: [],
      logs: [],
      logsAvailable: false,
      workflow: {
        titleKey: 'games.minecraft.sections.modpacks',
        statusKey: 'games.minecraft.modpacks.preparing',
        phaseKey: 'games.minecraft.modpacks.downloading',
        review: { sectionId: 'modpacks', labelKey: 'games.minecraft.modpacks.review' },
      },
    };
    await page.goto(`${origin}provisioning-fixture`);
    await check(page.locator('.provisioning-panel')).toBeVisible();
    await check(page.locator('.provisioning-panel')).toHaveAttribute('data-state', 'active');
    expect(reads).toContain(`/v1/servers/${id}/provisioning`);
    await page.reload();
    await check(page.locator('.provisioning-panel')).toBeVisible();
    await check(page.locator('.provisioning-panel')).toHaveAttribute('data-state', 'active');
    expect(writes).toEqual([]);
  });
  it('shows a modpack runtime uncertainty without active animation and links to its recovery review', async () => {
    advance('installing', 'uncertain');
    installState = 'installed';
    operationId = id;
    snapshot = {
      ...snapshot,
      action: 'reinstall',
      errorCode: 'operation_uncertain',
      stages: [],
      workflow: {
        titleKey: 'games.minecraft.sections.modpacks',
        statusKey: 'games.minecraft.modpacks.uncertain',
        phaseKey: 'games.minecraft.modpacks.changingRuntime',
        review: { sectionId: 'modpacks', labelKey: 'games.minecraft.modpacks.review' },
      },
    };
    await page.goto(`${origin}provisioning-fixture`);
    await check(
      page.getByRole('heading', { name: 'Check the installation outcome', exact: true }),
    ).toBeVisible();
    await check(page.getByText('Last step: Preparing runtime.', { exact: false })).toBeVisible();
    await check(
      page.getByRole('heading', { name: 'Preparing your server', exact: true }),
    ).toHaveCount(0);
    const panel = page.locator('.provisioning-panel');
    await check(panel).toHaveAttribute('data-state', 'uncertain');
    expect(
      await panel
        .locator('.provisioning-mark-unit i')
        .first()
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none');
    const elapsed = await panel.getByRole('timer').textContent();
    await page.clock.install();
    await page.clock.fastForward(3000);
    await check(panel.getByRole('timer')).toHaveText(elapsed ?? '');
    await check(page.getByRole('button', { name: 'Reinstall', exact: true })).toHaveCount(0);
    await screenshot('modpack-runtime-uncertain-en-desktop');
    const review = page.getByRole('link', { name: 'Review installation', exact: false });
    await check(review).toHaveAttribute('href', `/servers/${id}/game/modpacks?operation=${id}`);
    await review.focus();
    await page.keyboard.press('Enter');
    await check(page).toHaveURL(`${origin}servers/${id}/game/modpacks?operation=${id}`);
    expect(writes).toEqual([]);
    await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${origin}provisioning-fixture`);
    await check(
      page.getByRole('heading', { name: 'Verifica l’esito dell’installazione', exact: true }),
    ).toBeVisible();
    await screenshot('modpack-runtime-uncertain-it-mobile');
  });
  it('recovers a failed progress read without opening the runtime console prematurely', async () => {
    unavailable = true;
    await page.goto(`${origin}provisioning-fixture`);
    await check(
      page.getByRole('heading', { name: 'Progress unavailable', exact: true }),
    ).toBeVisible();
    expect(reads.filter((p) => p.endsWith('/console'))).toEqual([]);
    unavailable = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await check(page.getByRole('heading', { name: 'Installing', exact: true })).toBeVisible();
    await check(page.getByRole('log')).toContainText('Installing Fabric Loader');
  });
  it('discards installer output when stream access is revoked', async () => {
    await page.goto(`${origin}provisioning-fixture`);
    await check(page.getByRole('log')).toContainText('Installing Fabric Loader');
    await check.poll(() => streams.size).toBe(1);
    for (const stream of streams) stream.write('event: error\ndata: {"code":"forbidden"}\n\n');
    await check(
      page.getByText('You do not have permission to do this.', { exact: true }),
    ).toBeVisible();
    await check(page.getByRole('log')).not.toContainText('Installing Fabric Loader');
    await check.poll(() => streams.size).toBe(0);
    await check(page.getByRole('button', { name: 'Reinstall', exact: true })).toHaveCount(0);
  });
  it('shows a neutral loading skeleton until authoritative progress arrives', async () => {
    holdNextRead = true;
    await page.goto(`${origin}provisioning-fixture`);
    await check(page.getByRole('heading', { name: 'Loading installation progress' })).toBeVisible();
    await check(page.getByRole('heading', { name: 'Preparing your server' })).toHaveCount(0);
    await check(page.locator('.provisioning-panel')).toHaveAttribute('data-state', 'loading');
    await screenshot('provisioning-loading-en-desktop');
    releaseRead?.();
    await check(page.getByRole('heading', { name: 'Installing', exact: true })).toBeVisible();
  });
  it('keeps a large live transcript and ignores an older GET with the same job timestamp', async () => {
    await page.goto(`${origin}provisioning-fixture`);
    await check(page.getByRole('log')).toContainText('Installing Fabric Loader');
    await check.poll(() => streams.size).toBe(1);
    holdNextRead = true;
    await page.evaluate(
      "void import('/src/api/client.ts').then(({ queryClient }) => queryClient.invalidateQueries({ queryKey: ['provisioning'] }))",
    );
    await check.poll(() => Boolean(releaseRead)).toBe(true);
    const stamp = snapshot.updatedAt;
    snapshot = {
      ...snapshot,
      logs: Array.from({ length: 32 }, (_, index) => ({
        id: `large-${index}`,
        at: stamp,
        text: `${'x'.repeat(8160)} line-${index}-confirmed`,
      })),
    };
    for (const stream of streams)
      stream.write(`event: provisioning\ndata: ${JSON.stringify({ provisioning: snapshot })}\n\n`);
    await check(page.getByRole('log')).toContainText('line-31-confirmed');
    releaseRead?.();
    await check
      .poll(() =>
        page.evaluate(
          "import('/src/api/client.ts').then(({ queryClient }) => queryClient.isFetching({ queryKey: ['provisioning'] }))",
        ),
      )
      .toBe(0);
    await check(page.getByRole('log')).toContainText('line-31-confirmed');
    expect(snapshot.updatedAt).toBe(stamp);
    await check(page.locator('.provisioning-recovery')).toHaveCount(0);
  });
  it('discovers a new reinstall while the completed console stays mounted', async () => {
    await page.goto(`${origin}provisioning-fixture`);
    await check(page.getByRole('heading', { name: 'Installing', exact: true })).toBeVisible();
    await check.poll(() => streams.size).toBe(1);
    advance('ready', 'completed');
    await check(page.getByText('Setup complete', { exact: true })).toBeVisible();
    await check(page.getByRole('textbox', { name: 'Command', exact: true })).toBeVisible();
    snapshot = { ...snapshot, jobId: '10000000-0000-4000-8000-000000000002', action: 'reinstall' };
    installState = 'installing';
    advance('installing');
    holdNextRead = true;
    await page.evaluate(
      "void import('/src/api/client.ts').then(({ queryClient }) => queryClient.invalidateQueries({ queryKey: ['server'] }))",
    );
    await check(page.getByRole('heading', { name: 'Loading installation progress' })).toBeVisible();
    releaseRead?.();
    await check(page.getByRole('heading', { name: 'Installing', exact: true })).toBeVisible();
    await check.poll(() => streams.size).toBe(1);
    await check(page.getByRole('log')).toContainText('Installing Fabric Loader');
  });
  it('refreshes resolved capacity denial after a manual start and does not revive it when stopped', async () => {
    snapshot = { ...snapshot, errorCode: 'resources_unavailable' };
    advance('starting', 'start-denied');
    // Enter as a creation journey so the terminal snapshot is already cached.
    installState = 'installing';
    await page.goto(`${origin}provisioning-fixture`);
    await check(page.getByRole('heading', { name: 'Installed, not started' })).toBeVisible();
    installState = 'installed';
    operationId = '10000000-0000-4000-8000-000000000003';
    holdNextRead = true;
    await page.evaluate(
      "void import('/src/api/client.ts').then(({ queryClient }) => queryClient.invalidateQueries({ queryKey: ['server'] }))",
    );
    await check
      .poll(() =>
        page.evaluate(
          "import('/src/api/client.ts').then(({ queryClient }) => queryClient.getQueriesData({ queryKey: ['server'] })[0]?.[1]?.activeOperationId)",
        ),
      )
      .toBe(operationId);
    await check.poll(() => Boolean(releaseRead)).toBe(true);
    operationId = null;
    runtimeState = 'running';
    hideProvisioning = true;
    await page.evaluate(
      "void import('/src/api/client.ts').then(({ queryClient }) => queryClient.invalidateQueries({ queryKey: ['server'] }))",
    );
    await check
      .poll(() =>
        page.evaluate(
          "import('/src/api/client.ts').then(({ queryClient }) => queryClient.getQueriesData({ queryKey: ['provisioning'] }).find(([, data]) => data)?.[1]?.provisioning)",
        ),
      )
      .toBe(null);
    releaseRead?.();
    runtimeState = 'offline';
    await page.evaluate(
      "void import('/src/api/client.ts').then(({ queryClient }) => queryClient.invalidateQueries({ queryKey: ['server'] }))",
    );
    await check(page.locator('.provisioning-panel')).toHaveCount(0);
    await check(page.getByRole('textbox', { name: 'Command', exact: true })).toBeVisible();
  });
  it('renders compact Italian mobile progress with reduced motion and distinct capacity denial', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await page.goto(`${origin}provisioning-fixture`);
    await check(
      page.getByRole('heading', { name: 'Installazione in corso', exact: true }),
    ).toBeVisible();
    expect(
      await page
        .locator('.provisioning-mark-unit i')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
    await screenshot('provisioning-installing-it-mobile');
    snapshot = { ...snapshot, errorCode: 'resources_unavailable' };
    advance('starting', 'start-denied');
    await check(page.getByRole('heading', { name: 'Installato, non avviato' })).toBeVisible();
    await check(page.getByRole('button', { name: 'Reinstalla', exact: true })).toHaveCount(0);
    await screenshot('provisioning-capacity-it-mobile');
  });
});
