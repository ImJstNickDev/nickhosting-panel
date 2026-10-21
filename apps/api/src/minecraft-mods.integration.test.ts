import { randomUUID } from 'node:crypto';
import type { ContentHttp } from '@nickhosting/content-providers';
import { authSessionId, DomainError, SecretCodec } from '@nickhosting/core';
import { storeSecret, updateSettings } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { createManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp, type Variables } from './app.js';
import { registerMinecraftModRoutes } from './minecraft-mods.js';

const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 5) } });
const env = { NH_CONTENT_METADATA_USER_AGENT: 'NickHosting isolated Mods route test' };
const project = {
  id: 'testmod',
  slug: 'testmod',
  title: 'Fixture mod',
  description: 'Fixture summary',
  body: '# Fixture description',
  project_type: 'mod',
  downloads: 20,
  categories: ['technology'],
  environment: ['client_and_server'],
};
const version = {
  id: 'version1',
  project_id: 'testmod',
  name: 'Version 1',
  version_number: '1.0.0',
  game_versions: ['1.21.1'],
  loaders: ['fabric'],
  date_published: '2026-10-10T00:00:00Z',
  version_type: 'release',
  environment: 'client_and_server',
  files: [
    {
      url: 'https://cdn.modrinth.com/private-artifact.jar',
      filename: 'testmod.jar',
      size: 100,
      hashes: { sha1: 'a'.repeat(40) },
      primary: true,
    },
  ],
  dependencies: [],
};

