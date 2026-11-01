import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, firefox } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';

it('prepares and hashes a world folder on a cold Firefox visit without reloading its draft', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'nickhosting-world-folder-vite-'));
  let vite: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    vite = await createServer({
      root: resolve('apps/web'),
      configFile: resolve('apps/web/vite.config.ts'),
      configLoader: 'runner',
      cacheDir,
      server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null },
      logLevel: 'error',
    });
    await vite.listen();
    const origin = vite.resolvedUrls?.local[0];
    if (!origin) throw new Error('Missing isolated Vite listener');
    const libs = resolve(
      homedir(),
      '.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu',
    );
    browser = await firefox.launch({
      headless: true,
      ...(existsSync(libs)
        ? {
            env: {
              ...process.env,
              LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
            },
          }
        : {}),
    });
    const page = await browser.newPage();
    const reloads: string[] = [];
    const pageErrors: string[] = [];
    let navigations = 0;
    let hmrConnected = false;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string' && payload.includes('"type":"connected"'))
          hmrConnected = true;
        if (typeof payload === 'string' && payload.includes('"type":"full-reload"'))
          reloads.push(payload);
      });
    });
    await page.route('**/world-folder-cold-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><title>World folder import</title><body><input id="draft" value="my-world"><script type="module" src="/@vite/client"></script></body></html>',
      }),
    );
    await page.goto(new URL('/world-folder-cold-fixture', origin).href);
    await expect.poll(() => hmrConnected).toBe(true);
    await page.locator('#draft').fill('unsaved-world-name');
    // Complete the initial dependency pass before the user selects their folder.
    // A warm shared cache or hmr:false would hide the original draft-loss failure.
    await vite.environments.client?.depsOptimizer?.scanProcessing;
    await vite.waitForRequestsIdle();
    await expect
      .poll(
        () =>
          Object.keys(vite?.environments.client?.depsOptimizer?.metadata.optimized ?? {}).length,
        { timeout: 60000 },
      )
      .toBeGreaterThan(0);
    const initialDependencies = Object.keys(
      vite.environments.client?.depsOptimizer?.metadata.optimized ?? {},
    );
    // Keep browser imports out of Vitest's server-side module transformation.
    const result = await page.evaluate<{
      sha256: string;
      bytes: number[];
      name: string;
    }>(`(async () => {
      const archiveModule = '/src/integrations/minecraft/world-folder-archive.ts';
      const hashModule = '/src/api/hash.ts';
      const { prepareMinecraftWorldFolder } = await import(/* @vite-ignore */ archiveModule);
      const { hashFile } = await import(/* @vite-ignore */ hashModule);
      const file = new File(['cold-folder-fixture'], 'level.dat');
      Object.defineProperty(file, 'webkitRelativePath', { value: 'my-world/level.dat' });
      const archive = await prepareMinecraftWorldFolder([file]);
      const sha256 = await hashFile(archive);
      return {
        sha256,
        bytes: Array.from(new Uint8Array(await archive.arrayBuffer())),
        name: archive.name,
      };
    })()`);
    await vite.waitForRequestsIdle();
    expect(initialDependencies).toContain('@noble/hashes/sha2.js');
    expect(result.name).toBe('my-world.zip');
    expect(result.sha256).toBe(
      createHash('sha256').update(new Uint8Array(result.bytes)).digest('hex'),
    );
    expect(reloads).toEqual([]);
    expect(navigations).toBe(1);
    expect(pageErrors).toEqual([]);
    await expect.poll(() => page.locator('#draft').inputValue()).toBe('unsaved-world-name');
  } finally {
    await browser?.close();
    await vite?.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}, 120000);
