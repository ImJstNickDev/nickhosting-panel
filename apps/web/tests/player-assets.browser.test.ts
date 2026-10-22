import { homedir } from 'node:os';
import { chromium, firefox } from '@playwright/test';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

it.each(['chromium', 'firefox'] as const)(
  'crops named SVG atlas views and caches one resource in %s',
  async (engine) => {
    let requests = 0;
    let atlas = '';
    const vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [
        {
          name: 'atlas-fixture',
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.url === '/atlas-fixture') {
                res.setHeader('Content-Type', 'text/html');
                res.end('<!doctype html><html><body></body></html>');
              } else if (req.url === '/sprite.svg') {
                requests++;
                res.setHeader('Content-Type', 'image/svg+xml');
                res.setHeader('Cache-Control', 'public, max-age=3600');
                res.end(atlas);
              } else next();
            });
          },
        },
      ],
      logLevel: 'error',
    });
    const browser = await { chromium, firefox }[engine].launch({
      headless: true,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
      },
    });
    try {
      await vite.listen();
      const origin = vite.resolvedUrls?.local[0];
      if (!origin) throw new Error('Missing atlas fixture origin');
      const page = await browser.newPage();
      await page.goto(`${origin}atlas-fixture`);
      atlas = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Missing fixture canvas');
        context.fillStyle = '#ff0000';
        context.fillRect(0, 0, 16, 16);
        const red = canvas.toDataURL();
        context.fillStyle = '#00ff00';
        context.fillRect(0, 0, 16, 16);
        const green = canvas.toDataURL();
        return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 1024 32"><view id="items-red" viewBox="0 0 16 16"/><view id="items-green" viewBox="16 0 16 16"/><image x="0" y="0" width="16" height="16" href="${red}"/><image x="16" y="0" width="16" height="16" href="${green}"/></svg>`;
      });
      const colors = await page.evaluate(async () => {
        const result = [];
        for (const name of ['red', 'green', 'red']) {
          const image = new Image();
          image.src = `/sprite.svg#items-${name}`;
          image.width = image.height = 32;
          document.body.append(image);
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 32;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Missing fixture canvas');
          context.drawImage(image, 0, 0, 32, 32);
          result.push(Array.from(context.getImageData(16, 16, 1, 1).data));
        }
        return result;
      });
      expect(colors).toEqual([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [255, 0, 0, 255],
      ]);
      expect(requests).toBe(1);
      const unknown = await page.evaluate(`(async () => {
      const { minecraftItemIcon } = await import('/src/integrations/minecraft/player-item-assets.ts');
      return ['__proto__', 'constructor', 'mod:unavailable', '../dirt'].map(id => minecraftItemIcon(id) ?? null);
    })()`);
      expect(unknown).toEqual([null, null, null, null]);
    } finally {
      await browser.close();
      await vite.close();
    }
  },
);
