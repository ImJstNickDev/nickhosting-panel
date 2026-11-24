import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { type Browser, chromium, expect as see } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { OpenworldRulesSnapshot } from '../../../games/openworld/src/rules.js';

let vite: ViteDevServer, browser: Browser, url: string;
const shots = '.codex/local/openworld-browser';
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    cacheDir: `${process.cwd()}/.codex/local/openworld-rules-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'rules-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/rules-fixture')) return next();
            res.setHeader('content-type', 'text/html');
            res.end(
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Openworld</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/openworld-rules-page.tsx"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await vite.listen();
  url = `${vite.resolvedUrls?.local[0]}rules-fixture?section=rules`;
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
const accountId = '34567890-1234-4f00-8899-987654321012';
const processRef = 'a'.repeat(64);
const sample: OpenworldRulesSnapshot & { processRef: string } = {
  processRef,
  difficulty: 'normal',
  roles: {
    defaultRole: 'player',
    entries: [
      {
        key: 'moderator',
        name: 'Moderator',
        priority: 50,
        parent: 'player',
        permissions: ['admin.kick', '-home.delete'],
        color: '#876abb',
        maxHomes: 10,
      },
      {
        key: 'player',
        name: 'Player',
        priority: 0,
        parent: null,
        permissions: ['build', 'home.*'],
        color: '#578160',
        maxHomes: 3,
      },
    ],
  },
  zones: [
    {
      name: 'Harbour',
      id: 1,
      shape: 'circle',
      centre: [3, 6],
      radius: 50,
      priority: 10,
      color: '#39917c',
      world: 'earth',
      description: 'North coast trading port',
      flags: [{ key: 'pvp', value: 'allow' }],
    },
    {
      id: 2,
      name: 'Citadel',
      world: 'moon',
      shape: 'polygon',
      points: [
        [8, 9],
        [9, 10.1],
        [11, 10.5],
        [12, 9],
        [10, 8.5],
      ],
      priority: 3,
      color: '#8069a0',
      flags: [{ key: 'build', value: 'deny' }],
      description: 'Lunar outpost',
    },
  ],
  borders: {
    spaceOpen: true,
    worlds: [
      { world: 'earth', description: 'closed' },
      {
        world: 'moon',
        description: 'bounded',
        border: { radiusMeters: 250, longitude: 2.5, latitude: 3 },
      },
    ],
  },
  bans: [
    { uuid: accountId, name: 'Harbour Scout', reason: 'Repeated trespassing' },
    { uuid: 'guest:quay', name: 'Harbour Guest', reason: null },
  ],
  globalFlags: { pvp: 'deny', explosions: 'deny', build: 'allow' },
  permissionNodes: ['build', 'admin.kick', 'home.set', 'home.delete'],
  capabilities: {
    difficulty: true,
    unban: true,
    globals: true,
    zones: true,
    borders: true,
    roles: true,
    spawning: true,
  },
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
  page.setDefaultTimeout(4000);
  return page;
}
it('edits a world rule, traces zone exceptions and inherited group permissions', async () => {
  const page = await open('en', 1152);
  try {
    const state = structuredClone(sample);
    const writes: unknown[] = [];
    let reads = 0;
    await page.route('**/openworld/rules', async (route) => {
      if (route.request().method() === 'GET') {
        reads++;
        return route.fulfill({ json: state });
      }
      const body = route.request().postDataJSON();
      writes.push(body.action);
      if (body.action.kind === 'zoneFlag') {
        const zone = state.zones?.find((z) => z.id === body.action.zoneId);
        if (zone) zone.flags = (zone.flags ?? []).filter((f) => f.key !== body.action.flag);
      }
      if (body.action.kind === 'globalFlag')
        state.globalFlags = { ...state.globalFlags, pvp: body.action.value };
      return route.fulfill({ json: { outcome: 'accepted', requestId: body.requestId } });
    });
    await page.goto(`${url}&manage&territory&groups&map`);
    await see(page.getByRole('heading', { name: 'World rules' })).toBeVisible();
    await see(page.getByText('Harbour Scout')).toHaveCount(0);
    await page.screenshot({ path: `${shots}/rules-editor-world.png`, fullPage: true });
    await page.getByRole('button', { name: 'Harbour', exact: false }).click();
    await see(page.getByRole('heading', { name: 'Harbour' })).toBeVisible();
    await see(page.getByRole('link', { name: 'Open in Map' })).toBeVisible();
    await see(page.getByText('World rule: Denied').first()).toBeVisible();
    await page.screenshot({ path: `${shots}/rules-editor-zone.png`, fullPage: true });
    await page.getByRole('button', { name: 'Player combat (PvP): Allowed', exact: true }).click();
    const zoneEdit = page.getByRole('dialog');
    await zoneEdit.getByLabel(/Use world rule/).check();
    await zoneEdit.getByRole('button', { name: 'Save changes' }).click();
    await see(
      page.getByRole('button', { name: 'Player combat (PvP): Denied', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'World rules', exact: true }).click();
    await page.getByRole('button', { name: 'Player combat (PvP): Denied' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Allowed', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await see(
      page.getByRole('button', { name: 'Player combat (PvP): Allowed', exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([
      { kind: 'zoneFlag', zoneId: 1, flag: 'pvp', value: 'default' },
      { kind: 'globalFlag', flag: 'pvp', value: 'allow' },
    ]);
    expect(reads).toBe(3);
    await page.getByRole('button', { name: 'Permission groups', exact: true }).click();
    await page.getByRole('button', { name: 'Moderator', exact: true }).click();
    await see(page.getByRole('heading', { name: 'Moderator' })).toBeVisible();
    await see(page.getByText('home.*', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${shots}/rules-editor-groups.png`, fullPage: true });
    await page.getByRole('searchbox', { name: 'Filter permissions' }).fill('kick');
    await see(page.getByText('admin.kick', { exact: true })).toBeVisible();
    await see(page.getByText('home.*', { exact: true })).toHaveCount(0);
  } finally {
    await page.close();
  }
});
it('keeps a failed refresh readable, clears revoked access and reflows on mobile', async () => {
  const page = await open('it', 390);
  try {
    let status = 200,
      reads = 0;
    await page.route('**/openworld/rules', (r) => {
      reads++;
      return status === 200
        ? r.fulfill({ json: sample })
        : r.fulfill({
            status,
            json: {
              error: {
                code: status === 403 ? 'forbidden' : 'integration_unavailable',
                messageKey: status === 403 ? 'errors.forbidden' : 'errors.integration_unavailable',
              },
            },
          });
    });
    await page.goto(url);
    await see(page.getByRole('heading', { name: 'Regole del mondo' })).toBeVisible();
    await see(page.getByRole('button', { name: 'Cambia difficoltà' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${shots}/rules-editor-mobile-it.png`, fullPage: true });
    status = 503;
    await page.getByRole('button', { name: 'Aggiorna', exact: true }).click();
    await see(page.getByRole('alert')).toBeVisible();
    await see(page.getByText('Harbour')).toBeVisible();
    status = 403;
    await page.getByRole('button', { name: 'Aggiorna', exact: true }).click();
    await see(page.getByText('Harbour')).toHaveCount(0);
    status = 503;
    await page.getByRole('alert').getByRole('button').click();
    await see(page.getByRole('alert')).toContainText('Questa integrazione non è disponibile.');
    await see(page.getByRole('alert').getByRole('button')).toBeVisible();
    await see(page.getByText('Harbour')).toHaveCount(0);
    const count = reads;
    await page.goto(`${url}&offline`);
    await see(page.getByText('Avvia il server per consultare le regole.')).toBeVisible();
    await page.goto(`${url}&restricted`);
    await see(page.getByRole('alert')).toBeVisible();
    expect(reads).toBe(count);
  } finally {
    await page.close();
  }
});
it('creates a group on mobile, adds an explicit denial and traces the inherited wildcard to its source', async () => {
  const page = await open('en', 390);
  try {
    const state = structuredClone(sample);
    const groups = state.roles?.entries;
    if (!groups) throw Error('missing fixture groups');
    const sent: unknown[] = [];
    await page.route('**/openworld/rules', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: state });
      const body = route.request().postDataJSON(),
        a = body.action;
      sent.push(a);
      if (a.kind === 'roleCreate')
        groups.push({ key: a.role, name: a.role, priority: 1, parent: a.parent, permissions: [] });
      if (a.kind === 'rolePermission')
        groups.find((g) => g.key === a.role)?.permissions?.push(a.permission);
      return route.fulfill({ json: { requestId: body.requestId, outcome: 'accepted' } });
    });
    await page.goto(`${url}&groups`);
    await page.getByRole('button', { name: 'Permission groups', exact: true }).click();
    await page.getByRole('button', { name: 'New group' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Group ID').fill('builder');
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await see(page.getByRole('heading', { name: 'builder' })).toBeVisible();
    await page.getByRole('button', { name: 'Add permission' }).click();
    await dialog.getByLabel('Permission', { exact: true }).fill('home.delete');
    await dialog.getByLabel('Denied', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('searchbox', { name: 'Filter permissions' }).fill('home.delete');
    await see(page.getByText('home.delete · Denied by builder')).toBeVisible();
    await see(page.getByText('home.*', { exact: true })).toBeVisible();
    await see(page.getByRole('button', { name: 'Remove home.*' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${shots}/rules-editor-mobile-group.png`, fullPage: true });
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(sent).toEqual([
      { kind: 'roleCreate', role: 'builder', parent: 'player' },
      { kind: 'rolePermission', role: 'builder', permission: '-home.delete', add: true },
    ]);
  } finally {
    await page.close();
  }
});
it('separates territory permission and keeps ambiguous zone targets and uncertain writes read-only', async () => {
  const page = await open('en', 900);
  try {
    let writes = 0;
    const state = structuredClone(sample);
    state.zones = [
      { id: 11, name: 'Arena', world: 'earth', description: 'Capital', flags: [] },
      { id: 12, name: 'Arena', world: 'moon', description: 'Colony', flags: [] },
    ];
    await page.route('**/openworld/rules', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: state });
      writes++;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'operation_uncertain', messageKey: 'errors.operation_uncertain' } },
      });
    });
    await page.goto(`${url}&manage`);
    await see(page.getByRole('heading', { name: 'World rules' })).toBeVisible();
    await see(page.getByRole('button', { name: 'Change difficulty' })).toBeVisible();
    await see(page.getByRole('button', { name: 'Player combat (PvP): Denied' })).toHaveCount(0);
    await page.goto(`${url}&territory`);
    await page.getByRole('button', { name: 'Arena', exact: false }).first().click();
    await see(page.getByRole('heading', { name: 'Arena' })).toBeVisible();
    await see(page.getByRole('button', { name: 'Apply preset' })).toHaveCount(0);
    await page.getByRole('button', { name: 'World rules', exact: true }).click();
    await page.getByRole('button', { name: 'View worlds' }).click();
    await page.getByRole('button', { name: /moon/i }).click();
    await page.getByRole('button', { name: 'Edit Radius (m)' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Radius (m)').fill('275');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await see(dialog.getByRole('alert')).toBeVisible();
    await see(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(writes).toBe(1);
  } finally {
    await page.close();
  }
});
