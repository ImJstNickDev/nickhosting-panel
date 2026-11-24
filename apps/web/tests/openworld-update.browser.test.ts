import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { type Browser, expect as check, chromium } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  OpenworldUpdate,
  UpdateRequest,
} from '../src/integrations/openworld/version-update.api.js';

let vite: ViteDevServer, browser: Browser, origin: string;
const id = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const shots = '.codex/local/openworld-browser';
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    cacheDir: `${process.cwd()}/.codex/local/openworld-update-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'openworld-update-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/servers/')) return next();
            res.setHeader('Content-Type', 'text/html');
            res.end(
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/openworld-update-page.tsx"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await vite.listen();
  origin = vite.resolvedUrls?.local[0] ?? '';
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
it.each(['timed', 'when-empty', 'immediate'] as const)(
  'submits %s updates from the runtime and restores progress on reload',
  async (mode) => {
    const mobile = mode === 'when-empty';
    const context = await browser.newContext({
      locale: mobile ? 'it-IT' : 'en-US',
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let current: OpenworldUpdate | null = null,
      installed = 'a1.2.9';
    let request: UpdateRequest | undefined;
    let firstRequest: UpdateRequest | undefined;
    let catalogUnavailable = false;
    let currentReads = 0,
      catalogReads = 0;
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const send = (json: unknown) => route.fulfill({ json });
      if (path.endsWith('/openworld/update/current')) {
        currentReads++;
        return send({ current });
      }
      if (path.endsWith('/cancel') && current) {
        current = { ...current, phase: 'cancelled', cancellable: false };
        return send(current);
      }
      if (path.endsWith('/openworld/update')) {
        if (route.request().method() === 'POST') {
          request = route.request().postDataJSON();
          if (mode === 'immediate' && !firstRequest) {
            firstRequest = request;
            return route.fulfill({
              status: 503,
              json: { error: { code: 'integration_unavailable' } },
            });
          }
          current = {
            id: task,
            fromVersion: installed,
            toVersion: 'a1.2.11',
            phase: 'preparing',
            deadline: null,
            warning: null,
            error: null,
            restart: null,
            backupBefore: request?.backupBefore ?? false,
            cancellable: true,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          return send(current);
        }
        catalogReads++;
        if (catalogUnavailable)
          return route.fulfill({
            status: 503,
            json: { error: { code: 'integration_unavailable' } },
          });
        return send({
          installedVersion: installed,
          latestVersion: installed === 'a1.2.11' ? null : 'a1.2.11',
          releases:
            installed === 'a1.2.11'
              ? []
              : [
                  { version: 'a1.2.11', size: 20000000 },
                  { version: 'a1.2.10', size: 18000000 },
                ],
          defaultNoticeSeconds: 90,
          current,
        });
      }
      if (path.endsWith(`/platform/servers/${id}`))
        return send({
          id,
          name: 'Aurora',
          gameId: 'openworld',
          runtimeId: 'dedicated',
          runtimeNameKey: 'games.openworld.runtime',
          version: installed,
          permissions: { manage: true, read: true },
          permissionKeys: ['settings.read', 'backups.create'],
          activeOperationId:
            current && !['cancelled', 'completed'].includes(current.phase) ? task : null,
          installationState: 'installed',
          runtimeState: 'running',
          availableActions: {},
          capabilities: {},
          limits: {},
        });
      if (path.endsWith('/provisioning')) return send({ provisioning: null });
      return send({});
    });
    const url = `${origin}servers/${id}/console`;
    await page.goto(url);
    const icon = page.getByRole('link', {
      name: mobile ? 'Nuova versione disponibile' : 'New version available',
    });
    await check(icon).toBeVisible({ timeout: 20000 });
    await check(
      page.getByText(mobile ? 'Server dedicato a1.2.9' : 'Dedicated server a1.2.9'),
    ).toBeVisible();
    expect(currentReads).toBe(0);
    await icon.click();
    await page
      .getByRole('button', { name: mobile ? 'Prepara aggiornamento' : 'Review update' })
      .click();
    const dialog = page.getByRole('dialog');
    const timer = dialog.getByRole('spinbutton');
    const delay = dialog.getByRole('switch', {
      name: mobile ? 'Dai un preavviso ai giocatori' : 'Give players advance notice',
    });
    const empty = dialog.getByRole('switch', {
      name: mobile ? 'Attendi che il server sia vuoto' : 'Wait until the server is empty',
    });
    const route = dialog.locator('.ow-update-route');
    const bounds = await route.evaluate((row) => {
      const { left, right } = row.getBoundingClientRect();
      const [from, arrow, to] = [...row.children].map((child) => child.getBoundingClientRect());
      if (!from || !arrow || !to) throw new Error('Incomplete version comparison');
      return [from.left - left, (arrow.left + arrow.right - left - right) / 2, to.right - right];
    });
    expect(bounds.every((offset) => Math.abs(offset) < 1)).toBe(true);
    await check(timer).toHaveValue('90');
    await check(delay).toBeChecked();
    await check(dialog.getByRole('checkbox')).not.toBeChecked();
    if (mode === 'when-empty') {
      await timer.fill('47');
      await empty.click();
      await check(delay).toBeEnabled();
      await check(delay).not.toBeChecked();
      await check(timer).toHaveCount(0);
      await delay.click();
      await check(empty).not.toBeChecked();
      await check(delay).toBeChecked();
      await check(timer).toHaveValue('47');
      await empty.click();
    } else if (mode === 'immediate') {
      await timer.fill('45');
      await delay.click();
      await check(timer).toHaveCount(0);
      await delay.click();
      await check(timer).toHaveValue('45');
      await delay.click();
    } else {
      await timer.fill('35');
      await dialog.getByRole('checkbox').check();
    }
    await page.screenshot({ path: `${shots}/update-dialog-${mode}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog
      .getByRole('button', { name: mobile ? 'Aggiorna server' : 'Update server' })
      .click();
    if (mode === 'immediate') {
      await check(dialog.getByRole('alert')).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'Check request' }).click();
      await check(delay).toBeDisabled();
      await dialog.getByRole('button', { name: 'Check request' }).click();
      expect(request).toEqual(firstRequest);
    }
    const progress = page.getByRole('complementary', {
      name: mobile ? 'Aggiornamento Openworld' : 'Openworld update',
    });
    await check(progress).toContainText(mobile ? 'Preparazione dei file' : 'Preparing files');
    expect(request).toMatchObject({
      version: 'a1.2.11',
      expectedVersion: 'a1.2.9',
      mode,
      backupBefore: mode === 'timed',
    });
    expect(request?.noticeSeconds).toBe(mode === 'timed' ? 35 : undefined);
    expect(catalogReads).toBe(1);
    if (!current) throw new Error('Expected accepted update');
    const accepted = current as OpenworldUpdate;
    current = {
      ...accepted,
      phase: mode === 'when-empty' ? 'waiting-empty' : mode === 'timed' ? 'notice' : 'stopping',
      restart: true,
      deadline: new Date(Date.now() + 35000).toISOString(),
    };
    catalogUnavailable = mobile;
    await page.reload();
    await check(progress).toContainText(
      mobile
        ? 'In attesa che escano i giocatori'
        : mode === 'timed'
          ? 'Waiting for shutdown'
          : 'Stopping server',
    );
    await page.screenshot({ path: `${shots}/update-progress-${mode}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (mobile) {
      catalogUnavailable = false;
      await progress.getByRole('button', { name: 'Annulla aggiornamento' }).click();
      await check(progress).toHaveCount(0);
      await check(icon).toBeVisible();
    } else {
      current = { ...current, phase: 'installing', cancellable: false, deadline: null };
      await check(progress).toContainText('Installing the update');
      await check(progress.getByRole('button', { name: 'Cancel update' })).toHaveCount(0);
      installed = 'a1.2.11';
      current = { ...current, phase: 'completed' };
      await check(page.getByText('Update complete', { exact: true })).toBeVisible({
        timeout: 7000,
      });
      await check(icon).toHaveCount(0);
      await check(page.getByText('Dedicated server a1.2.11')).toBeVisible();
      await page.reload();
      await check(page.getByText('Dedicated server a1.2.11')).toBeVisible();
      await check(page.getByText('Update complete', { exact: true })).toHaveCount(0);
    }
    await context.close();
  },
);
