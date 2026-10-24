import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ContentHttp, ModrinthProvider } from '@nickhosting/content-providers';
import { authSessionId, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  type ApplicationServer,
  type PterodactylAdapter,
  PterodactylError,
} from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { createMinecraftDatapackCatalogService } from './minecraft-datapack-catalog.js';
import { createMinecraftDatapackService } from './minecraft-datapacks.js';
import { createMinecraftSourceStore } from './minecraft-sources.js';
import { createManagementRuntime } from './runtime.js';
import { minecraftManagementFixture, pendingUploadFixture } from './test-fixtures.js';

// Real isolated PostgreSQL, authorization/runtime and source ingestion. Only the
// external provider's filesystem/console is substituted; no live game resources.
describe('Minecraft datapack durable preparation and publication', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let drainCleanup: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    drainCleanup = undefined;
    database = await createTestDatabase();
    root = `./mountdata/test-assets/datapack-integration-${randomUUID()}`;
    await mkdir(root, { recursive: true });
  });
  afterEach(async () => {
    await drainCleanup?.();
    await database?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function fixture(running = true) {
    const f = await minecraftManagementFixture(database.db, { interactive: true });
    const serverId = await f.server();
    await f.db
      .updateTable('managed_servers')
      .set({ runtime_state: running ? 'running' : 'offline' })
      .where('id', '=', serverId)
      .execute();
    await f.db
      .updateTable('physical_hosts')
      .set({
        local_disk_path: resolve(root),
        upload_policy: JSON.stringify({
          providerMaxFileBytes: 1024 ** 2,
          temporaryDiskPath: resolve(root),
          temporaryDiskBudgetBytes: 8 * 1024 ** 2,
          temporaryDiskHeadroomBytes: 0,
        }),
      })
      .where('id', '=', f.hostId)
      .execute();
    const combinationId = randomUUID();
    await f.db
      .insertInto('minecraft_combinations')
      .values({
        id: combinationId,
        mapping_id: f.mappingId,
        identity_digest: '1'.repeat(64),
        mapping_digest: '2'.repeat(64),
        combination: JSON.stringify({
          release: '1.21.1',
          releaseType: 'release',
          protocolId: 767,
          family: 'netty',
          profile: 'vanilla',
          javaMajor: 21,
          runtimeDigest: 'a'.repeat(64),
          protocolSource: { url: 'https://example.test/protocols', sha256: 'b'.repeat(64) },
        }),
        resolved_runtime: '{}',
        binding: '{}',
      })
      .execute();
    await f.db
      .insertInto('minecraft_server_profiles')
      .values({
        server_id: serverId,
        combination_id: combinationId,
        configuration: '{}',
        installed: true,
      })
      .execute();
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    const allocations = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    const remote = {
      id: server.pterodactyl_id,
      uuid: server.pterodactyl_uuid,
      identifier: server.pterodactyl_identifier,
      external_id: server.external_id,
      node: f.providerNodeId,
      user: server.provider_user_id,
      allocation: allocations.find((a) => a.is_primary)?.pterodactyl_allocation_id,
      relationships: {
        allocations: {
          data: allocations.map((a) => ({
            attributes: {
              id: a.pterodactyl_allocation_id,
              ip: a.address,
              port: a.port,
              assigned: true,
            },
          })),
        },
      },
    } as ApplicationServer;
    const files = new Map<string, Buffer>([
      ['server.properties', Buffer.from('level-name=world\n')],
      ['world/level.dat', Buffer.from([10, 0, 0, 10, 0, 4, 68, 97, 116, 97, 0, 0])],
    ]);
    const directories = new Set(['', 'world', 'world/datapacks']);
    const missing = () => new PterodactylError('not_found', 'client', 'rejected', 404);
    const listFiles = vi.fn(async (_id: string, path = '') => {
      if (!directories.has(path)) throw missing();
      const prefix = path ? `${path}/` : '';
      const names = new Set(
        [...files.keys(), ...directories]
          .filter((name) => name.startsWith(prefix) && name !== path)
          .map((name) => name.slice(prefix.length).split('/')[0] as string),
      );
      return [...names].map((name) => ({
        name,
        is_file: files.has(`${prefix}${name}`),
        is_symlink: false,
        size: files.get(`${prefix}${name}`)?.length ?? 0,
        modified_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        mimetype: 'application/octet-stream',
        mode: '-rw-r--r--',
        mode_bits: '644',
      }));
    });
    const renameFiles = vi.fn(
      async (_id: string, _root: string, moves: { from: string; to: string }[]) => {
        for (const { from, to } of moves) {
          if (files.has(from)) {
            files.set(to, files.get(from) as Buffer);
            files.delete(from);
          }
          if (directories.has(from)) {
            for (const path of [...files.keys()])
              if (path.startsWith(`${from}/`)) {
                files.set(`${to}${path.slice(from.length)}`, files.get(path) as Buffer);
                files.delete(path);
              }
            for (const path of [...directories])
              if (path === from || path.startsWith(`${from}/`)) {
                directories.add(`${to}${path.slice(from.length)}`);
                directories.delete(path);
              }
          }
        }
      },
    );
    const uploadFile = vi.fn(
      async (
        _id: string,
        path: string,
        value: { body: ReadableStream<Uint8Array>; authorize?: () => Promise<void> },
      ) => {
        await value.authorize?.();
        files.set(path, Buffer.from(await new Response(value.body).arrayBuffer()));
      },
    );
    const sendCommand = vi.fn(async () => {});
    const adapter = {
      ...f.adapter,
      getApplicationServer: async () => remote,
      listFiles,
      getDirectoryBatchSettings: async () => ({
        directoryBatchLimit: 48,
        directoryTimeoutSeconds: 5,
      }),
      listDirectoriesBatch: async (identifier: string, paths: string[]) =>
        Promise.all(
          paths.map(async (directory) => {
            try {
              return { directory, files: await listFiles(identifier, directory) };
            } catch (error) {
              if (error instanceof PterodactylError && error.reason === 'not_found')
                return { directory, error: 'not_found' };
              throw error;
            }
          }),
        ),
      renameFiles,
      uploadFile,
      sendCommand,
      getResources: async () => ({
        current_state: running ? 'running' : 'offline',
        is_suspended: false,
        resources: {
          disk_bytes: 0,
          memory_bytes: 0,
          cpu_absolute: 0,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
        },
      }),
      createDirectory: async (_id: string, path: string, name: string) => {
        directories.add([path, name].filter(Boolean).join('/'));
      },
      deleteFiles: async (_id: string, path: string, names: string[]) => {
        for (const name of names) {
          const target = [path, name].filter(Boolean).join('/');
          files.delete(target);
          directories.delete(target);
        }
      },
      readFileForEditor: async (_id: string, path: string) => {
        const data = files.get(path);
        if (!data) throw missing();
        return data;
      },
      downloadFile: async (_id: string, path: string) => {
        const data = files.get(path);
        if (!data) throw missing();
        return { body: new Response(Uint8Array.from(data)).body };
      },
      prefetchDownloads: async () => {},
    } as unknown as PterodactylAdapter;
    const env = {
      NH_OBSERVER_ID: 'isolated-observer',
      NH_CONTENT_SOURCE_ROOT: root,
      NH_CONTENT_SOURCE_FREE_BYTES: '0',
      NH_CONTENT_SOURCE_FREE_PERCENT: '0',
    };
    const runtime = await createManagementRuntime({
      db: f.db,
      adapter,
      codec: new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
      env,
    });
    const service = createMinecraftDatapackService({ db: f.db, runtime, env });
    drainCleanup = () => service.drainCleanup();
    async function draft(name: string, action: 'install' | 'disable' = 'install') {
      const id = randomUUID();
      const from = `world/datapacks/${name}${action === 'install' ? `.${id}.pending` : ''}`;
      const to = `world/datapacks/${name}${action === 'disable' ? '.disabled' : ''}`;
      files.set(from, Buffer.from('pack fixture'));
      await f.db
        .insertInto('minecraft_datapack_changes')
        .values({
          id,
          server_id: serverId,
          actor_user_id: f.context.actorUserId,
          world: 'world',
          name,
          action,
          state: 'ready',
          idempotency_key: randomUUID(),
          source_id: null,
          plan: JSON.stringify({ from, to, kind: 'zip', size: 12, metadata: null }),
          error: null,
        })
        .execute();
      return { id, from, to };
    }
    return {
      ...f,
      serverId,
      files,
      directories,
      service,
      runtime,
      adapter,
      env,
      renameFiles,
      uploadFile,
      sendCommand,
      listFiles,
      draft,
    };
  }

  async function catalogFixture() {
    const f = await fixture(false);
    const zip = new ZipFile();
    zip.addBuffer(
      Buffer.from('{"pack":{"pack_format":48,"description":"Dependency fixture"}}'),
      'pack.mcmeta',
    );
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const download = vi.fn(async (_artifact: unknown, path: string) => {
      await writeFile(path, bytes);
      return { sha256, size: bytes.length };
    });
    const http = { download } as unknown as ContentHttp;
    const provider = {
      resolveDatapackPlan: vi.fn(async () => ({
        plan: {
          provider: 'modrinth' as const,
          root: { projectId: 'root', versionId: 'r1' },
          gameVersion: '1.21.1',
          items: [
            {
              projectId: 'root',
              versionId: 'r1',
              name: 'Root',
              filename: 'root.zip',
              required: [{ projectId: 'dep', versionId: 'd1' }],
              conflicts: [],
            },
            {
              projectId: 'dep',
              versionId: 'd1',
              name: 'Dependency',
              filename: 'dep.zip',
              required: [],
              conflicts: [],
            },
          ],
          optional: [],
          embedded: [],
          blocked: [],
        },
        artifacts: ['root', 'dep'].map((projectId) => ({
          projectId,
          versionId: projectId === 'root' ? 'r1' : 'd1',
          path: `${projectId}.zip`,
          urls: [`https://cdn.example.test/${projectId}.zip`],
          size: bytes.length,
          hashes: { sha256 },
          kind: 'override' as const,
          serverSide: 'required' as const,
        })),
      })),
    } as unknown as ModrinthProvider;
    const catalog = createMinecraftDatapackCatalogService({
      db: f.db,
      runtime: f.runtime,
      env: f.env,
      http,
    });
    const request = {
      provider: 'modrinth' as const,
      projectId: 'root',
      versionId: 'r1',
      world: 'world',
    };
    return { ...f, download, provider, catalog, request };
  }
  it('resolves then stages complete graph, reuses drafts and applies without metadata or download requests', async () => {
    const f = await catalogFixture();
    const plan = await f.catalog.plan(f.context, f.serverId, f.request, f.provider);
    expect(plan.items.map((item) => item.disposition)).toEqual(['install', 'install']);
    const prepared = await f.catalog.acquire(f.context, f.serverId, {
      ...f.request,
      planId: plan.planId,
      idempotencyKey: 'graph',
    });
    expect(prepared.changes).toHaveLength(2);
    expect(f.download).toHaveBeenCalledTimes(2);
    const again = await f.catalog.plan(f.context, f.serverId, f.request, f.provider);
    expect(again.items.map((item) => item.disposition)).toEqual(['reuse', 'reuse']);
    await f.catalog.acquire(f.context, f.serverId, {
      ...f.request,
      planId: again.planId,
      idempotencyKey: 'graph-again',
    });
    expect(f.download).toHaveBeenCalledTimes(2);
    vi.mocked(f.provider.resolveDatapackPlan).mockClear();
    f.download.mockClear();
    await f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: 'publish' });
    expect(f.provider.resolveDatapackPlan).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.renameFiles.mock.calls[0]?.[2]).toHaveLength(2);
    // More than the former 2,000-row cutoff must not erase current dependency identities.
    await f.db
      .insertInto('minecraft_datapack_changes')
      .values(
        Array.from({ length: 2001 }, () => ({
          id: randomUUID(),
          server_id: f.serverId,
          actor_user_id: f.context.actorUserId,
          world: 'world',
          name: 'noise.zip',
          action: 'install' as const,
          state: 'applied' as const,
          idempotency_key: randomUUID(),
          source_id: null,
          plan: JSON.stringify({
            from: 'world/datapacks/noise.pending',
            to: 'world/datapacks/noise.zip',
            kind: 'zip',
            size: 1,
            metadata: null,
          }),
          error: null,
        })),
      )
      .execute();
    const installed = await f.catalog.plan(f.context, f.serverId, f.request, f.provider);
    expect(installed.items.map((item) => item.disposition)).toEqual(['reuse', 'reuse']);
  });
  it('rejects foreign/expired plans and does not publish a root whose required draft was cancelled', async () => {
    const f = await catalogFixture();
    const plan = await f.catalog.plan(f.context, f.serverId, f.request, f.provider);
    await expect(
      f.catalog.acquire({ ...f.context, subjectUserId: randomUUID() }, f.serverId, {
        ...f.request,
        planId: plan.planId,
        idempotencyKey: 'foreign',
      }),
    ).rejects.toMatchObject({ code: 'content_plan_expired' });
    const prepared = await f.catalog.acquire(f.context, f.serverId, {
      ...f.request,
      planId: plan.planId,
      idempotencyKey: 'graph',
    });
    const dep = prepared.changes.at(-1);
    if (!dep) throw new Error('missing dependency');
    await f.service.cancel(f.context, f.serverId, dep.changeId);
    await expect(
      f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: 'broken' }),
    ).rejects.toMatchObject({ code: 'content_dependency_missing' });
    expect(f.renameFiles).not.toHaveBeenCalled();
    const retry = await f.catalog.plan(f.context, f.serverId, f.request, f.provider);
    expect(retry.items.map((item) => item.disposition)).toEqual(['reuse', 'install']);
    await f.catalog.acquire(f.context, f.serverId, {
      ...f.request,
      planId: retry.planId,
      idempotencyKey: 'retry',
    });
    await f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: 'recovered' });
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
  });
  it('reports a conflicting unpublished draft as a discard requirement, not an impossible disable', async () => {
    const f = await catalogFixture();
    const plan = await f.catalog.plan(f.context, f.serverId, f.request, f.provider);
    await f.catalog.acquire(f.context, f.serverId, {
      ...f.request,
      planId: plan.planId,
      idempotencyKey: 'graph',
    });
    const original = await f.provider.resolveDatapackPlan('root', 'r1', '1.21.1');
    const other = {
      ...original,
      plan: {
        ...original.plan,
        root: { projectId: 'other', versionId: 'o1' },
        items: [
          {
            projectId: 'other',
            versionId: 'o1',
            name: 'Other',
            filename: 'other.zip',
            required: [],
            conflicts: [{ projectId: 'root' }],
          },
        ],
      },
    };
    vi.mocked(f.provider.resolveDatapackPlan).mockResolvedValue(other);
    const request = { ...f.request, projectId: 'other', versionId: 'o1' };
    const next = await f.catalog.plan(f.context, f.serverId, request, f.provider);
    expect(next.conflicts).toEqual([]);
    expect(next.blockers).toContainEqual(
      expect.objectContaining({ projectId: 'root', reason: 'prepared_conflict' }),
    );
    await expect(
      f.catalog.acquire(f.context, f.serverId, {
        ...request,
        planId: next.planId,
        idempotencyKey: 'blocked',
      }),
    ).rejects.toMatchObject({ code: 'content_dependency_missing' });
    expect(f.download).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a pack explicitly disabled by Minecraft native selection', async () => {
    const f = await catalogFixture();
    const plan = await f.catalog.plan(f.context, f.serverId, f.request, f.provider);
    await f.catalog.acquire(f.context, f.serverId, {
      ...f.request,
      planId: plan.planId,
      idempotencyKey: 'graph',
    });
    await f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: 'publish' });
    const dependency = await f.db
      .selectFrom('minecraft_datapack_changes')
      .select('name')
      .where('server_id', '=', f.serverId)
      .where('state', '=', 'applied')
      .where('name', 'like', 'modrinth-dep-%')
      .executeTakeFirstOrThrow();
    const text = (value: string) => {
      const bytes = Buffer.from(value);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(bytes.length);
      return Buffer.concat([length, bytes]);
    };
    f.files.set(
      'world/level.dat',
      Buffer.concat([
        Buffer.from([10, 0, 0, 10]),
        text('Data'),
        Buffer.from([10]),
        text('DataPacks'),
        Buffer.from([9]),
        text('Disabled'),
        Buffer.from([8, 0, 0, 0, 1]),
        text(`file/${dependency.name}`),
        Buffer.from([9]),
        text('Enabled'),
        Buffer.from([8, 0, 0, 0, 0]),
        Buffer.from([0, 0, 0]),
      ]),
    );
    const next = await f.catalog.plan(f.context, f.serverId, f.request, f.provider);
    expect(next.blockers).toContainEqual(
      expect.objectContaining({ projectId: 'dep', reason: 'native_disabled' }),
    );
  });

  it('prevents using a catalog source to bypass dependency planning through generic preparation', async () => {
    const f = await catalogFixture();
    const plan = await f.catalog.plan(f.context, f.serverId, f.request, f.provider);
    await f.catalog.acquire(f.context, f.serverId, {
      ...f.request,
      planId: plan.planId,
      idempotencyKey: 'graph',
    });
    const source = await f.db
      .selectFrom('minecraft_sources')
      .select('id')
      .where('server_id', '=', f.serverId)
      .where('provider_project_id', '=', 'root')
      .executeTakeFirstOrThrow();
    await expect(
      f.service.prepare(f.context, f.serverId, {
        world: 'world',
        action: 'install',
        sourceId: source.id,
        name: 'bypass.zip',
        idempotencyKey: 'bypass',
      }),
    ).rejects.toMatchObject({ code: 'content_dependency_missing' });
  });

  it.each([true, false])(
    'returns an empty inventory before the first world exists (properties present: %s)',
    async (propertiesPresent) => {
      const f = await fixture(false);
      f.files.delete('world/level.dat');
      f.directories.delete('world/datapacks');
      f.directories.delete('world');
      if (!propertiesPresent) f.files.delete('server.properties');
      expect(await f.service.snapshot(f.context, f.serverId)).toMatchObject({
        world: '',
        selectedWorld: 'world',
        worlds: [],
        running: false,
        supported: true,
        installed: true,
        packs: [],
        changes: [],
        reload: { state: 'not_required' },
      });
      expect(f.listFiles.mock.calls.map(([, path]) => path)).toEqual(['']);
      expect(f.renameFiles).not.toHaveBeenCalled();
      expect(f.uploadFile).not.toHaveBeenCalled();
      await expect(f.service.snapshot(f.context, f.serverId, 'world')).rejects.toMatchObject({
        code: 'not_found',
      });
    },
  );
  it('keeps unavailable world discovery distinct from an empty inventory', async () => {
    const f = await fixture(false);
    const batch = f.adapter.listDirectoriesBatch.bind(f.adapter);
    f.adapter.listDirectoriesBatch = async (...args) =>
      (await batch(...args)).map((result) =>
        result.directory === 'world'
          ? { directory: 'world', error: 'unavailable' as const }
          : result,
      );
    await expect(f.service.snapshot(f.context, f.serverId)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  });
  it('does not probe absent optional inventory directories and preserves failures for existing directories', async () => {
    const f = await fixture();
    f.directories.delete('world/datapacks');
    const batch = f.adapter.listDirectoriesBatch.bind(f.adapter);
    const unavailable = new Set<string>();
    f.adapter.listDirectoriesBatch = async (...args) =>
      (await batch(...args)).map((result) =>
        'error' in result || unavailable.has(result.directory)
          ? { directory: result.directory, error: 'unavailable' as const }
          : result,
      );
    expect((await f.service.snapshot(f.context, f.serverId)).packs).toEqual([]);
    expect(
      f.listFiles.mock.calls.some(
        ([, path]) => path === 'world/datapacks' || path?.startsWith('.nickhosting-datapacks'),
      ),
    ).toBe(false);
    f.directories.add('world/datapacks');
    unavailable.add('world/datapacks');
    await expect(f.service.snapshot(f.context, f.serverId)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  });
  it('publishes a prepared batch with one provider rename and one reload, and retries without replay', async () => {
    const f = await fixture();
    const a = await f.draft('one.zip'),
      b = await f.draft('two.zip');
    const input = { world: 'world', idempotencyKey: randomUUID() };
    expect(await f.service.apply(f.context, f.serverId, input)).toEqual({
      state: 'published',
      reload: 'requested',
    });
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.renameFiles.mock.calls[0]?.[2]).toHaveLength(2);
    expect(f.sendCommand).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'reload');
    expect(f.files.has(a.from)).toBe(false);
    expect(f.files.has(b.to)).toBe(true);
    await f.service.apply(f.context, f.serverId, input);
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
    expect(f.uploadFile).not.toHaveBeenCalled();
  });

  it('stages folder disable without moving it, then publishes outside Minecraft discovery', async () => {
    const f = await fixture();
    f.directories.add('world/datapacks/folder');
    f.files.set(
      'world/datapacks/folder/pack.mcmeta',
      Buffer.from('{"pack":{"pack_format":48,"description":"Fixture"}}'),
    );
    const input = {
      world: 'world',
      action: 'disable',
      path: 'world/datapacks/folder',
      idempotencyKey: randomUUID(),
    };
    const change = await f.service.prepare(f.context, f.serverId, input);
    expect(change.state).toBe('ready');
    expect(f.renameFiles).not.toHaveBeenCalled();
    expect(f.directories.has('world/datapacks/folder')).toBe(true);
    expect(await f.service.prepare(f.context, f.serverId, input)).toEqual(change);
    await f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() });
    expect(f.directories.has('world/datapacks/folder')).toBe(false);
    expect(f.files.has('.nickhosting-datapacks/world/disabled/folder/pack.mcmeta')).toBe(true);
  });

  it('rejects a collision before dispatch without overwriting the external file', async () => {
    const f = await fixture();
    const item = await f.draft('one.zip');
    f.files.set(item.to, Buffer.from('externally-created'));
    await expect(
      f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.renameFiles).not.toHaveBeenCalled();
    expect(f.files.get(item.to)?.toString()).toBe('externally-created');
  });

  it('records an unconfirmed provider rename as uncertain and never replays the batch', async () => {
    const f = await fixture();
    await f.draft('one.zip');
    f.renameFiles.mockImplementationOnce(async () => {}); // Wings can return 204 for a missing source.
    const input = { world: 'world', idempotencyKey: randomUUID() };
    await expect(f.service.apply(f.context, f.serverId, input)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(await f.service.apply(f.context, f.serverId, input)).toEqual({
      state: 'uncertain',
      reload: 'uncertain',
    });
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.sendCommand).not.toHaveBeenCalled();
    const row = await f.db
      .selectFrom('minecraft_datapack_changes')
      .select('state')
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('uncertain');
  });

  it('does not retry reload when the provider response is lost after publication', async () => {
    const f = await fixture();
    const item = await f.draft('one.zip');
    f.sendCommand.mockRejectedValueOnce(new Error('lost response'));
    const input = { world: 'world', idempotencyKey: randomUUID() };
    expect(await f.service.apply(f.context, f.serverId, input)).toEqual({
      state: 'published',
      reload: 'uncertain',
    });
    await f.service.apply(f.context, f.serverId, input);
    expect(f.files.has(item.to)).toBe(true);
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('authorizes again after preparation, rejecting revoked sessions before any publication', async () => {
    const f = await fixture();
    await f.draft('one.zip');
    await f.db
      .deleteFrom('session')
      .where('id', '=', f.context[authSessionId] as string)
      .execute();
    await expect(
      f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(f.renameFiles).not.toHaveBeenCalled();
    expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uploads and validates ZIP bytes without enabling them before Apply (missing datapacks directory: %s)',
    async (missingDatapacks) => {
      const f = await fixture(false);
      if (missingDatapacks) {
        f.directories.delete('world/datapacks');
        const batch = f.adapter.listDirectoriesBatch.bind(f.adapter);
        f.adapter.listDirectoriesBatch = async (...args) =>
          (await batch(...args)).map((result) =>
            'error' in result
              ? { directory: result.directory, error: 'unavailable' as const }
              : result,
          );
      }
      const zip = new ZipFile();
      zip.addBuffer(
        Buffer.from('{"pack":{"pack_format":48,"description":"Fixture"}}'),
        'pack.mcmeta',
      );
      zip.end();
      const chunks: Buffer[] = [];
      for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const sources = createMinecraftSourceStore(f.db, f.context, f.env, {
        observeDisk: async () => ({ available: 10n ** 12n, total: 10n ** 12n }),
      });
      const reserved = await sources.reserveUpload({
        kind: 'datapack',
        serverId: f.serverId,
        idempotencyKey: randomUUID(),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      await sources.upload(
        reserved.id,
        Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>,
        bytes.length,
      );
      const change = await f.service.prepare(f.context, f.serverId, {
        world: 'world',
        action: 'install',
        name: 'fixture.zip',
        sourceId: reserved.id,
        idempotencyKey: randomUUID(),
      });
      expect(change.state).toBe('ready');
      expect(f.uploadFile).toHaveBeenCalledTimes(1);
      const pendingPath = f.uploadFile.mock.calls[0]?.[1] ?? '';
      expect(pendingPath).toMatch(/^world\/datapacks\/fixture\.zip\.[a-f0-9-]+\.pending$/);
      expect(f.files.get(pendingPath)).toEqual(bytes);
      expect(f.files.has('world/datapacks/fixture.zip')).toBe(false);
      expect(f.renameFiles).not.toHaveBeenCalled();
      expect(f.sendCommand).not.toHaveBeenCalled();
      expect(
        await f.service.apply(f.context, f.serverId, {
          world: 'world',
          idempotencyKey: randomUUID(),
        }),
      ).toEqual({ state: 'published', reload: 'required' });
      expect(f.files.get('world/datapacks/fixture.zip')).toEqual(bytes);
      expect(f.sendCommand).not.toHaveBeenCalled();
    },
  );
  it('does not prepare the same pack twice under different request keys', async () => {
    const f = await fixture();
    f.files.set('world/datapacks/one.zip', Buffer.from('fixture'));
    const change = { world: 'world', action: 'disable', path: 'world/datapacks/one.zip' };
    await f.service.prepare(f.context, f.serverId, { ...change, idempotencyKey: randomUUID() });
    await expect(
      f.service.prepare(f.context, f.serverId, { ...change, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.renameFiles).not.toHaveBeenCalled();
  });

  it('reconciles unchanged files after uncertain response without retrying the external effect', async () => {
    const f = await fixture();
    const item = await f.draft('one.zip');
    f.renameFiles.mockImplementationOnce(async () => {});
    await expect(
      f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'operation_uncertain' });
    expect(await f.service.recover(f.context, f.serverId, { world: 'world' })).toEqual({
      recovered: 1,
      uncertain: 0,
    });
    expect(f.files.has(item.from)).toBe(true);
    expect(f.files.has(item.to)).toBe(false);
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.sendCommand).not.toHaveBeenCalled();
    const row = await f.db
      .selectFrom('minecraft_datapack_changes')
      .select('state')
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('ready');
  });

  it('reconciles publication after a lost response without replaying rename or reload', async () => {
    const f = await fixture();
    const item = await f.draft('one.zip');
    f.renameFiles.mockImplementationOnce(async () => {
      f.files.set(item.to, f.files.get(item.from) as Buffer);
      f.files.delete(item.from);
      throw new Error('connection lost after write');
    });
    await expect(
      f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'operation_uncertain' });
    expect(await f.service.recover(f.context, f.serverId, { world: 'world' })).toEqual({
      recovered: 1,
      uncertain: 0,
    });
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.sendCommand).not.toHaveBeenCalled();
    const row = await f.db
      .selectFrom('minecraft_datapack_changes')
      .select('state')
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('applied');
  });

  it('requires an explicit replacement and retires its old bytes before publishing new bytes', async () => {
    const f = await fixture();
    const item = await f.draft('one.zip');
    const previous = Buffer.from('previous pack');
    f.files.set(item.to, previous);
    const retired = `.nickhosting-datapacks/world/retired/${item.id}-one.zip`;
    for (const path of [
      '.nickhosting-datapacks',
      '.nickhosting-datapacks/world',
      '.nickhosting-datapacks/world/retired',
    ])
      f.directories.add(path);
    await f.db
      .updateTable('minecraft_datapack_changes')
      .set({
        plan: JSON.stringify({
          from: item.from,
          to: item.to,
          kind: 'zip',
          size: 12,
          metadata: null,
          replacement: { from: item.to, to: retired, kind: 'zip', size: previous.length },
        }),
      })
      .where('id', '=', item.id)
      .execute();
    await f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() });
    expect(f.renameFiles).toHaveBeenCalledTimes(2);
    expect(f.renameFiles.mock.calls[0]?.[2]).toEqual([{ from: item.to, to: retired }]);
    expect(f.renameFiles.mock.calls[1]?.[2]).toEqual([{ from: item.from, to: item.to }]);
    expect(f.files.get(item.to)?.toString()).toBe('pack fixture');
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('never requests a reload of the active world when publishing to a different world', async () => {
    const f = await fixture();
    f.directories.add('spare');
    f.directories.add('spare/datapacks');
    f.files.set('spare/level.dat', f.files.get('world/level.dat') as Buffer);
    f.files.set('spare/datapacks/one.zip', Buffer.from('pack fixture'));
    await f.service.prepare(f.context, f.serverId, {
      world: 'spare',
      action: 'disable',
      path: 'spare/datapacks/one.zip',
      idempotencyKey: randomUUID(),
    });
    expect(
      await f.service.apply(f.context, f.serverId, {
        world: 'spare',
        idempotencyKey: randomUUID(),
      }),
    ).toEqual({ state: 'published', reload: 'not_required' });
    expect(f.sendCommand).not.toHaveBeenCalled();
  });
  it('rejects session revocation during directory preparation before sending any rename', async () => {
    const f = await fixture();
    await f.draft('one.zip');
    const original = f.listFiles.getMockImplementation();
    f.listFiles.mockImplementationOnce(async (identifier, path) => {
      const entries = await original?.(identifier, path);
      await f.db
        .deleteFrom('session')
        .where('id', '=', f.context[authSessionId] as string)
        .execute();
      return entries ?? [];
    });
    await expect(
      f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(f.renameFiles).not.toHaveBeenCalled();
    expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it('discovers manually installed folders and ZIPs without claiming they are loaded', async () => {
    const f = await fixture();
    f.files.set('world/datapacks/manual.zip', Buffer.from('manual fixture'));
    f.directories.add('world/datapacks/folder');
    f.files.set(
      'world/datapacks/folder/pack.mcmeta',
      Buffer.from('{"pack":{"pack_format":48,"description":"Fixture"}}'),
    );
    const pending = await f.draft('staged.zip');
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot.packs.map((pack) => pack.name).sort()).toEqual(['folder', 'manual.zip']);
    expect(snapshot.packs.every((pack) => pack.nativeState === 'unknown')).toBe(true);
    expect(snapshot.changes).toContainEqual(
      expect.objectContaining({ id: pending.id, state: 'ready' }),
    );
    expect(snapshot.packs.find((pack) => pack.name === 'folder')?.compatibility).toBe('compatible');
    expect(f.renameFiles).not.toHaveBeenCalled();
  });
  it('allows explicit discard of interrupted preparation without pretending it was completed', async () => {
    const f = await fixture();
    const item = await f.draft('interrupted.zip');
    await f.db
      .updateTable('minecraft_datapack_changes')
      .set({ state: 'preparing' })
      .where('id', '=', item.id)
      .execute();
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot.changes).toContainEqual(
      expect.objectContaining({ id: item.id, state: 'preparing', cancellable: true }),
    );
    await f.service.cancel(f.context, f.serverId, item.id);
    expect(f.files.has(item.from)).toBe(false);
    expect(f.files.has(item.to)).toBe(false);
    expect(
      (
        await f.db
          .selectFrom('minecraft_datapack_changes')
          .select('state')
          .where('id', '=', item.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('cancelled');
    expect(f.renameFiles).not.toHaveBeenCalled();
    expect(f.sendCommand).not.toHaveBeenCalled();
  });
  it('discards unpublished uncertain bytes while retaining an unproven ingestion capacity claim', async () => {
    const f = await fixture();
    const item = await f.draft('interrupted.zip');
    await f.db
      .updateTable('minecraft_datapack_changes')
      .set({ state: 'uncertain' })
      .where('id', '=', item.id)
      .execute();
    const claimId = await pendingUploadFixture(f.db, f.serverId);
    expect((await f.service.snapshot(f.context, f.serverId)).changes).toContainEqual(
      expect.objectContaining({ id: item.id, cancellable: true }),
    );
    await f.service.cancel(f.context, f.serverId, item.id);
    expect(f.files.has(item.from)).toBe(false);
    expect(
      await f.db
        .selectFrom('upload_ingestion_claims')
        .select('id')
        .where('id', '=', claimId)
        .executeTakeFirst(),
    ).toEqual({ id: claimId });
    expect(f.sendCommand).not.toHaveBeenCalled();
  });
  it('refuses discarding a change after its publication dispatch fence', async () => {
    const f = await fixture();
    const item = await f.draft('fenced.zip');
    f.renameFiles.mockImplementationOnce(async () => {});
    await expect(
      f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'operation_uncertain' });
    expect((await f.service.snapshot(f.context, f.serverId)).changes).toContainEqual(
      expect.objectContaining({ id: item.id, cancellable: false }),
    );
    await expect(f.service.cancel(f.context, f.serverId, item.id)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.files.has(item.from)).toBe(true);
  });
  it('restores the retired original after replacement publication fails, then permits an explicit retry', async () => {
    const f = await fixture();
    const item = await f.draft('one.zip');
    const previous = Buffer.from('original bytes');
    f.files.set(item.to, previous);
    const retired = `.nickhosting-datapacks/world/retired/${item.id}-one.zip`;
    for (const path of [
      '.nickhosting-datapacks',
      '.nickhosting-datapacks/world',
      '.nickhosting-datapacks/world/retired',
    ])
      f.directories.add(path);
    await f.db
      .updateTable('minecraft_datapack_changes')
      .set({
        plan: JSON.stringify({
          from: item.from,
          to: item.to,
          kind: 'zip',
          size: 12,
          metadata: null,
          replacement: {
            from: item.to,
            to: retired,
            kind: 'zip',
            size: previous.length,
            modifiedAt: '2026-01-01T00:00:00Z',
          },
        }),
      })
      .where('id', '=', item.id)
      .execute();
    const rename = f.renameFiles.getMockImplementation();
    f.renameFiles
      .mockImplementationOnce(async (...args) => {
        await rename?.(...args);
      })
      .mockImplementationOnce(async () => {
        throw new Error('publication unavailable');
      });
    await expect(
      f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'operation_uncertain' });
    expect(f.files.has(item.to)).toBe(false);
    expect(f.files.get(retired)).toEqual(previous);
    expect(await f.service.recover(f.context, f.serverId, { world: 'world' })).toEqual({
      recovered: 1,
      uncertain: 0,
    });
    expect(f.files.get(item.to)).toEqual(previous);
    expect(f.files.has(retired)).toBe(false);
    expect(f.files.has(item.from)).toBe(true);
    expect(f.renameFiles.mock.calls.at(-1)?.[2]).toEqual([{ from: retired, to: item.to }]);
    expect(f.sendCommand).not.toHaveBeenCalled();
    await f.service.drainCleanup();
    await f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() });
    expect(f.files.get(item.to)?.toString()).toBe('pack fixture');
  });
  it('never lets delayed cleanup from a restored attempt delete the rollback file of a failed retry', async () => {
    const f = await fixture();
    const item = await f.draft('one.zip');
    const previous = Buffer.from('original bytes');
    const retired = `.nickhosting-datapacks/world/retired/${item.id}-one.zip`;
    f.files.set(item.to, previous);
    for (const path of [
      '.nickhosting-datapacks',
      '.nickhosting-datapacks/world',
      '.nickhosting-datapacks/world/retired',
    ])
      f.directories.add(path);
    await f.db
      .updateTable('minecraft_datapack_changes')
      .set({
        plan: JSON.stringify({
          from: item.from,
          to: item.to,
          kind: 'zip',
          size: 12,
          metadata: null,
          replacement: { from: item.to, to: retired, kind: 'zip', size: previous.length },
        }),
      })
      .where('id', '=', item.id)
      .execute();
    const rename = f.renameFiles.getMockImplementation();
    const failPublication = () =>
      f.renameFiles
        .mockImplementationOnce(async (...args) => {
          await rename?.(...args);
        })
        .mockImplementationOnce(async () => {
          throw new Error('publication unavailable');
        });
    failPublication();
    await expect(
      f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'operation_uncertain' });
    await f.service.recover(f.context, f.serverId, { world: 'world' });
    const oldApply = await f.db
      .selectFrom('minecraft_datapack_applies')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(oldApply.cleanup).toEqual([]);
    expect(oldApply.cleanup_state).toBe('complete');
    // A stale receipt from a previous process must also be harmless even if its
    // already scheduled cleanup acquires the lock only after the next failure.
    await f.db
      .updateTable('minecraft_datapack_applies')
      .set({ cleanup: JSON.stringify([retired]), cleanup_state: 'pending' })
      .where('id', '=', oldApply.id)
      .execute();
    await f.service.recover(f.context, f.serverId, { world: 'world' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const access = f.runtime.fileMutationAccess;
    const accessSpy = vi
      .spyOn(f.runtime, 'fileMutationAccess')
      .mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return access(...args);
      });
    await acquired;
    try {
      failPublication();
      await expect(
        f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'operation_uncertain' });
      expect(f.files.get(retired)).toEqual(previous);
    } finally {
      release();
      await f.service.drainCleanup();
      accessSpy.mockRestore();
    }
    expect(f.files.get(retired)).toEqual(previous);
    expect(f.files.has(item.to)).toBe(false);
    expect(f.files.has(item.from)).toBe(true);
    expect(await f.service.recover(f.context, f.serverId, { world: 'world' })).toMatchObject({
      recovered: 1,
      uncertain: 0,
    });
    expect(f.files.get(item.to)).toEqual(previous);
  });
  it('keeps replacement of an installed disabled ZIP disabled', async () => {
    const f = await fixture(false);
    const zip = new ZipFile();
    zip.addBuffer(
      Buffer.from('{"pack":{"pack_format":48,"description":"Updated"}}'),
      'pack.mcmeta',
    );
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const sources = createMinecraftSourceStore(f.db, f.context, f.env, {
      observeDisk: async () => ({ available: 10n ** 12n, total: 10n ** 12n }),
    });
    const source = await sources.reserveUpload({
      kind: 'datapack',
      serverId: f.serverId,
      idempotencyKey: randomUUID(),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    await sources.upload(
      source.id,
      Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>,
      bytes.length,
    );
    f.files.set('world/datapacks/fixture.zip.disabled', Buffer.from('old disabled'));
    const change = await f.service.prepare(f.context, f.serverId, {
      world: 'world',
      action: 'install',
      name: 'fixture.zip',
      path: 'world/datapacks/fixture.zip.disabled',
      sourceId: source.id,
      idempotencyKey: randomUUID(),
    });
    const row = await f.db
      .selectFrom('minecraft_datapack_changes')
      .select('plan')
      .where('id', '=', change.changeId)
      .executeTakeFirstOrThrow();
    expect(row.plan).toMatchObject({ to: 'world/datapacks/fixture.zip.disabled' });
    await f.service.apply(f.context, f.serverId, { world: 'world', idempotencyKey: randomUUID() });
    expect(f.files.get('world/datapacks/fixture.zip.disabled')).toEqual(bytes);
    expect(f.files.has('world/datapacks/fixture.zip')).toBe(false);
  });
});
