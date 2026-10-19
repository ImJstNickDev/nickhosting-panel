import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import type { ContentHttp } from '../../../packages/content-providers/src/contracts.js';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { browserLevelDat } from './minecraft-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

async function packZip() {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        pack: { min_format: [101, 1], max_format: [101, 1], description: 'Browser datapack' },
      }),
    ),
    'pack.mcmeta',
  );
  zip.addBuffer(Buffer.from('say isolated'), 'data/browser/function/test.mcfunction');
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('Minecraft datapacks: world-scoped preparation and explicit apply', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let identifier: string;
  let ownedDirectory: string;
  const pageErrors: string[] = [];
  let catalogZip: Buffer;
  let downloadGate: Promise<void> | undefined;
  const download = vi.fn<ContentHttp['download']>(async (_artifact, destination, options) => {
    await downloadGate;
    options?.signal?.throwIfAborted();
    await writeFile(destination, catalogZip, { flag: 'wx', mode: 0o600 });
    return {
      size: catalogZip.length,
      sha256: createHash('sha256').update(catalogZip).digest('hex'),
    };
  });
  const json = vi.fn<ContentHttp['json']>(async (url) => {
    const address = new URL(url);
    const version = (id: string) => ({
      id,
      project_id: 'catalog-pack',
      name: `Pack ${id}`,
      version_number: id,
      game_versions: ['26.1'],
      loaders: ['datapack'],
      date_published: '2026-01-01T00:00:00Z',
      files: [
        {
          filename: `${id}.zip`,
          url: `https://cdn.modrinth.com/${id}.zip`,
          size: catalogZip.length,
          hashes: { sha512: createHash('sha512').update(catalogZip).digest('hex') },
          primary: true,
        },
      ],
      dependencies: [],
    });
    if (address.pathname === '/v2/search')
      return {
        hits: [
          {
            project_id: 'catalog-pack',
            slug: 'catalog-pack',
            title: 'Catalog pack',
            description: 'Isolated catalog fixture',
            author: 'Fixture',
            downloads: 1,
          },
        ],
        offset: 0,
        limit: 20,
        total_hits: 1,
      };
    if (address.pathname === '/v2/project/catalog-pack')
      return {
        id: 'catalog-pack',
        slug: 'catalog-pack',
        title: 'Catalog pack',
        project_type: 'mod',
      };
    if (address.pathname === '/v2/project/catalog-pack/version')
      return [
        version('first'),
        version('second'),
        {
          ...version('blocked'),
          dependencies: [
            { project_id: 'required-mod', version_id: null, dependency_type: 'required' },
          ],
        },
      ];
    if (address.pathname.startsWith('/v2/version/'))
      return version(address.pathname.split('/').at(-1) ?? 'first');
    throw new Error(`Unexpected fixture request ${address.pathname}`);
  });
  const route = () => `${fixture.origin}/servers/${provider.ids.serverId}/game/datapacks`;
  const base = () => `/v1/servers/${provider.ids.serverId}/minecraft/datapacks`;
  beforeAll(async () => {
    catalogZip = await packZip();
    fixture = await browserHarness({
      minecraftContentHttp: { json, download },
      browser: process.env.NH_BROWSER === 'firefox' ? 'firefox' : 'chromium',
    });
    identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    user.on('pageerror', (error) => pageErrors.push(error.message));
    ownedDirectory = await mkdtemp(resolve('mountdata/m2-tests/m5-datapacks-browser-'));
    await mkdir(`${ownedDirectory}/sources`);
    await mkdir(`${ownedDirectory}/expanded`);
    const staging = `./${relative(process.cwd(), ownedDirectory)}`;
    Object.assign(fixture.env, {
      NH_MINECRAFT_SOURCE_ROOT: `${staging}/sources`,
      NH_MINECRAFT_CONTENT_ROOT: `${staging}/expanded`,
      NH_CONTENT_SOURCE_FREE_BYTES: '0',
      NH_CONTENT_SOURCE_FREE_PERCENT: '0',
      NH_CONTENT_METADATA_USER_AGENT: 'NickHosting isolated datapacks browser',
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('Unexpected external request in isolated datapack fixture');
    });
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    const server = await fixture.database.db
      .selectFrom('managed_servers')
      .select('pterodactyl_identifier')
      .where('id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    identifier = server.pterodactyl_identifier ?? '';
    await provider.adapter.power(identifier, 'stop');
    await fixture.database.db
      .updateTable('managed_servers')
      .set({ runtime_state: 'offline' })
      .where('id', '=', provider.ids.serverId)
      .execute();
    await provider.adapter.createDirectory(identifier, 'world', 'datapacks');
    await provider.adapter.createDirectory(identifier, 'world/datapacks', 'Manual pack');
    await provider.adapter.writeFile(
      identifier,
      'world/datapacks/Manual pack/pack.mcmeta',
      JSON.stringify({ pack: { pack_format: 1, description: 'Manual folder fixture' } }),
    );
    await provider.adapter.createDirectory(identifier, '', 'archive-world');
    await provider.adapter.writeFile(
      identifier,
      'archive-world/level.dat',
      browserLevelDat().toString('binary'),
    );
    (await provider.files()).set('archive-world/level.dat', browserLevelDat());
  });
  afterAll(async () => {
    provider?.dispose();
    vi.unstubAllGlobals();
    await fixture?.close();
    if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true });
  });
  async function accessible(page = user) {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  async function snapshot() {
    const response = await user.request.get(`${fixture.origin}${base()}?world=world`);
    expect(response.status(), await response.text()).toBe(200);
    return await response.json();
  }
  it('discovers manually uploaded folders, keeps selected-world default and changes world independently', async () => {
    const initialSnapshot = await snapshot();
    expect(initialSnapshot.world).toBe('world');
    await user.goto(route());
    await browserExpect(
      user.getByRole('combobox', { name: 'World', exact: true }),
      await user.locator('body').innerText(),
    ).toBeVisible({ timeout: 15000 });
    await browserExpect(user.getByText('Manual pack', { exact: true })).toBeVisible();
    await browserExpect(user.getByText('Manual folder fixture', { exact: true })).toBeVisible();
    await browserExpect(user.getByText('Incompatible format', { exact: true })).toBeVisible();
    await accessible();
    await user.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots/minecraft-datapacks-desktop-en.png'),
      fullPage: true,
    });
    await user.getByRole('combobox', { name: 'World', exact: true }).selectOption('archive-world');
    await browserExpect(
      user.getByText('No datapacks in this world.', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      user.getByText('Changes to this world load when the server next starts with it.', {
        exact: true,
      }),
    ).toBeVisible();
    await user.getByRole('combobox', { name: 'World', exact: true }).selectOption('world');
  });
  it('persists a disable draft through reload and applies without confusing disk state with loaded state', async () => {
    await user.getByRole('button', { name: 'Disable: Manual pack', exact: true }).click();
    const changes = user.getByRole('region', { name: 'Pending changes', exact: true });
    await browserExpect(changes.getByText('Manual pack', { exact: true })).toBeVisible();
    expect((await provider.files()).has('world/datapacks/Manual pack/pack.mcmeta')).toBe(true);
    await user.reload();
    await browserExpect(
      user.getByRole('button', { name: 'Apply changes', exact: true }),
    ).toBeEnabled();
    let releaseInventory = () => {};
    const inventoryGate = new Promise<void>((resolveGate) => {
      releaseInventory = resolveGate;
    });
    let finishInventory = () => {};
    const inventoryFinished = new Promise<void>((resolveFinished) => {
      finishInventory = resolveFinished;
    });
    const inventoryUrl = `${fixture.origin}${base()}?world=world`;
    const applyRequests: string[] = [];
    const recordApply = (request: import('@playwright/test').Request) => {
      if (request.method() === 'POST' && request.url().endsWith(`${base()}/apply`)) {
        applyRequests.push(request.url());
      }
    };
    user.on('request', recordApply);
    await user.route(inventoryUrl, async (route) => {
      await inventoryGate;
      await route.continue();
      finishInventory();
    });
    try {
      await user.getByRole('button', { name: 'Apply changes', exact: true }).click();
      // The published receipt clears confirmed drafts before the slower inventory refresh.
      await browserExpect(changes).toHaveCount(0);
      await browserExpect(
        user.getByRole('button', { name: 'Apply changes', exact: true }),
      ).toHaveCount(0);
      expect(applyRequests).toHaveLength(1);
    } finally {
      releaseInventory();
      await inventoryFinished;
      await user.unroute(inventoryUrl);
      user.off('request', recordApply);
    }
    await browserExpect(
      user.getByRole('button', { name: 'Enable: Manual pack', exact: true }),
    ).toBeEnabled();
    expect((await provider.files()).has('world/datapacks/Manual pack/pack.mcmeta')).toBe(false);
    expect(
      (await snapshot()).packs.find((pack: { name: string }) => pack.name === 'Manual pack').state,
    ).toBe('disabled');
  });
  it('cancels queued changes without renaming installed packs and confirms removals before staging', async () => {
    await user.getByRole('button', { name: 'Enable: Manual pack', exact: true }).click();
    await user.getByRole('button', { name: 'Discard change: Manual pack', exact: true }).click();
    await browserExpect(
      user.getByRole('region', { name: 'Pending changes', exact: true }),
    ).toHaveCount(0);
    expect(
      (await snapshot()).packs.find((pack: { name: string }) => pack.name === 'Manual pack').state,
    ).toBe('disabled');
    await user.getByRole('button', { name: 'Remove datapack: Manual pack', exact: true }).click();
    const dialog = user.getByRole('dialog', { name: 'Remove Manual pack?', exact: true });
    await browserExpect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await user.keyboard.press('Escape');
    expect((await snapshot()).changes).toEqual([]);
  });
  it('uploads a ZIP through Fileman staging before apply, leaving the live world untouched until publication', async () => {
    await user
      .locator('input[type=file]:not([webkitdirectory])')
      .setInputFiles({ name: 'browser.zip', mimeType: 'application/zip', buffer: await packZip() });
    await expect
      .poll(
        async () => ({
          error: await user.getByRole('alert').allTextContents(),
          changes: (await snapshot()).changes.map((change: { name: string }) => change.name),
        }),
        { timeout: 20000 },
      )
      .toEqual({ error: [], changes: ['browser.zip'] });
    await browserExpect(
      user.getByRole('button', { name: 'Apply changes', exact: true }),
    ).toBeEnabled({ timeout: 20000 });
    const before = await provider.files();
    expect(before.has('world/datapacks/browser.zip')).toBe(false);
    expect(
      [...before.keys()].some(
        (path) => path.startsWith('world/datapacks/browser.zip.') && path.endsWith('.pending'),
      ),
    ).toBe(true);
    await user.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await browserExpect(
      user.getByRole('button', { name: 'Disable: browser.zip', exact: true }),
    ).toBeEnabled();
    expect((await provider.files()).has('world/datapacks/browser.zip')).toBe(true);
  });
  it('prepares selected catalog files in background while browsing, and preserves the queue when the dialog closes', async () => {
    let release = () => {};
    downloadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await user.getByRole('button', { name: 'Find datapacks', exact: true }).click();
      const dialog = user.getByRole('dialog', { name: 'Find datapacks', exact: true });
      await dialog.getByRole('button', { name: /Catalog pack/ }).click();
      const files = user.getByRole('dialog', { name: 'Catalog pack', exact: true });
      await browserExpect(
        files.getByText(
          'This version declares dependencies or conflicts that automatic installation does not yet handle.',
          { exact: true },
        ),
      ).toBeVisible();
      await browserExpect(
        files
          .getByRole('listitem')
          .filter({ hasText: 'Pack blocked' })
          .getByRole('button', { name: 'Prepare this file', exact: true }),
      ).toBeDisabled();
      await files
        .getByRole('listitem')
        .filter({ hasText: 'Pack first' })
        .getByRole('button', { name: 'Prepare this file', exact: true })
        .click();
      await user.screenshot({
        path: resolve(
          '.codex/local/m5-browser/screenshots/minecraft-datapacks-catalog-unavailable-en.png',
        ),
        fullPage: true,
      });
      await expect.poll(() => download.mock.calls.length).toBe(1);
      await files
        .getByRole('listitem')
        .filter({ hasText: 'Pack second' })
        .getByRole('button', { name: 'Prepare this file', exact: true })
        .click();
      await browserExpect(
        files.getByRole('button', { name: 'Queued for preparation', exact: true }),
      ).toBeVisible();
      await files.getByRole('button', { name: 'Back to results', exact: true }).click();
      await browserExpect(
        user.getByRole('dialog', { name: 'Find datapacks', exact: true }),
      ).toBeVisible();
      await user.keyboard.press('Escape');
      await browserExpect(
        user.getByRole('region', { name: 'Preparing datapacks', exact: true }),
      ).toBeVisible();
      expect(download.mock.calls.length).toBe(1);
      release();
      downloadGate = undefined;
      await expect.poll(() => download.mock.calls.length).toBe(2);
      await browserExpect(
        user.getByRole('region', { name: 'Preparing datapacks', exact: true }),
      ).toHaveCount(0, { timeout: 20000 });
      await browserExpect(
        user.getByRole('button', { name: 'Apply changes', exact: true }),
      ).toBeEnabled();
      await browserExpect(
        user
          .getByRole('region', { name: 'Pending changes', exact: true })
          .locator('.datapack-change'),
      ).toHaveCount(2);
      expect((await provider.files()).has('world/datapacks/catalog-pack-first.zip')).toBe(false);
      await user.screenshot({
        path: resolve('.codex/local/m5-browser/screenshots/minecraft-datapacks-prepared-en.png'),
        fullPage: true,
      });
      await accessible();
      for (const name of ['catalog-pack-first.zip', 'catalog-pack-second.zip']) {
        await user.getByRole('button', { name: `Discard change: ${name}`, exact: true }).click();
        await browserExpect(
          user.getByRole('button', { name: `Discard change: ${name}`, exact: true }),
        ).toHaveCount(0);
      }
    } finally {
      release();
      downloadGate = undefined;
    }
  });
  it('allows discarding an interrupted preparation after refresh without publishing the pack', async () => {
    await user.locator('input[type=file]:not([webkitdirectory])').setInputFiles({
      name: 'interrupted.zip',
      mimeType: 'application/zip',
      buffer: await packZip(),
    });
    await expect
      .poll(async () =>
        (await snapshot()).changes.some(
          (change: { name: string; state: string }) =>
            change.name === 'interrupted.zip' && change.state === 'ready',
        ),
      )
      .toBe(true);
    await fixture.database.db
      .updateTable('minecraft_datapack_changes')
      .set({ state: 'preparing' })
      .where('server_id', '=', provider.ids.serverId)
      .where('name', '=', 'interrupted.zip')
      .execute();
    await user.reload();
    const discard = user.getByRole('button', {
      name: 'Discard change: interrupted.zip',
      exact: true,
    });
    await browserExpect(discard).toBeEnabled();
    await discard.click();
    await browserExpect(discard).toHaveCount(0);
    expect([...(await provider.files())].some(([path]) => path.includes('interrupted.zip'))).toBe(
      false,
    );
  });
  it('offers a compact Italian mobile view with keyboard-accessible actions and no horizontal overflow', async () => {
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    await user.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await user.setViewportSize({ width: 390, height: 844 });
    await user.reload();
    await browserExpect(user.getByRole('combobox', { name: 'Mondo', exact: true })).toBeVisible();
    await browserExpect(
      user.getByRole('button', { name: 'Carica ZIP', exact: true }),
    ).toBeVisible();
    await accessible();
    await user.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots/minecraft-datapacks-mobile-it.png'),
      fullPage: true,
    });
    await user.getByRole('searchbox', { name: 'Cerca datapack', exact: true }).fill('missing');
    await browserExpect(
      user.getByText('Nessun datapack corrispondente.', { exact: true }),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
    await user.evaluate(() => localStorage.setItem('nh.locale', 'en'));
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'en' });
    await user.setViewportSize({ width: 1440, height: 1000 });
  });
  it('keeps manage actions unavailable for a project viewer and rejects mutation directly', async () => {
    const project = await journeyRequest<{ id: string }>(fixture, user, '/v1/projects', {
      name: 'Datapack readers',
    });
    await journeyRequest(
      fixture,
      user,
      `/v1/platform/servers/${provider.ids.serverId}`,
      { projectId: project.id },
      'PATCH',
    );
    await journeyRequest(
      fixture,
      user,
      `/v1/projects/${project.id}/members`,
      { userId: identities.peerId, role: 'viewer' },
      'PUT',
    );
    await identities.peer.goto(route());
    await browserExpect(
      identities.peer.getByText('You have read-only access to datapacks.', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      identities.peer.getByRole('button', { name: 'Upload ZIP', exact: true }),
    ).toBeDisabled();
    const denied = await identities.peer.request.post(`${fixture.origin}${base()}/changes`, {
      headers: { Origin: fixture.origin },
      data: {
        world: 'world',
        action: 'disable',
        path: 'world/datapacks/browser.zip',
        idempotencyKey: 'viewer-denied',
      },
    });
    expect(denied.status()).toBe(403);
  });
});
