import { Buffer } from 'node:buffer';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Actual Fileman + compiled Minecraft viewer; archive HTTP results are isolated fixtures.
 * ZIP parsing, source permissions and byte budgets remain exercised by their owned tests. */
describe('Minecraft integration-owned Plugscope viewer', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  let endpoint: string;
  const archives = new Map<string, Map<string, Buffer>>();
  const preferences: { scope: string; extension: string; viewerId: string }[] = [];
  const requests: URL[] = [];
  const errors: string[] = [];
  let retryFailure = false;
  let holdMember: Promise<void> | undefined;
  let releaseMember: (() => void) | undefined;
  let externalRequests = 0;

  beforeAll(async () => {
    harness = await browserHarness({
      browser: process.env.NH_BROWSER === 'chromium' ? 'chromium' : 'firefox',
    });
    const identities = await prepareJourneyIdentities(harness);
    page = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    endpoint = `/v1/servers/${provider.ids.serverId}/files/viewer`;
    const server = await harness.database.db
      .selectFrom('managed_servers')
      .select('pterodactyl_identifier')
      .where('id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    if (!server.pterodactyl_identifier) throw new Error('Missing fixture identifier');
    await provider.adapter.createDirectory(server.pterodactyl_identifier, '', 'plugins');
    const files = await provider.files();
    const bukkit = `name: Harbor
version: 2.4.1
main: dev.example.harbor.HarborPlugin
api-version: '1.21'
authors: [Alex Morgan, René Bell]
description: |-
  Shared homes and waypoints for your server.
  Local plugin metadata, with commands and permissions kept within reach.
website: https://example.invalid/harbor
load: POSTWORLD
folia-supported: false
provides: [HarborHomes]
depend: [Vault]
softdepend: [PlaceholderAPI]
loadbefore: [WelcomeBoard]
commands:
  home:
    description: Return to a saved home.
    aliases: [h, homes]
    usage: /home [name]
    permission: harbor.home
  sethome:
    description: Save your current position.
    permission: harbor.home.set
permissions:
  harbor.home:
    description: Travel to a home.
    default: true
  harbor.admin:
    description: Manage other players' homes.
    default: op
    children:
      harbor.home: true
      harbor.home.set: true
`;
    const paper = `name: Harbor
version: 2.4.1
main: dev.example.harbor.HarborPlugin
api-version: '1.21'
authors: [Alex Morgan, René Bell]
description: Native Paper descriptor for shared homes and waypoints.
website: https://example.invalid/harbor
folia-supported: true
bootstrapper: dev.example.harbor.Bootstrap
loader: dev.example.harbor.Loader
dependencies:
  bootstrap:
    ConfigAPI:
      required: true
      load: BEFORE
      join-classpath: true
  server:
    Vault:
      required: true
      load: BEFORE
    PlaceholderAPI:
      required: false
      load: AFTER
      join-classpath: false
    Metrics:
      required: false
      load: OMIT
commands:
  should-not-appear:
    description: Paper commands are registered dynamically.
`;
    const fixture = (name: string, entries: Record<string, string>) => {
      archives.set(
        name,
        new Map(Object.entries(entries).map(([path, content]) => [path, Buffer.from(content)])),
      );
      files.set(name, Buffer.from('Isolated archive transport fixture; never read as a full JAR.'));
    };
    for (const name of [
      'harbor.jar',
      'harbor.jar.disabled',
      'harbor.jar.pending',
      'retry.jar',
      'cancel.jar',
    ])
      fixture(`plugins/${name}`, {
        'plugin.yml': bukkit,
        'do-not-read.class': 'Never execute Java',
      });
    fixture('plugins/bundle.jar', { 'plugin.yml': bukkit, 'paper-plugin.yml': paper });
    fixture('plugins/empty.jar', { 'README.txt': 'No plugin descriptor' });
    fixture('plugins/malformed.jar', { 'plugin.yml': 'name: [invalid' });
    fixture('plugins/unsafe.jar', {
      'plugin.yml': `name: '<img src=x onerror=alert(1)>'
version: '1.0'
main: test.Unsafe
description: '<script>window.pluginExecuted=true</script>'
website: 'javascript:alert(1)'
icon: https://example.invalid/icon.svg
`,
    });
    fixture('plugins/velocity.jar', {
      'velocity-plugin.json': JSON.stringify({
        id: 'harbor_proxy',
        name: 'Harbor Proxy',
        version: '1.0',
        main: 'example.Proxy',
        authors: ['Alex Morgan'],
        dependencies: [{ id: 'limboapi', optional: true }],
      }),
    });
    fixture('plugins/bungee.jar', {
      'bungee.yml':
        'name: HarborBridge\nversion: 1.0\nmain: example.Bridge\nauthor: Alex Morgan\ndepends: [RedisBungee]',
    });
    fixture('plugins/large.jar', {
      'plugin.yml': `name: CommandAtlas\nversion: 1.0\nmain: example.Commands\ncommands:\n${Array.from({ length: 120 }, (_, index) => `  route${index}:\n    description: Navigate route ${index}.`).join('\n')}`,
    });
    fixture('server.jar', { 'README.txt': 'Ordinary runtime archive' });
    fixture('bundle.zip', { 'plugins/harbor.jar': 'Nested JAR fixture' });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://example.invalid/**', (route) => {
      externalRequests++;
      return route.abort();
    });
    await page.route(
      (url) => url.pathname.startsWith(`${endpoint}/`),
      async (route) => {
        const url = new URL(route.request().url());
        const action = url.pathname.slice(endpoint.length);
        if (action === '/capabilities') return route.fulfill({ json: { available: true } });
        if (action === '/preferences') {
          if (route.request().method() === 'PUT') {
            const preference = route.request().postDataJSON();
            const index = preferences.findIndex(
              (value) =>
                value.scope === preference.scope && value.extension === preference.extension,
            );
            if (index >= 0) preferences.splice(index, 1);
            preferences.push(preference);
          }
          return route.fulfill({ json: { preferences } });
        }
        requests.push(url);
        const path = url.searchParams.get('path') ?? '';
        const chain = JSON.parse(url.searchParams.get('archives') ?? '[]') as string[];
        const contents = archives.get(
          path === 'bundle.zip' && chain.at(-1) === 'plugins/harbor.jar'
            ? 'plugins/harbor.jar'
            : path,
        );
        if (!contents) return route.fulfill({ status: 404, json: { code: 'not_found' } });
        if (action === '/archive') {
          if (path === 'plugins/retry.jar' && retryFailure)
            return route.fulfill({
              status: 503,
              json: { code: 'integration_unavailable', messageKey: 'viewer.unavailable' },
            });
          const directory = url.searchParams.get('directory') ?? '';
          const prefix = directory ? `${directory}/` : '';
          const entries = new Map<
            string,
            { name: string; path: string; directory: boolean; size: number }
          >();
          for (const [member, body] of contents) {
            if (!member.startsWith(prefix)) continue;
            const rest = member.slice(prefix.length);
            const name = rest.split('/')[0] ?? '';
            if (!name) continue;
            entries.set(name, {
              name,
              path: `${prefix}${name}`,
              directory: rest.includes('/'),
              size: rest.includes('/') ? 0 : body.length,
            });
          }
          const query = url.searchParams.get('query') ?? '';
          const selected = [...entries.values()]
            .filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
            .sort(
              (left, right) =>
                Number(right.directory) - Number(left.directory) ||
                left.name.localeCompare(right.name),
            );
          return route.fulfill({
            json: {
              directory,
              entries: selected.slice(0, 200),
              offset: 0,
              limit: 200,
              total: selected.length,
            },
          });
        }
        if (action === '/archive/content') {
          if (path === 'plugins/cancel.jar' && holdMember) await holdMember;
          const body = contents.get(url.searchParams.get('entry') ?? '');
          return body
            ? route.fulfill({ body, contentType: 'application/octet-stream' }).catch(() => {})
            : route.fulfill({ status: 404, json: { code: 'not_found' } });
        }
        return route.fulfill({ status: 400, json: { code: 'unexpected_full_archive_read' } });
      },
    );
  });
  afterAll(async () => {
    releaseMember?.();
    provider?.dispose();
    await harness?.close();
  });

  async function open(name: string, folder = 'plugins') {
    await page.goto(base);
    await page.getByRole('button', { name: 'root', exact: true }).click();
    if (folder) await page.locator('.fm-filename').getByText(folder, { exact: true }).click();
    await page.locator('.fm-filename').getByText(name, { exact: true }).click();
    await browserExpect(page.getByRole('button', { name: /^(Open with|Apri con)$/ })).toBeVisible();
  }
  async function screenshot(name: string) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `docs/screenshots/m5/${name}.png`, fullPage: true });
  }
  async function fits() {
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const sizes = await page
      .locator('.mc-modscope')
      .evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.width);
  }

  it('opens plugin JARs through the integration, reads descriptors only, restores on refresh and returns to Files', async () => {
    await open('harbor.jar');
    await browserExpect(page.locator('.mc-plugscope h2')).toHaveText('Harbor');
    const viewer = page.locator('.mc-plugscope');
    await browserExpect(viewer).toContainText('Minimum API version');
    await browserExpect(viewer).toContainText('After worlds load');
    await browserExpect(viewer.locator('.mc-modscope-facts')).toContainText(
      'Declared Folia supportNo',
    );
    await browserExpect(viewer).toContainText('This plugin loads first');
    expect(await viewer.locator('a').count()).toBe(1);
    await browserExpect(viewer.locator('a')).toHaveText('Website');
    await browserExpect(viewer.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(
      requests.every((url) =>
        ['/archive', '/archive/content'].some((suffix) => url.pathname === `${endpoint}${suffix}`),
      ),
    ).toBe(true);
    expect(
      requests
        .filter((url) => url.pathname.endsWith('/archive/content'))
        .map((url) => url.searchParams.get('entry')),
    ).toEqual(['plugin.yml']);
    expect(externalRequests).toBe(0);
    await page.locator('.mc-plugscope-inventory > summary').filter({ hasText: 'Commands' }).click();
    await page.locator('.mc-plugscope-entry summary').filter({ hasText: '/home' }).click();
    await browserExpect(viewer).toContainText('/h, /homes');
    await screenshot('plugscope-desktop-en');
    expect((await new AxeBuilder({ page }).include('.mc-plugscope').analyze()).violations).toEqual(
      [],
    );
    await fits();
    await page.reload();
    await browserExpect(page.locator('.mc-plugscope h2')).toHaveText('Harbor');
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('.mc-plugscope')).toHaveCount(0);
    await browserExpect(
      page.locator('.fm-filename').getByText('harbor.jar', { exact: true }),
    ).toBeVisible();
  });

  it('preserves distinct Paper and Bukkit declarations and switches without rereading', async () => {
    await open('bundle.jar');
    await browserExpect(page.locator('.mc-plugscope h2')).toHaveText('Harbor');
    await browserExpect(page.locator('.mc-modscope-tags')).toContainText('Paper');
    await browserExpect(page.locator('.mc-plugscope')).toContainText('Dependency loads first');
    await browserExpect(page.locator('.mc-plugscope')).toContainText('Dependency loads after');
    await browserExpect(page.locator('.mc-plugscope')).toContainText('No load order');
    await browserExpect(page.locator('.mc-plugscope')).not.toContainText('should-not-appear');
    await screenshot('plugscope-multiple-en');
    const count = requests.length;
    const second = page.getByRole('button', { name: 'Harbor Bukkit / Spigot', exact: true });
    await second.focus();
    await page.keyboard.press('Enter');
    await browserExpect(second).toHaveAttribute('aria-pressed', 'true');
    await browserExpect(page.locator('.mc-plugscope')).toContainText('Commands');
    expect(requests.length).toBe(count);
    expect((await new AxeBuilder({ page }).include('.mc-plugscope').analyze()).violations).toEqual(
      [],
    );
  });

  it('supports proxy descriptors, keeps absent facts absent, and bounds long command inventories', async () => {
    await open('velocity.jar');
    await browserExpect(page.locator('.mc-plugscope h2')).toHaveText('Harbor Proxy');
    await browserExpect(page.locator('.mc-modscope-tags')).toContainText('Velocity');
    await browserExpect(page.locator('.mc-plugscope')).not.toContainText('Folia');
    await browserExpect(page.locator('.mc-plugscope')).not.toContainText('Minimum API version');
    await open('bungee.jar');
    await browserExpect(page.locator('.mc-modscope-tags')).toContainText('BungeeCord');
    await browserExpect(page.locator('.mc-plugscope')).toContainText('RedisBungee');
    await open('large.jar');
    await page.locator('.mc-plugscope-inventory > summary').filter({ hasText: 'Commands' }).click();
    const body = page.locator('.mc-plugscope-inventory-body');
    const sizes = await body.evaluate((element) => ({
      height: element.clientHeight,
      content: element.scrollHeight,
    }));
    expect(sizes.height).toBeLessThanOrEqual(320);
    expect(sizes.content).toBeGreaterThan(sizes.height);
    await fits();
  });

  it('keeps ordinary JARs in Atlas and offers explicit archive fallback for disabled and pending plugins', async () => {
    await open('server.jar', '');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await browserExpect(page.locator('.mc-plugscope')).toHaveCount(0);
    for (const name of ['harbor.jar.disabled', 'harbor.jar.pending']) {
      await open(name);
      await browserExpect(page.locator('.mc-plugscope h2')).toHaveText('Harbor');
    }
    await page.getByRole('button', { name: 'Open archive', exact: true }).focus();
    await page.keyboard.press('Enter');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await browserExpect(
      page.locator('.fm-filename').getByText('plugin.yml', { exact: true }),
    ).toBeVisible();
  });

  it('can explicitly inspect a nested plugin with Fileman archive transport', async () => {
    await open('bundle.zip', '');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await page.locator('.ve-archive .fm-filename').getByText('plugins', { exact: true }).click();
    await page.locator('.ve-archive .fm-filename').getByText('harbor.jar', { exact: true }).click();
    await browserExpect(
      page.locator('.ve-archive .fm-filename').getByText('plugin.yml', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Show all', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Plugscope', exact: true }).click();
    await browserExpect(page.locator('.mc-plugscope h2')).toHaveText('Harbor');
    expect(
      requests.some(
        (url) =>
          url.searchParams.get('path') === 'bundle.zip' &&
          url.searchParams.get('archives') === '["plugins/harbor.jar"]' &&
          url.searchParams.get('entry') === 'plugin.yml',
      ),
    ).toBe(true);
  });

  it('renders missing and malformed metadata without breaking Fileman', async () => {
    await open('empty.jar');
    await browserExpect(page.locator('.mc-plugscope')).toContainText('No plugin metadata found');
    await screenshot('plugscope-empty-en');
    await open('malformed.jar');
    await browserExpect(page.locator('.mc-plugscope')).toContainText('No plugin metadata found');
    await page.locator('.mc-modscope-source summary').click();
    await browserExpect(page.locator('.mc-modscope-source')).toContainText('Invalid metadata');
    expect(errors).toEqual([]);
  });

  it('retries transport failures in place', async () => {
    retryFailure = true;
    await open('retry.jar');
    await browserExpect(page.locator('.mc-plugscope')).toContainText('Could not read this plugin.');
    await screenshot('plugscope-error-en');
    retryFailure = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await browserExpect(page.locator('.mc-plugscope h2')).toHaveText('Harbor');
  });

  it('renders descriptor text safely and never requests external artwork or executes Java', async () => {
    await open('unsafe.jar');
    await browserExpect(page.locator('.mc-plugscope h2')).toHaveText(
      '<img src=x onerror=alert(1)>',
    );
    await browserExpect(page.locator('.mc-modscope-description')).toHaveText(
      '<script>window.pluginExecuted=true</script>',
    );
    await browserExpect(page.locator('.mc-plugscope-art img')).toHaveCount(0);
    await browserExpect(page.locator('.mc-plugscope a')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { pluginExecuted?: boolean }).pluginExecuted),
    ).toBeUndefined();
    expect(externalRequests).toBe(0);
    expect(errors).toEqual([]);
  });

  it('aborts a pending descriptor read when leaving and uses the shared skeleton', async () => {
    holdMember = new Promise<void>((resolve) => {
      releaseMember = resolve;
    });
    try {
      await page.goto(base);
      await page.getByRole('button', { name: 'root', exact: true }).click();
      await page.locator('.fm-filename').getByText('plugins', { exact: true }).click();
      await page.evaluate(() => {
        const original = window.fetch;
        const state = window as unknown as { pluginReadAborts: number };
        state.pluginReadAborts = 0;
        window.fetch = (input, init) => {
          if (String(input).includes('/archive/content') && String(input).includes('cancel.jar'))
            init?.signal?.addEventListener('abort', () => state.pluginReadAborts++, { once: true });
          return original(input, init);
        };
      });
      await page.locator('.fm-filename').getByText('cancel.jar', { exact: true }).click();
      await browserExpect(page.locator('.mc-modscope-skeleton')).toBeVisible();
      await browserExpect
        .poll(() =>
          requests.some(
            (url) =>
              url.pathname.endsWith('/archive/content') &&
              url.searchParams.get('path') === 'plugins/cancel.jar',
          ),
        )
        .toBe(true);
      await screenshot('plugscope-loading-en');
      await page.keyboard.press('Escape');
      await browserExpect(page.locator('.mc-plugscope')).toHaveCount(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { pluginReadAborts: number }).pluginReadAborts,
        ),
      ).toBeGreaterThan(0);
    } finally {
      releaseMember?.();
      holdMember = undefined;
    }
  });

  it('keeps Italian 320px layout and keyboard-accessible descriptor disclosures', async () => {
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 320, height: 740 });
    await open('harbor.jar');
    await browserExpect(page.locator('.mc-plugscope')).toContainText('Versione API minima');
    await fits();
    const commands = page
      .locator('.mc-plugscope-inventory > summary')
      .filter({ hasText: 'Comandi' });
    await commands.focus();
    await page.keyboard.press('Enter');
    await browserExpect(page.locator('.mc-plugscope-inventory-body').first()).toBeVisible();
    await browserExpect(commands).toBeFocused();
    const skip = await page.locator('.skip-link').boundingBox();
    expect(skip && skip.y + skip.height <= 0).toBe(true);
    await screenshot('plugscope-mobile-it');
    expect((await new AxeBuilder({ page }).include('.mc-plugscope').analyze()).violations).toEqual(
      [],
    );
    await page.getByRole('button', { name: 'Apri con', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Plugscope', exact: true }).click();
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'en' });
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  it('honors an explicit Atlas default over the plugin suggestion', async () => {
    await open('harbor.jar');
    await browserExpect(page.locator('.mc-plugscope h2')).toHaveText('Harbor');
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'My choice for .jar' }).selectOption('server');
    await dialog.getByRole('button', { name: 'Atlas', exact: true }).click();
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    expect(preferences).toContainEqual({ scope: 'server', extension: 'jar', viewerId: 'archive' });
    await open('harbor.jar');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await browserExpect(page.locator('.mc-plugscope')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
