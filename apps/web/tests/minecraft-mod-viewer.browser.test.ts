import { Buffer } from 'node:buffer';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Actual Fileman + compiled Minecraft viewer; archive HTTP results are isolated fixtures.
 * ZIP parsing, source permissions and byte budgets remain exercised by their owned tests. */
describe('Minecraft integration-owned Modscope viewer', () => {
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
    await provider.adapter.createDirectory(server.pterodactyl_identifier, '', 'mods');
    const files = await provider.files();
    const icon = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing canvas');
      context.fillStyle = '#264d43';
      context.fillRect(0, 0, 128, 128);
      context.strokeStyle = '#e9f3da';
      context.lineWidth = 8;
      context.strokeRect(33, 27, 62, 74);
      context.beginPath();
      context.moveTo(33, 52);
      context.lineTo(95, 52);
      context.moveTo(33, 77);
      context.lineTo(95, 77);
      context.stroke();
      return canvas.toDataURL('image/png').split(',')[1] ?? '';
    });
    const fabric = JSON.stringify({
      schemaVersion: 1,
      id: 'aster_storage',
      name: 'Aster Storage',
      version: '2.4.1',
      description:
        'Thoughtful storage for a shared world.\nA compact fixture with local metadata and embedded artwork.',
      environment: '*',
      authors: ['Alex Morgan', { name: 'René Bell' }],
      license: 'MIT',
      icon: 'assets/aster/icon.png',
      contact: {
        homepage: 'https://example.invalid/aster',
        sources: 'https://example.invalid/aster/source',
        issues: 'javascript:alert(1)',
      },
      depends: { minecraft: '~1.21.1', fabricloader: '>=0.16.0', 'fabric-api': '*' },
      recommends: { modmenu: '*' },
      breaks: { conflicting_storage: '<2.0' },
    });
    const fixture = (name: string, entries: Record<string, string | Buffer>) => {
      archives.set(
        name,
        new Map(
          Object.entries(entries).map(([path, content]) => [
            path,
            Buffer.isBuffer(content) ? content : Buffer.from(content),
          ]),
        ),
      );
      files.set(name, Buffer.from('Isolated archive transport fixture; never read as a full JAR.'));
    };
    fixture('mods/aster.jar', {
      'fabric.mod.json': fabric,
      'assets/aster/icon.png': Buffer.from(icon, 'base64'),
      'do-not-read.class': 'Never execute Java',
    });
    fixture('mods/aster.jar.disabled', { 'fabric.mod.json': fabric });
    fixture('mods/retry.jar', { 'fabric.mod.json': fabric });
    fixture('mods/cancel.jar', { 'fabric.mod.json': fabric });
    fixture('mods/empty.jar', { 'README.txt': 'No mod descriptor' });
    fixture('mods/malformed.jar', { 'fabric.mod.json': '{not valid json' });
    fixture('mods/unsafe.jar', {
      'fabric.mod.json': JSON.stringify({
        schemaVersion: 1,
        id: 'unsafe_fixture',
        version: '1',
        name: '<img src=x onerror=alert(1)>',
        description: '<script>window.modExecuted=true</script>',
        icon: 'icon.svg',
        contact: { homepage: 'javascript:alert(1)', sources: 'https://example.invalid/safe' },
      }),
      'icon.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><script>window.modExecuted=true</script></svg>',
    });
    fixture('mods/bundle.jar', {
      'META-INF/mods.toml': `modLoader="javafml"
loaderVersion="[47,)"
license="MIT"
[[mods]]
modId="north"
displayName="North Compass"
version="1.2"
description="An embedded module."
[[mods]]
modId="south"
displayName="South Compass"
version="1.3"
description="Another module in the same file."
`,
    });
    fixture('server.jar', { 'README.txt': 'Ordinary runtime archive' });
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
        const contents = archives.get(path);
        if (!contents) return route.fulfill({ status: 404, json: { code: 'not_found' } });
        if (action === '/archive') {
          if (path === 'mods/retry.jar' && retryFailure)
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
          if (path === 'mods/cancel.jar' && holdMember) await holdMember;
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

  async function open(name: string, folder = 'mods') {
    await page.goto(base);
    await page.getByRole('button', { name: 'root', exact: true }).click();
    if (folder) await page.locator('.fm-filename').getByText(folder, { exact: true }).click();
    await page.locator('.fm-filename').getByText(name, { exact: true }).click();
    await browserExpect(page.getByRole('button', { name: /^(Open with|Apri con)$/ })).toBeVisible();
  }
  async function screenshot(name: string) {
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

  it('prioritizes the Minecraft viewer in mods, reads only descriptors and local artwork, and restores on refresh', async () => {
    await open('aster.jar');
    await browserExpect(page.locator('.mc-modscope h2')).toHaveText('Aster Storage');
    await browserExpect(page.locator('.mc-modscope-art img')).toBeVisible();
    await browserExpect(page.locator('.mc-modscope')).toContainText('Client & server');
    await browserExpect(page.locator('.mc-modscope')).toContainText('fabricloader');
    expect(await page.locator('.mc-modscope a').count()).toBe(2);
    await browserExpect(page.locator('.mc-modscope a').first()).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(
      requests.every((url) =>
        ['/archive', '/archive/content'].some((suffix) => url.pathname === `${endpoint}${suffix}`),
      ),
    ).toBe(true);
    const members = requests
      .filter((url) => url.pathname.endsWith('/archive/content'))
      .map((url) => url.searchParams.get('entry'));
    expect(members).toEqual(['fabric.mod.json', 'assets/aster/icon.png']);
    expect(externalRequests).toBe(0);
    await screenshot('modscope-desktop-en');
    expect((await new AxeBuilder({ page }).include('.mc-modscope').analyze()).violations).toEqual(
      [],
    );
    await fits();
    await page.reload();
    await browserExpect(page.locator('.mc-modscope h2')).toHaveText('Aster Storage');
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('.mc-modscope')).toHaveCount(0);
    await browserExpect(
      page.locator('.fm-filename').getByText('aster.jar', { exact: true }),
    ).toBeVisible();
  });

  it('keeps the runtime JAR in Atlas and supports explicit archive fallback from Modscope', async () => {
    await open('server.jar', '');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await browserExpect(page.locator('.mc-modscope')).toHaveCount(0);
    await open('aster.jar.disabled');
    await browserExpect(page.locator('.mc-modscope h2')).toHaveText('Aster Storage');
    await page.getByRole('button', { name: 'Open archive', exact: true }).focus();
    await page.keyboard.press('Enter');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await browserExpect(
      page.locator('.fm-filename').getByText('fabric.mod.json', { exact: true }),
    ).toBeVisible();
  });

  it('switches multiple contained mods without rereading the archive and leaves undeclared sides unknown', async () => {
    await open('bundle.jar');
    await browserExpect(page.locator('.mc-modscope h2')).toHaveText('North Compass');
    await browserExpect(page.locator('.mc-modscope-facts')).toContainText('Not declared');
    const count = requests.length;
    await page.getByRole('button', { name: /South Compass/ }).focus();
    await page.keyboard.press('Enter');
    await browserExpect(page.locator('.mc-modscope h2')).toHaveText('South Compass');
    expect(requests.length).toBe(count);
    await browserExpect(page.getByRole('button', { name: /South Compass/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect((await new AxeBuilder({ page }).include('.mc-modscope').analyze()).violations).toEqual(
      [],
    );
  });

  it('renders missing or malformed metadata locally without crashing Fileman', async () => {
    await open('empty.jar');
    await browserExpect(page.locator('.mc-modscope')).toContainText('No mod metadata found');
    await screenshot('modscope-empty-en');
    await open('malformed.jar');
    await browserExpect(page.locator('.mc-modscope')).toContainText('No mod metadata found');
    await page.locator('.mc-modscope-source summary').click();
    await browserExpect(page.locator('.mc-modscope-source')).toContainText('Invalid metadata');
    expect(errors).toEqual([]);
  });

  it('retries a failed metadata request without losing shared navigation', async () => {
    retryFailure = true;
    await open('retry.jar');
    await browserExpect(page.locator('.mc-modscope')).toContainText('Could not read this mod.');
    await screenshot('modscope-error-en');
    retryFailure = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await browserExpect(page.locator('.mc-modscope h2')).toHaveText('Aster Storage');
  });

  it('never executes descriptor HTML or embedded SVG and filters unsafe links', async () => {
    await open('unsafe.jar');
    await browserExpect(page.locator('.mc-modscope h2')).toHaveText('<img src=x onerror=alert(1)>');
    await browserExpect(page.locator('.mc-modscope-description')).toHaveText(
      '<script>window.modExecuted=true</script>',
    );
    await browserExpect(page.locator('.mc-modscope-art img')).toHaveCount(0);
    await browserExpect(page.locator('.mc-modscope a')).toHaveCount(1);
    expect(
      await page.evaluate(() => (window as unknown as { modExecuted?: boolean }).modExecuted),
    ).toBeUndefined();
    expect(externalRequests).toBe(0);
    expect(errors).toEqual([]);
  });

  it('aborts an unfinished member read when leaving the viewer', async () => {
    holdMember = new Promise<void>((resolve) => {
      releaseMember = resolve;
    });
    try {
      await page.goto(base);
      await page.getByRole('button', { name: 'root', exact: true }).click();
      await page.locator('.fm-filename').getByText('mods', { exact: true }).click();
      await page.evaluate(() => {
        const original = window.fetch;
        const state = window as unknown as { modReadAborts: number };
        state.modReadAborts = 0;
        window.fetch = (input, init) => {
          if (String(input).includes('/archive/content') && String(input).includes('cancel.jar'))
            init?.signal?.addEventListener('abort', () => state.modReadAborts++, { once: true });
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
              url.searchParams.get('path') === 'mods/cancel.jar',
          ),
        )
        .toBe(true);
      await screenshot('modscope-loading-en');
      await page.keyboard.press('Escape');
      await browserExpect(page.locator('.mc-modscope')).toHaveCount(0);
      expect(
        await page.evaluate(() => (window as unknown as { modReadAborts: number }).modReadAborts),
      ).toBeGreaterThan(0);
    } finally {
      releaseMember?.();
      holdMember = undefined;
    }
  });

  it('keeps Italian 320px layout, shared controls and keyboard navigation usable', async () => {
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 320, height: 740 });
    await open('aster.jar');
    await browserExpect(page.locator('.mc-modscope')).toContainText('Client e server');
    await browserExpect(page.locator('.mc-modscope-art img')).toBeVisible();
    await fits();
    const heading = await page.locator('.mc-modscope-heading').boundingBox();
    const title = await page.locator('.mc-modscope h2').boundingBox();
    if (!heading || !title) throw new Error('Missing mod heading');
    expect(heading.width).toBeGreaterThanOrEqual(140);
    expect(title.height).toBeLessThan(100);
    await screenshot('modscope-mobile-it');
    expect((await new AxeBuilder({ page }).include('.mc-modscope').analyze()).violations).toEqual(
      [],
    );
    await page.getByRole('button', { name: 'Apri con', exact: true }).click();
    const card = page.getByRole('dialog').getByRole('button', { name: 'Modscope', exact: true });
    await browserExpect(card).toBeVisible();
    await card.focus();
    await page.keyboard.press('Enter');
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('.mc-modscope')).toHaveCount(0);
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'en' });
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  it('honors an explicit saved Atlas choice over the integration suggestion', async () => {
    await open('aster.jar');
    await browserExpect(page.locator('.mc-modscope h2')).toHaveText('Aster Storage');
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'My choice for .jar' }).selectOption('server');
    await dialog.getByRole('button', { name: 'Atlas', exact: true }).click();
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    expect(preferences).toContainEqual({ scope: 'server', extension: 'jar', viewerId: 'archive' });
    await open('aster.jar');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await browserExpect(page.locator('.mc-modscope')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
