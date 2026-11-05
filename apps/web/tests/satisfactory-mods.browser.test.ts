import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, expect as check, chromium } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let vite: ViteDevServer, browser: Browser, origin: string;
const shots = '.codex/local/m6-browser/screenshots';
beforeAll(async () => {
  vite = await createServer({
    root: `${process.cwd()}/apps/web`,
    configFile: false,
    cacheDir: `${process.cwd()}/.codex/local/satisfactory-vite`,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: 'satisfactory-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/satisfactory-fixture')) return next();
            res.setHeader('content-type', 'text/html');
            res.end(
              '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Satisfactory</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/satisfactory-mods-page.tsx"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await vite.listen();
  origin = vite.resolvedUrls?.local[0] ?? '';
  browser = await chromium.launch({
    headless: true,
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
const emptySnapshot = () => ({
  selection: [],
  lock: { version: 1, mods: {} },
  revision: 0,
  profiles: [],
  activeProfileId: null,
  vanilla: false,
  externalMode: false,
  rollbackAvailable: false,
  inventoryFingerprint: null,
});
const emptyInventory = () => ({
  items: [],
  fingerprint: 'a'.repeat(64),
  diverged: false,
  gameVersion: 400001,
});
const exampleProject = {
  id: 'example',
  reference: 'Example',
  name: 'Example mod',
  description: 'A compact factory mod.',
  authors: ['Factory Tools'],
  tags: ['Buildings'],
  logo: null,
};
const exampleVersion = {
  version: '1.2.3',
  gameVersion: '>=400000',
  compatibility: 'compatible',
  dependencies: [{ mod_id: 'SML', condition: '>=3.0.0', optional: false }],
};

it('reviews resolved changes before apply, reuses shared Minecraft layout, and supports Italian mobile read-only view', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const requests: { path: string; body: unknown }[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/catalog'))
      return route.fulfill({ json: { total: 1, items: [exampleProject] } });
    if (url.pathname.includes('/catalog/'))
      return route.fulfill({
        json: {
          ...exampleProject,
          fullDescription: 'A compact factory mod. No scripts are executed from descriptions.',
        },
      });
    if (url.pathname.includes('/versions/')) return route.fulfill({ json: [exampleVersion] });
    if (url.pathname.endsWith('/inventory')) return route.fulfill({ json: emptyInventory() });
    if (url.pathname.endsWith('/preview') || url.pathname.endsWith('/apply')) {
      requests.push({ path: url.pathname, body: route.request().postDataJSON() });
      return route.fulfill({
        json: url.pathname.endsWith('/preview')
          ? { planId: 'resolved-plan', jobId: 'preview-job' }
          : { jobId: 'durable-job' },
        status: 202,
      });
    }
    if (url.pathname.includes('/plans/'))
      return route.fulfill({
        json: {
          id: 'resolved-plan',
          status: 'ready',
          revision: 0,
          selection: [{ reference: 'Example', version: '1.2.3', enabled: true }],
          vanilla: false,
          lock: { version: 1, mods: {} },
          filesBytes: 4200,
          changes: [
            {
              reference: 'Example',
              action: 'install',
              fromVersion: null,
              toVersion: '1.2.3',
              dependency: false,
              requiredBy: [],
            },
            {
              reference: 'SML',
              action: 'install',
              fromVersion: null,
              toVersion: '3.10.0',
              dependency: true,
              requiredBy: ['Example'],
            },
          ],
        },
      });
    return route.fulfill({ json: emptySnapshot() });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await check(page.getByText('No mods selected.')).toBeVisible();
  await page.getByRole('button', { name: 'Discover', exact: true }).first().click();
  await page.getByRole('searchbox').fill('ab');
  await check(page.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
  await page.getByRole('searchbox').fill('');
  await page
    .getByRole('button', {
      name: 'Example mod A compact factory mod. Factory Tools · Buildings',
      exact: true,
    })
    .click();
  await check(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: `${shots}/satisfactory-mods-version-en.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await check(page.getByRole('dialog')).toHaveCount(0);
  await page
    .getByRole('button', {
      name: 'Example mod A compact factory mod. Factory Tools · Buildings',
      exact: true,
    })
    .click();
  await page
    .getByLabel('Version and game build requirement', { exact: true })
    .selectOption('1.2.3');
  await page.getByRole('button', { name: 'Select version', exact: true }).click();
  await page.screenshot({ path: `${shots}/satisfactory-mods-discover-en.png`, fullPage: true });
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await check(page.getByRole('heading', { name: 'Review changes' })).toBeFocused();
  await check(page.getByText('Required by Example')).toBeVisible();
  await check(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({ path: `${shots}/satisfactory-mods-review-en.png`, fullPage: true });
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await check(page.locator('body')).toHaveAttribute('data-job', 'durable-job');
  expect(requests).toMatchObject([
    {
      body: { selection: [{ reference: 'Example', version: '1.2.3', enabled: true }], revision: 0 },
    },
    { body: { planId: 'resolved-plan', revision: 0 } },
  ]);
  await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}satisfactory-fixture?readonly`);
  await check(page.getByText('Nessuna mod selezionata.')).toBeVisible();
  await check(page.getByText('Puoi consultare le mod, ma non modificarle.')).toBeVisible();
  await page.screenshot({ path: `${shots}/satisfactory-mods-mobile-it.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${shots}/satisfactory-mods-desktop-it.png`, fullPage: true });
  await page.evaluate(() => localStorage.setItem('nh.locale', 'en'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}satisfactory-fixture?readonly`);
  await check(page.getByText('No mods selected.')).toBeVisible();
  await page.screenshot({ path: `${shots}/satisfactory-mods-mobile-en.png`, fullPage: true });
  expect(errors).toEqual([]);
  await context.close();
});

it('connects a write-only token, updates server and advanced options with acknowledgement and supports Italian read-only settings', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let configured = false;
  let option = '4';
  let creativeModeEnabled = false;
  let advancedValue = 'False';
  const mutations: unknown[] = [];
  const readBodies: unknown[] = [];
  const secret = 'fixture-opaque-token-never-returned';
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      mutations.push(body);
      if (path.endsWith('/token')) configured = true;
      if (path.endsWith('/options')) option = body.options['FG.DSAutoPause'];
      if (path.endsWith('/advanced-settings')) {
        creativeModeEnabled = true;
        advancedValue = body.settings['FG.GameRules.NoBuildCost'];
      }
      return route.fulfill({ status: 204 });
    }
    const body = path.endsWith('/state')
      ? {
          activeSessionName: 'Fixture factory',
          numConnectedPlayers: 2,
          playerLimit: 4,
          averageTickRate: 29.5,
          isGameRunning: true,
        }
      : path.endsWith('/options')
        ? {
            serverOptions: {
              'FG.DSAutoPause': option,
              'FG.AutosaveInterval': '300.0',
              'Future.Option': 'unchanged',
            },
            pendingServerOptions: {},
          }
        : path.endsWith('/advanced-settings')
          ? {
              sessionName: 'Factory',
              creativeModeEnabled,
              advancedGameSettings: { 'FG.GameRules.NoBuildCost': advancedValue },
            }
          : { configured };
    readBodies.push(body);
    return route.fulfill({ json: body });
  });
  await page.goto(`${origin}satisfactory-fixture?settings`);
  const token = page.getByLabel('Application token', { exact: true });
  await check(token).toHaveAttribute('type', 'password');
  await check(token).toHaveValue('');
  await page.screenshot({
    path: `${shots}/satisfactory-settings-unconfigured-en.png`,
    fullPage: true,
  });
  await token.fill(secret);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await check(page.getByText('Server API connected.', { exact: true })).toBeVisible();
  await check(token).toHaveValue('');
  await check(page.getByText('Advanced world settings', { exact: true })).toBeVisible();
  const field = page.getByLabel('Pause when no players are connected', { exact: true });
  await check(page.getByLabel('Autosave interval (seconds)', { exact: true })).toHaveValue('300.0');
  await check(page.getByLabel('Future.Option', { exact: true })).toHaveValue('unchanged');
  await field.fill('true');
  await field
    .locator('xpath=ancestor::form')
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await check(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  await check(field).toHaveValue('true');
  const advancedField = page.getByLabel('Build without material costs', { exact: true });
  await advancedField.fill('True');
  const advancedSave = advancedField
    .locator('xpath=ancestor::form')
    .getByRole('button', { name: 'Save changes', exact: true });
  await check(advancedSave).toBeDisabled();
  await page
    .getByLabel('Enable creative mode and apply these settings to the current world')
    .check();
  await advancedSave.click();
  await check(
    page.getByText('Creative mode is enabled for this world.', { exact: true }),
  ).toBeVisible();
  expect(mutations).toEqual([
    { token: secret },
    { options: { 'FG.DSAutoPause': 'true' } },
    {
      settings: { 'FG.GameRules.NoBuildCost': 'True' },
      expectedSessionName: 'Factory',
      confirmEnable: true,
    },
  ]);
  expect(JSON.stringify(readBodies)).not.toContain(secret);
  expect(await page.locator('body').innerText()).not.toContain(secret);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: `${shots}/satisfactory-settings-desktop-en.png`, fullPage: true });
  await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}satisfactory-fixture?settings&readonly`);
  await check(page.getByText('Impostazioni avanzate del mondo', { exact: true })).toBeVisible();
  await check(
    page.getByLabel('Costruisci senza costi di materiali', { exact: true }),
  ).toBeDisabled();
  await check(page.locator('input[type=password]')).toHaveCount(0);
  await check(
    page.getByLabel('Pausa quando non ci sono giocatori connessi', { exact: true }),
  ).toBeDisabled();
  for (const save of await page.getByRole('button', { name: 'Salva modifiche', exact: true }).all())
    await check(save).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: `${shots}/satisfactory-settings-mobile-it.png`, fullPage: true });
  await context.close();
});

it('shows version failures and a usable retry inside the read-only modal', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let failed = true;
  let versionReads = 0;
  const writes: string[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(request.method());
    if (path.endsWith('/catalog'))
      return route.fulfill({
        json: {
          total: 1,
          items: [{ id: 'example', reference: 'Example', name: 'Example mod' }],
        },
      });
    if (path.includes('/versions/')) {
      versionReads++;
      if (failed)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'integration_unavailable',
              messageKey: 'errors.integration_unavailable',
            },
          },
        });
      return route.fulfill({
        json: [{ version: '1.2.3', gameVersion: '>=400000', dependencies: [] }],
      });
    }
    if (path.endsWith('/inventory')) return route.fulfill({ json: emptyInventory() });
    if (path.includes('/catalog/')) return route.fulfill({ json: exampleProject });
    return route.fulfill({ json: emptySnapshot() });
  });
  try {
    await page.goto(`${origin}satisfactory-fixture?readonly`);
    await page.getByRole('button', { name: 'Discover', exact: true }).first().click();
    await page.getByRole('button', { name: 'Example mod', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Example mod' });
    await check(modal.getByRole('alert')).toBeVisible();
    await check(
      modal.getByLabel('Version and game build requirement', { exact: true }),
    ).toHaveCount(0);
    const retry = modal.getByRole('button', { name: 'Try again', exact: true });
    await check(retry).toBeEnabled();
    await retry.focus();
    await check(retry).toBeFocused();
    await page.screenshot({
      path: `${shots}/satisfactory-mods-versions-error-en.png`,
      fullPage: true,
    });
    failed = false;
    const readsBefore = versionReads;
    await page.keyboard.press('Enter');
    await check(modal.getByRole('alert')).toHaveCount(0);
    await check(
      modal.getByLabel('Version and game build requirement', { exact: true }).locator('option'),
    ).toHaveCount(2);
    await check(
      modal.getByLabel('Version and game build requirement', { exact: true }),
    ).toBeDisabled();
    expect(versionReads).toBeGreaterThan(readsBefore);
    expect(writes).toEqual([]);
    await page.keyboard.press('Escape');
    await check(modal).toHaveCount(0);
    await check(page.getByRole('button', { name: 'Example mod', exact: true })).toBeFocused();
  } finally {
    await context.close();
  }
});

