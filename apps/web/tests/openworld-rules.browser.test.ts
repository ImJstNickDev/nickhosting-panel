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
        permissions: ['admin.kick', 'admin.teleport'],
      },
      { key: 'player', name: 'Player', priority: 0, parent: null, permissions: ['build', 'chat'] },
    ],
  },
  zones: [
    {
      name: 'Old Harbour',
      world: 'earth',
      description: 'Face 0 · 160, 240 m',
      flags: [{ key: 'pvp', value: 'deny' }],
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
  capabilities: { difficulty: true, unban: true },
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
it('shows per-world rules and game permissions, confirms difficulty and a ban removal, and refreshes the verified result', async () => {
  const page = await open('en', 1152);
  try {
    let state = structuredClone(sample);
    const writes: {
      requestId: string;
      processRef: string;
      action: { kind: string; uuid?: string; value?: 'hard' };
    }[] = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/openworld/rules', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: state });
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.action.kind === 'unban')
        state = { ...state, bans: state.bans?.filter((b) => b.uuid !== body.action.uuid) ?? null };
      if (body.action.kind === 'difficulty') state = { ...state, difficulty: body.action.value };
      return route.fulfill({ json: { outcome: 'accepted', requestId: body.requestId } });
    });
    await page.goto(`${url}&manage&bans&consoleRead&consoleCommand`);
    await see(page.getByRole('heading', { name: 'World rules' })).toBeVisible();
    await see(page.getByText('Old Harbour')).toBeVisible();
    await see(page.getByText('Denied', { exact: true })).toBeVisible();
    await see(page.getByText('Closed', { exact: true })).toBeVisible();
    await page.getByText('Moderator', { exact: true }).click();
    await see(page.getByText('admin.kick, admin.teleport')).toBeVisible();
    await see(page.getByText('Repeated trespassing')).toBeVisible();
    await see(page.getByText('Radius 250 m · Longitude 2.5° · Latitude 3°')).toBeVisible();
    await see(page.getByRole('link', { name: 'Open console' })).toHaveAttribute(
      'href',
      '/servers/10000000-0000-4000-8000-000000000001/console',
    );
    await page.screenshot({ path: `${shots}/rules-desktop.png`, fullPage: true });
    await page.getByRole('button', { name: 'Change difficulty' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Difficulty', { exact: true }).selectOption('hard');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await see(page.getByRole('status')).toHaveText('Difficulty updated.');
    await see(page.getByText('Hard', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Lift ban' }).click();
    await see(dialog.getByText(accountId)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(writes).toHaveLength(1);
    await page.getByRole('button', { name: 'Lift ban' }).click();
    await dialog.getByRole('button', { name: 'Lift ban' }).click();
    await see(page.getByText('Harbour Scout')).toHaveCount(0);
    await see(page.getByText('Harbour Guest')).toBeVisible();
    await see(page.getByRole('button', { name: 'Lift ban' })).toHaveCount(0);
    expect(writes.map((w) => w.action)).toEqual([
      { kind: 'difficulty', value: 'hard' },
      { kind: 'unban', uuid: accountId },
    ]);
    expect(writes.every((w) => w.processRef === processRef && w.requestId.length === 36)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
it('separates unavailable from empty on mobile, gates mutations by grant and suppresses reads while offline or forbidden', async () => {
  const page = await open('it', 390);
  try {
    let reads = 0,
      forbidden = false;
    await page.route('**/openworld/rules', (route) => {
      reads++;
      return forbidden
        ? route.fulfill({
            status: 403,
            json: { error: { code: 'forbidden', messageKey: 'errors.forbidden' } },
          })
        : route.fulfill({ json: { ...sample, zones: [], borders: null } });
    });
    await page.goto(url);
    await see(page.getByText('Nessuna zona protetta.')).toBeVisible();
    await see(page.getByText('Non disponibile')).toBeVisible();
    await see(page.getByText('Harbour Scout')).toBeVisible();
    await see(page.getByRole('button', { name: 'Cambia difficoltà' })).toHaveCount(0);
    await see(page.getByRole('button', { name: 'Revoca ban' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${shots}/rules-mobile-it.png`, fullPage: true });
    forbidden = true;
    await page.getByRole('button', { name: 'Aggiorna' }).click();
    await see(page.getByRole('alert')).toBeVisible();
    await see(page.getByText('Harbour Scout')).toHaveCount(0);
    const count = reads;
    await page.goto(`${url}&offline&consoleRead&consoleCommand`);
    await see(page.getByRole('link', { name: 'Apri console' })).toHaveCount(0);
    await see(page.getByText('Avvia il server per consultare le regole.')).toBeVisible();
    await page.goto(`${url}&restricted&manage&bans`);
    await see(page.getByRole('alert')).toBeVisible();
    expect(reads).toBe(count);
  } finally {
    await page.close();
  }
});
it('prevents a repeated moderation command when the game outcome is uncertain', async () => {
  const page = await open('en', 900);
  try {
    let writes = 0;
    await page.route('**/openworld/rules', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: sample });
      writes++;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'operation_uncertain', messageKey: 'errors.operation_uncertain' } },
      });
    });
    for (const grants of ['consoleRead', 'consoleCommand', 'bans']) {
      await page.goto(`${url}&${grants}`);
      await see(page.getByRole('heading', { name: 'Banned players' })).toBeVisible();
      await see(page.getByRole('link', { name: 'Open console' })).toHaveCount(0);
    }
    await see(page.getByRole('button', { name: 'Change difficulty' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Lift ban' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Lift ban' }).click();
    await see(dialog.getByRole('alert')).toBeVisible();
    await see(dialog.getByRole('button', { name: 'Lift ban' })).toBeDisabled();
    expect(writes).toBe(1);
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await see(dialog).toHaveCount(0);
  } finally {
    await page.close();
  }
});
