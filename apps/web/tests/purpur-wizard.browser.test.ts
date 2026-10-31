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

const id = '10000000-0000-4000-8000-000000000001';
const purpurId = `purpur:${id}:1.21.1`;
/** Actual wizard and integration module; local API catalog/creation responses are isolated. */
describe('Purpur independent catalog wizard', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let reads: string[], writes: Array<{ path: string; body: unknown }>, errors: string[];
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/purpur-wizard-vite`,
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
    reads = [];
    writes = [];
    errors = [];
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
    });
    await page.route('**/domains-fixture*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Purpur</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/domains-page.tsx"></script></body></html>',
      }),
    );
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'GET') reads.push(path);
      else writes.push({ path, body: route.request().postDataJSON() });
      const response = (json: unknown) => route.fulfill({ json });
      if (path === '/v1/web/session')
        return response({
          context: {
            actorUserId: id,
            subjectUserId: id,
            role: 'user',
            sessionType: 'regular',
            ownerElevation: false,
          },
          actor: { id, name: 'Fixture', role: 'user' },
          subject: { id, name: 'Fixture', role: 'user' },
        });
      if (path === '/v1/games')
        return response([
          {
            id: 'minecraft',
            access: { canCreate: true },
            manifest: { runtimes: ['vanilla', 'purpur'] },
          },
        ]);
      if (path === '/v1/platform/quotas')
        return response({
          remaining: { memoryMiB: 8192, cpuPercent: 400, storageMiB: null },
          creationStorage: { mode: 'shared', defaultDiskMiB: 4096 },
        });
      if (path.endsWith('/connection-options'))
        return response({
          mode: 'custom-subdomain',
          customizable: true,
          domains: [{ id: 'main', hostname: 'games.example.test' }],
          defaultDomainId: 'main',
          defaultHostname: null,
          supportsSrv: true,
          configured: true,
        });
      if (path.endsWith('/connection-suggestion'))
        return response({
          domainId: 'main',
          subdomain: 'calm-panda-bag',
          hostname: 'calm-panda-bag.games.example.test',
          available: true,
        });
      if (path.endsWith('/connection-reservation'))
        return response({
          reservationId: id,
          domainId: 'main',
          subdomain: 'calm-panda-bag',
          hostname: 'calm-panda-bag.games.example.test',
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        });
      if (path === '/v1/minecraft/choices')
        return response([
          { id, version: '1.21.1', runtime: 'vanilla', releaseType: 'release' },
          {
            id: purpurId,
            version: '1.21.1',
            runtime: 'purpur',
            releaseType: 'release',
            capabilities: {
              installation: true,
              gateway: true,
              sleepWake: true,
              playerManagement: true,
            },
          },
          {
            id: `purpur:${id}:1.20.1`,
            version: '1.20.1',
            runtime: 'purpur',
            capabilities: {
              installation: true,
              gateway: true,
              sleepWake: true,
              playerManagement: true,
            },
            releaseType: 'release',
          },
        ]);
      if (path === '/v1/minecraft/players/FixturePlayer')
        return response({
          uuid: id,
          name: 'FixturePlayer',
          source: 'mc-api.io',
          verifiedAt: new Date().toISOString(),
        });
      if (path === '/v1/minecraft/servers') return response({ serverId: id, jobId: id });
      errors.push(`Unexpected ${path}`);
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
  async function next(locale = 'en') {
    await page
      .getByRole('button', { name: locale === 'it' ? 'Avanti' : 'Next', exact: true })
      .click();
  }
  async function open(locale = 'en') {
    await page.goto(`${origin}domains-fixture?view=wizard`);
    await page.getByRole('button', { name: 'Minecraft', exact: true }).click();
    await next(locale);
    const purpurCard = page
      .locator('.installer-choice-card')
      .filter({ has: page.getByRole('radio', { name: 'Purpur', exact: true }) });
    await check(purpurCard).toBeVisible();
    await check
      .poll(() =>
        purpurCard.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/purpur-wizard-runtimes.png',
      fullPage: true,
    });
    await purpurCard.click();
    await next(locale);
    await page
      .getByLabel(locale === 'it' ? 'Nome del server' : 'Server name', { exact: true })
      .fill('Purpur fixture');
    await next(locale);
    await page
      .locator('.installer-version')
      .filter({ has: page.getByRole('radio', { name: '1.21.1', exact: true }) })
      .click();
    await next(locale);
  }
  it('creates a Purpur server with a verified operator and no loader step', async () => {
    await open();
    await check(page.getByRole('heading', { name: 'Choose an address' })).toBeVisible();
    await check(page.getByRole('heading', { name: 'Choose a loader' })).toHaveCount(0);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/purpur-wizard-address-en.png',
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await next(); // operators
    await page.getByLabel('Player name', { exact: true }).fill('FixturePlayer');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await check(page.locator('.player-list')).toContainText('FixturePlayer');
    await next(); // whitelist
    await next(); // resources
    await next(); // review
    await check(page.getByText('calm-panda-bag.games.example.test', { exact: true })).toBeVisible();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/purpur-wizard-review-en.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Create server', exact: true }).click();
    await check(page.getByTestId('created-console')).toHaveText(`/servers/${id}/console`);
    expect(writes.map(({ path }) => path)).toEqual([
      '/v1/games/minecraft/connection-suggestion',
      '/v1/games/minecraft/connection-reservation',
      '/v1/minecraft/servers',
    ]);
    expect(writes.at(-1)).toMatchObject({
      path: '/v1/minecraft/servers',
      body: {
        minecraft: {
          choiceId: purpurId,
          configuration: { eula: true, operators: ['FixturePlayer'] },
        },
      },
    });
    const created = writes.at(-1);
    if (!created) throw new Error('missing create request');
    expect((created.body as { minecraft: Record<string, unknown> }).minecraft).not.toHaveProperty(
      'loaderVersion',
    );
    expect(reads.filter((path) => path === '/v1/minecraft/choices')).toHaveLength(1);
    expect(reads.some((path) => path.endsWith('/catalog'))).toBe(false);
  });
  it('supports Italian mobile and keyboard Minecraft version selection', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await open('it');
    await page.getByRole('button', { name: 'Indietro', exact: true }).click();
    const selected = page.getByRole('radio', { name: '1.21.1', exact: true });
    await selected.focus();
    await selected.press('ArrowDown');
    await check(page.getByRole('radio', { name: '1.20.1', exact: true })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/purpur-wizard-versions-it-mobile.png',
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await next('it');
    await check(page.getByRole('heading', { name: 'Scegli un indirizzo' })).toBeVisible();
    await check(page.getByRole('heading', { name: 'Scegli un loader' })).toHaveCount(0);
  });
});
