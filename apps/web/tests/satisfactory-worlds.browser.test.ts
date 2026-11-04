import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, expect as check, chromium } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let vite: ViteDevServer, browser: Browser, origin: string;
let progressive = false;
let finishStream: (() => void) | undefined;
let responseEnded = false;
const shots = 'docs/screenshots/m6';
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    cacheDir: `${process.cwd()}/.codex/local/satisfactory-worlds-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'satisfactory-worlds-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (progressive && req.url?.endsWith('/worlds/stream')) {
              res.setHeader('content-type', 'application/x-ndjson');
              const events = worldEvents(example);
              for (const event of events.slice(0, -2)) res.write(`${JSON.stringify(event)}\n`);
              res.flushHeaders();
              finishStream = () => {
                responseEnded = true;
                res.end(
                  `${events
                    .slice(-2)
                    .map((event) => JSON.stringify(event))
                    .join('\n')}\n`,
                );
              };
              req.on('close', () => {
                finishStream = undefined;
              });
              return;
            }
            if (!req.url?.startsWith('/satisfactory-worlds-fixture')) return next();
            res.setHeader('content-type', 'text/html');
            res.end(
              '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Satisfactory</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/satisfactory-worlds-page.tsx"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await vite.listen();
  origin = vite.resolvedUrls?.local[0] ?? '';
  browser = await chromium.launch({
    headless: true,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
    },
  });
  await mkdir(shots, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  await vite?.close();
});
const example = {
  sessions: [
    {
      sessionName: 'Northern factory',
      saveHeaders: [
        {
          saveVersion: 46,
          mapName: 'Persistent_Level',
          mapOptions: '',
          saveName: 'Factory_autosave_0',
          sessionName: 'Northern factory',
          saveDateTime: '2026-11-02T10:00:00Z',
          playDurationSeconds: 72000,
          buildVersion: 400001,
          isModdedSave: true,
          isEditedSave: false,
          isCreativeModeEnabled: false,
        },
      ],
    },
  ],
  currentSessionIndex: 0,
};
const retention = {
  defaultKeep: 5,
  minimumKeep: 1,
  maximumKeep: 100,
  environmentLocked: false,
  policies: [],
};
function worldEvents(worlds: typeof example, phase = 'ready', source = 'live') {
  return [
    {
      type: 'state',
      phase: phase === 'ready' ? 'refreshing' : phase,
      configured: true,
      hasSnapshot: source === 'cache',
    },
    { type: 'begin', source, observedAt: Date.parse('2026-11-02T10:00:00Z') },
    ...worlds.sessions.flatMap((session, index) => [
      { type: 'session', source, index, sessionName: session.sessionName },
      ...session.saveHeaders.map((save) => ({ type: 'save', source, sessionIndex: index, save })),
    ]),
    {
      type: 'complete',
      source,
      currentSessionIndex: worlds.currentSessionIndex,
      observedAt: Date.parse('2026-11-02T10:00:00Z'),
    },
    { type: 'state', phase, configured: true, hasSnapshot: true },
  ];
}
const streamBody = (worlds: typeof example, phase = 'ready', source = 'live') => ({
  contentType: 'application/x-ndjson',
  body: `${worldEvents(worlds, phase, source)
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`,
});
it('confirms load, prevents save collisions, preserves errors, searches and uses shared file transfer navigation', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const calls: { path: string; body: unknown }[] = [];

  let failLoad = true;
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/retention')) return route.fulfill({ json: retention });
    if (path.endsWith('/worlds/stream')) return route.fulfill(streamBody(example));
    calls.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith('/load') && failLoad)
      return route.fulfill({
        status: 503,
        json: { error: { code: 'integration_unavailable', messageKey: 'web.errors.request' } },
      });
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}satisfactory-worlds-fixture`);
  await check(page.getByRole('heading', { name: 'Northern factory' })).toBeVisible({
    timeout: 15000,
  });
  await page.getByText('Import and export saves', { exact: true }).click();
  await page.getByText('Save history', { exact: true }).click();
  await check(page.locator('strong', { hasText: /^Autosave$/ })).toBeVisible();
  await check(page.getByRole('link', { name: 'Upload or download save files' })).toHaveAttribute(
    'href',
    /files\?directory=\.config%2FEpic%2FFactoryGame%2FSaved%2FSaveGames$/,
  );
  await page.screenshot({ path: `${shots}/satisfactory-worlds-desktop-en.png`, fullPage: true });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Save world', exact: true }).click();
  await page.getByLabel('Save name', { exact: true }).fill('Factory_autosave_0');
  await check(
    page.getByRole('dialog').getByRole('button', { name: 'Save world', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Save name', { exact: true }).fill('Before_Update');
  await page.getByRole('dialog').getByRole('button', { name: 'Save world', exact: true }).click();
  await check(page.getByRole('dialog')).toBeHidden();
  expect(calls[0]?.body).toEqual({ saveName: 'Before_Update' });
  await page.getByRole('button', { name: 'Load Factory_autosave_0' }).click();
  await check(page.getByRole('dialog')).toContainText(
    'The current world is saved before switching',
  );
  expect(calls).toHaveLength(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Load save', exact: true }).click();
  await check(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.screenshot({ path: `${shots}/satisfactory-worlds-error-en.png`, fullPage: true });
  failLoad = false;
  await page.getByRole('dialog').getByRole('button', { name: 'Load save', exact: true }).click();
  await check(page.getByRole('dialog')).toBeHidden();
  expect(calls.at(-1)?.body).toEqual({ saveName: 'Factory_autosave_0', confirm: true });
  await page.getByRole('searchbox', { name: 'Search worlds', exact: true }).fill('missing');
  await check(page.getByText('No matching worlds.')).toBeVisible();
  await context.close();
});
it('shows empty and loading states, creates a world with confirmation, and reads snapshots while offline', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const nativeReads: string[] = [],
    mutations: unknown[] = [];
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/retention')) return route.fulfill({ json: retention });
    if (path.endsWith('/worlds/stream')) {
      nativeReads.push(path);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return route.fulfill(
        page.url().includes('offline')
          ? streamBody(example, 'offline', 'cache')
          : streamBody({ sessions: [], currentSessionIndex: -1 }),
      );
    }
    mutations.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}satisfactory-worlds-fixture`);
  await check(page.getByText('No saves available. Create a world to begin.')).toBeVisible();
  await page.screenshot({ path: `${shots}/satisfactory-worlds-empty-en.png`, fullPage: true });
  await page.getByRole('button', { name: 'Create world', exact: true }).click();
  await page.getByLabel('Session name').fill('New factory');
  await page.getByRole('dialog').getByRole('button', { name: 'Create world', exact: true }).click();
  await check(page.getByRole('dialog')).toBeHidden();
  expect(mutations).toEqual([{ sessionName: 'New factory', confirm: true }]);
  await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
  await page.goto(`${origin}satisfactory-worlds-fixture?offline&readonly`);
  await check(
    page.getByText(
      'Il server è spento. Le informazioni salvate restano disponibili; avvialo per gestire i salvataggi.',
    ),
  ).toBeVisible();
  await check(page.getByRole('heading', { name: 'Northern factory' })).toBeVisible();
  await page.getByText('Cronologia salvataggi', { exact: true }).click();
  const before = nativeReads.length;
  await page.waitForTimeout(500);
  expect(nativeReads.length).toBe(before);
  await check(page.getByRole('button', { name: 'Crea mondo' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `${shots}/satisfactory-worlds-offline-mobile-it.png`,
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await context.close();
});
it('renders the first world before the stream ends and gates mutations until native readiness', async () => {
  progressive = true;
  responseEnded = false;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.route('**/v1/**', (route) =>
    new URL(route.request().url()).pathname.endsWith('/retention')
      ? route.fulfill({ json: retention })
      : route.continue(),
  );
  try {
    await page.goto(`${origin}satisfactory-worlds-fixture`);
    await check(page.getByRole('heading', { name: 'Northern factory' })).toBeVisible();
    expect(responseEnded).toBe(false);
    await page.getByText('Save history', { exact: true }).click();
    await check(page.getByRole('button', { name: 'Load Factory_autosave_0' })).toBeDisabled();
    await check(page.locator('strong', { hasText: /^Autosave$/ })).toBeVisible();
    expect(finishStream).toBeTypeOf('function');
    finishStream?.();
    await check(page.getByRole('button', { name: 'Load Factory_autosave_0' })).toBeEnabled();
    expect(responseEnded).toBe(true);
  } finally {
    finishStream?.();
    progressive = false;
    await context.close();
  }
});
it('retains cached worlds during startup and failed live refreshes, labels proven safety saves and edits retention', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }),
    page = await context.newPage();
  let mode = 'cache';
  const policies: { sessionName: string; keep: number }[] = [];
  const withSafety = structuredClone(example);
  const first = withSafety.sessions[0]?.saveHeaders[0];
  if (first)
    withSafety.sessions[0]?.saveHeaders.push({
      ...first,
      saveName: 'nh-stop-10000000-0000-4000-8000-000000000001',
    });
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/retention')) {
      if (route.request().method() === 'PUT') policies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ...retention, policies } });
    }
    const events = worldEvents(withSafety, mode === 'cache' ? 'offline' : 'starting', 'cache');
    events.splice(-2, 0, {
      type: 'classification',
      source: 'cache',
      saveNames: ['nh-stop-10000000-0000-4000-8000-000000000001'],
    } as never);
    if (mode === 'starting')
      events.push(
        { type: 'begin', source: 'live', observedAt: Date.now() },
        { type: 'session', source: 'live', index: 0, sessionName: 'Interrupted live data' },
        { type: 'state', phase: 'starting', configured: true, hasSnapshot: true },
      );
    if (mode === 'error')
      events.push(
        { type: 'begin', source: 'live', observedAt: Date.now() },
        { type: 'session', source: 'live', index: 0, sessionName: 'Partial data' },
        { type: 'error', code: 'integration_unavailable' } as never,
      );
    return route.fulfill({
      contentType: 'application/x-ndjson',
      body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    });
  });
  await page.goto(`${origin}satisfactory-worlds-fixture?offline`);
  await check(page.getByRole('heading', { name: 'Northern factory' })).toBeVisible();
  await page.getByText('Save history', { exact: true }).click();
  await check(page.locator('strong', { hasText: 'Platform safety save' })).toBeVisible();
  await check(
    page.getByText('nh-stop-10000000-0000-4000-8000-000000000001.sav', { exact: true }),
  ).toBeHidden();
  await page.getByText('Safety save retention', { exact: true }).click();
  await page.getByLabel('Safety saves to keep').fill('8');
  await page.getByRole('button', { name: 'Save retention', exact: true }).click();
  await check(page.getByRole('button', { name: 'Save retention', exact: true })).toBeDisabled();
  expect(policies).toEqual([{ sessionName: 'Northern factory', keep: 8 }]);
  mode = 'starting';
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture-runtime', { detail: 'starting' })),
  );
  await check(
    page.getByText(
      'The server is starting. Saved worlds remain visible while the game becomes ready.',
    ),
  ).toBeVisible();
  await check(page.getByRole('heading', { name: 'Northern factory' })).toBeVisible();
  await check(page.getByRole('alert')).toHaveCount(0);
  await check(page.getByRole('heading', { name: 'Interrupted live data' })).toHaveCount(0);
  await check(
    page.getByRole('button', { name: 'Load latest save of Northern factory' }),
  ).toBeDisabled();
  await page.screenshot({
    path: `${shots}/satisfactory-worlds-starting-mobile-en.png`,
    fullPage: true,
  });
  mode = 'error';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await check(page.getByRole('alert')).toBeVisible();
  await check(page.getByRole('heading', { name: 'Northern factory' })).toBeVisible();
  await check(page.getByRole('heading', { name: 'Partial data' })).toHaveCount(0);
  await page.getByRole('heading', { name: 'Northern factory' }).click();
  await page.mouse.move(0, 0);
  await check(page.getByRole('tooltip')).toBeHidden();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await context.close();
});
it('bounds rendered save history for large worlds and filters proven safety saves', async () => {
  const context = await browser.newContext(),
    page = await context.newPage();
  const large = structuredClone(example),
    template = example.sessions[0]?.saveHeaders[0];
  if (!template || !large.sessions[0]) throw new Error('missing_fixture');
  large.sessions[0].saveHeaders = Array.from({ length: 2500 }, (_, index) => ({
    ...template,
    saveName: `Checkpoint_${index}`,
  }));
  await page.route('**/v1/**', (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/retention'))
      return route.fulfill({ json: retention });
    const events = worldEvents(large);
    for (let index = 0; index < 50; index++)
      events.splice(-2, 0, {
        type: 'classification',
        source: 'live',
        saveNames: [`Checkpoint_${index}`],
      } as never);
    return route.fulfill({
      contentType: 'application/x-ndjson',
      body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    });
  });
  await page.goto(`${origin}satisfactory-worlds-fixture`);
  await check(page.getByText('2,500 saves', { exact: true })).toBeVisible();
  await check(page.locator('.satisfactory-save-list > li')).toHaveCount(0);
  await page.getByText('Save history', { exact: true }).click();
  await check(page.locator('.satisfactory-save-list > li')).toHaveCount(20);
  await check(page.getByText('1 of 125', { exact: true })).toBeVisible();
  await page.getByLabel('Save type', { exact: true }).selectOption('safety');
  await check(page.getByText('1 of 3', { exact: true })).toBeVisible();
  await check(page.locator('.satisfactory-save-list strong')).toHaveText(
    Array(20).fill('Platform safety save'),
  );
  await page.getByRole('searchbox', { name: 'Search saves', exact: true }).fill('Checkpoint_49');
  await check(page.locator('.satisfactory-save-list > li')).toHaveCount(1);
  await page.getByText('Save details', { exact: true }).click();
  await check(page.getByText('Checkpoint_49.sav', { exact: true })).toBeVisible();
  await context.close();
});
it('renders live and historical overview honestly and exposes request errors', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }),
    page = await context.newPage();
  await page.clock.install({ time: new Date('2026-11-02T10:02:00Z') });
  let snapshot = false,
    failure = false,
    unavailable = false;
  await page.route('**/v1/**', (route) =>
    failure
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'integration_unavailable', messageKey: 'web.errors.request' } },
        })
      : route.fulfill({
          json: {
            configured: true,
            source: unavailable ? 'unavailable' : snapshot ? 'snapshot' : 'live',
            observedAt: unavailable ? null : '2026-11-02T10:00:00Z',
            state: unavailable
              ? null
              : {
                  activeSessionName: 'Northern factory',
                  numConnectedPlayers: 2,
                  playerLimit: 4,
                  techTier: 6,
                  activeSchematic:
                    "/Script/Engine.BlueprintGeneratedClass'/Game/FactoryGame/Schematics/Progression/Schematic_1-1.Schematic_1-1_C'",
                  gamePhase:
                    "/Script/FactoryGame.FGGamePhase'/Game/FactoryGame/GamePhases/GP_Project_Assembly_Phase_0.GP_Project_Assembly_Phase_0'",
                  isGameRunning: true,
                  totalGameDuration: 72000,
                  isGamePaused: false,
                  averageTickRate: 29.8,
                  autoLoadSessionName: 'Northern factory',
                },
          },
        }),
  );
  await page.goto(`${origin}satisfactory-worlds-fixture?overview`);
  await check(page.getByText('Northern factory', { exact: true })).toBeVisible();
  await check(page.getByText('Last updated 2 minutes ago', { exact: true })).toBeVisible();
  await check(page.getByText('Phase 0 · Establishing Phase', { exact: true })).toBeVisible();
  await check(page.getByText('Base Building', { exact: true })).toBeVisible();
  await check(page.getByText(/\/Script\//)).toHaveCount(0);
  await check(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveText('');
  await check(page.getByText(/Observed at:/)).toHaveCount(0);
  await page.screenshot({ path: `${shots}/satisfactory-overview-desktop-en.png`, fullPage: true });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  snapshot = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
  await page.goto(`${origin}satisfactory-worlds-fixture?overview&offline`);
  await check(page.getByText('Northern factory', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await check(page.getByText('Stato salvato', { exact: true })).toBeVisible();
  await check(page.getByText('Fase 0 · Insediamento', { exact: true })).toBeVisible();
  await check(page.getByText('Costruzione di base', { exact: true })).toBeVisible();
  await check(page.getByText('Ultimo aggiornamento 2 minuti fa', { exact: true })).toBeVisible();
  await page.clock.fastForward(60_000);
  await check(page.getByText('Ultimo aggiornamento 3 minuti fa', { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: `${shots}/satisfactory-overview-snapshot-mobile-it.png`,
    fullPage: true,
  });
  failure = true;
  await page.getByRole('button').click();
  await check(page.getByRole('alert')).toBeVisible();
  await check(page.getByText('Stato salvato', { exact: true })).toBeVisible();
  await check(page.getByText('Fase 0 · Insediamento', { exact: true })).toBeVisible();
  await check(page.getByText('Costruzione di base', { exact: true })).toBeVisible();
  failure = false;
  unavailable = true;
  await page.getByRole('button', { name: 'Aggiorna', exact: true }).click();
  await check(page.getByText('Nessuna osservazione del mondo ancora disponibile.')).toBeVisible();
  await check(page.locator('.ficsit-overview-updated time')).toHaveCount(0);
  await context.close();
});
