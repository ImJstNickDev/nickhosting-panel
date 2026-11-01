import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, expect as check, chromium } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let vite: ViteDevServer, browser: Browser, origin: string;
const shots = '.codex/local/m6-browser/screenshots';
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    cacheDir: `${process.cwd()}/.codex/local/satisfactory-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'satisfactory-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/satisfactory-fixture')) return next();
            res.setHeader('content-type', 'text/html');
            res.end(
              '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Satisfactory</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/satisfactory-mods-page.tsx"></script></body></html>',
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
it('selects exact versions, submits durable apply, supports Italian mobile read-only view', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const requests: unknown[] = [];
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/catalog'))
      return route.fulfill({
        json: { total: 1, items: [{ id: 'example', reference: 'Example', name: 'Example mod' }] },
      });
    if (url.pathname.includes('/versions/'))
      return route.fulfill({
        json: [
          {
            version: '1.2.3',
            gameVersion: '>=400000',
            dependencies: [{ mod_id: 'SML', condition: '>=3.0.0', optional: false }],
          },
        ],
      });
    if (url.pathname.endsWith('/apply')) {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ json: { jobId: 'durable-job' }, status: 202 });
    }
    return route.fulfill({ json: { selection: [], lock: { version: 1, mods: {} } } });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await check(page.getByText('No mods selected.')).toBeVisible();
  await page.getByRole('button', { name: 'Example mod', exact: true }).click();
  await page.getByRole('combobox').selectOption('1.2.3');
  await page.getByRole('button', { name: 'Select version', exact: true }).click();
  await check(page.getByRole('alert')).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: `${shots}/satisfactory-mods-desktop-en.png`, fullPage: true });
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await check(page.locator('body')).toHaveAttribute('data-job', 'durable-job');
  expect(requests).toMatchObject([{ selection: [{ reference: 'Example', version: '1.2.3' }] }]);
  await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}satisfactory-fixture?readonly`);
  await check(page.getByText('Nessuna mod selezionata.')).toBeVisible();
  await check(page.getByRole('button', { name: 'Applica modifiche' })).toBeDisabled();
  await page.screenshot({ path: `${shots}/satisfactory-mods-mobile-it.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});

it('connects a write-only token, updates options and shows read-only player state in Italian', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let configured = false;
  let option = '4';
  const mutations: unknown[] = [];
  const readBodies: unknown[] = [];
  const secret = 'fixture-opaque-token-never-returned';
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      mutations.push(body);
      if (path.endsWith('/token')) configured = true;
      if (path.endsWith('/options')) option = body.options['FG.DSAutoPause'];
      return route.fulfill({ status: 204 });
    }
    const body = path.endsWith('/state')
      ? {
          activeSessionName: 'Fixture factory',
          numConnectedPlayers: 2,
          playerLimit: 4,
          averageTickRate: 29.5,
          isGameRunning: true,
        }
      : path.endsWith('/options')
        ? { serverOptions: { 'FG.DSAutoPause': option }, pendingServerOptions: {} }
        : { configured };
    readBodies.push(body);
    return route.fulfill({ json: body });
  });
  await page.goto(`${origin}satisfactory-fixture?settings`);
  const token = page.getByLabel('Application token', { exact: true });
  await check(token).toHaveAttribute('type', 'password');
  await check(token).toHaveValue('');
  await page.screenshot({
    path: `${shots}/satisfactory-settings-unconfigured-en.png`,
    fullPage: true,
  });
  await token.fill(secret);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await check(page.getByText('Server API connected.', { exact: true })).toBeVisible();
  await check(token).toHaveValue('');
  await check(page.getByText('Fixture factory', { exact: true })).toBeVisible();
  const field = page.getByLabel('FG.DSAutoPause', { exact: true });
  await field.fill('true');
  await field
    .locator('xpath=ancestor::form')
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await check(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  await check(field).toHaveValue('true');
  expect(mutations).toEqual([{ token: secret }, { options: { 'FG.DSAutoPause': 'true' } }]);
  expect(JSON.stringify(readBodies)).not.toContain(secret);
  expect(await page.locator('body').innerText()).not.toContain(secret);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: `${shots}/satisfactory-settings-desktop-en.png`, fullPage: true });
  await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}satisfactory-fixture?settings&readonly`);
  await check(page.getByText('Giocatori connessi', { exact: true })).toBeVisible();
  await check(page.getByText('2 / 4', { exact: true })).toBeVisible();
  await check(page.locator('input[type=password]')).toHaveCount(0);
  await check(page.getByLabel('FG.DSAutoPause', { exact: true })).toBeDisabled();
  await check(page.getByRole('button', { name: 'Salva modifiche', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: `${shots}/satisfactory-settings-mobile-it.png`, fullPage: true });
  await context.close();
});
