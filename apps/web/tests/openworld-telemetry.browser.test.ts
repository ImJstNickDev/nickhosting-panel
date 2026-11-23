import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { type Browser, expect as check, chromium, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeMapTile } from '../../../games/openworld/src/map-terrain.js';

import { sampleIsometricDrag } from '../../../scripts/experiments/openworld-atlas/input-sample.js';
import {
  faceEdge,
  materialPalette,
  mesh,
  meshBundle,
  surface,
  texture,
  columns as valleyColumns,
} from '../../../scripts/experiments/openworld-atlas/valley.js';

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
  url = vite.resolvedUrls?.local[0] ?? '';
  browser = await chromium.launch({
    args:
      process.env.NICKHOSTING_PLAYWRIGHT_GPU === 'vulkan'
        ? [
            '--enable-gpu',
            '--use-angle=vulkan',
            '--enable-features=Vulkan',
            '--ignore-gpu-blocklist',
          ]
        : undefined,
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
function performanceHistory(offset = 0, retained = 49) {
  const indices = Array.from({ length: retained }, (_, i) => i + offset + 49 - retained);
  const wave = (i: number) => Math.sin(i / 2) + Math.sin(i / 6) + Math.cos(i * 1.8) / 2;
  return {
    t: indices.map((i) => Date.parse(instant) + (i - 48) * 5000),
    tickMean: indices.map((i) => (i === 10 ? null : Math.round(120 + 13 * wave(i)) / 10)),
    tickP99: indices.map((i) => Math.round(214 + 28 * wave(i) + (i === 34 ? 75 : 0)) / 10),
    recvKbps: indices.map((i) => (i === 48 ? 10000 : Math.round(7600 + 810 * wave(i)))),
    sentKbps: indices.map((i) => Math.round(2400 + 240 * wave(i + 4))),
    tps: indices.map((i) => Math.round(198 + Math.sin(i / 3)) / 10),
    players: indices.map((i) => (i < 7 ? 1 : 2)),
  };
}
const MiB = 1024 ** 2;
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
    worldTime: { dayFraction: 0.65625, dayLengthS: 1200 },
    phasesMs: {
      net: 0.38,
      chunks: 6.5,
      players: 0.21,
      edits: 0.14,
      sim: 3.1,
      snapshot: 0.48,
      projectiles: 0.09,
      entities: 0.73,
      chests: 0.12,
      send: 0.25,
    },
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
    pos: { face: 2, x: 128, y: 3, z: 256 },
    vitals: { health: 80, maxHealth: 100 },
    client: { fps: 60 },
    inventoryKnown: false,
    record: { joins: 9, blocksPlaced: 25 },
  },
  history: performanceHistory(),
  chunks: {
    worlds: [
      { key: 'earth', name: 'Earth', live: 24, dirty: 7, generatedColumns: 1200, savedColumns: 10 },
      { key: 'moon', name: 'Moon', live: 8, dirty: 0, generatedColumns: 32, savedColumns: 8 },
    ],
    hot: [{ world: 'earth', face: 2, i: 1, j: -3, editsPerS: 0.3, simWritesPerS: 1.1, score: 81 }],
  },
  storage: {
    totalBytes: 640 * MiB,
    totalFiles: 1000,
    worlds: [
      {
        key: 'earth',
        name: 'Earth',
        generatedBytes: 320 * MiB,
        savedBytes: 64 * MiB,
        pendingFlush: 4,
        dirtyLive: 2,
      },
      {
        key: 'moon',
        name: 'Moon',
        generatedBytes: 64 * MiB,
        savedBytes: 32 * MiB,
        pendingFlush: 0,
        dirtyLive: 0,
      },
    ],
    parts: [
      { key: 'earth.chunks', bytes: 320 * MiB, files: 512 },
      { key: 'moon.chunks', bytes: 64 * MiB, files: 172 },
      { key: 'earth.regions', bytes: 64 * MiB, files: 120 },
      { key: 'moon.regions', bytes: 32 * MiB, files: 50 },
      { key: 'earth.map', bytes: 64 * MiB, files: 96 },
      { key: 'moon.map', bytes: 32 * MiB, files: 42 },
      { key: 'logs', label: 'Journaux', bytes: 48 * MiB, files: 6 },
      { key: 'state', bytes: 16 * MiB, files: 2 },
    ],
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
async function serve(page: Page, offline = false, liveStatusTime?: string) {
  await page.route('**/v1/web/session', (route) => route.fulfill({ json: viewer('reader') }));
  await page.route('**/openworld/players/saved/search', (r) =>
    r.fulfill({
      json: { players: [], total: 0, page: 1, indexedAt: instant, stale: false, indexing: false },
    }),
  );
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
        ...(!offline && name === 'players' ? { processRef: 'a'.repeat(64) } : {}),
        observedAt:
          name === 'status' && !offline ? (liveStatusTime ?? new Date().toISOString()) : instant,
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
    const player = page.getByRole('link', { name: /Solstice/ });
    await player.click();
    await check(page.getByRole('dialog')).toHaveCount(0);
    await check(page.getByRole('searchbox')).toHaveCount(0);
    await check(page.getByRole('heading', { name: 'Solstice' })).toBeFocused();
    const directUrl = page.url();
    expect(new URL(directUrl).pathname).toMatch(/\/game\/players\/connection\/23$/);
    await check(page.locator('section.ow-profile')).toContainText('80 / 100');
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await check(page.locator('section.ow-profile')).toContainText(
      'The client has not reported an inventory yet.',
    );
    await page.getByRole('button', { name: 'Network', exact: true }).click();
    await check(page.locator('section.ow-profile')).toContainText('60');
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await check(page.locator('section.ow-profile')).toContainText('Blocks placed');
    await page.goBack();
    await check(page.locator('section.ow-profile')).toHaveCount(0);
    await check(page.getByRole('searchbox')).toHaveValue('sol');
    await check(player).toBeFocused();
    await page.goForward();
    await check(page.getByRole('region', { name: 'Solstice' })).toContainText('80 / 100');
    expect(page.url()).toBe(directUrl);
    await page.reload();
    await check(page.getByRole('region', { name: 'Solstice' })).toContainText('80 / 100');
    const detailReads = paths.filter((p) => p === 'players/23').length;
    expect(detailReads).toBeGreaterThan(0);
    await page.getByRole('link', { name: '← Players' }).click();
    await check(page.locator('section.ow-profile')).toHaveCount(0);
    await page.getByRole('searchbox').fill('');
    await page.screenshot({ path: `${shots}/telemetry-players-en.png` });
    await fits(page);
    await page.goto(`${url}telemetry-fixture?section=players&reader`);
    await check(page.getByText('Solstice', { exact: true })).toBeVisible();
    await check(page.getByRole('link', { name: /Solstice/ })).toHaveCount(0);
    expect(paths.filter((p) => p === 'players/23')).toHaveLength(detailReads);
  } finally {
    await context.close();
  }
});
it('displays independent performance resources and pins history by touch on mobile Italian', async () => {
  const context = await browser.newContext({
      locale: 'it-IT',
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    }),
    page = await context.newPage();
  try {
    await serve(page, false, instant);
    const historyReady = Promise.withResolvers<void>();
    await page.route('**/telemetry/history', async (route) => {
      await historyReady.promise;
      await route.fallback();
    });
    await page.goto(`${url}telemetry-fixture?section=performance`);
    await check(page.getByText('19,9', { exact: true })).toBeVisible();
    const world = page.getByRole('combobox', { name: 'Mondo', exact: true });
    await world.selectOption('moon');
    await check(page.getByText('32', { exact: true })).toBeVisible();
    await world.selectOption('earth');
    historyReady.resolve();
    const metric = page.getByRole('combobox', { name: 'Metrica' });
    await metric.selectOption('network');
    const graph = page.getByRole('slider', { name: 'Campione' });
    await check(page.getByRole('img', { name: /Rete/ })).toBeVisible();
    await check(page.locator('.ow-legend')).toContainText('10.000 kb/s');
    await graph.tap({ position: { x: 58, y: 42 } });
    const stamp = page.locator('.ow-history-readout time');
    const pinned = await stamp.getAttribute('datetime');
    expect(pinned).toBeTruthy();
    expect(pinned).not.toBe(instant);
    await metric.selectOption('timing');
    await check(stamp).toHaveAttribute('datetime', pinned ?? '');
    await check(page.getByText('Campione fissato', { exact: true })).toBeVisible();

    const phases = page.locator('.ow-tick-phases .ow-composition-legend');
    await check(phases.getByRole('button')).toHaveCount(10);
    await check(phases.getByRole('button', { name: /Chunk/ })).toContainText('6,5 ms');
    await check(page.getByText('36 ms', { exact: true })).toBeVisible();
    const terrain = page.getByText('Generazione del terreno e cache', { exact: true });
    await terrain.click();
    await check(page.getByText('Coda di generazione', { exact: true })).toBeVisible();
    await terrain.click();
    const stored = page.getByText('Archiviazione del mondo', { exact: true });
    await stored.click();
    const storagePanel = page.locator('.ow-panel').filter({ has: stored });
    await storagePanel.getByRole('combobox', { name: 'Mondo' }).selectOption('moon');
    await check(storagePanel.getByText('32 MiB', { exact: true })).toBeVisible();
    await stored.click();
    const hot = page.getByText('Chunk più attivi', { exact: true });
    await hot.click();
    await check(page.getByText('1, -3', { exact: true })).toBeVisible();
    await hot.click();
    const disk = page.locator('.ow-disk-breakdown');
    await disk.locator('.ow-composition-legend').getByRole('button', { name: /Chunk/ }).tap();
    await check(disk.getByRole('row', { name: /Earth.*320 MiB.*512/ })).toBeVisible();
    await check(disk.getByRole('row', { name: /Moon.*64 MiB.*172/ })).toBeVisible();
    await check(disk.getByText('Journaux', { exact: true })).toHaveCount(0);
    await disk.getByRole('heading').tap();
    await fits(page);
    await page.screenshot({ path: `${shots}/telemetry-performance-it.png`, fullPage: true });
    await page.clock.setFixedTime(new Date(instant));
    await page.goto(`${url}telemetry-fixture?section=overview`);
    await check(page.getByText('2 / 12', { exact: true })).toBeVisible();
    await check(page.getByText('10 Mb/s', { exact: true })).toBeVisible();
    const clock = page.locator('.ow-world-clock');
    await check(clock).toContainText('Ora del mondo');
    await check(clock.locator('time')).toHaveText('15:45');
    await check(clock.locator('.ow-cycle')).toHaveAttribute('aria-hidden', 'true');
    expect(
      Number.parseFloat((await clock.locator('circle').getAttribute('cy')) ?? ''),
    ).toBeLessThan(50);
    await fits(page);
    await page.locator('.ow-workspace').screenshot({ path: `${shots}/world-clock-mobile-it.png` });
  } finally {
    await context.close();
  }
});
it('inspects and zooms cached performance samples across metric changes and a rolling refresh', async () => {
  const context = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    await serve(page, false, instant);
    const requests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname.split('/telemetry/')[1];
      if (path) requests.push(path);
    });
    let historyReads = 0;
    await page.route('**/telemetry/history', (route) => {
      const data = historyReads++ === 0 ? sample.history : performanceHistory(3, 36);
      return route.fulfill({
        json: {
          data,
          source: 'live',
          reason: null,
          observedAt: new Date(data.t.at(-1) ?? 0).toISOString(),
        },
      });
    });
    await page.clock.install({ time: new Date(instant) });
    await page.goto(`${url}telemetry-fixture?section=performance`);
    const slider = page.getByRole('slider', { name: 'Sample' });
    const metric = page.getByRole('combobox', { name: 'Metric' });
    const stamp = page.locator('.ow-history-readout time');
    const chart = page.locator('.ow-history').getByRole('img');
    const phases = page.locator('.ow-tick-phases');
    const disk = page.locator('.ow-disk-breakdown');
    await check(stamp).toHaveAttribute('datetime', instant);
    await check(disk.getByText('640 MiB in reported categories')).toBeVisible();
    await check(phases.getByRole('heading')).toBeVisible();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 300));
    expect([...requests].sort()).toEqual(['chunks', 'history', 'status', 'storage']);

    await slider.hover({ position: { x: 120, y: 30 } });
    await check(stamp).not.toHaveAttribute('datetime', instant);
    await metric.hover();
    await check(stamp).toHaveAttribute('datetime', instant);
    await slider.click({ position: { x: 240, y: 50 } });
    await check(page.getByText('Pinned sample', { exact: true })).toBeVisible();
    const clicked = await stamp.getAttribute('datetime');
    await slider.press('ArrowRight');
    await check(stamp).toHaveAttribute(
      'datetime',
      new Date(Date.parse(clicked ?? '') + 5000).toISOString(),
    );
    await slider.press('Home');
    const origin = sample.history.t[0] ?? 0;
    await check(stamp).toHaveAttribute('datetime', new Date(origin).toISOString());
    for (let i = 0; i < 10; i++) await slider.press('ArrowRight');
    const pinned = new Date(origin + 50000).toISOString();
    await check(stamp).toHaveAttribute('datetime', pinned);
    const legend = page.locator('.ow-legend');
    await check(legend).toContainText('—');
    await metric.selectOption('network');
    await check(stamp).toHaveAttribute('datetime', pinned);
    await check(legend).not.toContainText('—');
    const values = await legend.innerText();
    const fullRange = await chart.getAttribute('aria-label');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await check(chart).not.toHaveAttribute('aria-label', fullRange ?? '');
    await check(stamp).toHaveAttribute('datetime', pinned);
    const resetZoom = page.getByRole('button', { name: 'Reset zoom' });
    await resetZoom.click();
    await check(chart).toHaveAttribute('aria-label', fullRange ?? '');
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    if (!box) throw Error('Expected the sample control to be visible');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
    await page.mouse.up();
    await check(chart).not.toHaveAttribute('aria-label', fullRange ?? '');
    await check(stamp).toHaveAttribute('datetime', pinned);
    await resetZoom.click();

    const phaseList = phases.locator('.ow-composition-legend');
    const phaseBar = phases.locator('.ow-composition-bar');
    const simulation = phaseList.getByRole('button', { name: /Simulation/ });
    await simulation.focus();
    await check(phaseBar.getByRole('button', { name: /Simulation/ })).toHaveAttribute(
      'data-highlighted',
      'true',
    );
    const segment = disk.locator('.ow-composition-bar').getByRole('button', { name: /Chunks/ });
    const row = disk.locator('.ow-composition-legend').getByRole('button', { name: /Chunks/ });
    await segment.hover();
    await check(row).toHaveAttribute('data-highlighted', 'true');
    await row.press('Enter');
    await check(row).toHaveAttribute('aria-pressed', 'true');
    await check(disk.getByRole('row', { name: /Earth.*320 MiB.*512/ })).toBeVisible();
    await check(disk.getByRole('row', { name: /Moon.*64 MiB.*172/ })).toBeVisible();
    await fits(page);
    expect(requests).toHaveLength(4);

    await page.clock.fastForward(15001);
    await page.clock.resume();
    await check.poll(() => historyReads).toBe(2);
    const historyPanel = page.locator('.ow-panel').filter({ has: chart });
    await check(historyPanel.locator('.ow-stamp time')).toHaveAttribute(
      'datetime',
      new Date(Date.parse(instant) + 15000).toISOString(),
    );
    await check(chart).toHaveAttribute('aria-label', fullRange ?? '');
    await check(stamp).toHaveAttribute('datetime', pinned);
    expect(await legend.innerText()).toBe(values);
    await metric.selectOption('timing');
    await slider.press('ArrowRight');
    await page.getByRole('heading', { name: 'Recent history' }).click();
    await page.screenshot({ path: `${shots}/telemetry-performance-en.png`, fullPage: true });
    await page.getByRole('button', { name: 'Return to live' }).click();
    await check(stamp).toHaveAttribute(
      'datetime',
      new Date(Date.parse(instant) + 15000).toISOString(),
    );
  } finally {
    await context.close();
  }
});

