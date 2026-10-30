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
import { playerSkinFixture } from './fixtures/player-skin.js';

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
    skin = await playerSkinFixture(generator);
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

  it('renders a three-quarter still at rest, waves at the same scale and releases the GPU on leave/unmount', async () => {
    const first = page.getByRole('button', { name: 'first', exact: true });
    await browserExpect(first.locator('.minecraft-player-body')).toHaveAttribute(
      'data-ready',
      'true',
    );
    await browserExpect(first.locator('img')).toHaveAttribute('src', /data:image\/png/);
    expect(skinRequests).toBeGreaterThan(0);
    await browserExpect(page.locator('canvas')).toHaveCount(0);
    const stage = await first.locator('.minecraft-player-body').boundingBox();
    expect(stage?.height).toBe(112);
    expect(stage?.width).toBe(96);
    if (!stage) throw new Error('Missing body frame');
    const headClip = { x: stage.x + 29, y: stage.y + 20, width: 34, height: 32 };
    const restingHead = await page.screenshot({
      clip: headClip,
      path: '/tmp/player-head-rest.png',
    });
    const skinPixels = await page.evaluate(async (encoded) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing pixel inspection context');
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let pixels = 0;
      for (let index = 0; index < data.length; index += 4) {
        const red = data[index] ?? 0,
          green = data[index + 1] ?? 0;
        if (red > 100 && green < 170 && red > green * 1.1) pixels++;
      }
      return pixels;
    }, restingHead.toString('base64'));
    expect(skinPixels).toBeGreaterThan(100); // Compare a real head, never empty background.
    await first.screenshot({ path: '/tmp/player-body-rest.png' });
    await first.hover();
    await browserExpect(first.locator('canvas')).toBeVisible();
    await page.waitForTimeout(500);
    await first.screenshot({ path: '/tmp/player-body-hover.png' });
    expect(
      (await page.screenshot({ clip: headClip, path: '/tmp/player-head-hover.png' })).equals(
        restingHead,
      ),
    ).toBe(true);
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

  it('keeps the local fallback while the raw skin is pending, then captures the same projection', async () => {
    let held: Route | undefined;
    await page.route('https://api.mcheads.org/skin/111*', (route) => {
      held = route;
    });
    await page.reload();
    await expect.poll(() => !!held).toBe(true);
    const first = page.getByRole('button', { name: 'first', exact: true });
    await browserExpect(first.locator('img')).toHaveAttribute('src', /data:image\/svg\+xml/);
    await browserExpect(first.locator('img')).toBeVisible();
    await held?.fulfill({
      contentType: 'image/png',
      body: skin,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
    await browserExpect(first.locator('.minecraft-player-body')).toHaveAttribute(
      'data-ready',
      'true',
    );
    await browserExpect(first.locator('img')).toHaveAttribute('src', /data:image\/png/);
    await browserExpect(page.locator('canvas')).toHaveCount(0);
  });

  it('honors reduced motion including a live preference change and offscreen previews', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'first', exact: true }).hover();
    await page.waitForTimeout(100);
    await browserExpect(page.locator('[data-player="first"]')).toHaveAttribute(
      'data-ready',
      'true',
    );
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
    await page.reload();
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
    await page.reload();
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