it('imports an SMM profile during external management and reconciles before finishing', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let revision = 0,
    externalMode = false,
    diverged = true;
  let profiles: {
    id: string;
    name: string;
    selection: { reference: string; version: string; enabled: boolean }[];
    vanilla: boolean;
  }[] = [];
  let selection: { reference: string; version: string; enabled: boolean }[] = [];
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === 'GET' ? {} : route.request().postDataJSON();
    if (route.request().method() !== 'GET') writes.push({ path, body });
    if (path.endsWith('/external/begin')) {
      externalMode = true;
      revision++;
      return route.fulfill({ json: { externalMode: true, jobId: null } });
    }
    if (path.endsWith('/profiles/import')) {
      profiles = [
        {
          id: 'imported',
          name: 'Shared factory',
          selection: [
            { reference: 'Example', version: '1.2.3', enabled: true },
            { reference: 'Paused', version: '2.0.0', enabled: false },
          ],
          vanilla: false,
        },
      ];
      revision++;
      return route.fulfill({ json: profiles[0] });
    }
    if (path.endsWith('/reconcile')) {
      selection = body.selection;
      diverged = false;
      revision++;
      return route.fulfill({ json: { revision, fingerprint: 'a'.repeat(64) } });
    }
    if (path.endsWith('/external/finish')) {
      externalMode = false;
      revision++;
      return route.fulfill({ json: { externalMode: false } });
    }
    if (path.endsWith('/inventory'))
      return route.fulfill({
        json: {
          ...emptyInventory(),
          diverged,
          items: [
            {
              reference: 'Example',
              name: 'Example mod',
              version: '1.2.3',
              path: 'FactoryGame/Mods/Example',
              managed: true,
              dependency: true,
              gameFeature: false,
            },
          ],
        },
      });
    return route.fulfill({
      json: {
        ...emptySnapshot(),
        revision,
        profiles,
        selection,
        externalMode,
        inventoryFingerprint: !diverged ? 'a'.repeat(64) : null,
      },
    });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await page.getByRole('button', { name: 'Connect Satisfactory Mod Manager', exact: true }).click();
  await page.getByRole('button', { name: 'Stop and enable SMM management', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Switch to SMM management?' });
  await check(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirm
    .getByRole('button', { name: 'Stop and enable SMM management', exact: true })
    .click();
  const smm = page.getByRole('dialog', { name: 'Connect Satisfactory Mod Manager' });
  await check(smm.getByText('The server is stopped. You can now edit with SMM.')).toBeVisible();
  await check(smm.getByRole('button', { name: 'Finish SMM management' })).toBeDisabled();
  await smm.getByRole('button', { name: 'Profiles', exact: true }).click();
  const profileDialog = page.getByRole('dialog', { name: 'Profiles', exact: true });
  await profileDialog.getByLabel('Import SMM profile (.smmprofile)').setInputFiles({
    name: 'factory.smmprofile',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        profile: {
          name: 'Shared factory',
          mods: {
            Example: { version: '1.2.3', enabled: true },
            Paused: { version: '2.0.0', enabled: false },
          },
          required_targets: ['LinuxServer', 'Windows'],
        },
        lockfile: null,
        metadata: { gameVersion: 400001 },
      }),
    ),
  });
  await check(profileDialog.getByText('Shared factory', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/satisfactory-mods-profiles-en.png`, fullPage: true });
  await profileDialog.getByRole('button', { name: 'Load selection', exact: true }).click();
  await page.getByRole('button', { name: 'Adopt inspected files', exact: true }).click();
  const adopt = page.getByRole('dialog', { name: 'Adopt the inspected server files?' });
  await check(adopt.getByText('Paused 2.0.0 · Disabled', { exact: true })).toBeVisible();
  await adopt.getByRole('button', { name: 'Adopt inspected files', exact: true }).click();
  await check(
    page.getByText(
      'Server files differ from the last panel installation. Review external changes before applying another selection.',
    ),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage SMM session', exact: true }).click();
  await check(smm.getByRole('button', { name: 'Finish SMM management' })).toBeEnabled();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({ path: `${shots}/satisfactory-mods-smm-en.png`, fullPage: true });
  await smm.getByRole('button', { name: 'Finish SMM management' }).click();
  await check(smm).toHaveCount(0);
  expect(writes.map((value) => value.path.split('/').slice(-2).join('/'))).toEqual([
    'external/begin',
    'profiles/import',
    'mods/reconcile',
    'external/finish',
  ]);
  expect(writes[2]?.body).toMatchObject({
    revision: 2,
    profileId: 'imported',
    selection: [
      { reference: 'Example', version: '1.2.3', enabled: true },
      { reference: 'Paused', version: '2.0.0', enabled: false },
    ],
  });
  expect(writes[3]?.body).toMatchObject({ revision: 3, inventoryFingerprint: 'a'.repeat(64) });
  await context.close();
});

it('stages updates and disabled choices, keeps failed requests retryable with the same identity', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const previews: Record<string, unknown>[] = [];
  let failPreview = true;
  let latestSelection: unknown[] = [];
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/inventory'))
      return route.fulfill({
        json: {
          ...emptyInventory(),
          items: [
            {
              reference: 'Example',
              name: 'Example mod',
              version: '1.0.0',
              path: 'FactoryGame/Mods/Example',
              managed: true,
              dependency: false,
              gameFeature: false,
            },
            {
              reference: 'SML',
              name: 'Satisfactory Mod Loader',
              version: '3.10.0',
              path: 'FactoryGame/Mods/SML',
              managed: true,
              dependency: true,
              gameFeature: false,
            },
          ],
        },
      });
    if (path.endsWith('/updates'))
      return route.fulfill({
        json: { items: [{ reference: 'Example', currentVersion: '1.0.0', version: '1.2.3' }] },
      });
    if (path.endsWith('/preview')) {
      const input = route.request().postDataJSON();
      previews.push(input);
      latestSelection = input.selection;
      if (failPreview) {
        failPreview = false;
        return route.abort('failed');
      }
      return route.fulfill({ status: 202, json: { planId: 'retry-plan', jobId: 'retry-preview' } });
    }
    if (path.includes('/plans/'))
      return route.fulfill({
        json: {
          id: 'retry-plan',
          status: 'ready',
          revision: 3,
          selection: latestSelection,
          vanilla: false,
          lock: { version: 1, mods: {} },
          changes: [
            {
              reference: 'Example',
              action: 'disable',
              fromVersion: '1.0.0',
              toVersion: '1.2.3',
              dependency: false,
              requiredBy: [],
            },
          ],
          filesBytes: 0,
        },
      });
    return route.fulfill({
      json: {
        ...emptySnapshot(),
        revision: 3,
        selection: [{ reference: 'Example', version: '1.0.0', enabled: true }],
      },
    });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await page.getByRole('button', { name: 'Check updates', exact: true }).click();
  await page.getByRole('button', { name: 'Select all updates', exact: true }).click();
  await check.poll(() => previews.length).toBe(1);
  await page.getByRole('button', { name: 'Disable Example mod', exact: true }).click();
  const controlBottoms = await page
    .locator('.mods-search-toolbar')
    .evaluate((toolbar) =>
      [...toolbar.querySelectorAll('.workspace-search, select, :scope > button')].map(
        (control) => control.getBoundingClientRect().bottom,
      ),
    );
  expect(Math.max(...controlBottoms) - Math.min(...controlBottoms)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${shots}/satisfactory-mods-installed-en.png`, fullPage: true });
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await check(
    page.getByText(
      'Preparation could not be confirmed. Retry to recover the request; you can still change your selection.',
    ),
  ).toBeVisible();
  await check(page.getByRole('button', { name: 'Discard selection changes' })).toBeEnabled();
  await page.screenshot({ path: `${shots}/satisfactory-mods-uncertain-en.png`, fullPage: true });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await check(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
  expect(previews).toHaveLength(3);
  expect(previews[0]).toEqual(previews[1]);
  expect(previews[0]).toMatchObject({
    selection: [{ reference: 'Example', version: '1.2.3', enabled: true }],
  });
  expect(previews[2]).toMatchObject({
    selection: [{ reference: 'Example', version: '1.2.3', enabled: false }],
  });
  await check(page.getByText('No mod file changes are required.', { exact: true })).toHaveCount(0);
  await context.close();
});