it('preserves zero and missing performance readings in partial snapshots', async () => {
  const page = await browser.newPage({ locale: 'en-GB', viewport: { width: 320, height: 720 } });
  try {
    await serve(page, true);
    let empty = false;
    const data = () => ({
      status: { ...sample.status, phasesMs: empty ? {} : { net: 0, sim: null } },
      storage: {
        ...sample.storage,
        parts: empty
          ? []
          : [
              { key: 'earth.chunks', bytes: 64 * MiB, files: 72 },
              { key: 'moon.chunks', bytes: null, files: null },
              { key: 'logs', bytes: 0, files: 0 },
              { key: 'tiles', label: 'Elevation tiles', bytes: 0, files: 1 },
            ],
      },
    });
    await page.route('**/telemetry/{status,storage}', (route) => {
      const resource = route.request().url().endsWith('/status') ? 'status' : 'storage';
      return route.fulfill({
        json: {
          data: data()[resource],
          source: 'snapshot',
          reason: 'offline',
          observedAt: instant,
        },
      });
    });
    await page.route('**/telemetry/history', (route) =>
      route.fulfill({
        json: {
          data: {
            t: [231, 1231].map((offset) => Date.parse(instant) + offset),
            recvKbps: [9347.56, 12345.23],
          },
          source: 'snapshot',
          observedAt: instant,
          reason: 'offline',
        },
      }),
    );
    await page.goto(`${url}telemetry-fixture?section=performance&offline`);
    const phases = page.locator('.ow-tick-phases');
    const disk = page.locator('.ow-disk-breakdown');
    const categories = disk.locator('.ow-composition-legend');
    await check(phases.getByRole('button', { name: /Network receive/ })).toContainText('0 ms');
    await check(phases.getByRole('button', { name: /Simulation/ })).toContainText('—');
    await check(phases.locator('.ow-composition-bar button')).toHaveCount(0);
    const partialTotal = '≥ 64 MiB in reported categories · percentages use measured bytes only';
    await check(disk.getByText(partialTotal, { exact: true })).toBeVisible();
    await check(categories.getByRole('button', { name: /Chunks/ })).toHaveAccessibleDescription(
      partialTotal,
    );
    await check(categories.getByRole('button', { name: /Chunks/ })).toContainText('≥ 64 MiB');
    await categories.getByRole('button', { name: /Chunks/ }).click();
    await check(disk.getByRole('row', { name: 'Moon — —' })).toBeVisible();
    await categories.getByRole('button', { name: /Logs/ }).click();
    await check(disk.getByRole('row', { name: 'Server-wide 0 B 0' })).toBeVisible();
    await check(categories.getByRole('button', { name: /Elevation tiles/ })).toBeVisible();
    await page.getByRole('combobox', { name: 'Metric' }).selectOption('network');
    const times = await page.locator('.ow-history-x span:visible').evaluateAll((labels) =>
      labels.map((label) => {
        const { left, right } = label.getBoundingClientRect();
        return { left, right };
      }),
    );
    expect(times.length).toBeGreaterThanOrEqual(2);
    let previousRight = 0;
    for (const { left, right } of times) {
      expect(left).toBeGreaterThanOrEqual(previousRight);
      previousRight = right;
    }
    const slider = page.getByRole('slider', { name: 'Sample' });
    await slider.press('Home');
    await check(page.getByRole('button', { name: 'Return to latest sample' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Metric' }).selectOption('pingMean');
    await check(page.getByText('No samples for this metric yet.')).toBeVisible();
    await fits(page);
    empty = true;
    await page.reload();
    await check(disk.getByText('No storage categories reported.')).toBeVisible();
    await check(phases.getByText('No metrics reported yet.')).toBeVisible();
    await check(page.getByRole('heading', { name: 'Terrain by world' })).toBeVisible();
    await fits(page);
  } finally {
    await page.close();
  }
});

async function expectWorldTime(page: Page, expected: string) {
  const clock = page.locator('.ow-world-clock');
  await expect
    .poll(
      async () => {
        await page.clock.runFor(32);
        return clock.locator('time:visible').allTextContents();
      },
      { timeout: 8000 },
    )
    .toEqual([expected]);
}
async function setTabHidden(page: Page, hidden: boolean) {
  await page.evaluate((hidden) => {
    if (hidden) {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    } else {
      Reflect.deleteProperty(document, 'hidden');
      Reflect.deleteProperty(document, 'visibilityState');
    }
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  }, hidden);
}
it.each(['no-preference', 'reduce'] as const)(
  'advances the live world clock between samples with %s motion',
  async (reducedMotion) => {
    const context = await browser.newContext({ locale: 'en-GB', reducedMotion });
    const page = await context.newPage();
    const releaseSecondSample = Promise.withResolvers<void>();
    try {
      await serve(page);
      const dayLengthS = 2400;
      let start: number | undefined;
      let reads = 0;
      await page.route('**/telemetry/status', async (route) => {
        const now = await page.evaluate(() => Date.now());
        start ??= now;
        reads++;
        const sampleLag = reads > 1 ? 0.4 : 0;
        const elapsed = (now - start) / 1000;
        const dayFraction = 0.5 + (elapsed - sampleLag) / dayLengthS;
        if (reads === 2) await releaseSecondSample.promise;
        await route.fulfill({
          json: {
            data: {
              ...sample.status,
              tick: sample.status.tick + Math.floor(elapsed * 20),
              worldTime: { dayFraction, dayLengthS },
            },
            source: 'live',
            reason: null,
            observedAt: new Date(now).toISOString(),
          },
        });
      });
      await page.clock.install({ time: new Date(instant) });
      await page.clock.pauseAt(new Date(Date.parse(instant) + 1000));
      await page.goto(`${url}telemetry-fixture?section=overview`);
      const clock = page.locator('.ow-world-clock');
      await expectWorldTime(page, '12:00');
      const marker = clock.locator('circle');
      const position = async () => Number.parseFloat((await marker.getAttribute('cx')) ?? '');
      const initial = await position();
      // Count painted marker positions, independently of the renderer's scheduling mechanism.
      const changes = await marker.evaluateHandle((dot) => {
        const counter = { ticks: 0 };
        new MutationObserver((mutations) => {
          counter.ticks += mutations.length;
        }).observe(dot, { attributes: true, attributeFilter: ['cx'] });
        return counter;
      });
      await page.clock.runFor(2000);
      expect(await position()).toBeGreaterThan(initial);
      await check(clock.locator('time')).toHaveText('12:01');
      expect(reads).toBe(1);
      const ticks = await changes.evaluate((value) => value.ticks);
      if (reducedMotion === 'reduce') expect(ticks).toBeLessThanOrEqual(3);
      else expect(ticks).toBeGreaterThan(3);

      const secondResponse = page.waitForResponse('**/telemetry/status');
      await page.clock.runFor(3100);
      await expect.poll(() => reads).toBe(2);
      const beforeCorrection = await position();
      releaseSecondSample.resolve();
      await secondResponse;
      await page.clock.runFor(32);
      expect(await position()).toBeGreaterThanOrEqual(beforeCorrection);
      await page.clock.runFor(2000);
      expect(await position()).toBeGreaterThan(beforeCorrection);
      expect(reads).toBe(2);

      await setTabHidden(page, true);
      const hiddenPosition = await position();
      await page.clock.runFor(1500);
      expect(await position()).toBe(hiddenPosition);
      await setTabHidden(page, false);
      await page.clock.runFor(32);
      expect(await position()).toBeGreaterThan(hiddenPosition);
    } finally {
      releaseSecondSample.resolve();
      await context.close();
    }
  },
);
it('waits for fresh world time after a long-hidden tab and resumes at the reported phase', async () => {
  const context = await browser.newContext({ locale: 'en-GB' });
  const page = await context.newPage();
  const delayedSample = Promise.withResolvers<void>();
  const freshSample = Promise.withResolvers<void>();
  let reads = 0;
  let firstObserved = 0;
  try {
    await serve(page);
    await page.route('**/telemetry/status', async (route) => {
      const read = ++reads;
      if (read === 2) await delayedSample.promise;
      if (read >= 3) await freshSample.promise;
      const now = await page.evaluate(() => Date.now());
      if (read === 1) firstObserved = now;
      const observedAt = new Date(read === 2 ? firstObserved + 1000 : now).toISOString();
      await route.fulfill({
        json: {
          data: {
            ...sample.status,
            tick: 10 + Math.round((Date.parse(observedAt) - firstObserved) / 50),
            worldTime: { dayFraction: read < 3 ? 0.375 : 0.90625, dayLengthS: 1500 },
          },
          source: 'live',
          reason: null,
          observedAt,
        },
      });
    });
    await page.clock.install({ time: new Date(instant) });
    await page.clock.pauseAt(new Date(Date.parse(instant) + 1000));
    await page.goto(`${url}telemetry-fixture?section=overview`);
    await expectWorldTime(page, '09:00');
    await setTabHidden(page, true);
    await page.clock.fastForward(900_000);
    await setTabHidden(page, false);
    await page.clock.runFor(32);
    const clock = page.locator('.ow-world-clock');
    await check(clock.locator('time')).toBeHidden();
    await check(clock.locator('circle')).toBeHidden();
    await check(clock.locator('polyline').first()).toBeVisible();
    await expect.poll(() => reads).toBe(2);
    delayedSample.resolve();
    await expect
      .poll(async () => {
        await page.clock.runFor(32);
        return page.locator('.ow-stamp time').getAttribute('datetime');
      })
      .toBe(new Date(firstObserved + 1000).toISOString());
    await check(clock.locator('time')).toBeHidden();
    await check(clock.locator('circle')).toBeHidden();
    await page.clock.runFor(5100);
    await expect.poll(() => reads).toBe(3);
    freshSample.resolve();
    await expectWorldTime(page, '21:45');
    await check(clock.locator('circle')).toBeVisible();
    expect(Number.parseFloat((await clock.locator('circle').getAttribute('cx')) ?? '')).toBeCloseTo(
      90.625,
      1,
    );
  } finally {
    delayedSample.resolve();
    freshSample.resolve();
    await context.close();
  }
});
it('keeps the last observed world time while offline and leaves a missing clock unknown', async () => {
  const context = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  try {
    await serve(page, true);
    let worldTime: { dayFraction: number; dayLengthS: number } | undefined = {
      dayFraction: 0,
      dayLengthS: 1200,
    };
    let statusReads = 0;
    await page.route('**/telemetry/status', (route) => {
      statusReads++;
      return route.fulfill({
        json: {
          data: { ...sample.status, worldTime },
          source: 'snapshot',
          observedAt: instant,
          reason: 'offline',
        },
      });
    });
    await page.clock.install();
    await page.goto(`${url}telemetry-fixture?section=overview&offline`);
    const clock = page.locator('.ow-world-clock');
    await check(page.locator('.ow-stamp time')).toHaveAttribute('datetime', instant);
    await check(clock.locator('time')).toHaveText('00:00');
    expect(
      Number.parseFloat((await clock.locator('circle').getAttribute('cy')) ?? ''),
    ).toBeGreaterThan(50);
    await page.clock.fastForward(60000);
    await check(clock.locator('time')).toHaveText('00:00');
    expect(Number.parseFloat((await clock.locator('circle').getAttribute('cx')) ?? '')).toBe(0);
    expect(statusReads).toBe(1);
    await fits(page);
    await page
      .locator('.ow-workspace')
      .screenshot({ path: `${shots}/world-clock-midnight-en.png` });

    worldTime = undefined;
    await page.reload();
    await check(page.getByText('2 / 12', { exact: true })).toBeVisible();
    await check(clock.getByText('Unavailable', { exact: true })).toBeVisible();
    await check(clock.locator('time')).toHaveCount(0);
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
    await check(page.getByRole('link', { name: /Solstice/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Online', exact: true }).click();
    await check(page.getByText('Solstice', { exact: true })).toHaveCount(0);
    await check(page.getByText('Nessun giocatore connesso.')).toBeVisible();
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
          gameVersion: 'a1.2.9',
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
              hotbar: [
                { code: 52428800, name: 'Iron pickaxe', kind: 'pickaxe', count: 2, wearPct: 8 },
                { name: 'Iron axe', kind: 'axe', count: 1 },
                { name: 'Leather cap', kind: 'helmet', count: 1 },
                null,
                { name: 'Bread', kind: 'food', count: 6 },
              ],

              bag: [
                null,
                { code: 16777217, name: 'Stone', kind: 'block', count: 48 },
                { name: 'Iron', kind: 'resource', count: 16 },
                { name: 'Key', kind: 'key', count: 1 },
              ],
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
    await page.getByRole('link', { name: /Solstice/ }).click();
    await page.getByRole('button', { name: 'Inventario', exact: true }).click();
    const profile = page.locator('section.ow-profile');
    const pickaxe = profile.getByRole('button', { name: /Piccone di ferro.*Selezionato/ });
    await check(pickaxe).toHaveAttribute('aria-pressed', 'true');
    await check(profile).toContainText('Quantità 2');
    await check(profile).toContainText('Usura 8 %');
    await pickaxe.focus();
    await check(page.getByRole('tooltip')).toContainText('Piccone di ferro');
    const stone = profile.getByRole('button', { name: /Slot 14 · Pietra/ });
    await check(stone.locator('.ow-item-tile')).toBeVisible();
    expect(
      await stone.locator('.ow-item-tile').evaluate((el) => getComputedStyle(el).backgroundImage),
    ).toContain('url(');
    await stone.click();
    await check(profile).toContainText('#16777217');
    await check(profile).toContainText('Quantità 48');
    await pickaxe.click();
    await check(profile).toContainText('#52428800');
    await page.mouse.move(0, 0);
    await expect.poll(() => skin?.searchParams.get('h')).toBe('aa12bc34');
    expect(skin?.origin).toBe(new URL(url).origin);
    expect(skin?.searchParams.get('name')).toBe(person.name);
    expect(skin?.searchParams.get('joinedAt')).toBe(
      String(Date.parse(instant) - person.connectedS * 1000),
    );
    expect(await profile.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const detailBounds = await profile.locator('.ow-item-detail').boundingBox();
    const profileBounds = await profile.boundingBox();
    expect(
      detailBounds &&
        profileBounds &&
        detailBounds.y + detailBounds.height <= profileBounds.y + profileBounds.height + 1,
    ).toBe(true);
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
    await page.getByRole('link', { name: /Solstice/ }).click();
    await check(page.locator('section.ow-profile')).toContainText('80 / 100');
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
    await check(page.locator('section.ow-profile')).toHaveCount(0);
    await check(page.getByText('Solstice', { exact: true })).toHaveCount(0);
    await check(page.getByText('Northwind', { exact: true })).toHaveCount(0);
    hold.resolve();
    await check(page.getByText('New identity roster', { exact: true })).toBeVisible();
  } finally {
    hold.resolve();
    await context.close();
  }
});

it('lets a moderator act on a pinned live session without reading player details', async () => {
  const context = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const sent: {
    player: typeof person;
    requestId: string;
    processRef: string;
    action: { kind: string; text?: string; reason?: string };
  }[] = [];
  try {
    const paths = await serve(page);
    await page.clock.install();
    await page.route('**/openworld/players/actions', (r) => {
      const body = r.request().postDataJSON();
      sent.push(body);
      return r.fulfill({ status: 202, json: { requestId: body.requestId, outcome: 'accepted' } });
    });
    await page.goto(`${url}telemetry-fixture?section=players&reader&moderator`);
    await check(page.getByRole('button', { name: 'Saved players' })).toHaveCount(0);
    await page.getByRole('link', { name: /Solstice/ }).click();
    const profile = page.locator('section.ow-profile');
    await check(profile.getByRole('button', { name: 'Inventory' })).toHaveCount(0);
    await check(profile.getByRole('button', { name: 'Request screenshot' })).toHaveCount(0);
    const sendMessage = profile.getByRole('button', { name: 'Send message' });
    const commandTop = () => sendMessage.evaluate((el) => el.getBoundingClientRect().top + scrollY);
    const initialTop = await commandTop();
    const toast = page.locator('.ow-action-toast');
    await sendMessage.click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Private message').fill('Welcome back');
    await editor.getByRole('button', { name: 'Send message' }).click();
    await check(toast.getByRole('status')).toContainText('Request accepted for Solstice');
    await check(toast).toHaveCSS('position', 'fixed');
    expect(await toast.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(480);
    expect(await commandTop()).toBeCloseTo(initialTop, 0);
    expect(await toast.evaluate((el) => el.contains(document.activeElement))).toBe(false);
    await page.screenshot({
      path: `${shots}/player-action-notice-desktop.png`,
      animations: 'disabled',
    });
    await toast.hover();
    await page.clock.fastForward(7000);
    await check(toast).toBeVisible();
    await page.mouse.move(0, 0);
    await page.clock.fastForward(3500);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      processRef: 'a'.repeat(64),
      player: { id: 23, name: 'Solstice', joinedAt: Date.parse(instant) - 345000 },
      action: { kind: 'message', text: 'Welcome back' },
    });

    await check(editor).toHaveCount(0);
    await profile.getByRole('button', { name: 'Kick player' }).click();
    await editor.getByLabel('Reason (optional)').fill('Please reconnect after the server update.');
    await editor.getByRole('button', { name: 'Continue' }).click();
    await check(profile).toContainText('Disconnect Solstice from the server?');
    expect(sent).toHaveLength(1);
    await page.screenshot({ path: `${shots}/block2-kick-desktop.png` });
    await editor.getByRole('button', { name: 'Back' }).click();
    expect(sent).toHaveLength(1);
    await editor.getByRole('button', { name: 'Continue' }).click();
    await editor.getByRole('button', { name: 'Kick player' }).click();
    await check(toast.getByRole('status')).toContainText('Kick player');
    await page.clock.fastForward(3500);
    await check(toast).toBeVisible();
    await page.clock.fastForward(3100);
    await check(toast).toHaveCount(0);
    expect(sent[1]?.action).toEqual({
      kind: 'kick',
      reason: 'Please reconnect after the server update.',
    });
    expect(sent[1]?.requestId).not.toBe(sent[0]?.requestId);
    expect(paths.some((path) => path.startsWith('players/'))).toBe(false);
  } finally {
    await context.close();
  }
});

it('validates teleport coordinates and prevents repeating an uncertain write', async () => {
  const context = await browser.newContext({
      locale: 'it-IT',
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage();
  try {
    await serve(page);
    const sent: unknown[] = [];
    await page.route('**/openworld/players/destinations', (r) =>
      r.fulfill({
        json: {
          worlds: [{ key: 'earth', name: 'Terra' }],
          checkpoints: [{ id: 7, world: 'earth', name: 'Baita' }],
        },
      }),
    );
    await page.route('**/openworld/players/actions', (r) => {
      sent.push(r.request().postDataJSON());
      const code = sent.length === 1 ? 'game_not_ready' : 'operation_uncertain';
      return r.fulfill({
        status: 409,
        json: { error: { code, messageKey: `errors.${code}` } },
      });
    });
    await page.goto(`${url}telemetry-fixture?section=players&reader&moderator`);
    await page.getByRole('link', { name: /Solstice/ }).click();
    await page.getByRole('button', { name: 'Teletrasporta', exact: true }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Destinazione', { exact: true }).selectOption('coordinates');
    await editor.getByLabel('Mondo', { exact: true }).selectOption('earth');
    await editor.getByLabel('Latitudine (°)').fill('91');
    await editor.getByLabel('Longitudine (°)').fill('11');
    await editor.getByRole('button', { name: 'Continua' }).click();
    expect(
      await editor
        .locator('input[name="lat"]')
        .evaluate((el) => (el as HTMLInputElement).validity.rangeOverflow),
    ).toBe(true);
    await editor.getByLabel('Latitudine (°)').fill('41');
    await editor.getByRole('button', { name: 'Continua' }).click();
    await check(editor).toContainText('Livello del terreno');
    await fits(page);
    await editor.getByRole('button', { name: 'Teletrasporta' }).click();
    await check(editor.getByRole('alert')).toBeVisible();
    await check(editor.getByRole('button', { name: 'Teletrasporta' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Teletrasporta' }).click();
    await check(editor.getByRole('button', { name: 'Teletrasporta' })).toBeDisabled();
    await check(page.locator('.ow-action-toast')).toHaveCount(0);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      action: {
        kind: 'teleport',
        destination: { type: 'coordinates', world: 'earth', lat: 41, lon: 11, alt: null },
      },
    });
  } finally {
    await context.close();
  }
});

const archiveId = '1a6d0a8f-3995-4336-960f-dd7e430b212f';
it('opens persisted player saves while offline and keeps same-name accounts separate', async () => {
  const context = await browser.newContext({
      locale: 'it-IT',
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage();
  try {
    const paths = await serve(page, true);
    const row = { uuid: archiveId, name: 'Solstice', savedAt: instant };
    const savedCalls: string[] = [];
    await page.route('**/openworld/players/saved/search', (r) =>
      r.fulfill({
        json: {
          indexedAt: instant,
          indexing: false,
          stale: true,
          page: 1,
          total: 2,
          players: [row, { ...row, uuid: '9a9712ef-4b49-4d65-8ea7-3627e827d873' }],
        },
      }),
    );
    await page.route(`**/openworld/players/saved/${archiveId}`, (r) => {
      savedCalls.push(r.request().url());
      return r.fulfill({
        json: {
          ...row,
          statsAt: instant,
          mode: 'survival',
          world: 'Terra',
          position: { x: 2, y: 80, z: 5 },
          stats: { joins: 9, lastSeenMs: Date.parse(instant) },
          inventory: { selected: 0, hotbar: [{ code: 71, count: 24 }], bag: [] },
        },
      });
    });
    await page.goto(`${url}telemetry-fixture?section=players&offline`);
    await check(page.getByRole('button', { name: 'Tutti i giocatori' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await check(page.getByRole('status')).toContainText('indice');
    await page.getByRole('link', { name: new RegExp(archiveId) }).click();
    const profile = page.locator('section.ow-profile');
    await check(profile).toContainText(archiveId);
    await check(profile).toContainText('Ultimo salvataggio');
    await profile.getByRole('button', { name: 'Inventario', exact: true }).click();
    await check(profile).toContainText('Barra rapida');
    await check(profile).toContainText('Quantità 24');
    await check(profile).toContainText('#71');
    await fits(page);
    await page.screenshot({ path: `${shots}/block2-save-mobile.png` });
    expect(savedCalls).toHaveLength(1);
    expect(savedCalls[0]).toContain(`/saved/${archiveId}`);
    const accountUrl = page.url();
    expect(new URL(accountUrl).pathname).toMatch(new RegExp(`/game/players/${archiveId}$`));
    await page.goto('about:blank');
    await page.goto(accountUrl);
    await check(page.getByRole('region', { name: 'Solstice' })).toContainText('Ultimo salvataggio');
    await check(page.getByRole('dialog')).toHaveCount(0);
    expect(paths.some((p) => p.startsWith('players/'))).toBe(false);
  } finally {
    await context.close();
  }
});

it('opens linked history using the verified account id and keeps screenshot permissions independent', async () => {
  const context = await browser.newContext({
      locale: 'en-GB',
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage();
  try {
    await serve(page);
    await page.route('**/telemetry/players/23?*', (r) =>
      r.fulfill({
        json: {
          data: { ...sample.player, account: archiveId, accountVerified: true },
          source: 'live',
          observedAt: instant,
          reason: null,
        },
      }),
    );
    await page.route(`**/openworld/players/saved/${archiveId}`, (r) =>
      r.fulfill({ status: 404, json: { error: { code: 'not_found' } } }),
    );
    await page.goto(`${url}telemetry-fixture?section=players&moderator`);
    await page.getByRole('link', { name: /Solstice/ }).click();
    await page.getByRole('button', { name: 'Last save', exact: true }).click();
    await check(page.locator('section.ow-profile')).toContainText('No save found for this UUID.');
    await check(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await page.clock.install();
    await page.goto(`${url}telemetry-fixture?section=players&reader&screenshots`);
    const files = Array.from({ length: 9 }, (_, i) => ({
      name: `capture-${i}.png`,
      mtimeMs: Date.parse(instant),
      bytes: 1200000,
    }));
    await page.route('**/openworld/screenshots', (r) => r.fulfill({ json: { files } }));
    let shotsRequested = 0;
    await page.route('**/openworld/players/actions', (r) => {
      shotsRequested++;
      expect(r.request().postDataJSON().action).toEqual({ kind: 'screenshot' });
      return r.fulfill({
        status: 202,
        json: { outcome: 'accepted', requestId: r.request().postDataJSON().requestId },
      });
    });
    const thumbs: string[] = [];
    await page.route('**/openworld/screenshots/thumbnail?*', (r) => {
      thumbs.push(r.request().url());
      return r.fulfill({ status: 404 });
    });
    const imgs: string[] = [];
    await page.route('**/openworld/screenshots/image?*', (r) => {
      imgs.push(r.request().url());
      return r.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOgeONsAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    });
    await page.getByRole('link', { name: /Solstice/ }).click();
    const profile = page.locator('section.ow-profile');
    await check(profile.getByRole('button', { name: 'Kick player' })).toHaveCount(0);
    const toast = page.locator('.ow-action-toast');
    const requestScreenshot = async () => {
      await profile.getByRole('button', { name: 'Request screenshot' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Request screenshot' }).click();
      await check(toast.getByRole('status')).toContainText('Solstice');
      await page.mouse.move(0, 0);
    };
    await requestScreenshot();
    await page.clock.fastForward(7500);
    await check(toast).toBeInViewport({ ratio: 1 });
    await fits(page);
    await page.screenshot({
      path: `${shots}/player-action-notice-mobile.png`,
      animations: 'disabled',
    });
    await page.clock.fastForward(3200);
    await check(toast).toHaveCount(0);
    await requestScreenshot();
    await toast.getByRole('button', { name: 'Close', exact: true }).click();
    await check(toast).toHaveCount(0);
    await requestScreenshot();
    const galleryShortcut = toast.getByRole('button', { name: 'Open screenshots' });
    await galleryShortcut.focus();
    await page.clock.fastForward(11000);
    await check(galleryShortcut).toBeFocused();
    await galleryShortcut.click();
    await check(toast).toHaveCount(0);
    await check(page.getByRole('button', { name: /capture-7/ })).toBeVisible();
    await check(page.getByRole('button', { name: /capture-8/ })).toHaveCount(0);
    expect(imgs).toHaveLength(0);
    await expect.poll(() => thumbs.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: /capture-8/ }).click();
    await check(page.getByRole('dialog', { name: 'capture-8.png' }).getByRole('img')).toBeVisible();
    await expect.poll(() => imgs.length).toBe(1);
    expect(Object.fromEntries(new URL(imgs[0] ?? '').searchParams)).toEqual({
      name: 'capture-8.png',
      mtimeMs: String(Date.parse(instant)),
      bytes: '1200000',
    });
    expect(shotsRequested).toBe(3);
    await fits(page);
  } finally {
    await context.close();
  }
});

it('keeps the verified profile and active pane when the player leaves, and fetches personal captures on demand', async () => {
  const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 1220, height: 840 } });
  const page = await ctx.newPage();
  try {
    await serve(page);
    await page.clock.install();
    let online = true;
    const savedCalls: string[] = [];
    const captureCalls: string[] = [];
    const excluded: string[][] = [];
    const named = { ...person, accountVerified: true, account: archiveId, skinHash: 'aa12bc34' };
    const sameName = { ...person, id: 30, accountVerified: false, account: archiveId };
    const skinRequests: URL[] = [];
    // Small original character silhouette for the synthetic head/body response.
    const skin = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAQCAYAAAAiYZ4HAAAAgklEQVR4nGNgoAQ4Bjv9R8ckKcarCSRxZWUzGKOzcdoCU7S9JRGugaA/YIpBNF6FOT1V/5dsmfMfRCNjmBhWDSBsEh+JgmHiWJ2CrADZAKzOA7kbpgHddKyeh2nAhnGGlqKl4/8b2+r+g2hkNs6QgilExwQ14OJTQYOt838QxsUHAQDUxMUMNzutTwAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.route('**/telemetry/players/23/skin?*', (r) => {
      skinRequests.push(new URL(r.request().url()));
      return r.fulfill({ contentType: 'image/png', body: skin });
    });
    await page.route('**/telemetry/players/23?*', (r) =>
      r.fulfill({
        json: {
          data: {
            ...sample.player,
            skinHash: 'aa12bc34',
            account: archiveId,
            accountVerified: true,
            heldItem: { name: 'Iron pickaxe', kind: 'pickaxe', count: 1 },
            armor: [
              { slot: 'helmet', name: 'Iron helmet', kind: 'helmet', count: 1 },
              null,
              null,
              null,
            ],
            inventoryKnown: true,
            inventory: {
              selected: 0,
              hotbar: [{ name: 'Iron pickaxe', kind: 'pickaxe', count: 1 }],
              bag: [null, { code: 16777217, name: 'Stone', kind: 'block', count: 48 }],
            },
            vitals: {
              ...sample.player.vitals,
              hunger: 55,
              maxHunger: 100,
              air: 18,
              maxAir: 20,
              saturation: 35,
            },
          },
          source: 'live',
          reason: null,
          observedAt: instant,
        },
      }),
    );
    const saved = {
      uuid: archiveId,
      name: 'Old Solstice',
      savedAt: instant,
      lastSeenMs: Date.parse(instant),
    };
    await page.route('**/telemetry/players', (r) =>
      r.fulfill({
        json: {
          data: { players: online ? [named, sameName] : [sameName] },
          reason: null,
          source: 'live',
          observedAt: instant,
          processRef: 'a'.repeat(64),
          gameVersion: 'a1.2.9',
        },
      }),
    );
    await page.route('**/openworld/players/saved/search', (r) => {
      const { excludeAccounts, q } = r.request().postDataJSON();
      excluded.push(excludeAccounts);
      const accounts = [
        saved,
        {
          uuid: 'ddd7b90f-af19-4473-950b-33a4d309feef',
          name: 'Vega',
          savedAt: instant,
          lastSeenMs: Date.parse(instant) - 86400000,
        },
        { uuid: 'guest:mistral', name: 'Mistral', savedAt: instant, lastSeenMs: null },
      ];
      const players = accounts.filter(
        (p) =>
          !excludeAccounts.includes(p.uuid) &&
          (!q || p.name.toLowerCase().includes(String(q).toLowerCase())),
      );
      return r.fulfill({
        json: {
          indexing: false,
          stale: false,
          indexedAt: instant,
          page: 1,
          total: players.length,
          players,
        },
      });
    });
    await page.route(`**/players/saved/${archiveId}`, (r) => {
      savedCalls.push(r.request().url());
      return r.fulfill({
        json: {
          ...saved,
          world: 'Archive world',
          mode: 'creative',
          vitals: {
            health: 78,
            maxHealth: 100,
            hunger: 48,
            maxHunger: 100,
            air: 17,
            maxAir: 20,
            saturation: 13,
          },
          heldItem: { code: 52428800, name: 'Iron pickaxe', kind: 'pickaxe', count: 1 },
          armor: [{ slot: 'helmet', name: 'Iron helmet', kind: 'helmet', count: 1 }],
          stats: { firstSeenMs: Date.parse(instant), playSeconds: 7200, joins: 25 },
          statsAt: instant,
          inventory: null,
        },
      });
    });
    await page.route('**/openworld/screenshots?*', (r) => {
      captureCalls.push(r.request().url());
      return r.fulfill({ json: { files: [] } });
    });
    await page.goto(`${url}telemetry-fixture?section=players&screenshots&moderator`);
    await check(page.getByRole('link', { name: /Solstice/ })).toHaveCount(2);
    await expect
      .poll(() => excluded.some((ids) => ids.length === 1 && ids[0] === archiveId))
      .toBe(true);
    await check(page.getByRole('link', { name: /Mistral/ })).toBeVisible();
    await page.screenshot({ path: `${shots}/players-unified-directory-en.png` });
    await page.getByRole('searchbox').fill('old');
    await check(page.getByRole('link', { name: /Old Solstice/ })).toBeVisible();
    await page.getByRole('link', { name: /Old Solstice/ }).click();
    const profile = page.getByRole('region', { name: 'Solstice' });
    await check(profile).toContainText('80 / 100');
    await expect
      .poll(() => skinRequests.some((u) => u.searchParams.get('view') === 'body'))
      .toBe(true);
    await expect
      .poll(() =>
        profile
          .locator('.ow-body-skin img')
          .evaluate((el) => (el as HTMLImageElement).naturalHeight),
      )
      .toBe(16);
    await page.screenshot({ path: `${shots}/players-character-en.png` });
    await profile.getByRole('button', { name: 'Inventory', exact: true }).click();
    await check(profile.getByRole('heading', { name: 'Backpack' })).toBeVisible();
    await page.screenshot({ path: `${shots}/players-inventory-desktop-en.png`, fullPage: true });
    await profile.getByRole('button', { name: 'Activity', exact: true }).click();
    await check(profile).toContainText('Blocks placed');
    expect(savedCalls).toHaveLength(0);
    expect(captureCalls).toHaveLength(0);
    online = false;
    await page.clock.fastForward(6000);
    await check(profile.getByRole('button', { name: 'Activity' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await check(profile.getByText(/Statistics saved/)).toHaveCount(0);
    await check(profile.locator('.ow-source-time')).toContainText('Last save');
    await check(profile).toContainText('2 h');
    await check(profile).toContainText('Offline');
    expect(savedCalls).toHaveLength(1);
    await profile.getByRole('button', { name: 'Character', exact: true }).click();
    await check(profile.getByRole('meter', { name: 'Health', exact: true })).toHaveJSProperty(
      'value',
      78,
    );
    await check(profile.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await check(profile.getByRole('button', { name: 'Request screenshot' })).toBeDisabled();
    await check(profile).toContainText('Iron pickaxe');
    await check(profile).toContainText('Iron helmet');
    await profile.getByRole('button', { name: 'Screenshots', exact: true }).click();
    await check(profile).toContainText('No screenshots attributed to this player.');
    expect(captureCalls.map((s) => new URL(s).searchParams.get('account'))).toEqual([archiveId]);
    await fits(page);
  } finally {
    await ctx.close();
  }
});

it('opens only the server gallery for an unverified connection with the same nickname as a saved player', async () => {
  const ctx = await browser.newContext({ locale: 'it-IT', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    const paths = await serve(page);
    const calls: string[] = [];
    await page.route('**/openworld/screenshots*', (r) => {
      calls.push(r.request().url());
      return r.fulfill({ json: { files: [] } });
    });
    await page.route('**/openworld/players/saved/search', (r) =>
      r.fulfill({
        json: {
          page: 1,
          total: 1,
          players: [{ uuid: archiveId, name: 'Solstice', savedAt: instant }],
          stale: false,
          indexing: false,
          indexedAt: instant,
        },
      }),
    );
    await page.goto(`${url}telemetry-fixture?section=players&screenshots`);
    await check(page.getByRole('link', { name: /Solstice/ })).toHaveCount(2);
    await page.getByRole('button', { name: 'Online', exact: true }).click();
    await check(page.getByRole('link', { name: /Solstice/ })).toHaveCount(1);
    await page.getByRole('link', { name: /Solstice/ }).click();
    const profile = page.locator('section.ow-profile');
    await check(profile).toContainText('80 / 100');
    await check(profile.getByRole('button', { name: 'Screenshot', exact: true })).toHaveCount(0);
    expect(calls).toHaveLength(0);
    await page.getByRole('link', { name: /^← (Players|Giocatori)$/ }).click();
    await page.getByRole('button', { name: 'Screenshot del server' }).click();
    await check(page.getByRole('heading', { name: 'Screenshot del server' })).toBeVisible();
    await check(page.getByText('Nessuno screenshot ricevuto.')).toBeVisible();
    expect(calls.map((s) => new URL(s).search)).toEqual(['']);
    await page.getByRole('button', { name: 'Indietro' }).click();
    await check(page.getByRole('button', { name: 'Online', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(paths).toContain('players/23');
  } finally {
    await ctx.close();
  }
});

it('closes personal captures and resumes the character when screenshot access is withdrawn', async () => {
  const page = await browser.newPage();
  try {
    await serve(page);
    await page.route('**/telemetry/players', (r) =>
      r.fulfill({
        json: {
          data: { players: [{ ...person, account: archiveId, accountVerified: true }] },
          reason: null,
          source: 'live',
          observedAt: instant,
          processRef: 'a'.repeat(64),
        },
      }),
    );
    await page.route('**/openworld/screenshots?*', (r) =>
      r.fulfill({ json: { files: [{ name: 'private.png', bytes: 100, mtimeMs: 1 }] } }),
    );
    await page.route('**/openworld/screenshots/thumbnail?*', (r) => r.fulfill({ status: 404 }));
    await page.goto(`${url}telemetry-fixture?section=players&screenshots`);
    await page.getByRole('link', { name: /Solstice/ }).click();
    const d = page.locator('section.ow-profile');
    await d.getByRole('button', { name: 'Screenshots', exact: true }).click();
    await check(d.getByRole('button', { name: /private.png/ })).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('fixture-revoke', { detail: 'game.openworld.players.screenshots' }),
      ),
    );
    await check(d.getByRole('button', { name: /private.png/ })).toHaveCount(0);
    await check(d.getByRole('button', { name: 'Character', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await check(d).toContainText('80 / 100');
  } finally {
    await page.close();
  }
});

it('paginates saved identities without counting online accounts twice and restores page one on search', async () => {
  const ctx = await browser.newContext({ locale: 'it-IT', viewport: { width: 375, height: 780 } });
  const page = await ctx.newPage();
  try {
    await serve(page);
    const named = { ...person, accountVerified: true, account: archiveId };
    await page.route('**/telemetry/players', (r) =>
      r.fulfill({
        json: {
          data: { players: [named] },
          reason: null,
          source: 'live',
          observedAt: instant,
          processRef: 'a'.repeat(64),
        },
      }),
    );
    const pages: number[] = [];
    await page.route('**/openworld/players/saved/search', (r) => {
      const body = r.request().postDataJSON();
      pages.push(body.page);
      const rows = Array.from({ length: 43 }, (_, i) => ({
        uuid: `archived_${i}`,
        name: `Archive ${String(i + 1).padStart(2, '0')}`,
        savedAt: instant,
      }));
      const filtered = rows.filter(
        (f) => !body.q || f.name.toLowerCase().includes(body.q.toLowerCase()),
      );
      return r.fulfill({
        json: {
          players: filtered.slice((body.page - 1) * 40, body.page * 40),
          total: filtered.length,
          page: body.page,
          indexedAt: instant,
          stale: false,
          indexing: false,
        },
      });
    });
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/openworld/players/saved/search') && r.ok()),
      page.goto(`${url}telemetry-fixture?section=players`),
    ]);
    await check(page.getByText('Pagina 1 di 2')).toBeVisible();
    await check(page.getByRole('listitem')).toHaveCount(41);
    await page.getByRole('button', { name: 'Avanti', exact: true }).click();
    await check(page.getByText('Pagina 2 di 2')).toBeVisible();
    await check(page.getByRole('listitem')).toHaveCount(3);
    await page.getByRole('searchbox').fill('Archive 04');
    await check(page.getByRole('listitem')).toHaveCount(1);
    await check(page.getByRole('listitem')).toContainText('Archive 04');
    expect(pages).toEqual([1, 2, 1]);
    await fits(page);
  } finally {
    await ctx.close();
  }
});

it('keeps a roster skin URL stable across clock rounding and replaces it for a new connection', async () => {
  const page = await browser.newPage();
  try {
    await serve(page);

    let updates = 0;
    const requested: string[] = [];
    await page.route('**/telemetry/players', (r) => {
      const tick = updates++;
      const observedAt = new Date(Date.parse(instant) + tick * 5100).toISOString();
      const member = {
        ...person,
        skinHash: 'aa12bc34',
        connectedS: tick < 2 ? person.connectedS + 5 * tick : 1,
      };
      return r.fulfill({
        json: {
          source: 'live',
          reason: null,
          observedAt,
          data: { players: [member] },
          processRef: 'a'.repeat(64),
        },
      });
    });
    await page.route('**/telemetry/players/23/skin?*', (r) => {
      requested.push(r.request().url());
      return r.fulfill({ status: 404 });
    });
    await page.goto(`${url}telemetry-fixture?section=players&reader`);
    await expect.poll(() => requested.length).toBe(1);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => updates).toBe(2);
    expect(requested).toHaveLength(1);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => requested.length).toBe(2);
    expect(requested[1]).not.toBe(requested[0]);
  } finally {
    await page.close();
  }
});

it('follows a verified account when its first connection appears on the open saved page', async () => {
  const page = await browser.newPage();
  try {
    await serve(page);
    await page.clock.install();
    let connected = false;
    const account = { uuid: archiveId, name: person.name, savedAt: instant };
    await page.route('**/telemetry/players', (r) =>
      r.fulfill({
        json: {
          source: 'live',
          reason: null,
          processRef: 'a'.repeat(64),
          observedAt: instant,
          data: {
            players: connected ? [{ ...person, account: archiveId, accountVerified: true }] : [],
          },
        },
      }),
    );
    await page.route('**/players/saved/search', (r) =>
      r.fulfill({
        json: {
          players: [account],
          page: 1,
          total: 1,
          stale: false,
          indexing: false,
          indexedAt: instant,
        },
      }),
    );
    await page.route(`**/players/saved/${archiveId}`, (r) =>
      r.fulfill({
        json: {
          ...account,
          world: 'Archive world',
          statsAt: null,
          inventory: null,
          stats: null,
        },
      }),
    );
    await page.goto(`${url}telemetry-fixture?section=players&moderator`);
    await page.getByRole('link', { name: /Solstice/ }).click();
    const profile = page.getByRole('region', { name: 'Solstice', exact: true });
    await check(profile).toContainText('Archive world');
    await check(profile.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await check(profile.getByRole('button', { name: 'Request screenshot' })).toHaveCount(0);
    await check(profile).toContainText('No vitals recorded yet.');
    await check(profile.getByRole('meter', { name: 'Health', exact: true })).toHaveCount(0);
    connected = true;
    await page.clock.fastForward(6500);
    await check(profile.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await check(profile.getByRole('combobox', { name: 'Session' })).toHaveCount(0);
    await check(profile).toContainText('80 / 100');
    expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('player')).toBe('23');
  } finally {
    await page.close();
  }
});

it('groups confirmed simultaneous connections and never retargets a prepared moderation action', async () => {
  const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await serve(page);
    await page.clock.install();
    const primary = { ...person, accountVerified: true, account: archiveId };
    const secondary = { ...primary, id: 73, name: 'Solstice II', world: 'Europa' };
    let connected = [primary, secondary];
    await page.route('**/telemetry/players', (r) =>
      r.fulfill({
        json: {
          data: { players: connected },
          reason: null,
          source: 'live',
          processRef: 'a'.repeat(64),
          observedAt: instant,
        },
      }),
    );
    await page.route(`**/openworld/players/saved/${archiveId}`, (r) =>
      r.fulfill({
        json: {
          uuid: archiveId,
          name: person.name,
          savedAt: instant,
          stats: null,
          inventory: null,
        },
      }),
    );
    let sent = 0;
    await page.route('**/openworld/players/actions', (r) => {
      sent++;
      return r.fulfill({ status: 409 });
    });
    await page.goto(`${url}telemetry-fixture?section=players&moderator`);
    const row = page.getByRole('link', { name: /Solstice/ });
    await check(row).toHaveCount(1);
    await check(row).toContainText('Solstice II');
    await check(row).toContainText('2 connections');
    await row.click();
    const profile = page.locator('section.ow-profile');
    await check(profile.getByRole('button', { name: 'Kill character' })).toBeDisabled();
    await profile.getByRole('combobox', { name: 'Session', exact: true }).selectOption('23');
    await profile.getByRole('button', { name: 'Kill character' }).click();
    await check(page.getByRole('dialog')).toContainText('Kill the character of Solstice?');
    connected = [secondary];
    await page.clock.fastForward(6000);
    await check(page.getByRole('dialog')).toHaveCount(0);
    await check(profile.getByRole('combobox', { name: 'Session', exact: true })).toHaveCount(0);
    await check(profile).toHaveAccessibleName('Solstice II');
    await check(profile.getByRole('button', { name: 'Send message' })).toBeVisible();
    await fits(page);
    expect(sent).toBe(0);
  } finally {
    await ctx.close();
  }
});

it('disables a prepared action when the same player id appears in another game process', async () => {
  const context = await browser.newContext({ locale: 'en-GB' }),
    page = await context.newPage();
  try {
    await serve(page);
    await page.clock.install();
    await page.goto(`${url}telemetry-fixture?section=players&reader&moderator`);
    await page.getByRole('link', { name: /Solstice/ }).click();
    const profile = page.locator('section.ow-profile');
    await profile.getByRole('button', { name: 'Kill character' }).click();
    await check(page.getByRole('dialog')).toContainText('Kill the character of Solstice?');
    await page.route('**/telemetry/players', (r) =>
      r.fulfill({
        json: {
          data: sample.players,
          source: 'live',
          observedAt: instant,
          reason: null,
          processRef: 'b'.repeat(64),
        },
      }),
    );
    await page.clock.fastForward(6000);
    await check(page.getByRole('dialog')).toHaveCount(0);
    await check(profile.getByRole('button', { name: 'Kill character' })).toBeDisabled();
    await check(profile).toContainText('This player has left the server.');
  } finally {
    await context.close();
  }
});

it('opens the exact connected player from a map marker and links back to their location', async () => {
  const page = await browser.newPage();
  try {
    const paths = await serve(page);
    const fromMap = new URLSearchParams({
      player: '23',
      name: person.name,
      processRef: 'a'.repeat(64),
      joinedAt: String(Date.parse(instant) - person.connectedS * 1000),
    });
    const target = `${url}telemetry-fixture?section=players&mapAccess#`;
    await page.goto(target + fromMap);
    const dialog = page.getByRole('region', { name: 'Solstice' });
    await check(dialog).toBeVisible();
    const link = dialog.getByRole('link', { name: 'Show on map' });
    await check(link).toBeVisible();
    expect(new URL(page.url()).pathname).toMatch(/\/game\/players\/connection\/23$/);
    const href = new URL((await link.getAttribute('href')) ?? '', url);
    expect(href.pathname).toBe('/servers/10000000-0000-4000-8000-000000000001/game/map');
    expect(Object.fromEntries(new URLSearchParams(href.hash.slice(1)))).toMatchObject({
      world: 'Earth',
      face: '2',
      x: '128',
      z: '256',
      y: '3',
    });
    fromMap.set('processRef', 'b'.repeat(64));
    await page.goto('about:blank');
    const start = paths.length;
    await page.goto(target + fromMap);
    await check(page.locator('section.ow-profile')).toBeVisible();
    await check(page.getByRole('link', { name: 'Show on map' })).toHaveCount(0);
    await check(page.getByText('Solstice', { exact: true }).first()).toBeVisible();
    expect(paths.slice(start)).not.toContain('players/23');

    await mapRoutes(page);
    const processRef = 'f'.repeat(64);
    await page.route('**/openworld/map/players?*', (r) =>
      r.fulfill({
        json: {
          processRef,
          players: [
            {
              id: 23,
              name: person.name,
              world: 'earth',
              face: 0,
              x: 129,
              z: 128,
              joinedAt: Number(fromMap.get('joinedAt')),
            },
          ],
        },
      }),
    );
    await page.route('**/openworld/telemetry/players', (r) =>
      r.fulfill({
        json: { source: 'live', observedAt: instant, processRef, data: { players: [person] } },
      }),
    );
    await page.goto(`${url}telemetry-fixture?section=map#world=earth&face=0&x=128&z=128`);
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByLabel('Show players').check();
    const marker = page.getByRole('link', { name: 'Open player Solstice' });
    await check(marker).toHaveAttribute('href', /\/players\/connection\/23#/);
    await marker.click();
    await check(page.getByRole('region', { name: 'Solstice' })).toContainText('80 / 100');
  } finally {
    await page.close();
  }
});

function fixtureCheckpoint(id: number, name: string, visibility: 'admins' | 'players' = 'players') {
  return {
    id,
    world: 'earth',
    name,
    note: 'Western approach',
    color: '#438a6a',
    icon: 'flag',
    visibility,
    pos: { face: 0, x: id === 1 ? 150 : 124, y: 41, z: id === 1 ? 70 : 128 },
    geo: { lat: 12.12, lon: 42.42, alt: 41 },
    revision: 'a'.repeat(64),
    createdAtMs: 0,
  };
}
async function mapRoutes(
  page: Page,
  options: {
    wide?: boolean;
    bridge?: boolean;
    radius?: 3 | 8 | 16;
    firstMeshGate?: Promise<void>;
    edge?: number;
    emptyWorlds?: boolean;
    failWrites?: boolean;
    deltaGate?: Promise<void>;
    revoked?: () => boolean;
  } = {},
) {
  await serve(page);
  const paths: URL[] = [],
    writes: Record<string, unknown>[] = [];
  let checkpoints = [
    fixtureCheckpoint(1, 'Lakeside'),
    fixtureCheckpoint(2, 'Supply cache', 'admins'),
  ];
  const processRef = 'f'.repeat(64);
  const known = options.bridge
    ? valleyColumns(options.radius ?? 8)
    : valleyColumns().filter(([x, z]) => x < 16 && z < 16);
  if (options.wide) known.push([200, 100]);
  if (options.bridge)
    checkpoints[0] = {
      ...fixtureCheckpoint(1, 'Footbridge'),
      pos: { face: 0, x: 256, z: 258, y: 35 },
    };
  await page.route('**/v1/servers/**/openworld/map**', async (route) => {
    const u = new URL(route.request().url());
    paths.push(u);
    const path = u.pathname.split('/map')[1];
    if (options.revoked?.())
      return route.fulfill({
        status: 403,
        json: { code: 'forbidden', messageKey: 'errors.forbidden' },
      });
    if (!path)
      return route.fulfill({
        json: {
          worlds: options.emptyWorlds
            ? []
            : [
                { key: 'earth', name: 'Earth', faceEdgeMeters: options.edge ?? faceEdge },
                { key: 'moon', name: 'Moon', faceEdgeMeters: null },
              ],
          processRef,
        },
      });
    if (u.searchParams.get('processRef') !== processRef && route.request().method() !== 'POST')
      return route.fulfill({ status: 409, json: { code: 'conflict' } });
    if (path === '/index')
      return route.fulfill({
        json: {
          stamp: 7,
          faces: Array.from({ length: 6 }, (_, face) =>
            face === 0
              ? {
                  face,
                  count: known.length,
                  i0: options.bridge ? 16 - (options.radius ?? 8) : 0,
                  j0: options.bridge ? 16 - (options.radius ?? 8) : 0,
                  i1: options.wide ? 200 : options.bridge ? 15 + (options.radius ?? 8) : 15,
                  j1: options.wide ? 100 : options.bridge ? 15 + (options.radius ?? 8) : 15,
                }
              : { face, count: 0, i0: null, j0: null, i1: null, j1: null },
          ),
        },
      });
    if (path === '/changes') {
      if (options.deltaGate) await options.deltaGate;
      return route.fulfill({
        json: options.deltaGate
          ? { stamp: 8, reset: false, columns: [[0, 0, 0]] }
          : { stamp: 7, reset: false, columns: [] },
      });
    }
    const number = (key: string, fallback = 0) => Number(u.searchParams.get(key) ?? fallback);
    if (path === '/columns') {
      const stride = number('stride', 1);
      const unique = new Map<string, number[]>();
      for (const [i, j] of known) {
        if (
          i < number('i0') ||
          j < number('j0') ||
          i > number('i1', Infinity) ||
          j > number('j1', Infinity)
        )
          continue;
        const cell = [Math.floor(i / stride) * stride, Math.floor(j / stride) * stride];
        unique.set(cell.join('/'), cell);
      }
      return route.fulfill({ json: { columns: Array.from(unique.values()) } });
    }
    if (path === '/palette')
      return route.fulfill({
        json: { materials: materialPalette, voxelSize: 0.25, faceEdgeMeters: faceEdge },
      });
    if (path === '/texture')
      return route.fulfill({ contentType: 'image/png', body: texture(number('id')) });
    if (path === '/meshes') {
      if (options.firstMeshGate) await options.firstMeshGate;
      const cells = (u.searchParams.get('cells') ?? '')
        .split(';')
        .map((pair) => pair.split(',').map(Number) as [number, number]);
      if (cells.length > 16 || !cells.length) throw Error('Mesh batch size out of bounds');
      return route.fulfill({
        contentType: 'application/octet-stream',
        body: await meshBundle(cells, number('lod'), 16, number('face')),
      });
    }
    if (path === '/surface') {
      const ci = number('ci'),
        cj = number('cj'),
        face = number('face');
      return route.fulfill({ json: decodeMapTile(surface(ci, cj, 8, 4, 16, face), face, ci, cj) });
    }
    if (path === '/terrain' || path === '/mesh') {
      if (number('face') !== 0 || u.searchParams.get('world') !== 'earth')
        return route.fulfill({ status: 204 });
      const body =
        path === '/mesh'
          ? mesh(number('i'), number('j'), number('lod', 1))
          : surface(number('ci'), number('cj'), number('n', 8), number('lod'));
      return route.fulfill({ contentType: 'application/octet-stream', body });
    }
    if (path === '/seed-legend')
      return route.fulfill({
        json: {
          featureKinds: [
            {
              key: 'copper',
              name: 'Copper vein',
              color: '#bc8956',
              category: 'deposit',
              cellMeters: 128,
            },
          ],
          biomes: [{ id: 1, name: 'Temperate hills', color: '#649661' }],
          faceEdgeMeters: faceEdge,
          maxZoom: 8,
        },
      });
    if (path === '/seed-features')
      return route.fulfill({
        json: { features: [{ kind: 'copper', x: 250, y: 26, z: 260 }], truncated: false },
      });
    if (path === '/seed-tile') {
      const side = 256,
        n = side * side,
        mpp = faceEdge / (2 ** number('z') * side);
      const body = Buffer.alloc(32 + 8 * n);
      body.write('NHST');
      body.writeUInt16LE(side, 4);
      body.writeDoubleLE(number('x') * side * mpp, 8);
      body.writeDoubleLE(number('y') * side * mpp, 16);
      body.writeFloatLE(mpp, 24);
      for (let i = 0; i < n; i++) {
        body.writeInt16LE(200, i * 2 + 32);
        body.writeInt16LE(-32768, 32 + 2 * n + i * 2);
        body.writeUInt16LE(1, 32 + 4 * n + i * 2);
        body[32 + 6 * n + i] = 1;
      }
      return route.fulfill({ contentType: 'application/octet-stream', body });
    }
    if (path === '/creatures') {
      const world = u.searchParams.get('world'),
        earth = world === 'earth';
      const markers = u.searchParams.get('markers') === '1' && earth;
      return route.fulfill({
        json: {
          world,
          total: earth ? 7 : 0,
          items: earth ? 31 : 0,
          species: earth
            ? [{ id: 3, key: 'marsh_toad', name: 'Marsh toad', count: 7, hostile: false }]
            : [],
          markers: markers ? [{ species: 3, face: 0, x: 131, z: 128 }] : [],
          markersTruncated: markers,
        },
      });
    }
    if (path === '/space')
      return route.fulfill({
        json: {
          t: 123456,
          bodies: [
            {
              index: 0,
              name: 'Sol',
              world: null,
              parent: null,
              radiusMeters: 2000,
              position: [0, 0, 0],
              atmosphere: false,
              isLight: true,
            },
            {
              index: 1,
              name: 'Earth',
              world: 'earth',
              parent: 0,
              radiusMeters: 900,
              position: [400000, 100, 40000],
              atmosphere: true,
              isLight: false,
            },
            {
              index: 2,
              name: 'Moon',
              world: 'moon',
              parent: 1,
              radiusMeters: 200,
              position: [404000, 30, 110000],
              atmosphere: false,
              isLight: false,
            },
          ],
          players: [{ id: 4, name: 'Night sail', world: null, position: [100000, 11, 72000] }],
          checkpoints: ['players', 'admins'].map((visibility, i) => ({
            id: i + 1,
            name: i ? 'Private beacon' : 'Public beacon',
            world: 'earth',
            visibility,
            color: '#998855',
            position: [400700, 0, 40000],
          })),
        },
      });
    if (path === '/players') return route.fulfill({ json: { processRef, players: [] } });
    if (path === '/checkpoints' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (options.failWrites) return route.abort('failed');
      const { action } = body;
      if (action.kind === 'create')
        checkpoints.push({
          ...fixtureCheckpoint(3, action.fields.name),
          ...action.fields,
          ...(action.position.type === 'face' ? { pos: action.position } : {}),
        });
      if (action.kind === 'update')
        checkpoints = checkpoints.map((c) => (c.id === action.id ? { ...c, ...action.fields } : c));
      if (action.kind === 'delete') checkpoints = checkpoints.filter((c) => c.id !== action.id);
      return route.fulfill({
        status: 202,
        json: { requestId: body.requestId, outcome: 'accepted' },
      });
    }
    if (path === '/checkpoints')
      return route.fulfill({
        json: { checkpoints: u.searchParams.get('world') === 'earth' ? checkpoints : [] },
      });
    return route.abort();
  });
  return { paths, writes };
}
it('opens and edits a checkpoint at the linked player position, then requires confirmation to delete it', async () => {
  const context = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    const { writes, paths } = await mapRoutes(page);
    await page.goto(
      `${url}telemetry-fixture?section=map&cartographer#world=earth&face=0&x=86&y=22&z=111`,
    );
    await check(page.getByRole('heading', { name: 'Map', exact: true })).toBeVisible();
    await check(page.locator('.ow-map-pin')).toHaveCount(2);
    await check
      .poll(() => paths.filter((p) => p.pathname.endsWith('/terrain')).length)
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Add checkpoint at this position' }).click();
    const dialog = page.getByRole('dialog');
    await check(dialog.getByLabel('X (m)', { exact: true })).toHaveValue('86');
    await check(dialog.getByLabel('Z (m)', { exact: true })).toHaveValue('111');
    await check(dialog.getByLabel('Altitude (m, optional)')).toHaveValue('22');
    await dialog.getByLabel('Name', { exact: true }).fill('Trailhead');
    await dialog.getByLabel('Note', { exact: true }).fill('By the footbridge');
    await dialog.getByRole('button', { name: 'Create checkpoint' }).click();
    await page.getByRole('searchbox').focus();
    await check(page.getByRole('list').getByRole('button', { name: /Trailhead/ })).toBeVisible();
    expect(writes[0]).toMatchObject({
      world: 'earth',
      processRef: 'f'.repeat(64),
      action: {
        kind: 'create',
        position: { type: 'face', face: 0, x: 86, z: 111, y: 22 },
        fields: { visibility: 'admins', name: 'Trailhead', note: 'By the footbridge' },
      },
    });
    await page
      .getByRole('list')
      .getByRole('button', { name: /Trailhead/ })
      .click();
    await page.getByRole('button', { name: 'Edit checkpoint', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Footbridge');
    await dialog.getByLabel('Visible to').selectOption('players');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await check(page.getByRole('heading', { name: 'Footbridge' })).toBeVisible();
    expect(writes[1]).toMatchObject({
      action: {
        kind: 'update',
        id: 3,
        revision: 'a'.repeat(64),
        fields: { visibility: 'players' },
      },
    });
    expect(writes[1]?.action).not.toHaveProperty('position');
    await page.screenshot({ path: `${shots}/world-map-en.png` });
    await page.getByRole('button', { name: 'Delete checkpoint', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(writes).toHaveLength(2);
    await page.getByRole('button', { name: 'Delete checkpoint', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete checkpoint', exact: true }).click();
    await check(page.getByRole('list').getByRole('button', { name: /Footbridge/ })).toHaveCount(0);
    expect(writes[2]).toMatchObject({
      action: { kind: 'delete', id: 3, revision: 'a'.repeat(64) },
    });
    await fits(page);
  } finally {
    await context.close();
  }
});
it('shows the explored overview on mobile and limits player and private checkpoint access', async () => {
  const context = await browser.newContext({
      locale: 'it-IT',
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage();
  try {
    const { paths } = await mapRoutes(page, { wide: true });
    await page.goto(`${url}telemetry-fixture?section=map&reader`);
    await check(page.getByRole('heading', { name: 'Mappa', exact: true })).toBeVisible();
    await check
      .poll(() => paths.filter((p) => p.pathname.endsWith('/columns')).length)
      .toBeGreaterThan(0);
    expect(
      paths.some((p) => /\/(players|meshes|mesh|seed-tile|seed-legend)$/.test(p.pathname)),
    ).toBe(false);
    const footprint = paths.find((p) => p.pathname.endsWith('/columns'));
    expect(footprint?.searchParams.get('sample')).toBe('1');
    await check(page.getByRole('button', { name: 'Aggiungi checkpoint', exact: true })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: 'Livelli', exact: true }).click();
    await check(page.getByLabel('Mostra giocatori')).toHaveCount(0);
    await check(page.getByLabel('Anteprima seed')).toHaveCount(0);
    await check(page.getByRole('button', { name: /Supply cache/ })).toHaveCount(0);
    const search = page.getByRole('searchbox');
    await search.fill('wrong');
    await check(page.getByText('Nessun checkpoint corrispondente.')).toBeVisible();
    await search.fill('lake');
    await page
      .getByRole('list')
      .getByRole('button', { name: /Lakeside/ })
      .click();
    await check(page.getByRole('heading', { name: 'Lakeside' })).toBeVisible();
    await check(page.getByText('Western approach')).toHaveCount(0);
    await check
      .poll(() => paths.filter((p) => p.pathname.endsWith('/terrain')).length)
      .toBeGreaterThan(0);
    await fits(page);
    await page.screenshot({ path: `${shots}/world-map-it-mobile.png` });
    await page.getByLabel('Mondo', { exact: true }).selectOption('moon');
    await page.getByRole('searchbox').focus();
    await check(page.getByText('Questo mondo non ha checkpoint.')).toBeVisible();
    await check(page.getByRole('heading', { name: 'Lakeside' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
it('refreshes only changed visible tiles, suppresses reads offline and clears revoked data', async () => {
  const context = await browser.newContext({ viewport: { width: 1150, height: 800 } }),
    page = await context.newPage();
  let resume!: () => void,
    revoked = false;
  const deltaGate = new Promise<void>((r) => {
    resume = r;
  });
  try {
    const { paths } = await mapRoutes(page, { deltaGate, revoked: () => revoked });
    await page.goto(`${url}telemetry-fixture?section=map&offline`);
    await check(page.getByText(/offline/i)).toBeVisible();
    expect(paths).toEqual([]);
    await page.goto(`${url}telemetry-fixture?section=map`);
    await check(page.locator('canvas')).toBeVisible();
    const tiles = () => paths.filter((p) => p.pathname.endsWith('/terrain'));
    await check
      .poll(() =>
        tiles().some(
          (p) => Number(p.searchParams.get('ci')) === 0 && Number(p.searchParams.get('cj')) === 0,
        ),
      )
      .toBe(true);
    resume();
    await check
      .poll(() =>
        tiles()
          .filter((p) => p.searchParams.get('stamp') === '8')
          .map((p) => `${p.searchParams.get('ci')},${p.searchParams.get('cj')}`)
          .filter((v, i, a) => a.indexOf(v) === i),
      )
      .toEqual(['0,0']);
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByLabel('Face', { exact: true }).selectOption('4');
    await check(page.getByText('No explored terrain on this face.')).toBeVisible();
    const before = tiles().length;
    revoked = true;
    await page.getByLabel('World', { exact: true }).selectOption('moon');
    await check(page.getByRole('alert')).toBeVisible();
    await check(page.getByRole('list')).toHaveCount(0);
    expect(tiles().length).toBe(before);
  } finally {
    resume();
    await context.close();
  }
});
it('locks a checkpoint submission with an unknown outcome and preserves the original request', async () => {
  const context = await browser.newContext(),
    page = await context.newPage();
  try {
    const { writes } = await mapRoutes(page, { failWrites: true });
    await page.goto(`${url}telemetry-fixture?section=map&cartographer`);
    await page.getByRole('searchbox').focus();
    await page
      .getByRole('list')
      .getByRole('button', { name: /Lakeside/ })
      .click();
    await page.getByRole('button', { name: 'Delete checkpoint', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Delete checkpoint', exact: true }).click();
    await check(dialog.getByRole('alert')).toBeVisible();
    await check(
      dialog.getByRole('button', { name: 'Delete checkpoint', exact: true }),
    ).toBeDisabled();
    expect(writes).toHaveLength(1);
  } finally {
    await context.close();
  }
});

it('switches coordinate systems without reusing numbers, then closes a private checkpoint that disappears', async () => {
  const context = await browser.newContext(),
    page = await context.newPage();
  try {
    await mapRoutes(page);
    await page.goto(`${url}telemetry-fixture?section=map&cartographer`);
    await page.getByRole('searchbox').focus();
    await page
      .getByRole('list')
      .getByRole('button', { name: /Supply cache/ })
      .click();
    await page.getByRole('button', { name: 'Edit checkpoint', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Change position').check();
    await dialog.getByLabel('Longitude').fill('77.025');
    await dialog.getByLabel('Position', { exact: true }).selectOption('face');
    await check(dialog.getByLabel('X (m)', { exact: true })).toHaveValue('124');
    await check(dialog.getByLabel('Z (m)', { exact: true })).toHaveValue('128');
    await page.route('**/map/checkpoints?**', (r) =>
      r.fulfill({ json: { checkpoints: [fixtureCheckpoint(1, 'Lakeside')] } }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await check(dialog).toHaveCount(0);
    await check(page.getByText('Supply cache', { exact: true })).toHaveCount(0);
    await check(page.locator('.ow-map-location')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
it('keeps the map available after a failed index refresh and picks up new explored columns on retry', async () => {
  const context = await browser.newContext(),
    page = await context.newPage();
  let resume!: () => void;
  const deltaGate = new Promise<void>((r) => {
    resume = r;
  });
  try {
    const { paths } = await mapRoutes(page, { deltaGate });
    let reads = 0;
    await page.route('**/map/index?**', async (r) => {
      reads++;
      if (reads === 1)
        return r.fulfill({
          json: {
            stamp: 7,
            faces: [{ face: 0, count: 0, i0: null, i1: null, j0: null, j1: null }],
          },
        });
      if (reads === 2) return r.fulfill({ status: 503, json: { code: 'integration_unavailable' } });
      return r.fallback();
    });
    await page.goto(`${url}telemetry-fixture?section=map`);
    await check(page.getByText('No explored terrain on this face.')).toBeVisible();
    resume();
    await check(page.getByRole('alert')).toBeVisible();
    await check(page.locator('canvas')).toBeVisible();
    await page.getByRole('alert').getByRole('button').click();
    await check(page.getByRole('alert')).toHaveCount(0);
    await check(page.getByText('No explored terrain on this face.')).toHaveCount(0);
    await check.poll(() => paths.some((p) => p.pathname.endsWith('/terrain'))).toBe(true);
  } finally {
    resume();
    await context.close();
  }
});

it('frames a populated cluster, then reaches distant indexed columns without unbounded tile requests', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    const { paths } = await mapRoutes(page, { edge: 2_000_000 });
    const cluster = Array.from({ length: 256 }, (_, k) => [k % 16, Math.floor(k / 16)]);
    const far = [67321, 78123] as const,
      indexed = [...cluster, far];
    const queries: URL[] = [];
    await page.route('**/map/index?**', (r) =>
      r.fulfill({
        json: {
          stamp: 7,
          faces: [{ face: 0, count: indexed.length, i0: 0, j0: 0, i1: far[0], j1: far[1] }],
        },
      }),
    );
    await page.route('**/map/columns?**', (r) => {
      queries.push(new URL(r.request().url()));
      return r.fulfill({ json: { columns: indexed } });
    });
    await page.goto(`${url}telemetry-fixture?section=map&reader`);
    const all = page.getByRole('button', { name: 'Show full index' });
    const scale = page.locator('.ow-map-scale');
    await check(all).toBeVisible();
    await check.poll(() => paths.some((u) => u.pathname.endsWith('/terrain'))).toBe(true);
    expect(queries[0]?.searchParams.get('sample')).toBe('1');
    await all.click();
    await check(scale).toContainText('km');
    await page.getByRole('searchbox').fill(`${far[0] * 16 + 8}, ${far[1] * 16 + 8}`);
    await page.getByRole('button', { name: /Go to / }).click();
    await check
      .poll(() =>
        paths.some((u) => {
          if (!u.pathname.endsWith('/terrain')) return false;
          const ci = Number(u.searchParams.get('ci')),
            cj = Number(u.searchParams.get('cj')),
            n = Number(u.searchParams.get('n'));
          return ci <= far[0] && far[0] < ci + n && cj <= far[1] && far[1] < cj + n;
        }),
      )
      .toBe(true);
    expect(queries.length).toBeLessThan(4);
    await page.getByRole('button', { name: 'Recenter' }).click();
    await check(scale).not.toContainText('km');
    await fits(page);
  } finally {
    await context.close();
  }
});

it('keeps streaming visible terrain after a tile timeout on opening and reloading the map', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await mapRoutes(page, { bridge: true, radius: 16 });
    let failedTile = '';
    let recovered = false;
    const neighbors = new Set<string>();
    await page.route('**/map/terrain?**', async (route) => {
      const query = new URL(route.request().url()).searchParams;
      const key = ['ci', 'cj', 'lod', 'n'].map((field) => query.get(field)).join('/');
      if (!failedTile && query.get('lod') === '6') {
        failedTile = key;
        return route.fulfill({
          status: 504,
          json: {
            error: {
              code: 'game_request_timeout',
              messageKey: 'errors.game_request_timeout',
            },
          },
        });
      }
      if (key === failedTile) recovered = true;
      else if (Number(query.get('lod')) < 6) neighbors.add(key);
      return route.fallback();
    });
    for (const reload of [false, true]) {
      failedTile = '';
      recovered = false;
      neighbors.clear();
      if (reload) await page.reload();
      else
        await page.goto(
          `${url}telemetry-fixture?section=map&reader#world=earth&face=0&x=256&z=256`,
        );
      await check.poll(() => neighbors.size, { timeout: 10000 }).toBeGreaterThan(6);
      await check.poll(() => recovered, { timeout: 15000 }).toBe(true);
      await check(page.locator('.ow-map-stage canvas')).toBeVisible();
    }
  } finally {
    await page.close();
  }
});

it('uses a bounded sample to frame a larger map and fetches the actual overview inside that region', async () => {
  const page = await browser.newPage();
  try {
    await mapRoutes(page, { edge: 5_000_000 });
    const far = [180_100, 185_100] as const;
    const cluster = Array.from({ length: 200 }, (_, k) => [
      5000 + (k % 10),
      8000 + Math.floor(k / 10) * 8,
    ]);
    const queries: URLSearchParams[] = [];
    await page.route('**/map/index?**', (r) =>
      r.fulfill({
        json: {
          stamp: 7,
          faces: [{ face: 0, count: 45000, i0: 5000, j0: 8000, i1: far[0], j1: far[1] }],
        },
      }),
    );
    await page.route('**/map/columns?**', (r) => {
      const q = new URL(r.request().url()).searchParams;
      queries.push(q);
      return r.fulfill({ json: { columns: q.has('sample') ? [...cluster, far] : cluster } });
    });
    await page.goto(`${url}telemetry-fixture?section=map&reader`);
    await check(page.getByRole('button', { name: 'Show full index' })).toBeVisible();
    await check
      .poll(() =>
        queries.some(
          (q) => !q.has('sample') && Number(q.get('i1')) > 5000 && Number(q.get('i1')) < 7000,
        ),
      )
      .toBe(true);
    expect(queries.filter((q) => q.has('sample'))).toHaveLength(1);
    await page.getByRole('button', { name: 'Show full index' }).click();
    await check
      .poll(() =>
        queries.some(
          (q) =>
            Number(q.get('i1')) === far[0] &&
            Number(q.get('j1')) === far[1] &&
            Number(q.get('stride')) > 1024,
        ),
      )
      .toBe(true);
    await fits(page);
  } finally {
    await page.close();
  }
});

function completedMapTextures(page: Page) {
  const materials = new Set<number>();
  page.on('requestfinished', async (request) => {
    const u = new URL(request.url());
    if (
      u.pathname.endsWith('/map/texture') &&
      u.searchParams.has('id') &&
      (await request.response())?.ok()
    )
      materials.add(Number(u.searchParams.get('id')));
  });
  return materials;
}

it('shows the map FPS counter only in debug and measures movement and idle frames', async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  try {
    await mapRoutes(page, { bridge: true, radius: 3 });
    await page.goto(
      `${url}telemetry-fixture?section=map&cartographer#world=earth&face=0&x=235&z=244`,
    );
    const canvas = page.locator('.ow-map-stage canvas');
    const counter = page.locator('.ow-atlas-fps');
    const debug = page.getByRole('menuitemcheckbox', { name: 'Stats for nerds', exact: true });
    await check(canvas).toBeVisible();
    await check(counter).toHaveCount(0);
    await check(debug).toHaveCount(0);
    await canvas.click({ button: 'right', position: { x: 100, y: 70 } });
    await check(debug).toHaveAttribute('aria-checked', 'false');
    await debug.click();
    await check(debug).toHaveCount(0);
    await check(counter).toBeVisible();
    await check(counter).toHaveText(/\b0\b/);

    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await check
      .poll(() => counter.evaluate((el) => document.fullscreenElement?.contains(el)))
      .toBe(true);
    await canvas.focus();
    await page.keyboard.down('ArrowRight');
    try {
      await check(counter).toHaveText(/\b[1-9]\d*\b/);
    } finally {
      await page.keyboard.up('ArrowRight');
    }
    await check(counter).toHaveText(/\b0\b/);
    await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
    await canvas.press('Shift+F10');
    await check(debug).toHaveAttribute('aria-checked', 'true');
    await debug.press('Enter');
    await check(counter).toHaveCount(0);
    await page.getByRole('button', { name: 'Isometric', exact: true }).click();
    await canvas.scrollIntoViewIfNeeded();
    const pin = page
      .locator('.ow-map-stage')
      .getByRole('button', { name: 'Footbridge', exact: true });
    const position = () => pin.evaluate((el) => el.getBoundingClientRect().x);
    await check(pin).toBeVisible();
    const before = await position();
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error('Missing map canvas');
    await page.mouse.move(bounds.x + 100, bounds.y + 70);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(bounds.x + 166, bounds.y + 70, { steps: 6 });
    await page.mouse.up({ button: 'right' });
    await check.poll(async () => Math.abs((await position()) - before)).toBeGreaterThan(1);
    await check(debug).toHaveCount(0);
  } finally {
    await page.close();
  }
});

it('keeps the same bridge across the three projections', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.addInitScript(() => performance.setResourceTimingBufferSize(4000));
    const textures = completedMapTextures(page);
    const { paths } = await mapRoutes(page, { bridge: true });
    await page.goto(
      `${url}telemetry-fixture?section=map&seedAccess&cartographer#world=earth&face=0&x=256&z=258&y=35`,
    );
    const pinned = page.locator('.ow-map-location');
    const reads = (kind: string) => paths.filter((p) => p.pathname.endsWith(`/${kind}`));
    await check(pinned).toBeVisible();
    await check.poll(() => reads('terrain').length).toBeGreaterThan(0);
    expect([...reads('mesh'), ...reads('meshes')]).toHaveLength(0);
    await page.getByRole('button', { name: 'Isometric', exact: true }).click();
    await check.poll(() => reads('meshes').length).toBeGreaterThan(0);
    await check.poll(() => textures.size, { timeout: 60_000 }).toBeGreaterThanOrEqual(7);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await check(pinned).toBeVisible();
    const waitForDetail = () =>
      page.waitForFunction(() => {
        const entries = performance
          .getEntriesByType('resource')
          .filter((e) => /\/map\/(meshes|texture)\?/.test(e.name));
        return (
          entries.length > 0 &&
          performance.now() - Math.max(...entries.map((e) => e.startTime + e.duration)) > 800
        );
      });
    await waitForDetail();
    await page.screenshot({ path: `${shots}/world-map-isometric.png` });
    await page.getByRole('button', { name: 'Free flight', exact: true }).click();
    await check(pinned).toBeVisible();
    await waitForDetail();
    await page.screenshot({ path: `${shots}/world-map-flight.png` });
    await page.getByRole('button', { name: '2D', exact: true }).click();
    await check(pinned).toHaveAttribute('data-x', '256');
    await check(pinned).toHaveAttribute('data-z', '258');
    await check.poll(() => reads('seed-legend').length + reads('seed-tile').length).toBe(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('heading', { name: 'Map', exact: true }).scrollIntoViewIfNeeded();
    await check(pinned).toBeVisible();
    await fits(page);
    await page.screenshot({ path: `${shots}/world-map-bridge-mobile.png` });
  } finally {
    await page.close();
  }
}, 90_000);
it('keeps an isometric drag attached to its original plane while terrain streams', async () => {
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1050 },
    deviceScaleFactor: 1,
  });
  const gate = Promise.withResolvers<void>();
  try {
    await page.addInitScript(() => performance.setResourceTimingBufferSize(4000));
    const { paths } = await mapRoutes(page, {
      bridge: true,
      radius: 16,
      firstMeshGate: gate.promise,
    });
    await page.goto(
      `${url}telemetry-fixture?section=map&cartographer#world=earth&face=0&x=256&z=258&y=35`,
    );
    // Account for the panel's surrounding server workspace on a desktop viewport.
    await page.addStyleTag({ content: 'main { max-width: calc(100vw - 256px) !important; }' });
    await check(page.locator('.ow-map-location')).toBeVisible();
    await page.getByRole('button', { name: 'Isometric', exact: true }).click();
    await check.poll(() => paths.some((p) => p.pathname.endsWith('/meshes'))).toBe(true);
    const coldReads = await page.evaluate(
      () =>
        performance.getEntriesByType('resource').filter((e) => e.name.includes('/map/meshes?'))
          .length,
    );
    const cold = await sampleIsometricDrag(page, 244, () => setTimeout(() => gate.resolve(), 200));
    await page.waitForFunction(() => {
      const reads = performance
        .getEntriesByType('resource')
        .filter((e) => e.name.includes('/map/meshes?'));
      return (
        reads.length > 0 &&
        performance.now() - Math.max(...reads.map((e) => e.startTime + e.duration)) > 750
      );
    });
    const warm = await sampleIsometricDrag(page, -244);
    const reads = await page.evaluate(
      () =>
        performance.getEntriesByType('resource').filter((e) => e.name.includes('/map/meshes?'))
          .length,
    );
    const report = process.env.NICKHOSTING_ATLAS_INPUT_REPORT;
    if (report) {
      await writeFile(report, JSON.stringify({ cold, warm, coldReads, reads }, null, 2));
    }
    const glError = await page
      .locator('.ow-map-stage canvas')
      .evaluate((el) => (el as HTMLCanvasElement).getContext('webgl2')?.getError());
    expect(glError).toBe(0);
    expect(cold.meshResponses).toBeGreaterThan(0);
    expect(coldReads).toBe(0);
    expect(reads).toBeGreaterThan(0);
    for (const pass of [cold, warm]) {
      expect(Math.abs(pass.dx - pass.expectedDx)).toBeLessThan(5);
      expect(pass.orthogonalDriftPx).toBeLessThan(1.5);
      expect(pass.backwardsPx).toBeLessThan(1.5);
    }
  } finally {
    gate.resolve();
    await page.close();
  }
}, 90_000);

it.each([true, false])(
  'captures and releases free flight with keyboard capture available=%s',
  async (keyboardCapture) => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    try {
      await page.addInitScript(() => performance.setResourceTimingBufferSize(4000));
      // Observe the camera sent to WebGL without stalling a software renderer on readback.
      await page.addInitScript(() => {
        const pose = { yawAxis: NaN, altitude: NaN };
        Object.assign(window, { flightPose: pose });
        const api = WebGL2RenderingContext.prototype;
        const originalLocation = api.getUniformLocation,
          matrix = api.uniformMatrix3fv,
          vector = api.uniform3f;
        const names = new WeakMap<WebGLUniformLocation, string>();
        api.getUniformLocation = function (program, name) {
          const at = originalLocation.call(this, program, name);
          if (at) names.set(at, name);
          return at;
        };
        api.uniformMatrix3fv = function (...args) {
          const [at, , data] = args;
          if (at && names.get(at) === 'uAxes' && '0' in data) pose.yawAxis = Number(data[0]);
          matrix.apply(this, args);
        };
        api.uniform3f = function (at, x, y, z) {
          if (at && names.get(at) === 'uOrigin' && y !== 0) pose.altitude = -y;
          vector.call(this, at, x, y, z);
        };
      });
      if (!keyboardCapture) {
        await page.addInitScript(() =>
          Object.defineProperty(navigator, 'keyboard', { value: undefined }),
        );
      }
      // The command test only needs the bridge and its surrounding columns.
      const textures = completedMapTextures(page);
      await mapRoutes(page, { bridge: true, radius: 3 });
      await page.goto(
        `${url}telemetry-fixture?section=map&cartographer#world=earth&face=0&x=256&z=258&y=35`,
      );
      const stage = page.locator('.ow-map-stage canvas');
      const marker = page.locator('.ow-map-location');
      const locked = () =>
        page.evaluate(
          () => document.pointerLockElement === document.querySelector('.ow-map-stage canvas'),
        );
      const shader = () =>
        page.evaluate(
          () =>
            (window as Window & { flightPose?: { yawAxis: number; altitude: number } })
              .flightPose ?? { yawAxis: NaN, altitude: NaN },
        );
      const screenPosition = () =>
        marker.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
      await check(marker).toBeVisible();
      await page.getByRole('button', { name: 'Free flight', exact: true }).click();
      await check.poll(() => textures.has(4), { timeout: 60_000 }).toBe(true);
      await page.getByRole('button', { name: 'Inspect terrain', exact: true }).click();
      // Aim at the bridge edge, a known live surface beneath the selected position.
      await stage.scrollIntoViewIfNeeded();
      const anchor = await screenPosition();
      await page.mouse.click(anchor.x + 18, anchor.y + 15);
      expect(await locked()).toBe(false);
      await check(page.locator('.ow-atlas-point')).toBeVisible();
      await page.getByRole('button', { name: 'Inspect terrain', exact: true }).click();
      const beforeCapture = await shader();
      const clickStage = () => stage.click({ position: { x: 240, y: 190 } });
      await clickStage();
      await check.poll(locked).toBe(true);
      await check(stage).toHaveAttribute('aria-description', keyboardCapture ? /Ctrl/ : /Q/);
      expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(keyboardCapture);
      if (keyboardCapture) {
        await check
          .poll(() => stage.evaluate((el) => el.clientHeight / window.innerHeight))
          .toBeGreaterThan(0.85);
      }
      await check.poll(async () => Number.isFinite((await shader()).altitude)).toBe(true);
      const start = await shader();
      // Entering pointer lock can recenter the system cursor before pointerlockchange.
      expect(start.yawAxis).toBeCloseTo(beforeCapture.yawAxis, 5);
      // DevTools sends absolute motion while Pointer Lock reports hardware-relative motion.
      await stage.evaluate((el) =>
        el.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, movementX: 12, movementY: 1 }),
        ),
      );

      await check
        .poll(async () => Math.abs((await shader()).yawAxis - start.yawAxis), { timeout: 15_000 })
        .toBeGreaterThan(0.002);
      // Observe the actual rendered camera even if the marker has left the field of view.
      const beforeY = (await shader()).altitude;
      await page.keyboard.press('Space', { delay: 100 });
      await check
        .poll(async () => (await shader()).altitude - beforeY, { timeout: 15_000 })
        .toBeGreaterThan(0.2);
      const raisedY = (await shader()).altitude;
      const descend = keyboardCapture ? 'Control' : 'KeyQ';
      await page.keyboard.press(descend, { delay: 100 });
      await check
        .poll(async () => raisedY - (await shader()).altitude, { timeout: 15_000 })
        .toBeGreaterThan(0.2);
      await page.keyboard.down('Shift');
      await page.keyboard.down('KeyW');
      await page.keyboard.press('Escape');
      await check.poll(locked).toBe(false);
      await page.keyboard.up('KeyW');
      await page.keyboard.up('Shift');
      const filter = page.getByRole('searchbox');
      await filter.fill('wasd ');
      await check(filter).toHaveValue('wasd ');
      expect(await locked()).toBe(false);
      await filter.fill('');
      // Native Escape releases may have a browser-imposed re-entry interval.
      await check
        .poll(
          async () => {
            if (!(await locked()))
              await page.getByRole('button', { name: 'Capture mouse', exact: true }).click();
            return locked();
          },
          { intervals: [200, 400, 600] },
        )
        .toBe(true);
      await page.evaluate(() => document.exitPointerLock());
      await check.poll(locked).toBe(false);
    } finally {
      await page.close();
    }
  },
  90_000,
);

it('preserves touch look in free flight with the system pointer free', async () => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });
  try {
    await mapRoutes(page, { bridge: true });
    await page.goto(
      `${url}telemetry-fixture?section=map&cartographer#world=earth&face=0&x=256&z=258&y=35`,
    );
    const marker = page.locator('.ow-map-location'),
      canvas = page.locator('.ow-map-stage canvas');
    await page.getByRole('button', { name: 'Free flight', exact: true }).tap();
    await canvas.scrollIntoViewIfNeeded();
    await check(marker).toBeVisible();
    const before = await marker.boundingBox(),
      box = await canvas.boundingBox();
    if (!before || !box) throw Error('Missing touch scene');
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width * 0.3,
      y = box.y + box.height * 0.65;
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 28, y: y + 6 }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await cdp.detach();
    }
    await check
      .poll(async () => Math.abs(((await marker.boundingBox())?.x ?? before.x) - before.x))
      .toBeGreaterThan(2);
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  } finally {
    await page.close();
  }
}, 90_000);

it('shows seed deposits and structures only on opt-in and clears predicted markers when access is withdrawn', async () => {
  const page = await browser.newPage();
  try {
    const { paths } = await mapRoutes(page);
    const reads = (kind: string) => paths.filter((p) => p.pathname.endsWith(`/${kind}`));
    await page.goto(
      `${url}telemetry-fixture?section=map&reader&seedAccess#world=earth&face=1&x=250&z=260`,
    );
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    expect(paths.filter((u) => /\/seed-/.test(u.pathname))).toHaveLength(0);
    const seed = page.getByLabel('Seed preview');
    await seed.check();
    await check.poll(() => reads('seed-tile').length).toBeGreaterThan(0);
    expect(reads('seed-features')).toHaveLength(0);
    const resources = page.getByLabel('Seed deposits and structures');
    await resources.selectOption('copper');
    const feature = page.getByRole('button', { name: 'Copper vein', exact: true });
    await check(feature).toBeVisible();
    expect(reads('seed-features').every((u) => u.searchParams.get('kind') === 'copper')).toBe(true);
    await resources.selectOption('');
    await check(feature).toHaveCount(0);
    await resources.selectOption('copper');
    await check(feature).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('fixture-revoke', { detail: 'game.openworld.seed.inspect' }),
      ),
    );
    await check(seed).toHaveCount(0);
    await check(feature).toHaveCount(0);
    await check(resources).toHaveCount(0);
    await check(page.locator('.ow-atlas-seed-key')).toHaveCount(0);
    const prior = reads('seed-tile').length;
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByRole('button', { name: 'Isometric', exact: true }).click();
    await check(page.getByRole('button', { name: 'Isometric', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(reads('seed-tile').length).toBe(prior);
    await fits(page);
  } finally {
    await page.close();
  }
});

it('falls back to the readable 2D map with checkpoint navigation when WebGL2 is unavailable', async () => {
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      const actual = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        kind,
        ...options
      ) {
        return kind === 'webgl2' ? null : Reflect.apply(actual, this, [kind, ...options]);
      } as typeof actual;
    });
    const { paths } = await mapRoutes(page);
    await page.goto(
      `${url}telemetry-fixture?section=map&reader&seedAccess#world=earth&face=0&x=128&z=120`,
    );
    await check(page.getByText('WebGL is unavailable. Showing the 2D terrain map.')).toBeVisible();
    const counter = page.locator('.ow-atlas-fps');
    await check(counter).toHaveCount(0);
    await check.poll(() => paths.some((u) => u.pathname.endsWith('/surface'))).toBe(true);
    await page.getByRole('searchbox').fill('Lakeside');
    await page
      .locator('.ow-map-list')
      .getByRole('button', { name: /Lakeside/ })
      .click();
    await check(page.getByRole('heading', { name: 'Lakeside' })).toBeVisible();
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await check(page.getByLabel('Seed preview')).toHaveCount(0);
    await page
      .locator('.ow-map-stage canvas')
      .click({ button: 'right', position: { x: 100, y: 70 } });
    await page.getByRole('menuitemcheckbox', { name: 'Stats for nerds' }).click();
    await check(counter).toHaveText('0 FPS');
    expect(paths.some((u) => /\/(mesh|meshes|seed-tile|seed-legend)$/.test(u.pathname))).toBe(
      false,
    );
  } finally {
    await page.close();
  }
});

it('loads creature populations on demand, requests markers only when selected, and switches world and face', async () => {
  const context = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    const { paths } = await mapRoutes(page);
    await page.goto(`${url}telemetry-fixture?section=map&cartographer`);
    await check(page.getByRole('button', { name: 'Creatures', exact: true })).toBeVisible();
    expect(paths.filter((p) => /\/(creatures|space)$/.test(p.pathname))).toHaveLength(0);
    const place = page.getByRole('button', { name: 'Place checkpoint', exact: true });
    await place.click();
    await check(place).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Creatures', exact: true }).click();
    await check(page.getByRole('heading', { name: 'Active population in Earth' })).toBeVisible();
    await check(page.getByRole('row', { name: 'Marsh toad 7' })).toBeVisible();
    await check(
      page.locator('.ow-map-counts div').filter({ hasText: 'Items on the ground' }),
    ).toContainText('31');
    expect(
      paths
        .filter((p) => p.pathname.endsWith('/creatures'))
        .map((p) => p.searchParams.get('markers')),
    ).toEqual([null]);
    await check(page.locator('.ow-map-picking')).toHaveCount(0);
    await page.getByRole('button', { name: 'Terrain', exact: true }).click();
    await check(place).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Creatures', exact: true }).click();
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByLabel('Show creature positions').check();
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    const toad = page.getByRole('button', { name: 'Creature · Marsh toad', exact: true });
    await toad.hover();
    await check(toad).toHaveAttribute('title', 'Marsh toad');
    const box = await toad.boundingBox();
    if (!box) throw Error('Marker is outside the viewport');
    await page.mouse.move(box.x - 15, box.y - 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 21, box.y - 6, { steps: 4 });
    await page.mouse.up();
    await check.poll(async () => (await toad.boundingBox())?.x ?? 0).toBeGreaterThan(box.x + 25);
    await page.getByRole('button', { name: 'Recenter' }).click();
    await check(page.getByText('The map shows a sample of the creature positions.')).toBeVisible();
    await fits(page);
    await page.screenshot({ path: `${shots}/world-map-creatures-en.png` });
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByLabel('Face', { exact: true }).selectOption('3');
    await check(page.getByRole('button', { name: /^Creature ·/ })).toHaveCount(0);
    await page.getByLabel('World', { exact: true }).selectOption('moon');
    await check(page.getByRole('heading', { name: 'Active population in Moon' })).toBeVisible();
    await check(page.getByText('No species recorded in this world.')).toBeVisible();
    expect(paths.filter((p) => p.pathname.endsWith('/space'))).toHaveLength(0);
    expect(
      paths
        .filter((p) => p.searchParams.get('markers') === '1')
        .every((p) => p.searchParams.get('world') === 'earth'),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

it('centers on an orbital body, opens its terrain and clears space markers when authorization changes', async () => {
  const context = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    await mapRoutes(page);
    await page.goto(`${url}telemetry-fixture?section=map&cartographer`);
    await page.getByRole('button', { name: 'Space', exact: true }).click();
    await check(page.getByRole('img', { name: 'Orbital view centered on Sol' })).toBeVisible();
    await check(page.getByRole('listitem').filter({ hasText: 'Night sail' })).toBeVisible();
    await check(page.getByRole('listitem').filter({ hasText: 'Private beacon' })).toBeVisible();
    await page.getByRole('button', { name: 'Center on Moon', exact: true }).click();
    await check(page.getByLabel('Celestial body')).toHaveValue('2');
    await check(page.getByRole('button', { name: 'Earth', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open terrain map' }).click();
    await check(page.getByLabel('World', { exact: true })).toHaveValue('moon');
    await page.getByRole('button', { name: 'Space', exact: true }).click();
    await check(page.getByRole('heading', { name: 'Sol', exact: true })).toBeVisible();
    await page.route('**/map/space?**', (r) =>
      r.fulfill({ status: 403, json: { code: 'forbidden', messageKey: 'errors.forbidden' } }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await check(page.getByRole('alert')).toBeVisible();
    await check(page.getByRole('listitem').filter({ hasText: 'Private beacon' })).toHaveCount(0);
    await check(page.getByRole('img', { name: 'Orbital view centered on Sol' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

it('keeps reader-only space and factory positions accessible on mobile without reading player locations', async () => {
  const context = await browser.newContext({
    locale: 'it-IT',
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    const { paths } = await mapRoutes(page);
    await page.goto(
      `${url}telemetry-fixture?section=map&reader#origin=factories&world=moon&face=3&x=123&z=145`,
    );
    await check(page.getByLabel('Mondo', { exact: true })).toHaveValue('moon');
    await check(page.locator('.ow-map-location')).toBeVisible();
    await page.getByRole('button', { name: 'Spazio', exact: true }).click();
    await check(page.getByRole('heading', { name: 'Sol', exact: true })).toBeVisible();
    await check(page.getByRole('listitem').filter({ hasText: 'Public beacon' })).toBeVisible();
    await check(page.getByText('Private beacon', { exact: true })).toHaveCount(0);
    await check(page.getByText('Night sail', { exact: true })).toHaveCount(0);
    await check(page.getByText('Giocatori nello spazio', { exact: true })).toHaveCount(0);
    await fits(page);
    await page.screenshot({ path: `${shots}/world-map-space-it-mobile.png` });
    await page.getByLabel('Corpo celeste').selectOption('1');
    await check(page.getByRole('heading', { name: 'Earth', exact: true })).toBeVisible();
    expect(paths.some((p) => p.pathname.endsWith('/players'))).toBe(false);
    expect(paths.some((p) => p.pathname.endsWith('/creatures'))).toBe(false);
  } finally {
    await context.close();
  }
});

it('shows the archived head and body on a cold visit while the game is offline', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'it-IT',
  });
  try {
    const page = await context.newPage();
    const native = await serve(page, true);
    const archived = { uuid: archiveId, name: 'Selene', savedAt: instant, skinHash: 'ac1d0042' };
    await page.route('**/openworld/players/saved/search', (route) =>
      route.fulfill({
        json: {
          players: [archived, { uuid: 'guest:sol', name: 'Sol', savedAt: instant, skinHash: null }],
          total: 2,
          page: 1,
          indexedAt: instant,
          stale: false,
          indexing: false,
        },
      }),
    );
    await page.route(`**/players/saved/${archiveId}`, (route) =>
      route.fulfill({
        json: {
          ...archived,
          vitals: {
            health: 0,
            maxHealth: 100,
            hunger: 52,
            maxHunger: 100,
            saturation: 21,
            maxSaturation: 50,
            air: 14,
            maxAir: 20,
          },
          vitalsObservedAt: '2026-01-20T10:30:00.000Z',
          statsAt: null,
          mode: 'survival',
          world: 'Earth',
          position: null,
          inventory: null,
          stats: null,
        },
      }),
    );
    const skinReads: string[] = [];
    await page.route('**/players/saved/*/skin?*', (route) => {
      const target = new URL(route.request().url());
      skinReads.push(`${target.pathname}${target.search}`);
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOgeONsAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    });
    await page.goto(`${url}telemetry-fixture?section=players&offline`);
    const entry = page.getByRole('link', { name: /Selene/ });
    await check(entry.locator('img')).toBeVisible();
    await expect
      .poll(() => entry.locator('img').evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await entry.click();
    const profile = page.getByRole('region', { name: 'Selene', exact: true });
    const hud = profile.getByRole('region', { name: 'Parametri vitali' });
    await check(hud.getByRole('meter', { name: 'Salute', exact: true })).toHaveJSProperty(
      'value',
      0,
    );
    await check(hud.getByRole('meter', { name: 'Sazietà' })).toHaveJSProperty('value', 21);
    await check(hud.locator('time')).toHaveAttribute('datetime', '2026-01-20T10:30:00.000Z');
    await check(hud).toContainText('Ultima osservazione');
    await fits(page);
    const body = profile.locator('.ow-body-skin img');
    await check(body).toBeVisible();
    await expect
      .poll(() => body.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    expect(skinReads.map((path) => new URL(path, url).searchParams.get('view'))).toEqual([
      'head',
      'body',
    ]);
    expect(
      skinReads.every(
        (path) =>
          path.includes(`/${archiveId}/skin?`) &&
          new URL(path, url).searchParams.get('h') === archived.skinHash,
      ),
    ).toBe(true);
    expect(native.some((path) => path.endsWith('/skin'))).toBe(false);
  } finally {
    await context.close();
  }
});
