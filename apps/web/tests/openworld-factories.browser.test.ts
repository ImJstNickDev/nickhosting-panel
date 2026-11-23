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
        name: 'telemetry-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/telemetry-fixture') && !req.url?.startsWith('/servers/'))
              return next();
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
  url = `${vite.resolvedUrls?.local[0]}telemetry-fixture?section=factories`;
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
  stepMs: { mean: 0.047, p95: 0.06, max: 0.221 },
  simSeconds: 307,
  uptimeSeconds: 310,
  steps: 6140,
  priority: -1,
  qos: 'user-interactive',
  loadedColumns: 12,
  counts: {
    nodes: 34,
    nets: 46,
    pieces: 489,
    byDevice: { machine: 7, pump: 1, motor: 2, lamp: 4 },
    byMedium: { electric: 20, item: 12, signal: 9, rotation: 3, fluid: 2 },
    frozen: 0,
    tooLong: 1,
    tripped: 2,
  },
  history: Array.from({ length: 60 }, (_, i) => ({
    t: 1764000000 + i,
    hz: 20 - i / 60,
    stepMs: 0.05,
    nodes: 34,
  })),
  phasesMs: {
    commands: 0.02,
    topology: 0.05,
    signals: 0.01,
    electric: 0.03,
    rotation: 0.01,
    fluids: 0.01,
    items: 0.02,
    radio: 0.01,
    events: 0.02,
  },
  rotation: { systems: 3, jammed: 1, deliveredW: 28 },
  radio: { emitters: 1, receivers: 2, channels: 1 },
  pumps: { count: 1, pumpedVoxels: 28, pendingTerrainVoxels: 2 },
  memory: { totalBytes: 4096, topology: 1024, nodes: 3072 },
  power: { producedW: 910, usedW: 708.5, storedJ: 7200, capacityJ: 36000, systems: 3 },
  transit: { items: 7, fluidVoxels: 11, itemTypes: [{ name: 'Copper ingot', count: 7 }] },
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
      '0.06 ms',
      '708.5 W',
      '2 Wh',
      '10 Wh',
      'Fluid voxels',
      '41.3 %',
    ])
      await see(page.getByText(text, { exact: true })).toBeVisible();
    await see(
      page.locator('.ow-factory-headline').getByText('20 Hz', { exact: true }),
    ).toBeVisible();
    for (const name of [
      'Devices',
      'Networks by medium',
      'Step phases',
      'Mechanical rotation',
      'Radio',
      'Pumps',
    ]) {
      await see(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    const memory = page.locator('details').filter({ hasText: 'Estimated memory' });
    await memory.locator('summary').click();
    await see(memory.locator('dd').first()).toBeVisible();
    const conveyor = page
      .locator('.ow-composition-legend')
      .getByRole('button', { name: /Conveyors ·/ });
    await conveyor.click();
    await see(conveyor).toHaveAttribute('aria-pressed', 'true');
    await see(page.getByText('Copper ingot', { exact: true })).toBeVisible();
    await see(page.getByRole('meter', { name: 'Battery charge' })).toHaveJSProperty('value', 20);
    const history = page.locator('.ow-history');
    await see(history.locator('.ow-history-guide title')).toHaveText(/Current target · 20 Hz/);
    await history.getByRole('combobox').selectOption('stepDuration');
    await see(history.locator('.ow-history-guide')).toHaveCount(0);
    await see(history.locator('.ow-legend')).toContainText('50 ms · above scale');
    await history.getByRole('combobox').selectOption('nodes');
    await see(history.locator('.ow-history-guide')).toHaveCount(0);
    await history.getByRole('button', { name: 'Zoom in' }).click();
    await see(history.getByText('Pinned sample', { exact: true })).toBeVisible();
    await history.getByRole('button', { name: 'Return to live' }).click();
    await history.getByRole('combobox').selectOption('frequency');
    await see(page.getByRole('link')).toHaveCount(1);
    await see(page.getByRole('link')).toHaveAttribute(
      'href',
      `/servers/${id}/game/map#world=earth&face=0&x=2664&z=2648&origin=factories`,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${shots}/factories-desktop.png`, fullPage: true });
    await page.context().setOffline(true);
    await see(page.getByText(/last reading/i).first()).toBeVisible();
    await see(page.getByText('Copper ingot', { exact: true })).toBeVisible();
    await page.context().setOffline(false);
    await see(page.getByText(/last reading/i)).toHaveCount(0);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('fixture-revoke', { detail: 'game.openworld.map.read' }),
      ),
    );
    await see(page.getByRole('link')).toHaveCount(0);
    await see(conveyor).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('fixture-revoke', { detail: 'game.openworld.performance.read' }),
      ),
    );
    await see(page.getByRole('alert')).toBeVisible();
    await see(page.getByText('Copper ingot', { exact: true })).toHaveCount(0);
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

it('refreshes visible factories each second and pauses while hidden, throttled or unauthorized', async () => {
  const page = await open('en', 900);
  let reads = 0;
  const visible = (value: boolean) =>
    page.evaluate(
      (state) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      },
      value ? 'visible' : 'hidden',
    );
  try {
    await page.addInitScript(() =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }),
    );
    await page.route('**/openworld/factories', (route) => {
      reads++;
      if (reads === 3)
        return route.fulfill({
          status: 429,
          headers: { 'Retry-After': '3' },
          json: { error: { code: 'rate_limited' } },
        });
      if (reads === 4)
        return route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } });
      return route.fulfill({ json: { enabled: false } });
    });
    await page.goto(url);
    await see(page.getByRole('status')).toBeVisible();
    await page.waitForTimeout(1150);
    expect(reads).toBe(0);

    await visible(true);
    await see.poll(() => reads, { timeout: 1900 }).toBe(2);
    await visible(false);
    await page.waitForTimeout(1350);
    expect(reads).toBe(2);

    await visible(true);
    await see(page.getByRole('alert')).toBeVisible();
    expect(reads).toBe(3);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.waitForTimeout(100);
    expect(reads).toBe(3);
    const navigate = (section: string) =>
      page.evaluate((target) => {
        history.pushState(null, '', location.pathname.replace(/[^/]+$/, target));
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, section);
    await navigate('unknown');
    await see(page.getByRole('alert')).toHaveCount(0);
    await navigate('factories');
    await see(page.getByRole('alert')).toBeVisible();
    await visible(false);
    await visible(true);
    await page.waitForTimeout(1400);
    expect(reads).toBe(3);
    await see.poll(() => reads, { timeout: 2200 }).toBe(4);
    await page.waitForTimeout(1300);
    expect(reads).toBe(4);
    await page.getByRole('button', { name: 'Try again' }).click();
    await see.poll(() => reads).toBe(5);
  } finally {
    await page.close();
  }
});
