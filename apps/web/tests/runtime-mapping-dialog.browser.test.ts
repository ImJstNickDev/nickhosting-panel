import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  expect as check,
  firefox,
  type Page,
} from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { minecraftManifest } from '../../../games/minecraft/src/index.js';

describe('runtime mapping dialog (real Firefox, isolated provider discovery)', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let mappings: Record<string, unknown>[], writes: Record<string, unknown>[], errors: string[];
  let nests: Array<{ id: number; name: string }>;
  const existing = {
    id: 'mapping-one',
    game_id: 'minecraft',
    runtime_id: 'vanilla',
    node_id: 'node-one',
    nest_id: 1,
    egg_id: 2,
    docker_image: '',
    image_mode: 'integration',
    startup: 'java -Xmx2G -jar custom.jar',
    environment: { SERVER_JARFILE: 'custom.jar' },
    port_roles: [{ role: 'game', protocols: ['tcp'], primary: true }],
    feature_limits: { databases: 0, allocations: 1, backups: 2 },
    enabled: true,
    inUse: false,
  };
  const eggs = {
    '1': [
      {
        id: 2,
        name: 'Vanilla server',
        docker_image: 'registry.example.test/java:25',
        docker_images: {
          'Java 25': 'registry.example.test/java:25',
          'Java 21': 'registry.example.test/java:21',
        },
        startup: 'java -jar {{SERVER_JARFILE}}',
        relationships: {
          variables: {
            data: [{ attributes: { env_variable: 'SERVER_JARFILE', default_value: 'server.jar' } }],
          },
        },
      },
    ],
    '3': [
      {
        id: 4,
        name: 'Alternative server',
        docker_image: 'registry.example.test/java:21',
        startup: 'java -jar alternative.jar',
        relationships: {
          variables: {
            data: [{ attributes: { env_variable: 'VERSION', default_value: '1.21.11' } }],
          },
        },
      },
    ],
  };
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/runtime-mapping-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await vite.listen();
    origin = vite.resolvedUrls?.local[0] ?? '';
    browser = await firefox.launch({
      headless: true,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
      },
    });
    await mkdir('.codex/local/m5-browser/screenshots', { recursive: true });
  });
  beforeEach(async () => {
    mappings = [];
    writes = [];
    errors = [];
    nests = [{ id: 1, name: 'Minecraft' }];
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
    });
    await page.route('**/owner/integrations**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Runtime mappings</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/owner-integration-workspace.tsx"></script></body></html>',
      }),
    );
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const response = (json: unknown) => route.fulfill({ json });
      if (path === '/v1/owner/game-modules')
        return response([{ id: 'minecraft', manifest: minecraftManifest }]);
      if (path === '/v1/platform/owner/games')
        return response([
          { id: 'minecraft', state: 'public', allowlist: [], manifest: minecraftManifest },
        ]);
      if (path === '/v1/owner/runtime-mappings') {
        if (method === 'GET') return response(mappings);
        writes.push(route.request().postDataJSON());
        return response({});
      }
      if (path === '/v1/owner/nodes') return response([{ id: 'node-one', pterodactyl_node_id: 7 }]);
      if (path === '/v1/owner/infrastructure')
        return response({ nodes: [{ id: 7, name: 'Game node' }], nests });
      const nest = /^\/v1\/owner\/nests\/(\d+)\/eggs$/.exec(path)?.[1];
      if (nest) return response(eggs[nest as keyof typeof eggs] ?? []);
      errors.push(`Unexpected API ${method} ${path}`);
      return route.fulfill({ status: 404, json: { code: 'not_found' } });
    });
  });
  afterEach(async () => {
    await context.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  async function openCreate() {
    await page.goto(`${origin}owner/integrations/minecraft/runtime`);
    await page
      .getByRole('button', { name: /Add runtime mapping|Associate egg/, exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Associate egg', exact: true });
    await check(dialog.getByLabel('Pterodactyl node', { exact: true })).toHaveValue('node-one');
    await check(dialog.getByLabel('Nest', { exact: true })).toHaveValue('1');
    await dialog.getByLabel('Egg', { exact: true }).selectOption('2');
    return dialog;
  }
  it('creates a mapping with fixed runtime context and inherited egg defaults', async () => {
    const dialog = await openCreate();
    await check(dialog.getByRole('combobox', { name: 'Runtime', exact: true })).toHaveCount(0);
    await check(
      dialog.locator('.mapping-runtime-context').getByText('Vanilla', { exact: true }),
    ).toBeVisible();
    await check(
      dialog.getByRole('button', { name: 'Defined by integration', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await check(dialog.getByLabel('Available for new servers', { exact: true })).toBeChecked();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/runtime-mapping-desktop-en.png',
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await dialog.getByRole('button', { name: 'Create mapping', exact: true }).click();
    await check(dialog).not.toBeVisible();
    expect(writes).toEqual([
      {
        gameId: 'minecraft',
        runtimeId: 'vanilla',
        nodeId: 'node-one',
        nestId: 1,
        eggId: 2,
        imageMode: 'integration',
        startup: 'java -jar {{SERVER_JARFILE}}',
        environment: { SERVER_JARFILE: 'server.jar' },
        portRoles: [{ role: 'game', protocols: ['tcp'], primary: true }],
        featureLimits: { databases: 0, allocations: 1, backups: 1 },
        enabled: true,
      },
    ]);
  });
  it('clears egg-dependent values when the nest changes and submits the selected fixed image', async () => {
    nests.push({ id: 3, name: 'Alternative nest' });
    await page.goto(`${origin}owner/integrations/minecraft/runtime`);
    await page
      .getByRole('button', { name: /Add runtime mapping|Associate egg/, exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Nest', { exact: true }).selectOption('1');
    await dialog.getByLabel('Egg', { exact: true }).selectOption('2');
    await dialog.getByRole('button', { name: 'Fixed image', exact: true }).click();
    await dialog
      .getByRole('combobox', { name: 'Container image', exact: true })
      .selectOption('registry.example.test/java:21');
    await dialog.getByLabel('Nest', { exact: true }).selectOption('3');
    await check(dialog.getByLabel('Egg', { exact: true })).toHaveValue('');
    await check(dialog.getByLabel('Startup command', { exact: true })).toHaveValue('');
    await check(dialog.getByLabel(/^Variable name \d+$/)).toHaveCount(0);
    await dialog.getByLabel('Egg', { exact: true }).selectOption('4');
    await check(dialog.getByLabel('Startup command', { exact: true })).toHaveValue(
      'java -jar alternative.jar',
    );
    await dialog.getByRole('button', { name: 'Create mapping', exact: true }).click();
    await check(dialog).not.toBeVisible();
    expect(writes[0]).toMatchObject({
      nestId: 3,
      eggId: 4,
      imageMode: 'static',
      dockerImage: 'registry.example.test/java:21',
      environment: { VERSION: '1.21.11' },
      startup: 'java -jar alternative.jar',
    });
  });
  it('expands hidden invalid fields and focuses them before submitting', async () => {
    const dialog = await openCreate();
    const startup = dialog
      .locator('details')
      .filter({ has: page.locator('summary').filter({ hasText: /^Startup/ }) });
    await startup.locator('summary').click();
    await dialog.getByLabel('Startup command', { exact: true }).fill('');
    await startup.locator('summary').click();
    await dialog.getByRole('button', { name: 'Create mapping', exact: true }).click();
    await check(startup).toHaveAttribute('open', '');
    await check(dialog.getByLabel('Startup command', { exact: true })).toBeFocused();
    expect(writes).toEqual([]);
    await dialog.getByLabel('Startup command', { exact: true }).fill('java -jar server.jar');
    const variables = dialog
      .locator('details')
      .filter({ has: page.locator('summary').filter({ hasText: /^Variables/ }) });
    await variables.locator('summary').click();
    await dialog.getByRole('button', { name: 'Add variable', exact: true }).click();
    await variables.locator('summary').click();
    await dialog.getByRole('button', { name: 'Create mapping', exact: true }).click();
    await check(variables).toHaveAttribute('open', '');
    await check(dialog.getByLabel(/^Variable name \d+$/).last()).toBeFocused();
    expect(writes).toEqual([]);
    await dialog.getByRole('button', { name: 'Remove variable 2', exact: true }).click();
    await dialog.getByRole('button', { name: 'Create mapping', exact: true }).click();
    await check(dialog).not.toBeVisible();
    expect(writes).toHaveLength(1);
  });
  it('edits unused mappings without overwriting saved startup, variables or limits', async () => {
    mappings = [{ ...existing }];
    await page.goto(`${origin}owner/integrations/minecraft/runtime`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await check(dialog.getByLabel('Pterodactyl node', { exact: true })).toBeEnabled();
    await check(dialog.getByLabel('Startup command', { exact: true })).toHaveValue(
      existing.startup,
    );
    await dialog.getByRole('button', { name: 'Fixed image', exact: true }).click();
    await dialog
      .getByRole('combobox', { name: 'Container image', exact: true })
      .selectOption('registry.example.test/java:25');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check(dialog).not.toBeVisible();
    expect(writes[0]).toMatchObject({
      id: existing.id,
      runtimeId: 'vanilla',
      startup: existing.startup,
      environment: existing.environment,
      featureLimits: existing.feature_limits,
      imageMode: 'static',
      dockerImage: 'registry.example.test/java:25',
    });
  });
  it('drops an old mapping image and port variable after choosing another egg', async () => {
    mappings = [
      {
        ...existing,
        image_mode: 'static',
        docker_image: 'registry.example.test/old-custom:8',
        port_roles: [
          { role: 'game', protocols: ['tcp'], primary: true, environmentVariable: 'OLD_PORT' },
        ],
      },
    ];
    nests.push({ id: 3, name: 'Alternative nest' });
    await page.goto(`${origin}owner/integrations/minecraft/runtime`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const image = dialog.getByRole('combobox', { name: 'Container image', exact: true });
    await check(image).toHaveValue('registry.example.test/old-custom:8');
    await dialog.getByLabel('Nest', { exact: true }).selectOption('3');
    await dialog.getByLabel('Egg', { exact: true }).selectOption('4');
    await check(image).toHaveValue('registry.example.test/java:21');
    await check(image.locator('option[value="registry.example.test/old-custom:8"]')).toHaveCount(0);
    await check(dialog.getByLabel('Port environment variable', { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check(dialog).not.toBeVisible();
    expect(writes[0]).toMatchObject({
      eggId: 4,
      dockerImage: 'registry.example.test/java:21',
      portRoles: [{ role: 'game', protocols: ['tcp'], primary: true }],
    });
  });
  it('keeps incomplete provider discovery editable but prevents a mapping write', async () => {
    nests = [];
    await page.goto(`${origin}owner/integrations/minecraft/runtime`);
    await page
      .getByRole('button', { name: /Add runtime mapping|Associate egg/, exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await check(dialog.getByLabel('Nest', { exact: true })).toBeEnabled();
    await check(dialog.getByLabel('Egg', { exact: true })).toBeDisabled();
    await check(dialog.getByRole('button', { name: 'Create mapping', exact: true })).toBeDisabled();
    await check(dialog.getByRole('button', { name: 'Fixed image', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    expect(writes).toEqual([]);
  });
  it('keeps used mapping identity immutable while allowing availability changes', async () => {
    mappings = [{ ...existing, inUse: true }];
    await page.goto(`${origin}owner/integrations/minecraft/runtime`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    for (const label of ['Pterodactyl node', 'Nest', 'Egg', 'Startup command'])
      await check(dialog.getByLabel(label, { exact: true })).toBeDisabled();
    await check(dialog.getByRole('button', { name: 'Fixed image', exact: true })).toBeDisabled();
    await dialog.getByLabel('Available for new servers', { exact: true }).uncheck();
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check(dialog).not.toBeVisible();
    expect(writes[0]).toEqual({
      id: existing.id,
      gameId: existing.game_id,
      runtimeId: existing.runtime_id,
      nodeId: existing.node_id,
      nestId: existing.nest_id,
      eggId: existing.egg_id,
      imageMode: existing.image_mode,
      startup: existing.startup,
      environment: existing.environment,
      portRoles: existing.port_roles,
      featureLimits: existing.feature_limits,
      enabled: false,
    });
  });
  it('keeps keyboard focus inside the dialog and returns to the trigger on Escape', async () => {
    const dialog = await openCreate();
    await dialog.getByRole('button', { name: 'Create mapping', exact: true }).focus();
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await check(dialog).not.toBeVisible();
    await check(
      page.getByRole('button', { name: /Add runtime mapping|Associate egg/, exact: true }),
    ).toBeFocused();
    expect(writes).toEqual([]);
  });
  it('fits Italian mobile layout with advanced controls and accessible labels', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}owner/integrations/minecraft/runtime`);
    await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await page.reload();
    await page
      .getByRole('button', { name: /Aggiungi associazione runtime|Associa egg/, exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Associa egg', exact: true });
    await dialog.getByLabel('Egg', { exact: true }).selectOption('2');
    await dialog.getByRole('button', { name: 'Immagine fissa', exact: true }).click();
    await check(
      dialog.getByRole('combobox', { name: 'Immagine del container', exact: true }),
    ).toBeVisible();
    const geometry = await dialog.evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      width: window.innerWidth,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      bodyScroll: document.documentElement.scrollWidth,
    }));
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.bodyScroll).toBeLessThanOrEqual(geometry.width);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/runtime-mapping-mobile-it.png',
      fullPage: true,
    });
    await dialog
      .locator('summary')
      .filter({ hasText: /^Variabili/ })
      .click();
    await dialog.getByRole('button', { name: 'Aggiungi variabile', exact: true }).click();
    await dialog.getByLabel('Nome della variabile 2', { exact: true }).fill('MAX_PLAYERS');
    await dialog.getByLabel('Valore della variabile 2', { exact: true }).fill('10');
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/runtime-mapping-mobile-it-variables.png',
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    expect(writes).toEqual([]);
  });
});
