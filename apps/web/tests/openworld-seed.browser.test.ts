import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { type Browser, chromium, expect as see } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { OpenworldSeedView } from '../../../games/openworld/src/seed-inspector.js';

let vite: ViteDevServer, browser: Browser, url: string;
const shots = '.codex/local/openworld-browser';
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    optimizeDeps: { entries: ['tests/fixtures/openworld-telemetry-page.tsx'] },
    cacheDir: `${process.cwd()}/.codex/local/openworld-seed-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'seed-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/seed-fixture')) return next();
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
  url = `${vite.resolvedUrls?.local[0]}seed-fixture?section=seed`;
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
const sample: OpenworldSeedView = {
  seed: '18446744073709551615',
  seedText: 'High tide',
  planet: 'earth',
  planets: [
    { key: 'earth', name: 'Earth' },
    { key: 'moon', name: 'Moon' },
  ],
  version: 7,
  faceEdgeMeters: 1487000,
  planetRadiusMeters: 230300,
  voxelSize: 0.25,
  spawn: { face: 2, x: 7210, z: 4330 },
  biomes: [
    { key: 'deep_ocean', name: 'Deep ocean', color: '#124368' },
    { key: 'rainforest', name: 'Rainforest', color: '#347548' },
    { key: 'tundra', name: 'Tundra', color: '#bcbfaf' },
  ],
  materials: [{ key: 'sulfur', name: 'Sulfur' }],
  featureKinds: [{ key: 'ore_vein', name: 'Ore vein' }],
  treeSpecies: [{ key: 'oak', name: 'Oak' }],
  inspectorUrl: 'https://seed.example.test/inspector/',
  inspectorPublished: true,
};
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

it('reads the seed once and searches all generation catalogs without fetching terrain', async () => {
  const page = await open('en', 1280);
  try {
    let reads = 0;
    await page.route('**/openworld/seed', (route) => {
      reads++;
      return route.fulfill({ json: sample });
    });
    await page.goto(`${url}&seedAccess`);
    await see(page.getByText(sample.seed, { exact: true })).toBeVisible({ timeout: 15000 });
    await see(page.getByRole('link', { name: 'Open native inspector' })).toHaveAttribute(
      'href',
      'https://seed.example.test/inspector/',
    );
    await see(page.getByText('Deep ocean', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${shots}/seed-desktop.png`, fullPage: true });
    await page.getByRole('combobox').selectOption('materials');
    await see(page.getByText('Sulfur', { exact: true })).toBeVisible();
    await page.getByRole('searchbox').fill('other');
    await see(page.getByText('No matching entries.')).toBeVisible();
    expect(reads).toBe(1);
  } finally {
    await page.close();
  }
});
it('renders the unpublished inspector at phone width and skips offline and forbidden reads', async () => {
  const page = await open('it', 390);
  try {
    let reads = 0;
    await page.route('**/openworld/seed', (route) => {
      reads++;
      return route.fulfill({ json: { ...sample, inspectorPublished: false, inspectorUrl: null } });
    });
    await page.goto(`${url}&seedAccess`);
    await see(page.getByText('Catalogo di generazione', { exact: true })).toBeVisible();
    await see(page.getByRole('link')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${shots}/seed-mobile.png`, fullPage: true });
    await page.goto(`${url}&seedAccess&offline`);
    await see(page.getByText('Avvia il server per consultarne il seed.')).toBeVisible();
    await page.goto(url);
    await see(page.getByRole('alert')).toBeVisible();
    expect(reads).toBe(1);
  } finally {
    await page.close();
  }
});
