import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  expect as check,
  chromium,
  type Page,
} from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

const id = '10000000-0000-4000-8000-000000000001';
let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
let writes: Record<string, unknown>[], errors: string[];
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    cacheDir: `${process.cwd()}/.codex/local/satisfactory-wizard-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
  await mkdir('docs/screenshots/m6', { recursive: true });
});
beforeEach(async () => {
  writes = [];
  errors = [];
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('nh.locale', 'en'));
  await page.route('**/domains-fixture*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><head><title>Satisfactory setup</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/domains-page.tsx"></script></body></html>',
    }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const response = (json: unknown) => route.fulfill({ json });
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
      return response({
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
    if (path === '/v1/games')
      return response([
        { id: 'satisfactory', access: { canCreate: true }, manifest: { runtimes: ['dedicated'] } },
      ]);
    if (path === '/v1/games/satisfactory/choices')
      return response({ choices: [{ mappingId: id, name: 'Dedicated server' }] });
    if (path === '/v1/platform/quotas')
      return response({
        remaining: { memoryMiB: 8192, cpuPercent: 400, storageMiB: null },
        creationStorage: { mode: 'shared', defaultDiskMiB: 4096 },
      });
    if (path.endsWith('/connection-options'))
      return response({
        mode: 'shared-host',
        customizable: false,
        domains: [],
        defaultHostname: 'satisfactory.example.test',
        supportsSrv: false,
        configured: true,
      });
    if (path === '/v1/servers' && route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON());
      return response({ serverId: id, jobId: id });
    }
    errors.push(`Unexpected request: ${path}`);
    return route.fulfill({ status: 404, json: {} });
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
async function select(name: string) {
  await page
    .locator('.installer-choice-card')
    .filter({ has: page.getByRole('radio', { name, exact: true }) })
    .click();
}
async function next(locale = 'en') {
  await page
    .getByRole('button', { name: locale === 'en' ? 'Next' : 'Avanti', exact: true })
    .click();
}
async function open(locale = 'en') {
  await page.goto(`${origin}domains-fixture?view=wizard`);
  await page.getByRole('button', { name: 'Satisfactory', exact: true }).click();
  await next(locale);
  await page
    .getByLabel(locale === 'en' ? 'Server name' : 'Nome del server', { exact: true })
    .fill('Northern factory');
  await next(locale);
  await select('Dedicated server');
  await next(locale);
  await next(locale); // Stable is the integration default.
  await check(
    page.getByRole('heading', {
      name: locale === 'en' ? 'Set up your server' : 'Configura il server',
      exact: true,
    }),
  ).toBeVisible();
}
it('skips setup by default and discards credentials after changing back to client setup', async () => {
  await open();
  await check(
    page.getByRole('radio', { name: 'Set up in Satisfactory', exact: true }),
  ).toBeChecked();
  await page.screenshot({
    path: 'docs/screenshots/m6/satisfactory-wizard-setup-desktop-en.png',
    fullPage: true,
  });
  await select('Set up here');
  await next();
  await page.getByLabel('Administrator password', { exact: true }).fill('discard-me');
  await page.getByLabel('Player password (optional)', { exact: true }).fill('discard-player');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await select('Set up in Satisfactory');
  await next();
  await check(page.getByLabel('Administrator password', { exact: true })).toHaveCount(0);
  await next();
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await check(page.getByTestId('created-console')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.satisfactory).toEqual({ branch: 'public', autoUpdate: true });
  expect(JSON.stringify(writes)).not.toMatch(/discard|Password|setupMode/);
});
it('validates and masks credentials, excludes them from review and submits opt-in setup', async () => {
  await open();
  await select('Set up here');
  await next();
  const admin = page.getByLabel('Administrator password', { exact: true });
  await check(admin).toHaveAttribute('type', 'password');
  await admin.fill(' native secret ');
  await page.getByLabel('Player password (optional)', { exact: true }).fill(' native secret ');
  await next();
  await check(page.getByRole('heading', { name: 'Server access', exact: true })).toBeVisible();
  await check(page.getByLabel('Player password (optional)', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.getByLabel('Player password (optional)', { exact: true }).fill('guest secret');
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: 'docs/screenshots/m6/satisfactory-wizard-credentials-desktop-en.png',
    fullPage: true,
  });
  await next();
  await next();
  await check(page.locator('body')).not.toContainText('native secret');
  expect(
    await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    ),
  ).not.toContain('native secret');
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await check(page.getByTestId('created-console')).toBeVisible();
  expect(writes[0]?.satisfactory).toEqual({
    branch: 'public',
    autoUpdate: true,
    setup: { adminPassword: ' native secret ', clientPassword: 'guest secret' },
  });
});
it('keeps the optional credentials form usable on Italian mobile', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
  await open('it');
  await select('Configura qui');
  await next('it');
  await check(page.getByRole('heading', { name: 'Accesso al server', exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  await check(page.getByLabel('Password amministratore', { exact: true })).toBeFocused();
  await page.getByLabel('Password amministratore', { exact: true }).fill('password fixture');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: 'docs/screenshots/m6/satisfactory-wizard-credentials-mobile-it.png',
    fullPage: true,
  });
  await next('it');
  await check(page.getByLabel('Password amministratore', { exact: true })).toHaveCount(0);
});
