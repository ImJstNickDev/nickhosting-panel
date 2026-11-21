import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { type Browser, expect as check, chromium } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let vite: ViteDevServer, browser: Browser, origin: string;
const shots = '.codex/local/openworld-browser';
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    cacheDir: `${process.cwd()}/.codex/local/openworld-dashboard-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'openworld-dashboard-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/dashboard-fixture')) return next();
            res.setHeader('content-type', 'text/html');
            res.end(
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Openworld</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/openworld-dashboard-page.tsx"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await vite.listen();
  origin = vite.resolvedUrls?.local[0] ?? '';
  browser = await chromium.launch({
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

it('opens an authenticated private dashboard on desktop and presents read-only status on mobile', async () => {
  for (const owner of [true, false]) {
    const context = await browser.newContext({
      viewport: owner ? { width: 1280, height: 720 } : { width: 390, height: 844 },
      locale: owner ? 'en-US' : 'it-IT',
    });
    const page = await context.newPage();
    let enabled = !owner;
    await page.route('**/v1/servers/**/openworld/dashboard**', async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path.endsWith('/password'))
        return route.fulfill({ json: { password: 'isolated native dashboard password' } });
      if (path.endsWith('/status'))
        return route.fulfill({
          json: { tps: 19.8, players: { online: 2, slots: 8 }, memory: { rssMB: 70 } },
        });
      if (req.method() === 'PUT') {
        enabled = req.postDataJSON().enabled;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({
        json: {
          enabled,
          canConfigure: owner,
          privateAddress: owner && enabled ? 'http://10.0.0.2:23001' : null,
        },
      });
    });
    await page.goto(`${origin}dashboard-fixture${owner ? '' : '?subuser'}`);
    const toggle = page.getByRole('switch', {
      name: owner ? 'Enable web dashboard' : 'Attiva la dashboard web',
    });
    if (owner) {
      await check(toggle).not.toBeChecked();
      await toggle.focus();
      await page.keyboard.press('Space');
      await check(toggle).toBeChecked();
      await check(page.getByRole('link', { name: 'Open native dashboard' })).toHaveAttribute(
        'href',
        'http://10.0.0.2:23001',
      );
      await page.getByRole('button', { name: 'Show dashboard password' }).click();
      await check(page.getByText('isolated native dashboard password')).toBeVisible();
      await page.getByRole('button', { name: 'Hide password' }).click();
      await check(page.getByText('isolated native dashboard password')).toHaveCount(0);
    } else {
      await check(toggle).toBeDisabled();
      await check(page.getByRole('link')).toHaveCount(0);
      await check(page.getByRole('button', { name: /password/i })).toHaveCount(0);
    }
    await check(page.getByText('2 / 8')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${shots}/dashboard-${owner ? 'desktop' : 'mobile'}.png` });
    await context.close();
  }
});
