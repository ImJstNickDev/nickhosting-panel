import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { type Browser, chromium, expect as see } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { OpenworldFactoriesSnapshot } from '../../../games/openworld/src/factories.js';

let vite: ViteDevServer, browser: Browser, url: string;
const shots = '.codex/local/openworld-browser';
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    cacheDir: `${process.cwd()}/.codex/local/openworld-factories-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'factory-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/factory-fixture')) return next();
            res.setHeader('content-type', 'text/html');
            res.end(
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Openworld</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/openworld-telemetry-page.tsx"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await vite.listen();
  url = `${vite.resolvedUrls?.local[0]}factory-fixture?section=factories`;
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
const sample: OpenworldFactoriesSnapshot = {
  enabled: true,
  paused: false,
  scope: 'world',
  targetHz: 20,
  hz: 18.67,
  stepMs: { p95: 0.06 },
  counts: { nodes: 34, nets: 46, pieces: 489 },
  power: { producedW: 910, usedW: 708.5, storedJ: 7200, capacityJ: 36000 },
  transit: { items: 7, fluidVoxels: 11 },
  topColumns: [
    { world: 'earth', face: 0, i: 166, j: 165, usPerS: 385.62, share: 0.413, nodes: 10, nets: 8 },
    { world: 'ships', face: 2, x: 32, z: 20, usPerS: 124, share: 0.231 },
    { world: 'moon', face: null, i: 12, j: 7, usPerS: 82, share: 0.14 },
  ],
};
const id = '10000000-0000-4000-8000-000000000001';
async function open(locale: 'en' | 'it', width: number) {
  const page = await browser.newPage({ locale, viewport: { width, height: 850 } });
  await page.addInitScript((lang) => localStorage.setItem('nh.locale', lang), locale);
  const account = {
    id: 'reader',
    name: 'Reader',
    email: 'reader@example.test',
    emailVerified: true,
    locale,
    role: 'user',
    twoFactorEnabled: false,
  };
  await page.route('**/v1/web/session', (route) =>
    route.fulfill({
      json: {
        actor: account,
        subject: account,
        context: {
          actorUserId: account.id,
          subjectUserId: account.id,
          role: 'user',
          sessionType: 'regular',
          ownerElevation: false,
        },
      },
    }),
  );
  return page;
}
it('shows measured and target factory rates, power and transit; only valid planetary columns link to the map', async () => {
  const page = await open('en', 1280);
  try {
    await page.route('**/openworld/factories', (route) => route.fulfill({ json: sample }));
    await page.goto(`${url}&mapAccess`);
    for (const text of [
      'Factory simulation',
      '18.67 Hz',
      '20 Hz',
      '0.06 ms',
      '708.5 W',
      '2 Wh',
      '10 Wh',
      'Fluid voxels',
      '41.3 %',
    ])
      await see(page.getByText(text, { exact: true })).toBeVisible();
    await see(page.getByRole('link')).toHaveCount(1);
    await see(page.getByRole('link')).toHaveAttribute(
      'href',
      `/servers/${id}/game/map#world=earth&face=0&x=2664&z=2648&origin=factories`,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${shots}/factories-desktop.png`, fullPage: true });
  } finally {
    await page.close();
  }
});
it('renders the Italian diagnostic at phone width without map permission and separates unavailable from empty states', async () => {
  const page = await open('it', 360);
  try {
    let data = sample,
      reads = 0;
    await page.route('**/openworld/factories', (route) => {
      reads++;
      return route.fulfill({ json: data });
    });
    await page.goto(url);
    await see(page.getByText('18,67 Hz', { exact: true })).toBeVisible();
    await see(page.getByText('Colonne più costose')).toBeVisible();
    await see(page.getByRole('link')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${shots}/factories-mobile-it.png`, fullPage: true });
    data = { enabled: true, counts: { nodes: 0 }, topColumns: [] };
    await page.reload();
    await see(page.getByText('La simulazione non contiene nodi di fabbrica.')).toBeVisible();
    await see(
      page.getByText('Nessuna colonna ha registrato un costo di elaborazione.'),
    ).toBeVisible();
    data = { enabled: true, paused: true, scope: 'loaded' };
    await page.reload();
    await see(page.getByText('In pausa')).toBeVisible();
    await see(page.getByText('Non disponibile', { exact: true })).toBeVisible();
    data = { enabled: false };
    await page.reload();
    await see(
      page.getByText('La simulazione delle fabbriche è disabilitata su questo server.'),
    ).toBeVisible();
    data = { enabled: true, steps: 0 };
    await page.reload();
    await see(page.getByText('In attesa delle misurazioni sulle fabbriche.')).toBeVisible();
    const onlineReads = reads;
    await page.goto(`${url}&offline`);
    await see(page.getByText('Avvia il server per vedere le fabbriche.')).toBeVisible();
    expect(reads).toBe(onlineReads);
  } finally {
    await page.close();
  }
});
