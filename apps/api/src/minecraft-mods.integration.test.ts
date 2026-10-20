import { randomUUID } from 'node:crypto';
import type { ContentHttp } from '@nickhosting/content-providers';
import { authSessionId, DomainError, SecretCodec } from '@nickhosting/core';
import { storeSecret } from '@nickhosting/database';
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
    expect(json).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
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
    }
    expect(providerRead).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});