it('preserves SMM targets when renaming, exports a native profile, and confirms rollback', async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const selection = [{ reference: 'Example', version: '1.2.3', enabled: true }];
  let revision = 4;
  const profiles = [
    {
      id: 'shared',
      name: 'Shared factory',
      selection,
      vanilla: false,
      requiredTargets: ['Windows', 'LinuxServer'],
    },
  ];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') {
      const body = route.request().postDataJSON();
      writes.push({ path, body });
      if (path.endsWith('/profiles/shared')) {
        profiles[0] = { ...profiles[0], ...body };
        revision++;
        return route.fulfill({ json: profiles[0] });
      }
      if (path.endsWith('/rollback'))
        return route.fulfill({ status: 202, json: { jobId: 'rollback-job' } });
    }
    if (path.endsWith('/inventory')) return route.fulfill({ json: emptyInventory() });
    if (path.endsWith('/export'))
      return route.fulfill({
        json: {
          profile: {
            name: profiles[0]?.name,
            mods: { Example: { version: '1.2.3', enabled: true } },
            required_targets: profiles[0]?.requiredTargets,
          },
          lockfile: { version: 1, mods: {} },
          metadata: { gameVersion: 400001 },
        },
      });
    return route.fulfill({
      json: { ...emptySnapshot(), revision, selection, profiles, rollbackAvailable: true },
    });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  const profilesDialog = page.getByRole('dialog', { name: 'Profiles', exact: true });
  await profilesDialog.getByRole('button', { name: 'Edit profile Shared factory' }).click();
  await check(
    profilesDialog.getByRole('checkbox', { name: 'Also resolve for Windows players' }),
  ).toBeChecked();
  await profilesDialog.getByRole('textbox', { name: 'Profile name' }).fill('Team factory');
  await profilesDialog.getByRole('button', { name: 'Save profile', exact: true }).click();
  await check(profilesDialog.getByText('Team factory', { exact: true })).toBeVisible();
  expect(writes[0]?.body).toMatchObject({
    selection,
    requiredTargets: ['LinuxServer', 'Windows'],
    name: 'Team factory',
  });
  const downloadPromise = page.waitForEvent('download');
  await profilesDialog.getByRole('button', { name: 'Export Team factory for SMM' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Team_factory.smmprofile');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Restore previous mod set', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Restore the previous mod set?' });
  await check(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirm.getByRole('button', { name: 'Restore previous mod set', exact: true }).click();
  await check(page.locator('body')).toHaveAttribute('data-job', 'rollback-job');
  expect(writes[1]?.body).toMatchObject({ revision: 5 });
  await context.close();
});

it('requires explicit reconciliation even when an external SMM session changed no files', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let reconciled = false;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/inventory')) return route.fulfill({ json: emptyInventory() });
    if (path.endsWith('/reconcile')) {
      reconciled = true;
      return route.fulfill({ json: { revision: 2 } });
    }
    return route.fulfill({
      json: {
        ...emptySnapshot(),
        externalMode: true,
        revision: reconciled ? 2 : 1,
        inventoryFingerprint: reconciled ? 'a'.repeat(64) : null,
      },
    });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await page.getByRole('button', { name: 'Manage SMM session', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Satisfactory Mod Manager' });
  await check(dialog.getByRole('button', { name: 'Finish SMM management' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Adopt inspected files' }).click();
  await page
    .getByRole('dialog', { name: 'Adopt the inspected server files?' })
    .getByRole('button', { name: 'Adopt inspected files' })
    .click();
  await check(dialog.getByRole('button', { name: 'Finish SMM management' })).toBeEnabled();
  await context.close();
});

it('keeps SMM edits blocked during stop, and preserves a running-server draft with console navigation', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const mutations: string[] = [];
  let external = true;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') mutations.push(path);
    if (path.endsWith('/operations'))
      return route.fulfill({
        status: 202,
        json: { jobId: 'stop-job', serverId: '10000000-0000-4000-8000-000000000001' },
      });
    if (path.endsWith('/inventory'))
      return route.fulfill({
        json: {
          ...emptyInventory(),
          items: [
            {
              reference: 'Example',
              name: 'Example mod',
              version: '1.2.3',
              path: 'FactoryGame/Mods/Example',
              managed: true,
              dependency: false,
              gameFeature: false,
            },
          ],
        },
      });
    return route.fulfill({
      json: {
        ...emptySnapshot(),
        externalMode: external,
        selection: [{ reference: 'Example', version: '1.2.3', enabled: true }],
      },
    });
  });
  await page.goto(`${origin}satisfactory-fixture?pending`);
  await page.getByRole('button', { name: 'Manage SMM session' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Satisfactory Mod Manager' });
  await check(
    dialog.getByText('Wait for the server to stop before changing files with SMM.'),
  ).toBeVisible();
  await check(dialog.getByRole('button', { name: 'Adopt inspected files' })).toBeDisabled();
  await check(dialog.getByRole('button', { name: 'Finish SMM management' })).toBeDisabled();
  await page.screenshot({ path: `${shots}/satisfactory-mods-stopping-en.png`, fullPage: true });
  external = false;
  await page.goto(`${origin}satisfactory-fixture?running`);
  await page.getByRole('button', { name: 'Disable Example mod' }).click();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await check(page.getByText('Stop the server before applying this plan.')).toBeVisible();
  await check(page.getByRole('link', { name: 'Open console' })).toHaveAttribute(
    'href',
    '/servers/10000000-0000-4000-8000-000000000001/console',
  );
  await check(page.getByRole('button', { name: 'Resolve changes', exact: true })).toBeDisabled();
  expect(mutations).toEqual([]);
  await page.screenshot({
    path: `${shots}/satisfactory-mods-running-blocked-en.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Stop server', exact: true }).click();
  const stop = page.getByRole('dialog', { name: 'Save and stop the server?' });
  await check(stop.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await stop.getByRole('button', { name: 'Stop server', exact: true }).click();
  await check(page.locator('body')).toHaveAttribute('data-job', 'stop-job');
  await check(page.getByText('Selection has unapplied changes.', { exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}satisfactory-fixture?readonly`);
  await check(page.getByRole('button', { name: 'Example mod', exact: true })).toBeVisible();
  await page.screenshot({
    path: `${shots}/satisfactory-mods-installed-mobile-it.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await context.close();
});

it('loads imported minimum-version constraints and submits explicit version policies', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const previews: unknown[] = [];
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/inventory'))
      return route.fulfill({
        json: {
          ...emptyInventory(),
          items: [
            {
              reference: 'Example',
              name: 'Example mod',
              version: '1.2.3',
              path: 'FactoryGame/Mods/Example',
              managed: true,
              dependency: false,
              gameFeature: false,
            },
          ],
        },
      });
    if (path.includes('/catalog/')) return route.fulfill({ json: exampleProject });
    if (path.includes('/versions/')) return route.fulfill({ json: [exampleVersion] });
    if (path.endsWith('/preview')) {
      previews.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: { jobId: 'constraints-job', planId: 'constraints-plan' },
      });
    }
    if (path.includes('/plans/'))
      return route.fulfill({
        json: {
          id: 'constraints-plan',
          status: 'ready',
          revision: 0,
          selection: [{ reference: 'Example', version: '1.2.3', enabled: true }],
          vanilla: false,
          lock: { version: 1, mods: {} },
          changes: [],
          filesBytes: 0,
        },
      });
    return route.fulfill({
      json: {
        ...emptySnapshot(),
        selection: [{ reference: 'Example', version: '>=1.2.3', enabled: true }],
      },
    });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await page.getByRole('button', { name: 'Change version of Example mod' }).click();
  const dialog = page.getByRole('dialog', { name: 'Example mod' });
  await check(dialog.getByLabel('Version and game build requirement', { exact: true })).toHaveValue(
    '1.2.3',
  );
  await check(dialog.getByLabel('Version policy', { exact: true })).toHaveValue('minimum');
  await dialog.getByLabel('Version policy', { exact: true }).selectOption('exact');
  await dialog.getByRole('button', { name: 'Select version', exact: true }).click();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await check(page.getByText('No mod file changes are required.', { exact: true })).toBeVisible();
  expect(previews).toMatchObject([
    { selection: [{ reference: 'Example', version: '1.2.3', enabled: true }] },
  ]);
  await context.close();
});

it('selects multiple mods with leading checkboxes and latest compatible minimum versions', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const previews: { selection: unknown[] }[] = [];
  let finish = false;
  let versionRequests = 0;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/catalog'))
      return route.fulfill({
        json: {
          total: 2,
          items: [
            exampleProject,
            { ...exampleProject, id: 'second', reference: 'Second', name: 'Second mod' },
          ],
        },
      });
    if (path.includes('/versions/')) {
      versionRequests++;
      return route.fulfill({
        json: [
          { ...exampleVersion, version: '3.0.0', compatibility: 'incompatible' },
          { ...exampleVersion, version: '2.0.0' },
          exampleVersion,
        ],
      });
    }
    if (path.endsWith('/inventory')) return route.fulfill({ json: emptyInventory() });
    if (path.endsWith('/preview')) {
      previews.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { jobId: 'multi-job', planId: 'multi-plan' } });
    }
    if (path.includes('/plans/'))
      return route.fulfill({
        json: {
          id: 'multi-plan',
          status: finish ? 'ready' : 'pending',
          revision: 0,
          selection: previews.at(-1)?.selection,
          changes: [],
          lock: { version: 1, mods: {} },
          filesBytes: 0,
        },
      });
    return route.fulfill({ json: emptySnapshot() });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await page.getByRole('button', { name: 'Discover', exact: true }).first().click();
  const first = page.getByRole('checkbox', { name: 'Select Example mod', exact: true });
  const second = page.getByRole('checkbox', { name: 'Select Second mod', exact: true });
  await first.hover();
  await first.focus();
  await page.waitForTimeout(200);
  expect(versionRequests).toBe(0);
  await first.click();
  await check(first).toBeChecked();
  await second.click();
  await check(second).toBeChecked();
  await check(first).toBeChecked();
  await check(page.getByRole('dialog')).toHaveCount(0);
  await first.uncheck();
  await check(first).not.toBeChecked();
  await check(second).toBeChecked();
  await first.click();
  await check(first).toBeChecked();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const position = await page
      .locator('.mods-project')
      .first()
      .evaluate((row) => {
        const checkbox = row.querySelector('.mods-checkbox')?.getBoundingClientRect();
        const artwork = row.querySelector('.mods-artwork')?.getBoundingClientRect();
        if (!checkbox || !artwork) throw new Error('Missing mod selection controls');
        return { checkboxRight: checkbox.right, artworkLeft: artwork.left };
      });
    expect(position.checkboxRight).toBeLessThanOrEqual(position.artworkLeft);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `${shots}/satisfactory-mods-multiselect-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  expect(previews).toHaveLength(1);
  finish = true;
  await check.poll(() => previews.length).toBe(2);
  await check(page.locator('body')).not.toHaveAttribute('data-job', 'multi-job');
  expect(previews.at(-1)).toMatchObject({
    selection: [
      { reference: 'Example', version: '>=2.0.0', enabled: true },
      { reference: 'Second', version: '>=2.0.0', enabled: true },
    ],
  });
  await context.close();
});

it('prepares incrementally, keeps editing responsive and opens the matching ready review without another request', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const inputs: {
    selection: { reference: string; version: string }[];
    refreshMetadata?: boolean;
  }[] = [];
  let finishFirst = false;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/inventory')) return route.fulfill({ json: emptyInventory() });
    if (path.endsWith('/catalog'))
      return route.fulfill({
        json: {
          total: 2,
          items: [
            exampleProject,
            { ...exampleProject, id: 'second', reference: 'Second', name: 'Second mod' },
          ],
        },
      });
    if (path.includes('/versions/')) return route.fulfill({ json: [exampleVersion] });
    if (path.endsWith('/preview')) {
      inputs.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: {
          jobId: `incremental-job-${inputs.length}`,
          planId: `incremental-plan-${inputs.length}`,
        },
      });
    }
    if (path.includes('/plans/')) {
      const index = Number(path.split('-').at(-1)) - 1;
      const selected = inputs[index];
      if (!selected) throw new Error('Unknown preview request');
      return route.fulfill({
        json: {
          id: `incremental-plan-${index + 1}`,
          status: index === 0 && !finishFirst ? 'pending' : 'ready',
          phase: index === 0 && !finishFirst ? 'preparing' : 'ready',
          revision: 0,
          selection: selected.selection,
          vanilla: false,
          lock: { version: 1, mods: {} },
          filesBytes: 100,
          changes: selected.selection.map((mod) => ({
            reference: mod.reference,
            action: 'install',
            toVersion: '1.2.3',
            dependency: false,
          })),
        },
      });
    }
    return route.fulfill({ json: emptySnapshot() });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await page.getByRole('button', { name: 'Discover', exact: true }).first().click();
  await page.getByRole('checkbox', { name: 'Select Example mod' }).click();
  await check.poll(() => inputs.length).toBe(1);
  await check(page.getByRole('checkbox', { name: 'Select Second mod' })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Select Second mod' }).click();
  await check(page.getByRole('checkbox', { name: 'Select Second mod' })).toBeChecked();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await check(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeDisabled();
  expect(inputs).toHaveLength(1);
  finishFirst = true;
  await check.poll(() => inputs.length).toBe(2);
  await check(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
  expect(inputs[1]?.selection).toMatchObject([
    { reference: 'Example', version: '>=1.2.3' },
    { reference: 'Second', version: '>=1.2.3' },
  ]);
  await check(page.locator('.satisfactory-review-row')).toHaveCount(2);
  await check(page.locator('body')).not.toHaveAttribute('data-job');
  await page.getByRole('button', { name: 'Back to discovery', exact: true }).click();
  const localReviewMs = await page.evaluate(async () => {
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === 'Review changes',
    );
    if (!button) throw new Error('Review button missing');
    const started = performance.now();
    button.click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return performance.now() - started;
  });
  expect(localReviewMs).toBeLessThan(300);
  await writeFile(
    `${shots}/satisfactory-mods-incremental-timing.json`,
    JSON.stringify({ localReviewMs, previewRequests: inputs.length }),
  );
  await check(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
  expect(inputs).toHaveLength(2);
  await page.screenshot({
    path: `${shots}/satisfactory-mods-incremental-ready-en.png`,
    fullPage: true,
  });
  expect(inputs[0]?.refreshMetadata).toBeUndefined();
  await page.getByRole('button', { name: 'Resolve again', exact: true }).click();
  await check.poll(() => inputs.length).toBe(3);
  expect(inputs[2]?.refreshMetadata).toBe(true);
  await context.close();
});

it('revalidates a returned cached draft and replaces an evicted plan before allowing apply', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const previews: {
    idempotencyKey: string;
    selection: { reference: string; version: string }[];
  }[] = [];
  const applies: { planId: string }[] = [];
  let evictFirst = false,
    finishThird = false;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/inventory')) return route.fulfill({ json: emptyInventory() });
    if (path.endsWith('/catalog'))
      return route.fulfill({
        json: {
          total: 2,
          items: [
            exampleProject,
            { ...exampleProject, id: 'second', reference: 'Second', name: 'Second mod' },
          ],
        },
      });
    if (path.includes('/versions/')) return route.fulfill({ json: [exampleVersion] });
    if (path.endsWith('/preview')) {
      previews.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: { planId: `cached-${previews.length}`, jobId: `job-${previews.length}` },
      });
    }
    if (path.includes('/plans/')) {
      const number = Number(path.split('-').at(-1));
      if (number === 1 && evictFirst)
        return route.fulfill({
          status: 404,
          json: { error: { code: 'not_found', messageKey: 'errors.not_found' } },
        });
      const input = previews[number - 1];
      if (!input) throw new Error('Unknown plan');
      return route.fulfill({
        json: {
          id: `cached-${number}`,
          status: number === 3 && !finishThird ? 'pending' : 'ready',
          revision: 0,
          selection: input.selection,
          vanilla: false,
          lock: { version: 1, mods: {} },
          filesBytes: 0,
          changes: [],
        },
      });
    }
    if (path.endsWith('/apply')) {
      applies.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { jobId: 'apply-new-plan' } });
    }
    return route.fulfill({ json: emptySnapshot() });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await page.getByRole('button', { name: 'Discover', exact: true }).first().click();
  await page.getByRole('checkbox', { name: 'Select Example mod' }).click();
  await check(
    page.getByText('Selection prepared. Review the changes before applying.'),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Second mod' }).click();
  await check.poll(() => previews.length).toBe(2);
  await check(
    page.getByText('Selection prepared. Review the changes before applying.'),
  ).toBeVisible();
  evictFirst = true;
  await page.getByRole('checkbox', { name: 'Select Second mod' }).uncheck();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await check.poll(() => previews.length).toBe(3);
  await check(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeDisabled();
  expect(previews[2]?.idempotencyKey).not.toBe(previews[0]?.idempotencyKey);
  expect(applies).toEqual([]);
  finishThird = true;
  await check(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await check.poll(() => applies).toEqual([expect.objectContaining({ planId: 'cached-3' })]);
  await context.close();
});

it('bounds concurrent checkbox recommendations and coalesces a batch without resurrecting cancelled selections', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const releases = new Map<string, () => Promise<void>>();
  const requests: string[] = [];
  const previews: { selection: { reference: string }[] }[] = [];
  let inventoryReads = 0;
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/catalog'))
      return route.fulfill({
        json: {
          total: 8,
          items: Array.from({ length: 8 }, (_, index) => ({
            ...exampleProject,
            id: `mod${index}`,
            reference: `Mod${index}`,
            name: `Mod ${index}`,
          })),
        },
      });
    if (path.includes('/versions/')) {
      expect(url.searchParams.get('recommendation')).toBe('true');
      const reference = path.split('/').at(-1)!;
      requests.push(reference);
      releases.set(reference, () => route.fulfill({ json: [exampleVersion] }));
      return;
    }
    if (path.endsWith('/inventory')) {
      inventoryReads++;
      return route.fulfill({ json: emptyInventory() });
    }
    if (path.endsWith('/preview')) {
      previews.push(route.request().postDataJSON());
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent('fixture-pending', { detail: true })),
      );
      return route.fulfill({ status: 202, json: { jobId: 'batch-job', planId: 'batch-plan' } });
    }
    if (path.includes('/plans/'))
      return route.fulfill({
        json: {
          id: 'batch-plan',
          status: 'ready',
          revision: 0,
          selection: previews.at(-1)?.selection,
          changes: [],
          vanilla: false,
          lock: { version: 1, mods: {} },
          filesBytes: 0,
        },
      });
    return route.fulfill({ json: emptySnapshot() });
  });
  await page.goto(`${origin}satisfactory-fixture`);
  await page.getByRole('button', { name: 'Discover', exact: true }).first().click();
  for (let index = 0; index < 8; index++) {
    const checkbox = page.getByRole('checkbox', { name: `Select Mod ${index}`, exact: true });
    await checkbox.check();
    await check(checkbox).toBeChecked();
  }
  expect(requests).toHaveLength(4);
  expect(previews).toHaveLength(0);
  await page.getByRole('checkbox', { name: 'Select Mod 7', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Select Mod 0', exact: true }).uncheck();
  for (const reference of ['Mod3', 'Mod2', 'Mod1', 'Mod0'])
    await releases.get(reference)!().catch(() => {});
  await check.poll(() => requests.length).toBe(7);
  for (const reference of ['Mod6', 'Mod5', 'Mod4'])
    await releases.get(reference)!().catch(() => {});
  await check.poll(() => previews.length).toBe(1);
  expect(previews[0]?.selection.map((mod) => mod.reference).sort()).toEqual(
    Array.from({ length: 6 }, (_, index) => `Mod${index + 1}`),
  );
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture-pending', { detail: false })),
  );
  await check(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
  expect(inventoryReads).toBe(1);
  expect(requests).not.toContain('Mod7');
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture-pending', { detail: true })),
  );
  await check(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeDisabled();
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture-pending', { detail: false })),
  );
  await check.poll(() => inventoryReads).toBe(2);
  await context.close();
});

it('keeps advanced edits bound to their original world and avoids native reads while offline', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let sessionName = 'Original';
  const reads: string[] = [];
  let writes = 0;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') {
      writes++;
      return route.fulfill({ status: 204 });
    }
    reads.push(path);
    return route.fulfill({
      json: path.endsWith('/advanced-settings')
        ? {
            sessionName,
            creativeModeEnabled: true,
            advancedGameSettings: { 'FG.GameRules.NoBuildCost': 'False' },
          }
        : path.endsWith('/options')
          ? { serverOptions: {}, pendingServerOptions: {} }
          : { configured: true },
    });
  });
  await page.goto(`${origin}satisfactory-fixture?settings`);
  const field = page.getByLabel('Build without material costs', { exact: true });
  await field.fill('True');
  sessionName = 'Another world';
  await page.evaluate(
    "import('/src/api/client.ts').then(({queryClient}) => queryClient.invalidateQueries({queryKey: ['satisfactory-advanced-settings']}))",
  );
  await check(
    page.getByText('The active world changed. Cancel these edits before changing the new world.', {
      exact: true,
    }),
  ).toBeVisible();
  await check(
    field
      .locator('xpath=ancestor::form')
      .getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await field
    .locator('xpath=ancestor::form')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  expect(writes).toBe(0);
  reads.length = 0;
  await page.goto(`${origin}satisfactory-fixture?settings&offline`);
  await check(
    page.getByText('Start the server to connect its API or edit settings.', { exact: true }),
  ).toBeVisible();
  expect(
    reads.every((path) => !path.endsWith('/options') && !path.endsWith('/advanced-settings')),
  ).toBe(true);
  await context.close();
});