describe('Mods HTTP catalog and mutation boundaries', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof managementFixture>>;
  let actor: typeof fixture.context;
  let serverId: string;
  let app: Hono<{ Variables: Variables }>;
  let runtime: Awaited<ReturnType<typeof createManagementRuntime>>;
  const json = vi.fn<ContentHttp['json']>();
  const download = vi.fn<ContentHttp['download']>();
  const providerRead = vi.fn();
  const base = () => `/v1/servers/${serverId}/minecraft/mods`;
  const mutation = (suffix: string, body: unknown = {}, method = 'POST') =>
    app.request(`${base()}${suffix}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.destroy();
  });
  beforeEach(async () => {
    json.mockReset();
    download.mockReset();
    providerRead.mockReset();
    fixture = await managementFixture(database.db, { interactive: true });
    actor = fixture.context;
    serverId = await fixture.server();
    const combinationId = randomUUID();
    await database.db
      .insertInto('minecraft_combinations')
      .values({
        id: combinationId,
        mapping_id: fixture.mappingId,
        identity_digest: '1'.repeat(64),
        mapping_digest: '2'.repeat(64),
        combination: JSON.stringify({
          release: '1.21.1',
          releaseType: 'release',
          protocolId: 767,
          family: 'netty',
          profile: 'fabric',
          loaderVersion: '0.16.10',
          javaMajor: 21,
          runtimeDigest: 'a'.repeat(64),
          protocolSource: { url: 'https://example.test/protocols', sha256: 'b'.repeat(64) },
        }),
        resolved_runtime: '{}',
        binding: '{}',
      })
      .execute();
    await database.db
      .insertInto('minecraft_server_profiles')
      .values({
        server_id: serverId,
        combination_id: combinationId,
        configuration: '{}',
        installed: true,
      })
      .execute();
    await storeSecret(database.db, fixture.owner, codec, 'curseforgeApiKey', 'isolated-mod-key');
    runtime = await createManagementRuntime({
      db: database.db,
      codec,
      env,
      adapter: { getServer: providerRead } as unknown as PterodactylAdapter,
    });
    json.mockImplementation(async (input) => {
      const path = new URL(input).pathname;
      if (path.endsWith('/search'))
        return {
          offset: 0,
          total_hits: 1,
          hits: [{ ...project, project_id: project.id, author: 'Fixture author' }],
        };
      if (path.endsWith('/project/testmod/version')) return [version];
      if (path.endsWith('/project/testmod')) return project;
      throw new Error(`Unexpected fixture provider URL: ${path}`);
    });
    app = new Hono<{ Variables: Variables }>();
    app.onError((error, c) => {
      if (!(error instanceof DomainError)) throw error;
      return c.json({ code: error.code }, error.status as 400);
    });
    registerMinecraftModRoutes(app, {
      db: database.db,
      env,
      codec,
      contentHttp: { json, download },
      management: async () => runtime,
      principal: async () => actor,
      body: async (c) => c.req.json(),
    });
  });

  it('exposes plugin catalogs and placeholders only for plugin runtimes, rejecting cross-mode writes', async () => {
    const profile = await database.db
      .selectFrom('minecraft_server_profiles')
      .select('combination_id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const combination = await database.db
      .selectFrom('minecraft_combinations')
      .select('combination')
      .where('id', '=', profile.combination_id)
      .executeTakeFirstOrThrow();
    await database.db
      .updateTable('minecraft_combinations')
      .set({
        combination: JSON.stringify({ ...(combination.combination as object), profile: 'paper' }),
      })
      .where('id', '=', profile.combination_id)
      .execute();
    const plugins = `/v1/servers/${serverId}/minecraft/plugins`;
    const catalog = await app.request(`${plugins}/catalog`);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({
      providers: [
        { id: 'modrinth', available: true },
        { id: 'hangar', available: true },
        { id: 'spiget', available: true },
        { id: 'curseforge', available: true },
        { id: 'voxel', available: false, comingSoon: true },
        { id: 'builtbybit', available: false, comingSoon: true },
      ],
    });
    for (const [path, body] of [
      [
        '/selection',
        { roots: [{ provider: 'voxel', projectId: 'test' }], idempotencyKey: randomUUID() },
      ],
      ['/changes', { path: 'mods/foreign.jar', action: 'delete', idempotencyKey: randomUUID() }],
      [
        '/toggle',
        { path: 'plugins/../outside.jar', action: 'disable', idempotencyKey: randomUUID() },
      ],
    ] as const) {
      const response = await app.request(`${plugins}${path}`, {
        method: path === '/selection' ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect((await app.request(`${plugins}/catalog/search?provider=voxel`)).status).toBe(400);
    expect(json).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(providerRead).not.toHaveBeenCalled();
  });

  it('serves typed metadata without provider secrets, signed URLs or filesystem checks', async () => {
    expect(await (await app.request(`${base()}/catalog`)).json()).toEqual({
      providers: [
        { id: 'modrinth', available: true },
        { id: 'curseforge', available: true },
      ],
    });
    expect(json).not.toHaveBeenCalled();
    for (const suffix of [
      '/catalog/search?provider=modrinth',
      '/catalog/modrinth/testmod',
      '/catalog/modrinth/testmod/versions',
    ]) {
      const response = await app.request(`${base()}${suffix}`);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(
        /isolated-mod-key|private-artifact|cdn\.modrinth|sha1/,
      );
    }
    expect(download).not.toHaveBeenCalled();
    expect(providerRead).not.toHaveBeenCalled();
  });

  it('rejects unknown inputs and bounded pagination before provider work', async () => {
    for (const suffix of [
      '/catalog/search?provider=other',
      '/catalog/search?provider=modrinth&offset=9981',
      '/catalog/search?provider=modrinth&url=https://example.test',
      '/catalog/modrinth/testmod/versions?preferBeta=anything',
      '/catalog/modrinth/testmod/versions?includeIncompatible=true&url=https://example.test',
      '/updates?preferBeta=anything',
      '/updates?url=https://example.test',
      '/alternatives/modrinth/testmod?revision=-1',
      '/alternatives/unknown/testmod?revision=1',
    ])
      expect((await app.request(`${base()}${suffix}`)).status).toBe(400);
    expect(
      (
        await mutation(
          '/selection',
          {
            roots: [],
            idempotencyKey: randomUUID(),
            artifactUrl: 'https://example.test',
          },
          'PUT',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await mutation('/changes', {
          path: '../server.jar',
          action: 'delete',
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(400);
    for (const body of [
      { path: '../server.jar', action: 'disable' },
      { path: 'mods/test.jar', action: 'delete' },
      { path: 'mods/test.jar', action: 'enable' },
      { path: 'mods/test.jar.disabled', action: 'disable' },
      { path: 'mods/test.jar', action: 'disable', revision: 1 },
    ])
      expect((await mutation('/toggle', { ...body, idempotencyKey: randomUUID() })).status).toBe(
        400,
      );
    expect(json).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it.each(['modrinth', 'curseforge'] as const)(
    'resolves %s alternatives through the real provider contract without changing the draft',
    async (provider) => {
      const projectId = provider === 'modrinth' ? 'testmod' : '238222';
      const versionId = provider === 'modrinth' ? 'version1' : '9193051';
      const selected = {
        roots: [{ provider, projectId, forceIncompatible: false, optionalProjectIds: [] }],
        preferBeta: false,
        idempotencyKey: randomUUID(),
      };
      await database.db
        .insertInto('minecraft_mod_drafts')
        .values({
          server_id: serverId,
          revision: 3,
          actor_user_id: actor.actorUserId,
          state: 'ready',
          selection: JSON.stringify(selected),
          blockers: '[]',
          optional: '[]',
          error: null,
        })
        .execute();
      if (provider === 'curseforge') {
        const file = {
          id: Number(versionId),
          modId: Number(projectId),
          gameId: 432,
          displayName: 'Fixture version',
          fileName: 'fixture.jar',
          fileLength: 100,
          fileDate: '2026-10-10T00:00:00Z',
          releaseType: 1,
          gameVersions: ['1.21.1', 'Fabric', 'Client', 'Server'],
          isAvailable: true,
          downloadUrl: 'https://mediafilez.forgecdn.net/files/fixture.jar',
          hashes: [{ algo: 1, value: 'a'.repeat(40) }],
          dependencies: [],
        };
        json.mockImplementation(async (input) => {
          const path = new URL(input).pathname;
          if (path.endsWith(`/mods/${projectId}`))
            return {
              data: {
                id: Number(projectId),
                gameId: 432,
                classId: 6,
                slug: 'fixture',
                name: 'Fixture',
                summary: '',
                downloadCount: 1,
                authors: [],
                isAvailable: true,
                latestFiles: [file],
              },
            };
          if (path.endsWith(`/mods/${projectId}/files`))
            return {
              data: [file],
              pagination: { index: 0, pageSize: 20, resultCount: 1, totalCount: 1 },
            };
          throw new Error(`Unexpected fixture provider URL: ${path}`);
        });
      }
      const response = await app.request(
        `${base()}/alternatives/${provider}/${projectId}?revision=3`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        revision: 3,
        provider,
        projectId,
        items: [{ id: versionId }],
        checked: 1,
        limited: false,
      });
      expect(providerRead).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
      const unchanged = await database.db
        .selectFrom('minecraft_mod_drafts')
        .selectAll()
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow();
      expect(unchanged.selection).toEqual(selected);
      expect(unchanged.revision).toBe(3);
      expect(
        await database.db
          .selectFrom('minecraft_mod_changes')
          .select('id')
          .where('server_id', '=', serverId)
          .execute(),
      ).toEqual([]);
    },
  );

  it('honors the Owner alternative limit and invalidates advice when that limit changes', async () => {
    const selected = {
      roots: [
        {
          provider: 'modrinth',
          projectId: 'testmod',
          forceIncompatible: false,
          optionalProjectIds: [],
        },
      ],
      preferBeta: false,
      idempotencyKey: randomUUID(),
    };
    await database.db
      .insertInto('minecraft_mod_drafts')
      .values({
        server_id: serverId,
        revision: 1,
        actor_user_id: actor.actorUserId,
        state: 'ready',
        selection: JSON.stringify(selected),
        blockers: '[]',
        optional: '[]',
        error: null,
      })
      .execute();
    json.mockImplementation(async (input) => {
      const path = new URL(input).pathname;
      if (path.endsWith('/project/testmod/version'))
        return [
          {
            ...version,
            dependencies: [
              { project_id: 'missing', version_id: null, dependency_type: 'required' },
            ],
          },
          { ...version, id: 'older', date_published: '2026-10-01T00:00:00Z' },
        ];
      if (path.endsWith('/project/testmod')) return project;
      if (path.endsWith('/project/missing')) return { ...project, id: 'missing', slug: 'missing' };
      if (path.endsWith('/project/missing/version')) return [];
      throw new Error(`Unexpected fixture provider URL: ${path}`);
    });
    await updateSettings(database.db, fixture.owner, { minecraftModAlternativeLimit: 1 }, env);
    const url = `${base()}/alternatives/modrinth/testmod?revision=1`;
    const limited = await app.request(url);
    expect(limited.status).toBe(200);
    expect(await limited.json()).toMatchObject({ checked: 1, items: [], limited: true });
    const requestCount = json.mock.calls.length;
    await updateSettings(database.db, fixture.owner, { minecraftModAlternativeLimit: 2 }, env);
    const expanded = await app.request(url);
    expect(expanded.status).toBe(200);
    expect(await expanded.json()).toMatchObject({
      checked: 2,
      items: [{ id: 'older' }],
      limited: false,
    });
    expect(json.mock.calls.length).toBeGreaterThan(requestCount);
    const expandedCount = json.mock.calls.length;
    expect((await app.request(url)).status).toBe(200);
    expect(json).toHaveBeenCalledTimes(expandedCount);
    expect(providerRead).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    const current = await database.db
      .selectFrom('minecraft_mod_drafts')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect(current.selection).toEqual(selected);
    expect(current.revision).toBe(1);
  });

  it('serves updates without Wings reads and protects cached advice after session revocation', async () => {
    await database.db
      .insertInto('minecraft_mod_receipts')
      .values({
        server_id: serverId,
        path: 'mods/testmod.jar',
        receipt: JSON.stringify({
          from: 'mods/source.pending',
          to: 'mods/testmod.jar',
          size: 100,
          modifiedAt: '2026-01-01T00:00:00Z',
          metadata: {
            provider: 'modrinth',
            projectId: 'testmod',
            versionId: 'oldversion',
            name: 'Fixture mod',
            version: '0.1',
            channel: 'release',
            side: 'both',
            tags: [],
            minecraftVersions: ['1.21.1'],
            loaders: ['fabric'],
          },
          dependency: false,
          requiredBy: [],
          forceIncompatible: false,
          incompatibilities: [],
          dependencies: [],
          conflicts: [],
        }),
      })
      .execute();
    const original = json.getMockImplementation();
    json.mockImplementation(async (url, ...args) => {
      if (new URL(url).pathname.endsWith('/version/oldversion'))
        return { ...version, id: 'oldversion', date_published: '2026-01-01T00:00:00Z' };
      if (!original) throw new Error('Missing fixture');
      return original(url, ...args);
    });
    const response = await app.request(`${base()}/updates?preferBeta=false`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        {
          path: 'mods/testmod.jar',
          currentVersionId: 'oldversion',
          status: 'update',
          version: { id: 'version1' },
        },
      ],
    });
    expect(providerRead).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    await database.db
      .deleteFrom('session')
      .where('id', '=', actor[authSessionId] ?? '')
      .execute();
    expect((await app.request(`${base()}/updates`)).status).toBe(401);
  });

  it('allows a shared viewer to browse but rejects every mutation and a foreign server', async () => {
    const other = await managementFixture(database.db, { interactive: true });
    actor = other.context;
    expect((await app.request(`${base()}/catalog`)).status).toBe(403);
    const projectId = randomUUID();
    await database.db
      .insertInto('projects')
      .values({
        id: projectId,
        owner_id: fixture.context.subjectUserId,
        name: 'Mods shared fixture',
      })
      .execute();
    await database.db
      .insertInto('project_members')
      .values({
        project_id: projectId,
        user_id: actor.subjectUserId,
        role: 'viewer',
      })
      .execute();
    await database.db
      .updateTable('managed_servers')
      .set({ project_id: projectId })
      .where('id', '=', serverId)
      .execute();
    expect((await app.request(`${base()}/catalog`)).status).toBe(200);
    expect(
      (await mutation('/selection', { roots: [], idempotencyKey: randomUUID() }, 'PUT')).status,
    ).toBe(403);
    expect((await mutation('/apply', { revision: 0, idempotencyKey: randomUUID() })).status).toBe(
      403,
    );
    expect(
      (
        await mutation('/changes', {
          path: 'mods/test.jar',
          action: 'disable',
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await mutation('/toggle', {
          path: 'mods/test.jar',
          action: 'disable',
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request(`${base()}/changes/${randomUUID()}`, { method: 'DELETE' })).status,
    ).toBe(403);
    expect((await mutation('/recover')).status).toBe(403);
    expect(providerRead).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('keeps restart status local without a receipt and rechecks revoked sessions', async () => {
    expect(await (await app.request(`${base()}/restart-status`)).json()).toEqual({
      required: false,
    });
    await database.db
      .deleteFrom('session')
      .where('id', '=', actor[authSessionId] ?? '')
      .execute();
    expect((await app.request(`${base()}/restart-status`)).status).toBe(401);
    expect(providerRead).not.toHaveBeenCalled();
  });

  it('inherits the application Origin boundary before resolving any mutation', async () => {
    const fullApp = createApp({
      database,
      identity: async () => {
        throw new Error('Origin rejection must precede authentication');
      },
      env,
      codec,
      origins: ['http://localhost:3999'],
      management: async () => runtime,
    });
    for (const origin of [undefined, 'https://foreign.example.test']) {
      const response = await fullApp.request(`${base()}/selection`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ roots: [], idempotencyKey: randomUUID() }),
      });
      expect(response.status).toBe(403);
      expect(
        (
          await fullApp.request(`${base()}/toggle`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
            body: JSON.stringify({
              path: 'mods/test.jar',
              action: 'disable',
              idempotencyKey: randomUUID(),
            }),
          })
        ).status,
      ).toBe(403);
    }
    expect(providerRead).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});
