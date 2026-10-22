import { homedir } from 'node:os';
import {
  type Browser,
  expect as browserExpect,
  chromium,
  type Page,
  type Route,
} from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('Minecraft full-body previews', () => {
  let vite: ViteDevServer, browser: Browser, page: Page, origin: string;
  const errors: string[] = [];
  let skinRequests = 0;
  let skin: Buffer;
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/player-body-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [
        {
          name: 'player-body-fixture',
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.url !== '/body-fixture') return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                '<!doctype html><html><body style="background:#242729;color:white"><div id="root"></div><script type="module" src="/tests/fixtures/player-body-page.tsx"></script></body></html>',
              );
            });
          },
        },
      ],
      logLevel: 'error',
    });
    await vite.listen();
    origin = vite.resolvedUrls?.local[0] ?? '';
    if (!origin) throw new Error('Missing Vite fixture origin');
    browser = await chromium.launch({
      headless: true,
      args: ['--enable-unsafe-swiftshader'],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
      },
    });
    const generator = await browser.newPage();
    // Authored solid-color test texture only. No remote/player skin is committed.
    skin = Buffer.from(
      await generator.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Missing canvas context');
        context.fillStyle = '#ba8f69';
        context.fillRect(0, 0, 64, 64);
        context.fillStyle = '#4e7772';
        context.fillRect(16, 16, 24, 16);
        context.fillStyle = '#303948';
        context.fillRect(0, 16, 16, 16);
        context.fillRect(16, 48, 16, 16);
        context.fillStyle = '#43372e';
        context.fillRect(8, 8, 8, 3);
        context.fillStyle = '#ffffff';
        context.fillRect(9, 12, 2, 1);
        context.fillRect(13, 12, 2, 1);
        // Clear outer layers and slim-arm detection unused regions: classic model.
        context.clearRect(32, 0, 32, 16);
        context.clearRect(0, 32, 64, 16);
        context.clearRect(0, 48, 16, 16);
        context.clearRect(48, 48, 16, 16);
        return canvas.toDataURL('image/png').split(',')[1] ?? '';
      }),
      'base64',
    );
    await generator.close();
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  beforeEach(async () => {
    await page?.close();
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    page.on('pageerror', (error) => errors.push(error.message));
    skinRequests = 0;
    await page.route('https://api.mcheads.org/**', (route) => {
      if (route.request().url().includes('/skin/')) {
        skinRequests++;
        return route.fulfill({
          contentType: 'image/png',
          body: skin,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }
      return route.fulfill({ status: 404 });
    });
    await page.goto(`${origin}body-fixture`);
    await browserExpect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  });

  it('uses a body fallback at rest, waves on hover and releases the GPU on leave/unmount', async () => {
    const first = page.getByRole('button', { name: 'first', exact: true });
    await browserExpect(first.locator('img')).toHaveAttribute('src', /data:image\/svg\+xml/);
    expect(skinRequests).toBe(0);
    await first.hover();
    await browserExpect(first.locator('canvas')).toBeVisible();
    const initial = await first.screenshot();
    await expect.poll(async () => (await first.screenshot()).equals(initial)).toBe(false);
    await page.waitForTimeout(500);
    await first.screenshot({ path: '/tmp/nickhosting-player-body-wave.png' });
    await page.mouse.move(600, 400);
    await browserExpect(page.locator('canvas')).toHaveCount(0);
    await first.hover();
    await browserExpect(first.locator('canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Toggle mount', exact: true }).click();
    await browserExpect(page.locator('.minecraft-player-body')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  it('keeps a local body visible while the remote full-body image is pending', async () => {
    let held: Route | undefined;
    await page.route('https://api.mcheads.org/player/111*/**', (route) => {
      held = route;
    });
    await page.reload();
    await expect.poll(() => !!held).toBe(true);
    const first = page.getByRole('button', { name: 'first', exact: true });
    await browserExpect(first.locator('img').first()).toBeVisible();
    await browserExpect(first.locator('img').last()).toHaveCSS('opacity', '0');
    await held?.fulfill({ contentType: 'image/png', body: skin });
    await browserExpect(first.locator('img').last()).toHaveCSS('opacity', '1');
    await browserExpect(first.locator('img').first()).toBeHidden();
    expect(skinRequests).toBe(0);
  });

  it('honors reduced motion including a live preference change and offscreen previews', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'first', exact: true }).hover();
    await page.waitForTimeout(100);
    expect(skinRequests).toBe(0);
    await browserExpect(page.locator('canvas')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await browserExpect(page.locator('canvas')).toHaveCount(1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await browserExpect(page.locator('canvas')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await browserExpect(page.locator('canvas')).toHaveCount(1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await browserExpect(page.locator('canvas')).toHaveCount(0);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await browserExpect(page.locator('canvas')).toHaveCount(1);
    await page.evaluate(() => window.scrollTo(0, 1000));
    await browserExpect(page.locator('canvas')).toHaveCount(0);
  });

  it('leases one renderer even when multiple previews are active, and survives context loss', async () => {
    await page.getByRole('button', { name: 'Activate both', exact: true }).click();
    await browserExpect(page.locator('canvas')).toHaveCount(1);
    await page
      .locator('canvas')
      .evaluate((canvas) => canvas.dispatchEvent(new Event('webglcontextlost')));
    await browserExpect(page.locator('canvas')).toHaveCount(0);
    await browserExpect(page.locator('.minecraft-player-body img').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  it('keeps the static fallback after a skin failure and cancels an obsolete pending identity', async () => {
    await page.route('https://api.mcheads.org/skin/**', (route) =>
      route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' } }),
    );
    await page.getByRole('button', { name: 'first', exact: true }).hover();
    await page.waitForTimeout(150);
    await browserExpect(page.locator('canvas')).toHaveCount(0);
    await browserExpect(page.locator('.minecraft-player-body img').first()).toBeVisible();
    await page.unroute('https://api.mcheads.org/skin/**');
    let held = false;
    await page.route('https://api.mcheads.org/skin/111*', async (route) => {
      held = true;
      await page.waitForTimeout(200);
      await route
        .fulfill({
          contentType: 'image/png',
          body: skin,
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
        .catch(() => {});
    });
    await page.mouse.move(600, 400);
    await page.getByRole('button', { name: 'first', exact: true }).hover();
    await expect.poll(() => held).toBe(true);
    await page.getByRole('button', { name: 'Change player', exact: true }).click();
    await page.getByRole('button', { name: 'first', exact: true }).hover();
    await browserExpect(page.locator('canvas')).toHaveCount(1);
    await browserExpect(page.locator('[data-player="first"]')).toHaveAttribute(
      'data-animated',
      'true',
    );
    expect(errors).toEqual([]);
  });
});
