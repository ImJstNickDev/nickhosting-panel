/**
 * Compare the installed official map against the panel on identical generated
 * OWMS/OWM1 data, textures, markers, drawing buffers and time-normalized camera
 * tracks. First run primes the fixture. Each measured run starts an empty
 * browser context, moves while streaming, waits for quiet, then repeats.
 * GPU queries run on a separate pass. HTTP byte counts exclude module delivery
 * and report material images separately. Native reads are logical fixture reads.
 *
 * Usage: scripts/dev.sh pnpm exec tsx scripts/experiments/openworld-atlas/benchmark.ts --help
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  centre,
  columns,
  faceEdge,
  materialPalette,
  mesh,
  meshBundle,
  surface,
  texture,
} from './valley.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.slice(2).split('=')));
if ('help' in args) {
  console.log(
    'Options --native=/path/to/server/assets --renderers=native,panel --modes=plan,iso,fly --radii=4,8,12 --rounds=3 --duration=3000 --output=PATH --gpu=vulkan (or swiftshader). Runs only on 127.0.0.1 with synthetic public fixture data.',
  );
  process.exit(0);
}
const repo = resolve(here, '../../..'),
  root = join(repo, 'apps/web');
const native = args.native,
  renderers = (args.renderers ?? 'native,panel').split(','),
  modes = (args.modes ?? 'plan,iso,fly').split(',');
if (renderers.includes('native') && !native)
  throw Error('Pass --native pointing to your installed Openworld server assets');
const output = resolve(args.output ?? join(repo, '.codex/local/openworld-atlas-bench'));
const require = createRequire(join(root, 'package.json'));
const { createServer } = (await import(require.resolve('vite'))) as typeof import('vite');
const vite = await createServer({
  root,
  configFile: false,
  cacheDir: join(output, 'vite-cache'),
  optimizeDeps: {
    noDiscovery: true,
    include: ['react', 'react/jsx-runtime', '@tanstack/react-query'],
  },
  server: { host: '127.0.0.1', middlewareMode: true, ws: false, hmr: false, watch: null },
  appType: 'custom',
});
const cache = new Map<string, Buffer>();
const cachedMesh = (i: number, j: number, lod: number, radius: number) => {
  const key = `mesh/${i}/${j}/${lod}/${radius}`;
  let value = cache.get(key);
  if (!value) {
    value = mesh(i, j, lod, radius);
    cache.set(key, value);
  }
  return value;
};
const server = createHttpServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? '/', 'http://localhost'),
      p = u.pathname;
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (p === '/bench') {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.end(
        '<!doctype html><html><meta charset="utf-8"><script type="importmap">{"imports":{"three":"/reference/three.js"}}</script><style>*{box-sizing:border-box}body{margin:0;background:#17221c}#scene,#markers{position:absolute;inset:0;overflow:hidden}canvas,.owm-three{width:100%;height:100%;position:absolute;inset:0;display:block}.pin{width:9px;height:9px;margin:-4px 0 0 -4px;background:#eed77e;border:1px solid #183825;position:absolute;border-radius:50%}#markers{pointer-events:none}</style><div id="scene"></div><div id="markers"></div></html>',
      );
      return;
    }
    const asset =
      p === '/bench-view.mjs' || p === '/native-view.mjs'
        ? join(here, basename(p))
        : native && /^\/reference\/map\/[a-z0-9]+\.js$/.test(p)
          ? join(native, 'web/js/map', basename(p))
          : native && p === '/reference/three.js'
            ? join(native, 'inspector/vendor/three.module.js')
            : null;
    if (asset) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(asset));
      return;
    }
    const n = (s: string, fallback = 0) => Number(u.searchParams.get(s) ?? fallback);
    const radius = n('radius', 16);
    if (p === '/valley') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          edge: faceEdge,
          materials: materialPalette,
          columns: columns(radius),
          markers: [
            { x: 256, y: 35, z: 258, name: 'Footbridge' },
            { x: 240, y: 33, z: 226, name: 'West bank' },
          ],
        }),
      );
      return;
    }
    if (p === '/material.png') {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.end(texture(n('id')));
      return;
    }
    if (p === '/fixture/meshes') {
      const cells = (u.searchParams.get('cells') ?? '')
        .split(';')
        .map((pair) => pair.split(',').map(Number) as [number, number]);
      if (cells.length > 16 || !cells.length) throw Error('Invalid mesh batch');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        await meshBundle(cells, n('lod'), radius, 0, (i, j) => cachedMesh(i, j, n('lod'), radius)),
      );
      return;
    }
    if (p.startsWith('/fixture/')) {
      const lod = n('lod'),
        cn = n('n', 8);
      if (
        !Number.isInteger(cn) ||
        cn > 32 ||
        cn < 1 ||
        !Number.isInteger(lod) ||
        lod < 0 ||
        lod > 6 ||
        radius < 1 ||
        radius > 16
      )
        throw Error('Invalid fixture size');
      // Cache immutable buffers for both renderers across the untimed warm-up and measured rounds.
      const key = [p, n('ci'), n('cj'), n('i'), n('j'), cn, lod, radius].join('/');
      let body = cache.get(key);
      if (!body) {
        if (p === '/fixture/surface') body = surface(n('ci'), n('cj'), cn, lod, radius);
        else if (p === '/fixture/mesh') body = cachedMesh(n('i'), n('j'), lod, radius);
        else throw Error(`Unknown fixture request ${p}`);
        cache.set(key, body);
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(body);
      return;
    }
    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const address = server.address();
if (!address || typeof address === 'string') throw Error('Missing fixture address');
const gpu = args.gpu ?? 'vulkan';
const browser = await chromium.launch({
  args:
    gpu === 'swiftshader'
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : [
          '--enable-gpu',
          '--use-angle=vulkan',
          '--enable-features=Vulkan',
          '--ignore-gpu-blocklist',
        ],
  env: {
    ...process.env,
    LD_LIBRARY_PATH:
      process.env.LD_LIBRARY_PATH ??
      join(homedir(), '.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu'),
  },
});
try {
  await mkdir(output, { recursive: true });
  const rounds = Number(args.rounds ?? 3);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw Error('Rounds must be 1–10');
  // Untimed first sweep fills the loopback generator and GPU shader caches. Each
  // recorded pass still starts in a new browser context with empty renderer data.
  for (let round = args.prime === 'false' ? 1 : 0; round <= rounds; round++)
    for (const mode of modes)
      for (const r of (args.radii ?? '4,8,12').split(','))
        for (const renderer of round % 2 ? renderers : [...renderers].reverse()) {
          const radius = Number(r);
          const profile = {
            renderer,
            mode,
            radius,
            x: centre.x,
            z: centre.z,
            span: radius * 24,
            duration: Number(args.duration ?? 3000),
            travel: Math.min(48, radius * 3),
          };
          const context = await browser.newContext({
            viewport: { width: 800, height: 480 },
            deviceScaleFactor: 1,
            locale: 'en-US',
          });
          try {
            const page = await context.newPage(),
              errors: string[] = [];
            page.on('pageerror', (e) => errors.push(e.message));
            page.on('console', (msg) => {
              if (msg.type() === 'error') errors.push(msg.text().slice(0, 260));
            });
            await page.goto(`http://127.0.0.1:${address.port}/bench`);
            const result = await page
              .evaluate(async (profile) => {
                const entry = '/bench-view.mjs';
                const { mount } = await import(entry);
                return await mount(profile);
              }, profile)
              .catch((e) => {
                throw Error(`${e}: ${errors.join('; ')}`);
              });
            if (errors.length) throw Error(errors.slice(0, 5).join('\n'));
            if (round === 0) continue;
            const record = { profile, round, chromium: browser.version(), ...result };
            const name = `${renderer}-${mode}-${r}-${round}`;
            await page.screenshot({ path: join(output, `${name}.png`) });
            await writeFile(join(output, `${name}.json`), JSON.stringify(record, null, 2));
            if (renderer === 'panel' && mode === 'fly' && round === rounds) {
              const inspection = await page.evaluate(async () => {
                const w = window as typeof window & {
                  prepareBridgeInspection: () => Promise<{ eye: number[]; deckBottom: number }>;
                };
                return w.prepareBridgeInspection();
              });
              await page.mouse.move(400, 340);
              await page.mouse.down();
              await page.mouse.move(400, 125, { steps: 12 });
              await page.mouse.up();
              const ceiling = await page.evaluate(() => {
                const w = window as typeof window & {
                  pickBridgeCeiling: () => { source: string; y?: number } | null;
                };
                return w.pickBridgeCeiling();
              });
              if (
                ceiling?.source !== 'live' ||
                ceiling.y == null ||
                Math.abs(ceiling.y - inspection.deckBottom) > 0.05
              ) {
                throw Error(`Unexpected ceiling intersection: ${JSON.stringify(ceiling)}`);
              }
              await page.screenshot({ path: join(output, 'below-deck.png') });
              await writeFile(
                join(output, 'below-deck.json'),
                JSON.stringify({ ...inspection, ceiling }),
              );
            }
            console.log(JSON.stringify(record));
          } finally {
            await context.close();
          }
        }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await vite.close();
}
