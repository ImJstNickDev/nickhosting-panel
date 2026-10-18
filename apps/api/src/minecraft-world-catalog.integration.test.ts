import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ContentHttp } from '@nickhosting/content-providers';
import { DomainError, SecretCodec } from '@nickhosting/core';
import { storeSecret, updateSettings } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftManifest } from '@nickhosting/minecraft';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMinecraftSourceStore } from '../../../packages/server-management/src/minecraft-sources.js';
import { minecraftContentProviders } from '../../../packages/server-management/src/minecraft-world-catalog.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerMinecraftWorldCatalogRoutes } from './minecraft-world-catalog.js';

const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 7) } });
const binary = Buffer.from('isolated-world-source');
const sha1 = createHash('sha1').update(binary).digest('hex');
const sha256 = createHash('sha256').update(binary).digest('hex');
const project = {
  id: 41,
  gameId: 432,
  classId: 17,
  slug: 'fixture-world',
  name: 'Fixture world',
  summary: 'Fixture map',
  downloadCount: 30,
  authors: [{ name: 'Fixture author' }],
  isAvailable: true,
  allowModDistribution: true,
};
const file = {
  id: 73,
  modId: 41,
  gameId: 432,
  fileName: 'world.zip',
  displayName: 'World 1.7.10',
  fileDate: '2026-10-01T00:00:00Z',
  fileLength: binary.length,
  downloadUrl: 'https://cdn.example.test/world.zip',
  isAvailable: true,
  gameVersions: ['1.7.10'],
  hashes: [{ algo: 1, value: sha1 }],
};
const pagination = { index: 0, pageSize: 20, resultCount: 1, totalCount: 1 };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let actor: typeof f.context;
let serverId: string;
let root: string;
let env: Record<string, string>;
let app: Hono<{ Variables: Variables }>;
let allowed = true;
const json = vi.fn<ContentHttp['json']>();
const download = vi.fn<ContentHttp['download']>();
const http: ContentHttp = { json, download };
const slotRelease = vi.fn();
const acquireUploadSlot = vi.fn(() => slotRelease);
const base = () => `/v1/servers/${serverId}/minecraft/world-catalog`;
const input = (patch = {}) => ({
  provider: 'curseforge',
  projectId: '41',
  versionId: '73',
  serverId,
  idempotencyKey: randomUUID(),
  ...patch,
});
const acquire = (value = input(), headers: Record<string, string> = {}) =>
  app.request('/v1/minecraft/sources/world-catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  json.mockReset();
  download.mockReset();
  acquireUploadSlot.mockClear();
  slotRelease.mockClear();
  await database.db.deleteFrom('minecraft_sources').execute();
  await database.db
    .deleteFrom('encrypted_secrets')
    .where('name', '=', 'curseforgeApiKey')
    .execute();
  f = await managementFixture(database.db, { interactive: true });
  actor = f.context;
  serverId = await f.server();
  await f.db
    .insertInto('game_integrations')
    .values({
      id: 'minecraft',
      version: '1.0.0',
      manifest: JSON.stringify(minecraftManifest),
    })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'minecraft', runtime_id: 'vanilla' })
    .where('id', '=', f.mappingId)
    .execute();
  root = `./mountdata/test-assets/world-catalog-${randomUUID()}`;
  env = {
    NH_CONTENT_SOURCE_ROOT: root,
    NH_CONTENT_SOURCE_FREE_BYTES: '0',
    NH_CONTENT_SOURCE_FREE_PERCENT: '0',
    NH_CONTENT_METADATA_USER_AGENT: 'NickHosting isolated catalog test',
  };
  allowed = true;
  json.mockImplementation(async (url) => {
    const path = new URL(url);
    if (path.pathname === '/v1/categories')
      return { data: [{ id: 17, gameId: 432, slug: 'worlds', isClass: true }] };
    if (path.pathname === '/v1/mods/search') return { data: [project], pagination };
    if (path.pathname === '/v1/mods/41')
      return { data: { ...project, allowModDistribution: allowed } };
    if (path.pathname === '/v1/mods/41/files') return { data: [file], pagination };
    if (path.pathname === '/v1/mods/41/files/73') return { data: file };
    throw new Error(`Unexpected isolated provider request ${path.pathname}`);
  });
  download.mockImplementation(async (artifact, destination) => {
    expect(artifact).toMatchObject({ projectId: '41', versionId: '73', hashes: { sha1 } });
    await writeFile(destination, binary, { flag: 'wx', mode: 0o600 });
    return { size: binary.length, sha256 };
  });
  app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) => {
    if (!(error instanceof DomainError)) throw error;
    return c.json({ code: error.code }, error.status as 400);
  });
  registerMinecraftWorldCatalogRoutes(app, {
    db: f.db,
    env,
    codec,
    principal: async () => actor,
    acquireUploadSlot,
    http,
  });
  await storeSecret(f.db, f.owner, codec, 'curseforgeApiKey', 'isolated-world-key');
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('Minecraft world catalog HTTP and sealed source acquisition', () => {
  it('reads only local availability and never exposes provider credentials or download URLs', async () => {
    expect(await (await app.request(base())).json()).toEqual({
      providers: [{ id: 'curseforge', available: true }],
    });
    expect(json).not.toHaveBeenCalled();
    const search = await app.request(`${base()}/search?provider=curseforge&query=map`);
    const body = await search.text();
    expect(search.status).toBe(200);
    expect(body).toContain('Fixture world');
    expect(body).not.toMatch(/isolated-world-key|downloadUrl|cdn.example/);
    expect(
      json.mock.calls.every(
        ([, options]) => options?.headers?.['x-api-key'] === 'isolated-world-key',
      ),
    ).toBe(true);
    expect(await (await app.request(`${base()}/curseforge/41/files`)).json()).toMatchObject({
      items: [{ id: '73', projectId: '41', available: true, gameVersions: ['1.7.10'] }],
    });
  });
  it('reports an absent key and forbids using a catalog for an unrelated server', async () => {
    await f.db.deleteFrom('encrypted_secrets').where('name', '=', 'curseforgeApiKey').execute();
    expect(await (await app.request(base())).json()).toEqual({
      providers: [{ id: 'curseforge', available: false }],
    });
    expect((await app.request(`${base()}/search?provider=curseforge`)).status).toBe(503);
    const other = await managementFixture(f.db, { interactive: true });
    actor = other.context;
    expect((await app.request(base())).status).toBe(403);
    expect((await acquire()).status).toBe(403);
    expect(json).not.toHaveBeenCalled();
  });
  it('coalesces metadata, expires it, and invalidates it immediately after protected key/settings changes', async () => {
    const search = `${base()}/search?provider=curseforge&query=map`;
    await Promise.all([app.request(search), app.request(search), app.request(search)]);
    const countSearches = () =>
      json.mock.calls.filter(([url]) => new URL(url).pathname === '/v1/mods/search').length;
    expect(countSearches()).toBe(1);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await app.request(search);
    expect(countSearches()).toBe(2);
    await storeSecret(f.db, f.owner, codec, 'curseforgeApiKey', 'replacement-key');
    await app.request(search);
    expect(countSearches()).toBe(3);
    expect(json.mock.lastCall?.[1]?.headers?.['x-api-key']).toBe('replacement-key');
    await updateSettings(f.db, f.owner, {
      contentDownloadOrigins: ['https://custom.example.test'],
    });
    await app.request(search);
    expect(countSearches()).toBe(4);
  });
  it('validates provider, bounded pagination and request bodies before any external request', async () => {
    for (const query of [
      'provider=modrinth',
      'provider=curseforge&offset=9981',
      'provider=curseforge&url=https://example.test',
    ])
      expect((await app.request(`${base()}/search?${query}`)).status).toBe(400);
    expect((await app.request(`${base()}/curseforge/not-an-id/files`)).status).toBe(400);
    expect((await acquire(input({ url: 'https://example.test/archive.zip' }))).status).toBe(400);
    expect((await acquire(input(), { 'content-type': 'text/plain' })).status).toBe(400);
    expect((await acquire(input({ serverId: undefined }))).status).toBe(400);
    expect(json).not.toHaveBeenCalled();
  });
  it('lets shared viewers browse but only managers acquire a source', async () => {
    const other = await managementFixture(f.db, { interactive: true });
    const projectId = randomUUID();
    await f.db
      .insertInto('projects')
      .values({ id: projectId, owner_id: f.context.subjectUserId, name: 'Catalog fixture' })
      .execute();
    await f.db
      .insertInto('project_members')
      .values({ project_id: projectId, user_id: other.context.subjectUserId, role: 'viewer' })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ project_id: projectId })
      .where('id', '=', serverId)
      .execute();
    actor = other.context;
    expect((await app.request(base())).status).toBe(200);
    expect((await acquire()).status).toBe(403);
    await f.db
      .updateTable('project_members')
      .set({ role: 'manager' })
      .where('project_id', '=', projectId)
      .execute();
    expect((await acquire()).status).toBe(201);
  });
  it('seals the verified download once, reuses idempotent ready sources and preserves exact server scope', async () => {
    const request = input();
    // Spy on archive byte reads: downloader hashing must not be repeated for sealing/resolution.
    const probePath = join(resolve('./mountdata/test-assets'), `catalog-probe-${randomUUID()}`);
    const probe = await open(probePath, 'w');
    const reads = vi.spyOn(Object.getPrototypeOf(probe), 'createReadStream');
    await probe.close();
    await rm(probePath);
    const response = await acquire(request);
    expect(response.status).toBe(201);
    const ready = (await response.json()) as { id: string; state: string };
    expect(ready).toMatchObject({
      state: 'ready',
      kind: 'world',
      origin: 'curseforge',
      serverId,
      sha256,
    });
    const path = join(resolve(root), ready.id, 'archive.bin');
    expect((await lstat(path)).mode & 0o777).toBe(0o400);
    const source = await f.db
      .selectFrom('minecraft_sources')
      .selectAll()
      .where('id', '=', ready.id)
      .executeTakeFirstOrThrow();
    expect(source).toMatchObject({
      provider_project_id: '41',
      provider_version_id: '73',
      expected_hashes: { sha1 },
    });
    const store = createMinecraftSourceStore(f.db, actor, env);
    expect(await store.worldArchiveResolver(ready.id, serverId)).toMatchObject({
      path,
      sha256,
      verified: { sha256 },
    });
    expect(reads).not.toHaveBeenCalled();
    json.mockClear();
    expect(await (await acquire(request)).json()).toMatchObject({ id: ready.id, state: 'ready' });
    expect(json).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledTimes(1);
    expect((await acquire({ ...request, versionId: '74' })).status).toBe(409);
    await expect(store.worldArchiveResolver(ready.id, randomUUID())).rejects.toThrow('forbidden');
    expect(slotRelease).toHaveBeenCalledTimes(acquireUploadSlot.mock.calls.length);
  });
  it('refuses denied distribution without reserving or downloading anything', async () => {
    allowed = false;
    const response = await acquire();
    expect(response.status).toBe(503);
    expect(download).not.toHaveBeenCalled();
    expect(await f.db.selectFrom('minecraft_sources').select('id').execute()).toEqual([]);
  });
  it('retains uncertain claims on failed integrity and does not replay the download', async () => {
    const request = input();
    download.mockRejectedValue(
      new DomainError('validation_failed', 400, { reason: 'download_hash' }),
    );
    expect((await acquire(request)).status).toBe(400);
    const source = await f.db
      .selectFrom('minecraft_sources')
      .selectAll()
      .where('idempotency_key', '=', request.idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(source).toMatchObject({ state: 'uncertain', actual_sha256: null, source_seal: null });
    expect((await acquire(request)).status).toBe(409);
    expect(download).toHaveBeenCalledTimes(1);
    await expect(
      createMinecraftSourceStore(f.db, actor, env).worldArchiveResolver(source.id, serverId),
    ).rejects.toThrow('conflict');
  });
  it('enforces original source quotas and the forward migration provenance constraint', async () => {
    env.NH_CONTENT_SOURCE_USER_BYTES = String(binary.length);
    expect((await acquire()).status).toBe(409);
    expect(download).not.toHaveBeenCalled();
    delete env.NH_CONTENT_SOURCE_USER_BYTES;
    const ready = (await (await acquire()).json()) as { id: string };
    await expect(
      f.db
        .updateTable('minecraft_sources')
        .set({ kind: 'modpack' })
        .where('id', '=', ready.id)
        .execute(),
    ).rejects.toThrow();
    await expect(
      f.db
        .updateTable('minecraft_sources')
        .set({ server_id: null })
        .where('id', '=', ready.id)
        .execute(),
    ).rejects.toThrow();
    await expect(
      f.db
        .updateTable('minecraft_sources')
        .set({ provider_project_id: null })
        .where('id', '=', ready.id)
        .execute(),
    ).rejects.toThrow();
    await expect(
      f.db
        .updateTable('minecraft_sources')
        .set({ actual_sha256: null })
        .where('id', '=', ready.id)
        .execute(),
    ).rejects.toThrow();
  });
  it('uses the same configured provider instance as the content pipeline with environment precedence', async () => {
    const first = await minecraftContentProviders(f.db, codec, env, http);
    const second = await minecraftContentProviders(f.db, codec, env, http);
    expect(first.providers?.curseforge).toBe(second.providers?.curseforge);
    env.NH_CURSEFORGE_API_KEY = 'environment-key';
    const overridden = await minecraftContentProviders(f.db, codec, env, http);
    expect(overridden.providers?.curseforge).not.toBe(first.providers?.curseforge);
    await app.request(`${base()}/search?provider=curseforge`);
    expect(json.mock.lastCall?.[1]?.headers?.['x-api-key']).toBe('environment-key');
  });
  it('keeps development CurseForge disabled until explicit opt-in without changing production behavior', async () => {
    const search = `${base()}/search?provider=curseforge`;
    expect((await app.request(search)).status).toBe(200);
    json.mockClear();
    env.NH_DEPLOYMENT_ENV = 'development';
    env.NH_CURSEFORGE_API_KEY = 'development-disabled';
    expect(await (await app.request(base())).json()).toEqual({
      providers: [{ id: 'curseforge', available: false }],
    });
    expect((await app.request(search)).status).toBe(503);
    expect((await acquire()).status).toBe(503);
    expect(json).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();

    env.NH_DEV_CURSEFORGE_ENABLED = 'true';
    delete env.NH_CURSEFORGE_API_KEY;
    expect((await app.request(search)).status).toBe(200);
    expect(json.mock.lastCall?.[1]?.headers?.['x-api-key']).toBe('isolated-world-key');
    env.NH_DEPLOYMENT_ENV = 'production';
    env.NH_DEV_CURSEFORGE_ENABLED = 'false';
    expect(await (await app.request(base())).json()).toEqual({
      providers: [{ id: 'curseforge', available: true }],
    });
  });
});