it('replaces a rejected saved token and reports connected only after fresh native settings succeed', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let replacementAccepted = false;
  let releaseNative: (() => void) | undefined;
  const nativeReady = new Promise<void>((resolve) => {
    releaseNative = resolve;
  });
  const reads = { options: 0, advanced: 0 };
  const writes: unknown[] = [];
  const rejected = {
    error: { code: 'game_authentication_failed', messageKey: 'errors.game_authentication_failed' },
  };
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/token')) {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.token !== 'replacement-fixture-token')
        return route.fulfill({ status: 409, json: rejected });
      replacementAccepted = true;
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith('/options') || path.endsWith('/advanced-settings')) {
      const advanced = path.endsWith('/advanced-settings');
      reads[advanced ? 'advanced' : 'options']++;
      if (!replacementAccepted) return route.fulfill({ status: 409, json: rejected });
      await nativeReady;
      return route.fulfill({
        json: advanced
          ? {
              sessionName: 'Factory',
              creativeModeEnabled: false,
              advancedGameSettings: { 'FG.GameRules.NoBuildCost': 'False' },
            }
          : { serverOptions: { 'FG.AutosaveInterval': '600' }, pendingServerOptions: {} },
      });
    }
    return route.fulfill({ json: { configured: true } });
  });
  try {
    await page.goto(`${origin}satisfactory-fixture?settings`);
    await check(page.getByRole('alert')).toContainText(
      'The game rejected these credentials. Check the password or reconnect its API in Settings.',
    );
    await check(page.getByText('Server API connected.', { exact: true })).toHaveCount(0);
    await check(page.getByText('API credentials saved.', { exact: true })).toBeVisible();
    const token = page.getByLabel('Application token', { exact: true });
    const save = token
      .locator('xpath=ancestor::form')
      .getByRole('button', { name: 'Save changes', exact: true });
    await token.fill('rejected-fixture-token');
    await save.click();
    await check(token).toHaveValue('rejected-fixture-token');
    await check(page.getByRole('alert')).toContainText('The game rejected these credentials.');
    await token.fill('replacement-fixture-token');
    await save.click();
    await check.poll(() => reads).toEqual({ options: 2, advanced: 2 });
    await check(page.getByText('Server API connected.', { exact: true })).toHaveCount(0);
    releaseNative?.();
    await check(page.getByText('Server API connected.', { exact: true })).toBeVisible();
    await check(page.getByLabel('Autosave interval (seconds)', { exact: true })).toHaveValue('600');
    await check(token).toHaveValue('');
    await check(page.getByRole('alert')).toHaveCount(0);
    expect(writes).toEqual([
      { token: 'rejected-fixture-token' },
      { token: 'replacement-fixture-token' },
    ]);
  } finally {
    releaseNative?.();
    await context.close();
  }
});
