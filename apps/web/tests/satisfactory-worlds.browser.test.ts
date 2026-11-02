import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, expect as check, chromium } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let vite: ViteDevServer, browser: Browser, origin: string;
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
it('confirms load, prevents save collisions, preserves errors, searches and uses shared file transfer navigation', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const calls: { path: string; body: unknown }[] = [];

  let failLoad = true;
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/api')) return route.fulfill({ json: { configured: true } });
    if (path.endsWith('/worlds')) return route.fulfill({ json: example });
    calls.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith('/load') && failLoad)
      return route.fulfill({
        status: 503,
        json: { error: { code: 'integration_unavailable', messageKey: 'web.errors.request' } },
      });
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}satisfactory-worlds-fixture`);
  await check(page.getByText('Factory_autosave_0', { exact: true })).toBeVisible({
    timeout: 15000,
  });
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
  await page.getByRole('searchbox').fill('missing');
  await check(page.getByText('No matching saves.')).toBeVisible();
  await context.close();
});
it('shows empty and loading states, creates a world with confirmation, and never reads native saves while offline', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const nativeReads: string[] = [],
    mutations: unknown[] = [];
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/api')) return route.fulfill({ json: { configured: true } });
    if (path.endsWith('/worlds')) {
      nativeReads.push(path);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return route.fulfill({ json: { sessions: [], currentSessionIndex: -1 } });
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
      'Avvia il server per leggere e gestire i salvataggi. Questa pagina non lo risveglia.',
    ),
  ).toBeVisible();
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
                  activeSchematic: 'Tier 6 milestone',
                  gamePhase: 'Phase 3',
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
  failure = false;
  unavailable = true;
  await page.getByRole('button', { name: 'Aggiorna', exact: true }).click();
  await check(page.getByText('Nessuna osservazione del mondo ancora disponibile.')).toBeVisible();
  await check(page.locator('.ficsit-overview-updated time')).toHaveCount(0);
  await context.close();
});
