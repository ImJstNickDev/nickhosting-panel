import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { type Browser, expect as check, chromium, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let vite: ViteDevServer, browser: Browser, url: string;
const shots = '.codex/local/openworld-browser';
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    cacheDir: `${process.cwd()}/.codex/local/openworld-telemetry-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'openworld-telemetry-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/telemetry-fixture')) return next();
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
  url = vite.resolvedUrls?.local[0] ?? '';
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
const instant = '2026-01-20T10:34:49.000Z';
const person = {
  id: 23,
  name: 'Solstice',
  state: 'playing',
  admitted: true,
  mode: 'survival',
  world: 'Earth',
  connectedS: 345,
  pingMs: 28,
};
const sample = {
  status: {
    tps: 19.9,
    players: { online: 2, slots: 12 },
    tickMs: { mean: 12, p99: 25, max: 36 },
    tickBudgetMs: 50,
    phasesMs: { net: 0.4, chunks: 6.5, sim: 3.1 },
    memory: { rssMB: 140 },
    uptimeS: 7250,
    net: { sentKbps: 2680, recvKbps: 10000, lossPct: 0 },
    pingMs: { mean: 33 },
    chunks: {
      live: 24,
      genBacklog: 3,
      generatedTotal: 1234,
      savedColumns: 10,
      generatedPerS: 2.4,
      genMeanMs: 6.6,
      servedPerS: 19.2,
      memHits: 780,
      diskHits: 25,
    },
    tick: 48921,
  },
  players: {
    players: [person, { ...person, id: 42, name: 'Northwind', mode: 'creative', pingMs: 39 }],
  },
  player: {
    ...person,
    geo: { lat: 31, lon: 12, alt: 100 },
    vitals: { health: 80, maxHealth: 100 },
    client: { fps: 60 },
    inventoryKnown: false,
    record: { joins: 9, blocksPlaced: 25 },
  },
  history: {
    t: [0, 1000, 2000, 3000].map((v) => Date.parse(instant) + v),
    tickMean: [10, 11, 9, 12],
    tickP99: [18, 25, 20, 25],
    recvKbps: [1150, 1520, 2030, 10000],
    sentKbps: [320, 1800, 2130, 2680],
  },
  chunks: {
    worlds: [
      { key: 'earth', name: 'Earth', live: 24, dirty: 7, generatedColumns: 1200, savedColumns: 10 },
      { key: 'moon', name: 'Moon', live: 8, dirty: 0, generatedColumns: 32, savedColumns: 8 },
    ],
    hot: [{ world: 'earth', face: 2, i: 1, j: -3, editsPerS: 0.3, simWritesPerS: 1.1, score: 81 }],
  },
  storage: {
    totalBytes: 729168,
    totalFiles: 23,
    worlds: [
      {
        key: 'earth',
        name: 'Earth',
        generatedBytes: 8192,
        savedBytes: 4096,
        pendingFlush: 4,
        dirtyLive: 2,
      },
    ],
    parts: [{ key: 'logs', label: 'Journaux', bytes: 8820, files: 2 }],
  },
};
function viewer(id: string, assisted = false) {
  const account = {
    id,
    name: id,
    email: `${id}@example.test`,
    emailVerified: true,
    locale: 'en',
    role: 'user',
    twoFactorEnabled: false,
  };
  return {
    context: {
      actorUserId: assisted ? 'support' : id,
      subjectUserId: id,
      role: 'user',
      sessionType: assisted ? 'support' : 'regular',
      ownerElevation: false,
      ...(assisted
        ? {
            support: {
              id: 'support-session',
              expiresAt: instant,
              startedAt: instant,
              lastActivityAt: instant,
              reason: 'Test',
            },
          }
        : {}),
    },
    actor: assisted ? { ...account, id: 'support' } : account,
    subject: account,
  };
}
async function serve(page: Page, offline = false) {
  await page.route('**/v1/web/session', (route) => route.fulfill({ json: viewer('reader') }));
  const paths: string[] = [];
  await page.route('**/v1/servers/**/openworld/telemetry/**', async (route) => {
    const u = new URL(route.request().url()),
      path = u.pathname.split('/telemetry/')[1];
    if (!path) return route.abort();
    paths.push(path);
    const name = path === 'players/23' ? 'player' : path;
    if (
      name === 'player' &&
      (u.searchParams.get('name') !== person.name ||
        u.searchParams.get('joinedAt') !== String(Date.parse(instant) - person.connectedS * 1000))
    )
      return route.fulfill({ status: 404 });
    return route.fulfill({
      json: {
        data: sample[name as keyof typeof sample],
        source: offline ? 'snapshot' : 'live',
        observedAt: instant,
        reason: offline ? 'offline' : null,
      },
    });
  });
  return paths;
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
it('opens live roster and pinned read-only details in English; a roster-only reader cannot open details', async () => {
  const context = await browser.newContext({
      locale: 'en-GB',
      viewport: { width: 1280, height: 800 },
    }),
    page = await context.newPage();
  try {
    const paths = await serve(page);
    await page.goto(`${url}telemetry-fixture?section=players`);
    await check(page.getByRole('heading', { name: 'Players', exact: true })).toBeVisible();
    await page.getByRole('searchbox').fill('sol');
    await check(page.getByText('Northwind')).toHaveCount(0);
    await page.getByRole('button', { name: /Solstice/ }).click();
    await check(page.getByRole('dialog')).toContainText('80 / 100');
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await check(page.getByRole('dialog')).toContainText(
      'The client has not reported an inventory yet.',
    );
    await page.getByRole('button', { name: 'Network', exact: true }).click();
    await check(page.getByRole('dialog')).toContainText('60');
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await check(page.getByRole('dialog')).toContainText('Blocks placed');
    await page.keyboard.press('Escape');
    await check(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('searchbox').fill('');
    await page.screenshot({ path: `${shots}/telemetry-players-en.png` });
    await fits(page);
    await page.goto(`${url}telemetry-fixture?section=players&reader`);
    await check(page.getByText('Solstice', { exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: /Solstice/ })).toHaveCount(0);
    expect(paths.filter((p) => p === 'players/23')).toHaveLength(1);
  } finally {
    await context.close();
  }
});
it('displays independent performance resources and current bitrates on mobile Italian', async () => {
  const context = await browser.newContext({
      locale: 'it-IT',
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage();
  try {
    await serve(page);
    let unblock!: () => void;
    const gate = new Promise<void>((ok) => {
      unblock = ok;
    });
    await page.route('**/telemetry/history', async (route) => {
      await gate;
      await route.fallback();
    });
    await page.goto(`${url}telemetry-fixture?section=performance`);
    await check(page.getByText('19,9', { exact: true })).toBeVisible();
    const world = page.getByRole('combobox', { name: 'Mondo', exact: true });
    await world.selectOption('moon');
    await check(page.getByText('32', { exact: true })).toBeVisible();
    await world.selectOption('earth');
    unblock();
    await page.getByRole('combobox', { name: 'Metrica' }).selectOption('network');
    await check(page.getByRole('img', { name: /Rete/ })).toBeVisible();
    await check(page.locator('.ow-legend')).toContainText('10.000 kb/s');
    await page.getByText('Tempo per fase del tick', { exact: true }).click();
    await check(page.getByText('6,5 ms', { exact: true })).toBeVisible();
    await check(page.getByText('36 ms', { exact: true })).toBeVisible();
    await page.getByText('Generazione del terreno e cache', { exact: true }).click();
    await check(page.getByText('Coda di generazione', { exact: true })).toBeVisible();
    await page.getByText('Archiviazione del mondo', { exact: true }).click();
    await check(page.getByText('4 KiB', { exact: true })).toBeVisible();
    await page.getByText('Spazio per categoria', { exact: true }).click();
    await check(page.getByText('Log', { exact: true })).toBeVisible();
    await check(page.getByText('Journaux', { exact: true })).toHaveCount(0);
    await page.getByText('Chunk più attivi', { exact: true }).click();
    await check(page.getByText('1, -3', { exact: true })).toBeVisible();
    await fits(page);
    await page.screenshot({ path: `${shots}/telemetry-performance-it.png`, fullPage: true });
    await page.goto(`${url}telemetry-fixture?section=overview`);
    await check(page.getByText('2 / 12', { exact: true })).toBeVisible();
    await check(page.getByText('10 Mb/s', { exact: true })).toBeVisible();
    await fits(page);
  } finally {
    await context.close();
  }
});
it('labels observations from a stopped server and suppresses live detail actions', async () => {
  const context = await browser.newContext({
      locale: 'it-IT',
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage();
  try {
    const paths = await serve(page, true);
    await page.goto(`${url}telemetry-fixture?section=players&offline`);
    await check(page.getByText('Ultima osservazione')).toBeVisible();
    await check(page.getByText('Il server è spento.')).toBeVisible();
    await check(page.locator('time')).toHaveAttribute('datetime', instant);
    await check(page.getByText('Solstice', { exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: /Solstice/ })).toHaveCount(0);
    expect(paths).toEqual(['players']);
    await fits(page);
  } finally {
    await context.close();
  }
});

it('renders populated slots and requests skin only from the pinned NickPanel route on mobile', async () => {
  const context = await browser.newContext({
    locale: 'it-IT',
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await serve(page);
    await page.route('**/telemetry/players', (route) =>
      route.fulfill({
        json: {
          source: 'live',
          observedAt: instant,
          reason: null,
          data: { players: [{ ...person, skinHash: 'aa12bc34' }] },
        },
      }),
    );
    await page.route('**/telemetry/players/23?*', (route) =>
      route.fulfill({
        json: {
          source: 'live',
          observedAt: instant,
          reason: null,
          data: {
            ...sample.player,
            inventoryKnown: true,
            inventory: {
              selected: 0,
              hotbar: [{ name: 'Iron pickaxe', count: 2, wearPct: 8 }, null],
              bag: [null, { name: 'Stone', count: 48 }],
              reportedAgoS: 20,
            },
          },
        },
      }),
    );
    let skin: URL | undefined;
    await page.route('**/telemetry/players/23/skin?*', (route) => {
      skin = new URL(route.request().url());
      return route.fulfill({ status: 404 });
    });
    await page.goto(`${url}telemetry-fixture?section=players`);
    await page.getByRole('button', { name: /Solstice/ }).click();
    await page.getByRole('button', { name: 'Inventario', exact: true }).click();
    await check(page.getByRole('dialog')).toContainText('Iron pickaxe');
    await check(page.getByRole('dialog')).toContainText('×48');
    await check(page.getByRole('listitem', { name: /Selezionato/ })).toContainText('×2');
    await check(page.getByRole('dialog')).toContainText('Usura 8 %');
    await expect.poll(() => skin?.searchParams.get('h')).toBe('aa12bc34');
    expect(skin?.origin).toBe(new URL(url).origin);
    expect(skin?.searchParams.get('name')).toBe(person.name);
    expect(skin?.searchParams.get('joinedAt')).toBe(
      String(Date.parse(instant) - person.connectedS * 1000),
    );
    await page.screenshot({ path: `${shots}/telemetry-inventory-it.png` });
    await fits(page);
  } finally {
    await context.close();
  }
});

it('drops roster and open detail when the same server switches to an assisted identity', async () => {
  const context = await browser.newContext({ locale: 'en-GB' });
  const page = await context.newPage();
  const hold = Promise.withResolvers<void>();
  try {
    await serve(page);
    await page.clock.install();
    await page.goto(`${url}telemetry-fixture?section=players`);
    await page.getByRole('button', { name: /Solstice/ }).click();
    await check(page.getByRole('dialog')).toContainText('80 / 100');
    await page.route('**/v1/web/session', (route) =>
      route.fulfill({ json: viewer('reader', true) }),
    );
    await page.route('**/telemetry/players', async (route) => {
      await hold.promise;
      await route
        .fulfill({
          json: {
            source: 'live',
            reason: null,
            observedAt: instant,
            data: { players: [{ id: 82, name: 'New identity roster' }] },
          },
        })
        .catch(() => {});
    });
    await page.clock.fastForward(30001);
    await check(page.getByRole('dialog')).toHaveCount(0);
    await check(page.getByText('Solstice', { exact: true })).toHaveCount(0);
    await check(page.getByText('Northwind', { exact: true })).toHaveCount(0);
    hold.resolve();
    await check(page.getByText('New identity roster', { exact: true })).toBeVisible();
  } finally {
    hold.resolve();
    await context.close();
  }
});
