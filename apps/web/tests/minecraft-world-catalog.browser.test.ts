import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import type { ContentHttp } from '../../../packages/content-providers/src/contracts.js';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

// A real ZIP/NBT fixture from an older release: provider declarations warn before
// import, then actual world metadata determines compatibility without activation.
function olderLevelDat() {
  const string = (value: string) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const integer = (name: string, value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(value);
    return Buffer.concat([Buffer.from([3]), string(name), bytes]);
  };
  return gzipSync(
    Buffer.concat([
      Buffer.from([10, 0, 0, 10]),
      string('Data'),
      integer('version', 19133),
      integer('DataVersion', 3700),
      Buffer.from([10]),
      string('Version'),
      integer('Id', 3700),
      Buffer.from([8]),
      string('Name'),
      string('1.20.4'),
      Buffer.from([0, 0, 0]),
    ]),
  );
}
async function worldArchive() {
  const zip = new ZipFile();
  zip.addBuffer(olderLevelDat(), 'Verdant-Isles/level.dat');
  zip.addBuffer(Buffer.from('Isolated world catalog fixture'), 'Verdant-Isles/data/catalog.txt');
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('Minecraft Worlds catalog through actual browser, API, source and durable import handlers', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let directory: string;
  let archive: Buffer;
  let archiveSha1: string;
  let archiveSha256: string;
  let downloadGate: Promise<void> | undefined;
  const pageErrors: string[] = [];
  const browserRequests: { url: string; body: string; headers: Record<string, string> }[] = [];
  const providerKey = 'isolated-browser-world-catalog-key';
  const project = {
    id: 41,
    gameId: 432,
    classId: 17,
    slug: 'verdant-isles',
    name: 'Verdant Isles',
    summary: 'Floating islands and a village for an exploration world.',
    downloadCount: 12345,
    authors: [{ name: 'Catalog fixture' }],
    isAvailable: true,
    allowModDistribution: true,
  };
  const metadataFile = (unavailable = false) => ({
    id: unavailable ? 74 : 73,
    gameId: 432,
    modId: 41,
    fileName: unavailable ? 'verdant-preview.zip' : 'verdant-isles.zip',
    displayName: unavailable ? 'Preview archive' : 'Verdant Isles 1.20.4',
    fileDate: '2026-10-01T00:00:00Z',
    fileLength: archive.length,
    downloadUrl: unavailable ? null : 'https://edge.forgecdn.net/files/fixture/verdant.zip',
    isAvailable: !unavailable,
    gameVersions: ['1.20.4'],
    hashes: [{ algo: 1, value: archiveSha1 }],
  });
  const json = vi.fn<ContentHttp['json']>(async (url, options) => {
    expect(options?.headers?.['x-api-key']).toBe(providerKey);
    const address = new URL(url);
    const pagination = (count: number) => ({
      index: Number(address.searchParams.get('index') ?? 0),
      pageSize: 20,
      resultCount: count,
      totalCount: count,
    });
    if (address.pathname === '/v1/categories')
      return { data: [{ id: 17, gameId: 432, slug: 'worlds', isClass: true }] };
    if (address.pathname === '/v1/mods/search') {
      const query = address.searchParams.get('searchFilter') ?? '';
      const items = [
        project,
        {
          ...project,
          id: 42,
          name: 'Winter Village',
          slug: 'winter-village',
          summary: 'A snowy village with paths through the mountains.',
        },
      ].filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
      return { data: items, pagination: pagination(items.length) };
    }
    if (address.pathname === '/v1/mods/41') return { data: project };
    if (address.pathname === '/v1/mods/41/files')
      return { data: [metadataFile(), metadataFile(true)], pagination: pagination(2) };
    if (address.pathname === '/v1/mods/41/files/73') return { data: metadataFile() };
    throw new Error(`Unexpected isolated catalog request ${address.pathname}`);
  });
  const download = vi.fn<ContentHttp['download']>(async (artifact, destination, options) => {
    expect(artifact).toMatchObject({
      projectId: '41',
      versionId: '73',
      size: archive.length,
      hashes: { sha1: archiveSha1 },
    });
    await downloadGate;
    options?.signal?.throwIfAborted();
    await writeFile(destination, archive, { flag: 'wx', mode: 0o600 });
    return { size: archive.length, sha256: archiveSha256 };
  });
  const base = () => `/v1/servers/${provider.ids.serverId}/minecraft`;
  const route = () => `${fixture.origin}/servers/${provider.ids.serverId}/game/worlds`;

  beforeAll(async () => {
    archive = await worldArchive();
    archiveSha1 = createHash('sha1').update(archive).digest('hex');
    archiveSha256 = createHash('sha256').update(archive).digest('hex');
    fixture = await browserHarness({
      browser: process.env.NH_BROWSER === 'firefox' ? 'firefox' : 'chromium',
      minecraftContentHttp: { json, download },
    });
    identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    for (const page of [user, identities.peer]) {
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('request', (request) =>
        browserRequests.push({
          url: request.url(),
          body: request.postData() ?? '',
          headers: request.headers(),
        }),
      );
    }
    directory = await mkdtemp(resolve('mountdata/m2-tests/m5-world-catalog-browser-'));
    const root = `./${relative(process.cwd(), directory)}`;
    await mkdir(`${directory}/sources`);
    await mkdir(`${directory}/expanded`);
    Object.assign(fixture.env, {
      NH_CONTENT_SOURCE_ROOT: `${root}/sources`,
      NH_CONTENT_WORK_ROOT: `${root}/expanded`,
      NH_CONTENT_SOURCE_FREE_BYTES: '0',
      NH_CONTENT_SOURCE_FREE_PERCENT: '0',
      NH_CONTENT_METADATA_USER_AGENT: 'NickHosting isolated browser world catalog',
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('Unexpected external fetch in isolated world catalog browser fixture');
    });
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    await journeyRequest(
      fixture,
      identities.owner,
      '/v1/owner/secrets/curseforgeApiKey',
      { value: providerKey },
      'PUT',
    );
  });
  afterAll(async () => {
    provider?.dispose();
    vi.unstubAllGlobals();
    await fixture?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function screenshot(page: Page, name: string) {
    // All displayed values are public fixture data; keep controls visible for review.
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots', `${name}.png`),
      fullPage: true,
    });
  }
  async function accessible(page = user) {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    ).toEqual([]);
    const overflow = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      outside: [...document.querySelectorAll('main *')]
        .map((node) => ({
          tag: node.tagName,
          className: node.className,
          right: node.getBoundingClientRect().right,
        }))
        .filter((node) => node.right > innerWidth),
    }));
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
  }

  it('searches, blocks unavailable downloads, stages an older world and imports it without activation', async () => {
    await user.goto(route());
    await user.getByRole('button', { name: 'Find worlds', exact: true }).click();
    const catalog = user.getByRole('dialog', { name: 'Find worlds', exact: true });
    await browserExpect(catalog.getByRole('button', { name: /^Verdant Isles/ })).toBeVisible();
    await browserExpect(catalog.getByRole('button', { name: /^Winter Village/ })).toBeVisible();
    await screenshot(user, 'minecraft-world-catalog-search-desktop-en');
    await accessible();
    await catalog
      .getByRole('searchbox', { name: 'Search CurseForge worlds', exact: true })
      .fill('Verdant');
    await browserExpect(catalog.getByRole('button', { name: /^Winter Village/ })).toHaveCount(0);
    await catalog.getByRole('button', { name: /^Verdant Isles/ }).click();
    const files = user.getByRole('dialog', { name: 'Files for Verdant Isles', exact: true });
    const available = files
      .locator('li')
      .filter({ has: user.getByText('Verdant Isles 1.20.4', { exact: true }) });
    const unavailable = files
      .locator('li')
      .filter({ has: user.getByText('Preview archive', { exact: true }) });
    await browserExpect(
      unavailable.getByRole('button', { name: 'Use this file', exact: true }),
    ).toBeDisabled();
    await browserExpect(
      unavailable.getByText('Automatic download is not available for this file.', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      available.getByText('Declared for Minecraft 1.20.4. This server uses 26.1.', { exact: true }),
    ).toBeVisible();
    await screenshot(user, 'minecraft-world-catalog-files-desktop-en');
    await accessible();
    let releaseDownload = () => {};
    downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const sourceResponse = user.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/minecraft/sources/world-catalog') &&
        response.request().method() === 'POST',
    );
    let sourceId = '';
    try {
      await available.getByRole('button', { name: 'Use this file', exact: true }).click();
      await browserExpect(
        files.getByRole('progressbar', { name: 'Downloading world…', exact: true }),
      ).toBeVisible();
      expect((await provider.files()).has('catalog-islands/level.dat')).toBe(false);
      // Closing a picker must not cancel a server-side acquisition or reopen it
      // later. Selecting the same archive again reuses the ready sealed source.
      await files.getByRole('button', { name: 'Close', exact: true }).click();
      await browserExpect(user.getByRole('dialog')).toHaveCount(0);
      releaseDownload();
      const response = await sourceResponse;
      expect(response.status(), await response.text()).toBe(201);
      const source = await response.json();
      sourceId = source.id;
      expect(source.state).toBe('ready');
      expect(JSON.stringify(source)).not.toMatch(
        /isolated-browser-world-catalog-key|edge\.forgecdn\.net/,
      );
      const sourceRow = await fixture.database.db
        .selectFrom('minecraft_sources')
        .selectAll()
        .where('id', '=', source.id)
        .executeTakeFirstOrThrow();
      expect(sourceRow).toMatchObject({
        owner_user_id: identities.userId,
        server_id: provider.ids.serverId,
        state: 'ready',
        kind: 'world',
        origin: 'curseforge',
        provider_project_id: '41',
        provider_version_id: '73',
      });
    } finally {
      releaseDownload();
      downloadGate = undefined;
    }
    await browserExpect(user.getByRole('dialog')).toHaveCount(0);
    await user.getByRole('button', { name: 'Find worlds', exact: true }).click();
    await catalog.getByRole('button', { name: /^Verdant Isles/ }).click();
    const reused = user.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/minecraft/sources/world-catalog') &&
        response.request().method() === 'POST',
    );
    await available.getByRole('button', { name: 'Use this file', exact: true }).click();
    const reusedResponse = await reused;
    expect(reusedResponse.status(), await reusedResponse.text()).toBe(201);
    expect((await reusedResponse.json()).id).toBe(sourceId);
    expect(download).toHaveBeenCalledTimes(1);
    expect(
      await fixture.database.db
        .selectFrom('minecraft_sources')
        .select('id')
        .where('origin', '=', 'curseforge')
        .execute(),
    ).toHaveLength(1);
    const dialog = user.getByRole('dialog', { name: 'Import world', exact: true });
    await browserExpect(
      dialog.getByText('World downloaded. Import it to add it to the server.', { exact: true }),
    ).toBeVisible();
    await browserExpect(dialog.getByLabel('Folder name', { exact: true })).toBeFocused();
    await dialog.getByLabel('Folder name', { exact: true }).fill('catalog-islands');
    await screenshot(user, 'minecraft-world-catalog-import-desktop-en');
    await accessible();
    const filesBefore = await provider.files();
    const propertiesBefore = filesBefore.get('server.properties')?.toString();
    const accepted = user.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith(`${base()}/operations`),
    );
    await dialog.getByRole('button', { name: 'Import world', exact: true }).click();
    const response = await accepted;
    expect(response.status(), await response.text()).toBe(202);
    const { jobId } = await response.json();
    expect(filesBefore.has('catalog-islands/level.dat')).toBe(false);
    const delivery = await provider.processPending();
    const job = await fixture.database.db
      .selectFrom('operation_jobs')
      .select(['state', 'error_code'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(job.state, JSON.stringify({ delivery, job })).toBe('succeeded');
    const imported = user
      .locator('.minecraft-world')
      .filter({ has: user.getByText('catalog-islands', { exact: true }) });
    await browserExpect(imported.locator('.minecraft-world-compatibility')).toHaveText(
      'Incompatible version',
    );
    await browserExpect(imported.locator('.minecraft-world-version')).toHaveText('1.20.4');
    await browserExpect(
      imported.getByRole('button', { name: 'Select world: catalog-islands', exact: true }),
    ).toBeDisabled();
    const actual = await provider.files();
    expect(actual.get('catalog-islands/level.dat')).toEqual(olderLevelDat());
    expect(actual.get('catalog-islands/data/catalog.txt')?.toString()).toBe(
      'Isolated world catalog fixture',
    );
    expect(actual.get('server.properties')?.toString()).toBe(propertiesBefore);
    expect(download).toHaveBeenCalledTimes(1);
    expect(
      json.mock.calls.filter(([url]) => new URL(url).pathname === '/v1/categories'),
    ).toHaveLength(1);
    expect(
      browserRequests.some(({ url }) => /api\.curseforge\.com|edge\.forgecdn\.net/.test(url)),
    ).toBe(false);
    expect(JSON.stringify(browserRequests)).not.toContain(providerKey);
    await screenshot(user, 'minecraft-world-catalog-imported-desktop-en');
  });

  it('keeps the catalog localized, keyboard accessible and bounded on Italian mobile', async () => {
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    await user.goto(route());
    await user.getByRole('button', { name: 'Trova mondi', exact: true }).click();
    const catalog = user.getByRole('dialog', { name: 'Trova mondi', exact: true });
    await browserExpect(
      catalog.getByRole('searchbox', { name: 'Cerca mondi su CurseForge', exact: true }),
    ).toBeFocused();
    const project = catalog.getByRole('button', { name: /^Verdant Isles/ });
    await browserExpect(project).toBeVisible();
    await screenshot(user, 'minecraft-world-catalog-search-mobile-it');
    await accessible();
    await project.focus();
    await user.keyboard.press('Enter');
    const files = user.getByRole('dialog', { name: 'File di Verdant Isles', exact: true });
    await browserExpect(
      files
        .getByText('Dichiarato per Minecraft 1.20.4. Questo server usa 26.1.', { exact: true })
        .first(),
    ).toBeVisible();
    const unavailable = files
      .locator('li')
      .filter({ has: user.getByText('Preview archive', { exact: true }) });
    await browserExpect(
      unavailable.getByRole('button', { name: 'Usa questo file', exact: true }),
    ).toBeDisabled();
    await browserExpect(
      files.getByRole('link', { name: 'MinecraftMaps', exact: true }),
    ).toHaveAttribute('target', '_blank');
    await screenshot(user, 'minecraft-world-catalog-files-mobile-it');
    await accessible();
    await user.keyboard.press('Escape');
    await browserExpect(user.getByRole('dialog')).toHaveCount(0);
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'en' });
    await user.setViewportSize({ width: 1440, height: 1000 });
  });

  it('authorizes browsing and acquisition independently and does not expose mutation controls to a project viewer', async () => {
    const before = json.mock.calls.length;
    const downloadsBefore = download.mock.calls.length;
    const unrelated = await identities.peer.request.get(
      `${fixture.origin}${base()}/world-catalog/search?provider=curseforge&query=Verdant`,
    );
    expect(unrelated.status()).toBe(403);
    const request = {
      serverId: provider.ids.serverId,
      provider: 'curseforge',
      projectId: '41',
      versionId: '73',
      idempotencyKey: randomUUID(),
    };
    const crossOrigin = await user.request.post(
      `${fixture.origin}/v1/minecraft/sources/world-catalog`,
      { headers: { Origin: 'https://untrusted.example.test' }, data: request },
    );
    expect(crossOrigin.status()).toBe(403);
    expect(json.mock.calls.length).toBe(before);
    const denied = await identities.peer.request.post(
      `${fixture.origin}/v1/minecraft/sources/world-catalog`,
      { headers: { Origin: fixture.origin }, data: request },
    );
    expect(denied.status()).toBe(403);
    expect(json.mock.calls.length).toBe(before);
    const shared = await journeyRequest<{ id: string }>(fixture, user, '/v1/projects', {
      name: 'Catalog observers',
    });
    await journeyRequest(
      fixture,
      user,
      `/v1/platform/servers/${provider.ids.serverId}`,
      { projectId: shared.id },
      'PATCH',
    );
    await journeyRequest(
      fixture,
      user,
      `/v1/projects/${shared.id}/members`,
      { userId: identities.peerId, role: 'viewer' },
      'PUT',
    );
    await identities.peer.goto(route());
    await browserExpect(
      identities.peer.getByText('You have read-only access to worlds.', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      identities.peer.getByRole('button', { name: 'Find worlds', exact: true }),
    ).toHaveCount(0);
    await browserExpect(
      identities.peer.getByRole('button', { name: 'Import world', exact: true }),
    ).toHaveCount(0);
    const readable = await identities.peer.request.get(
      `${fixture.origin}${base()}/world-catalog/search?provider=curseforge&query=Verdant`,
    );
    expect(readable.status()).toBe(200);
    const viewerDenied = await identities.peer.request.post(
      `${fixture.origin}/v1/minecraft/sources/world-catalog`,
      { headers: { Origin: fixture.origin }, data: { ...request, idempotencyKey: randomUUID() } },
    );
    expect(viewerDenied.status()).toBe(403);
    expect(download).toHaveBeenCalledTimes(downloadsBefore);
    await accessible(identities.peer);
    expect(pageErrors).toEqual([]);
  });
});
