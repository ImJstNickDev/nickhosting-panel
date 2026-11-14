import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect } from '@playwright/test';
import { expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

it('opens Satisfactory INI and manifests through Fileman with existing editor fallbacks and bounded read-only views', async () => {
  const harness = await browserHarness();
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>> | undefined;
  try {
    const identities = await prepareJourneyIdentities(harness);
    const page = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    const id = provider.ids.serverId;
    const beforeOperations = await harness.database.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', id)
      .execute();
    const files = await provider.files();
    files.clear();
    const ini =
      '; Factory configuration\n[/Script/FactoryGame.FGGameSession]\nmMaxPlayers=8\n+AllowedPlayers=Alice\n.AllowedPlayers=Alice\n-AllowedPlayers=Bob\n!AllowedPlayers=ClearArray\n[/Script/FactoryGame.FGGameSession]\nmMaxPlayers=12\n';
    files.set('Game.ini', Buffer.from(ini));
    files.set('Empty.ini', Buffer.alloc(0));
    files.set('TooLarge.ini', Buffer.alloc(65536, 65));
    files.set(
      'FactoryTools.uplugin',
      Buffer.from(
        JSON.stringify({
          FileVersion: 3,
          Version: 12,
          VersionName: '1.2.0',
          FriendlyName: 'Factory Tools',
          Description: 'Building tools for the factory',
          CreatedBy: 'Factory team',
          SemVersion: '1.2.0',
          Plugins: [{ Name: 'SML', Enabled: true, SemVersion: '^3.10.0' }],
          Modules: [{ Name: 'FactoryTools', Type: 'Runtime', LoadingPhase: 'Default' }],
        }),
      ),
    );
    files.set('Broken.uplugin', Buffer.from('{invalid json'));
    files.set(
      'profiles.json',
      Buffer.from(
        JSON.stringify({
          version: 0,
          selected_profile: 'NickHosting',
          profiles: {
            NickHosting: {
              name: 'NickHosting',
              required_targets: ['LinuxServer'],
              mods: {
                SML: { version: '^3.10.0', enabled: true },
                FactoryTools: { version: '^1.2.0', enabled: true },
              },
            },
          },
        }),
      ),
    );
    files.set('unrelated.json', Buffer.from('{"custom":true}'));
    const fileBytes = new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
    const writes: string[] = [];
    const contentReads: { path: string; range: string }[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      // Directory batching is an existing read-only POST endpoint.
      if (
        path.startsWith(`/v1/servers/${id}/files`) &&
        path !== `/v1/servers/${id}/files/directories` &&
        !['GET', 'HEAD'].includes(request.method())
      )
        writes.push(`${request.method()} ${path}`);
    });
    await page.route(`**/v1/platform/servers/${id}`, async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      return route.fulfill({
        json: { ...value, gameId: 'satisfactory', runtimeId: 'satisfactory' },
      });
    });
    const revision = (body: Buffer) => createHash('sha256').update(body).digest('hex');
    await page.route(
      (url) => url.pathname === `/v1/servers/${id}/files/viewer`,
      async (route) => {
        const body = files.get(new URL(route.request().url()).searchParams.get('path') ?? '');
        if (!body) return route.fulfill({ status: 404, json: { code: 'not_found' } });
        return route.fulfill({
          json: { revision: revision(body), size: body.length, mtimeMs: 1700000000000 },
        });
      },
    );
    await page.route(`**/v1/servers/${id}/files/viewer/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/capabilities'))
        return route.fulfill({ json: { available: true } });
      if (url.pathname.endsWith('/preferences'))
        return route.fulfill({ json: { preferences: [] } });
      if (!url.pathname.endsWith('/content')) return route.fulfill({ status: 404 });
      const path = url.searchParams.get('path') ?? '';
      const body = files.get(path);
      if (!body) return route.fulfill({ status: 404, json: { code: 'not_found' } });
      const range = route.request().headers().range ?? '';
      contentReads.push({ path, range });
      if (!range) return route.fulfill({ body, contentType: 'application/octet-stream' });
      expect(route.request().headers()['if-match']).toBe(`"${revision(body)}"`);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return route.fulfill({ status: 400 });
      const start = Number(match[1]),
        end = Math.min(Number(match[2]), body.length - 1);
      return route.fulfill({
        status: 206,
        body: body.subarray(start, end + 1),
        contentType: 'application/octet-stream',
        headers: {
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        },
      });
    });
    const base = `${harness.origin}/servers/${id}/files`;
    await page.goto(base);
    const open = async (name: string) =>
      page.locator('.fm-filename').getByText(name, { exact: true }).click();
    const back = async () =>
      page.getByRole('button', { name: /^(Back to files|Torna ai file)$/ }).click();
    await open('Game.ini');
    const iniViewer = page.locator('.satisfactory-ini-viewer');
    await browserExpect(iniViewer).toContainText('mMaxPlayers');
    await browserExpect(iniViewer).toContainText('Factory configuration');
    await browserExpect(iniViewer).toContainText('ClearArray');
    await browserExpect(iniViewer.getByText('Add if absent', { exact: true })).toBeVisible();
    await browserExpect(
      iniViewer.getByText('Add, including duplicates', { exact: true }),
    ).toBeVisible();
    await browserExpect(iniViewer.locator('code').filter({ hasText: /^mMaxPlayers$/ })).toHaveCount(
      2,
    );
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: 'test-results/satisfactory-ini-desktop-en.png', fullPage: true });
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Scribe', exact: true }).click();
    await browserExpect(page.locator('.cm-content')).toContainText('+AllowedPlayers=Alice');
    await back();
    await open('FactoryTools.uplugin');
    const manifestViewer = page.locator('.satisfactory-manifest-viewer');
    await browserExpect(manifestViewer).toContainText('Factory Tools');
    await browserExpect(manifestViewer).toContainText('SML');
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({
      path: 'test-results/satisfactory-manifest-desktop-en.png',
      fullPage: true,
    });
    await back();
    await open('profiles.json');
    await browserExpect(manifestViewer).toContainText('NickHosting');
    await browserExpect(manifestViewer).toContainText('FactoryTools');
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'JSON Tree', exact: true }).click();
    await browserExpect(page.locator('.ve-json')).toContainText('profiles');
    await back();
    await open('unrelated.json');
    await browserExpect(page.locator('.ve-json')).toContainText('custom');
    await browserExpect(manifestViewer).toHaveCount(0);
    await back();
    await open('Broken.uplugin');
    await browserExpect(page.getByRole('alert')).toBeVisible();
    await page.screenshot({
      path: 'test-results/satisfactory-manifest-invalid-en.png',
      fullPage: true,
    });
    await back();
    const beforeOversize = contentReads.length;
    await open('Empty.ini');
    await browserExpect(
      page.getByText('This configuration file is empty.', { exact: true }),
    ).toBeVisible();
    expect(contentReads.length).toBe(beforeOversize);
    await back();
    await open('TooLarge.ini');
    await browserExpect(page.getByRole('alert')).toBeVisible();
    expect(contentReads.length).toBe(beforeOversize);
    await back();
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}?directory=`);
    await open('Game.ini');
    await browserExpect(iniViewer).toContainText('mMaxPlayers');
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: 'test-results/satisfactory-ini-mobile-it.png', fullPage: true });
    await page.getByRole('button', { name: 'Apri editor di testo', exact: true }).click();
    await browserExpect(page.locator('.cm-content')).toContainText('+AllowedPlayers=Alice');
    await back();
    await open('profiles.json');
    await browserExpect(manifestViewer).toContainText('NickHosting');
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: 'test-results/satisfactory-manifest-mobile-it.png',
      fullPage: true,
    });
    expect(
      contentReads
        .filter(({ path }) => ['Game.ini', 'FactoryTools.uplugin', 'Broken.uplugin'].includes(path))
        .every(({ range }) => range === 'bytes=0-65535'),
    ).toBe(true);
    expect(writes).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect([...files]).toEqual([...fileBytes]);
    expect(
      await harness.database.db
        .selectFrom('server_operations')
        .select('job_id')
        .where('server_id', '=', id)
        .execute(),
    ).toEqual(beforeOperations);
  } finally {
    provider?.dispose();
    await harness.close();
  }
});
