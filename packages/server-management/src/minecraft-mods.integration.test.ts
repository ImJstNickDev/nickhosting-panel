import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type ContentHttp,
  CurseForgeProvider,
  ModrinthProvider,
} from '@nickhosting/content-providers';
import { authSessionId, SecretCodec } from '@nickhosting/core';
import { updateSettings } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  type ApplicationServer,
  type PterodactylAdapter,
  PterodactylError,
} from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { createMinecraftModsService } from './minecraft-mods.js';
import { createManagementRuntime } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

// Real isolated PostgreSQL, authorization/runtime and source ingestion. Only the
// external provider's filesystem/console is substituted; no live game resources.
describe('Minecraft Mods durable preparation and publication', () => {
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
    vi.restoreAllMocks();
    await database?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function fixture(running = true) {
    const f = await managementFixture(database.db, { interactive: true });
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
    const directories = new Set(['', 'world', 'world/datapacks', 'mods']);
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
    const service = createMinecraftModsService({ db: f.db, runtime, env });
    drainCleanup = () => service.drain();
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
    };
  }

  async function catalogFixture(environment = '*') {
    const f = await fixture();
    const zip = new ZipFile();
    zip.addBuffer(
      Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'fixture', version: '1.0', environment })),
      'fabric.mod.json',
    );
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifact = {
      path: 'mods/example.jar',
      urls: ['https://example.test/example.jar'],
      size: bytes.length,
      hashes: { sha256 },
      projectId: 'example',
      versionId: 'v1',
      kind: 'mod' as const,
      serverSide: 'required' as const,
    };
    const http = {
      json: async () => {
        throw new Error('Unexpected provider JSON');
      },
      download: vi.fn(async (_artifact: unknown, path: string) => {
        await writeFile(path, bytes);
        return { size: bytes.length, sha256 };
      }),
    } as unknown as ContentHttp;
    const project = {
      provider: 'modrinth' as const,
      id: 'example',
      name: 'Example',
      summary: 'Example mod',
      websiteUrl: 'https://example.test',
      authors: [],
      downloads: 1,
      tags: [
        {
          id: 'technology',
          label: 'Technology',
          source: 'modrinth' as const,
          original: 'technology',
        },
      ],
      environment: { kind: 'both' as const, source: 'modrinth' as const, original: [] },
    };
    const version = {
      provider: 'modrinth' as const,
      id: 'v1',
      projectId: 'example',
      name: 'Example 1',
      version: '1.0',
      filename: 'example.jar',
      gameVersions: ['1.21.1'],
      loaders: ['fabric'],
      publishedAt: '2026-01-01T00:00:00Z',
      bytes: bytes.length,
      channel: 'release' as const,
      available: true,
      compatibility: [],
      environment: project.environment,
    };
    const resolution = {
      plan: {
        format: 'individual' as const,
        target: { minecraftVersion: '1.21.1', loader: 'fabric' as const },
        artifacts: [artifact],
        overrides: [],
        projects: [],
        warnings: [],
      },
      catalog: {
        items: [
          {
            project,
            version,
            root: true,
            forced: false,
            requiredBy: [],
            dependencies: [],
            conflicts: [],
          },
        ],
        optional: [],
        embedded: [],
        blocked: [],
      },
    };
    const resolve = vi
      .spyOn(ModrinthProvider.prototype, 'resolveMods')
      .mockResolvedValue(resolution);
    const service = createMinecraftModsService({ db: f.db, runtime: f.runtime, env: f.env, http });
    drainCleanup = () => service.drain();
    const select = (roots = [{ provider: 'modrinth', projectId: 'example' }]) =>
      service.select(f.context, f.serverId, {
        roots,
        preferBeta: false,
        idempotencyKey: randomUUID(),
      });
    return { ...f, service, http, bytes, artifact, project, version, resolution, resolve, select };
  }
  async function installedMod(
    f: Awaited<ReturnType<typeof fixture>>,
    path: string,
    projectId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const bytes = Buffer.from(`fixture-${projectId}`);
    f.files.set(path, bytes);
    const plan = {
      from: path,
      to: path,
      size: bytes.length,
      modifiedAt: '2026-01-01T00:00:00Z',
      metadata: {
        provider: 'modrinth',
        projectId,
        versionId: 'v1',
        name: projectId,
        version: '1.0',
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
      aliases: [],
      retired: [],
      reuse: false,
      runtimeModId: projectId,
      runtimeModVersion: '1.0',
      target: { minecraftVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.10' },
      ...overrides,
    };
    await f.db
      .insertInto('minecraft_mod_receipts')
      .values({
        server_id: f.serverId,
        path,
        receipt: JSON.stringify(plan),
      })
      .execute();
    return plan;
  }

  it('toggles in both directions without a draft, preserves receipts and confirms idempotent replay', async () => {
    const f = await fixture();
    const receipt = await installedMod(f, 'mods/local.jar', 'local');
    const disabled = { path: 'mods/local.jar', action: 'disable', idempotencyKey: randomUUID() };
    expect(await f.service.toggle(f.context, f.serverId, disabled)).toEqual({
      state: 'published',
      path: 'mods/local.jar.disabled',
      restartRequired: true,
    });
    expect(f.files.has('mods/local.jar')).toBe(false);
    expect(f.files.has('mods/local.jar.disabled')).toBe(true);
    expect(f.renameFiles).toHaveBeenCalledExactlyOnceWith(expect.any(String), '', [
      { from: 'mods/local.jar', to: 'mods/local.jar.disabled' },
    ]);
    await f.service.drain();
    f.listFiles.mockClear();
    expect((await f.service.toggle(f.context, f.serverId, disabled)).state).toBe('published');
    expect(f.listFiles).not.toHaveBeenCalled();
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    await expect(
      f.service.toggle(f.context, f.serverId, { ...disabled, path: 'mods/other.jar' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await f.service.toggle(f.context, f.serverId, {
        path: 'mods/local.jar.disabled',
        action: 'enable',
        idempotencyKey: randomUUID(),
      }),
    ).toEqual({ state: 'published', path: 'mods/local.jar', restartRequired: true });
    const stored = await f.db
      .selectFrom('minecraft_mod_receipts')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(stored.path).toBe('mods/local.jar');
    expect(stored.receipt).toMatchObject({
      metadata: receipt.metadata,
      runtimeModId: 'local',
      runtimeModVersion: '1.0',
      target: receipt.target,
    });
    expect(
      await f.db
        .selectFrom('minecraft_mod_drafts')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
    ).toEqual([]);
    expect(
      await f.db
        .selectFrom('minecraft_mod_restart')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
    ).toHaveLength(1);
    const audits = await f.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'minecraft.mods.applied')
      .execute();
    expect(audits).toHaveLength(2);
    expect(
      audits.every(
        (event) =>
          event.actor_user_id === f.context.actorUserId &&
          event.metadata.serverId === f.serverId &&
          event.metadata.count === 1,
      ),
    ).toBe(true);
    expect(audits.map((event) => event.metadata.paths)).toEqual(
      expect.arrayContaining([['mods/local.jar.disabled'], ['mods/local.jar']]),
    );
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.uploadFile).not.toHaveBeenCalled();
  });

  it('publishes only the toggle and preserves an unrelated ready installation and its selection', async () => {
    const f = await catalogFixture();
    const selected = await f.select();
    await f.service.drain();
    await installedMod(f, 'mods/local.jar', 'local');
    const beforeDraft = await f.db
      .selectFrom('minecraft_mod_drafts')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    const beforeChanges = await f.db
      .selectFrom('minecraft_mod_changes')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .execute();
    expect(
      await f.service.toggle(f.context, f.serverId, {
        path: 'mods/local.jar',
        action: 'disable',
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ state: 'published' });
    expect(
      await f.db
        .selectFrom('minecraft_mod_drafts')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeDraft);
    expect(
      await f.db
        .selectFrom('minecraft_mod_changes')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .where('action', '=', 'install')
        .execute(),
    ).toEqual(beforeChanges);
    expect(f.files.has('mods/example.jar')).toBe(false);
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
    await f.service.apply(f.context, f.serverId, {
      revision: selected.revision,
      idempotencyKey: randomUUID(),
    });
    expect(f.files.has('mods/example.jar')).toBe(true);
    expect(f.files.has('mods/local.jar.disabled')).toBe(true);
  });

  it('validates the installed graph only, neither queued dependencies nor planned removals count', async () => {
    const f = await catalogFixture();
    await f.select();
    await f.service.drain();
    await installedMod(f, 'mods/dependent.jar.disabled', 'dependent', {
      dependencies: [{ provider: 'modrinth', projectId: 'example' }],
    });
    await expect(
      f.service.toggle(f.context, f.serverId, {
        path: 'mods/dependent.jar.disabled',
        action: 'enable',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'content_dependency_missing' });
    expect(f.renameFiles).not.toHaveBeenCalled();
    await installedMod(f, 'mods/required.jar', 'required');
    await installedMod(f, 'mods/other.jar', 'other', {
      dependencies: [{ provider: 'modrinth', projectId: 'required' }],
    });
    await f.service.change(f.context, f.serverId, {
      path: 'mods/other.jar',
      action: 'delete',
      idempotencyKey: randomUUID(),
    });
    await expect(
      f.service.toggle(f.context, f.serverId, {
        path: 'mods/required.jar',
        action: 'disable',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'content_dependency_missing' });
    expect(f.renameFiles).not.toHaveBeenCalled();
    expect(f.files.has('mods/required.jar')).toBe(true);
  });

  it('keeps conflicting enabled dependencies protected while enabling an installed mod', async () => {
    const f = await fixture();
    await installedMod(f, 'mods/first.jar', 'first');
    await installedMod(f, 'mods/second.jar.disabled', 'second', {
      conflicts: [{ provider: 'modrinth', projectId: 'first' }],
    });
    await expect(
      f.service.toggle(f.context, f.serverId, {
        path: 'mods/second.jar.disabled',
        action: 'enable',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'content_dependency_conflict' });
    expect(f.renameFiles).not.toHaveBeenCalled();
  });

  it('refreshes only draft graph blockers after toggling without re-resolving or consuming the queue', async () => {
    const f = await catalogFixture();
    await installedMod(f, 'mods/local.jar', 'local', {
      conflicts: [{ provider: 'modrinth', projectId: 'example' }],
    });
    await f.select();
    await f.service.drain();
    const before = await f.db
      .selectFrom('minecraft_mod_drafts')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(before.blockers).toContainEqual(
      expect.objectContaining({ source: 'graph', reason: 'conflict' }),
    );
    const catalogBlocker = { projectId: 'unavailable', name: 'unavailable', reason: 'unavailable' };
    await f.db
      .updateTable('minecraft_mod_drafts')
      .set({
        blockers: JSON.stringify([...(before.blockers as object[]), catalogBlocker]),
      })
      .where('server_id', '=', f.serverId)
      .execute();
    await f.service.toggle(f.context, f.serverId, {
      path: 'mods/local.jar',
      action: 'disable',
      idempotencyKey: randomUUID(),
    });
    const after = await f.db
      .selectFrom('minecraft_mod_drafts')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ ...before, blockers: [catalogBlocker] });
    await f.service.toggle(f.context, f.serverId, {
      path: 'mods/local.jar.disabled',
      action: 'enable',
      idempotencyKey: randomUUID(),
    });
    const restored = await f.db
      .selectFrom('minecraft_mod_drafts')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(restored.blockers).toContainEqual(catalogBlocker);
    expect(restored.blockers).toContainEqual(
      expect.objectContaining({ source: 'graph', reason: 'conflict' }),
    );
    expect(restored.selection).toEqual(before.selection);
    expect(f.files.has('mods/example.jar')).toBe(false);
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('invalidates the preparing inventory cache immediately after a confirmed toggle', async () => {
    const f = await catalogFixture();
    await installedMod(f, 'mods/local.jar', 'local');
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const download = vi.mocked(f.http.download).getMockImplementation();
    vi.mocked(f.http.download).mockImplementationOnce(async (...args) => {
      started();
      await held;
      if (!download) throw new Error('Missing download fixture');
      return download(...args);
    });
    try {
      await f.select();
      await pending;
      const initial = await f.service.snapshot(f.context, f.serverId);
      expect(initial.preparing).toBe(true);
      expect(initial.packs[0]?.state).toBe('enabled');
      await f.service.toggle(f.context, f.serverId, {
        path: 'mods/local.jar',
        action: 'disable',
        idempotencyKey: randomUUID(),
      });
      const next = await f.service.snapshot(f.context, f.serverId);
      expect(next.preparing).toBe(true);
      expect(next.packs[0]).toMatchObject({ path: 'mods/local.jar.disabled', state: 'disabled' });
    } finally {
      release();
      await f.service.drain();
    }
  });

  it('rejects pending update retirement collisions and an existing destination without renaming', async () => {
    const f = await catalogFixture();
    await f.select();
    await f.service.drain();
    await installedMod(f, 'mods/local.jar', 'local');
    const pending = await f.db
      .selectFrom('minecraft_mod_changes')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('minecraft_mod_changes')
      .set({
        plan: JSON.stringify({
          ...(pending.plan as object),
          retired: [{ from: 'mods/local.jar', to: 'mods/.retired', size: 13 }],
        }),
      })
      .where('id', '=', pending.id)
      .execute();
    await expect(
      f.service.toggle(f.context, f.serverId, {
        path: 'mods/local.jar',
        action: 'disable',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await installedMod(f, 'mods/other.jar', 'other');
    f.files.set('mods/other.jar.disabled', Buffer.from('foreign'));
    await expect(
      f.service.toggle(f.context, f.serverId, {
        path: 'mods/other.jar',
        action: 'disable',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.renameFiles).not.toHaveBeenCalled();
  });

  it('recovers a lost toggle response without replay or consuming unrelated interrupted preparation', async () => {
    const f = await catalogFixture();
    await f.select();
    await f.service.drain();
    await f.db
      .updateTable('minecraft_mod_drafts')
      .set({ state: 'preparing' })
      .where('server_id', '=', f.serverId)
      .execute();
    await f.db
      .updateTable('minecraft_mod_changes')
      .set({ state: 'queued' })
      .where('server_id', '=', f.serverId)
      .execute();
    const beforeDraft = await f.db
      .selectFrom('minecraft_mod_drafts')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    const beforeQueue = await f.db
      .selectFrom('minecraft_mod_changes')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .execute();
    await installedMod(f, 'mods/local.jar', 'local');
    const rename = f.renameFiles.getMockImplementation();
    f.renameFiles.mockImplementationOnce(async (...args) => {
      await rename?.(...args);
      throw new Error('response lost after rename');
    });
    const input = { path: 'mods/local.jar', action: 'disable', idempotencyKey: randomUUID() };
    expect(await f.service.toggle(f.context, f.serverId, input)).toEqual({
      state: 'uncertain',
      path: 'mods/local.jar.disabled',
      restartRequired: false,
    });
    expect((await f.service.snapshot(f.context, f.serverId)).changes).toContainEqual(
      expect.objectContaining({ action: 'disable', state: 'uncertain', immediate: true }),
    );
    expect((await f.service.toggle(f.context, f.serverId, input)).state).toBe('uncertain');
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(await f.service.recover(f.context, f.serverId)).toEqual({ recovered: 1, uncertain: 0 });
    expect(
      await f.db
        .selectFrom('minecraft_mod_drafts')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeDraft);
    expect(
      await f.db
        .selectFrom('minecraft_mod_changes')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .where('action', '=', 'install')
        .execute(),
    ).toEqual(beforeQueue);
    expect((await f.service.toggle(f.context, f.serverId, input)).state).toBe('published');
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed unconfirmed toggle fenced when no publication can be proved', async () => {
    const f = await fixture();
    await installedMod(f, 'mods/local.jar', 'local');
    f.renameFiles.mockRejectedValueOnce(new Error('transport interrupted'));
    const input = { path: 'mods/local.jar', action: 'disable', idempotencyKey: randomUUID() };
    expect((await f.service.toggle(f.context, f.serverId, input)).state).toBe('uncertain');
    expect(await f.service.recover(f.context, f.serverId)).toEqual({ recovered: 0, uncertain: 1 });
    expect((await f.service.toggle(f.context, f.serverId, input)).state).toBe('uncertain');
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.files.has('mods/local.jar')).toBe(true);
  });

  it('rejects revoked authorization and foreign managed identity before an immediate toggle', async () => {
    const f = await fixture();
    await installedMod(f, 'mods/local.jar', 'local');
    const input = { path: 'mods/local.jar', action: 'disable', idempotencyKey: randomUUID() };
    await f.db
      .updateTable('managed_servers')
      .set({ external_id: 'foreign' })
      .where('id', '=', f.serverId)
      .execute();
    await expect(f.service.toggle(f.context, f.serverId, input)).rejects.toBeDefined();
    await f.db
      .deleteFrom('session')
      .where('id', '=', f.context[authSessionId] as string)
      .execute();
    await expect(f.service.toggle(f.context, f.serverId, input)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(f.renameFiles).not.toHaveBeenCalled();
  });
  it('preserves dependency diagnostics through the durable draft and links the selected root', async () => {
    const f = await catalogFixture();
    vi.spyOn(ModrinthProvider.prototype, 'modVersions').mockResolvedValue({
      items: [],
      offset: 0,
      limit: 20,
      total: 0,
    });
    f.resolve.mockResolvedValue({
      ...f.resolution,
      catalog: {
        ...f.resolution.catalog,
        blocked: [
          {
            provider: 'modrinth',
            projectId: 'dep',
            name: 'Dependency',
            requiredBy: 'example',
            reason: 'incompatible-version',
            availableMinecraftVersions: ['1.21.2'],
            availableLoaders: ['fabric'],
          },
        ],
      },
    });
    await f.select();
    await f.service.drain();
    expect((await f.service.snapshot(f.context, f.serverId)).blockers).toEqual([
      expect.objectContaining({
        provider: 'modrinth',
        projectId: 'dep',
        requiredBy: 'example',
        requiredByName: 'Example',
        roots: [{ projectId: 'example', name: 'Example' }],
        availableMinecraftVersions: ['1.21.2'],
      }),
    ]);
    expect(f.http.download).not.toHaveBeenCalled();
  });
  it.each([undefined, 'v2'])(
    'automatically prepares a resolved alternative for selection %s and preserves idempotent intent',
    async (versionId) => {
      const f = await catalogFixture();
      const requested = { ...f.version, id: 'v2', publishedAt: '2026-10-01T00:00:00Z' };
      const blocked = {
        ...f.resolution,
        catalog: {
          ...f.resolution.catalog,
          items: f.resolution.catalog.items.map((item) => ({ ...item, version: requested })),
          blocked: [
            {
              provider: 'modrinth' as const,
              projectId: 'missing',
              name: 'Missing',
              requiredBy: 'example',
              reason: 'incompatible-version' as const,
            },
          ],
        },
      };
      f.resolve.mockImplementation(async (roots) =>
        roots[0]?.versionId === 'v1' ? f.resolution : blocked,
      );
      const versions = vi.spyOn(ModrinthProvider.prototype, 'modVersions').mockResolvedValue({
        items: [requested, f.version],
        offset: 0,
        limit: 20,
        total: 2,
      });
      const request = {
        roots: [
          { provider: 'modrinth', projectId: 'example', ...(versionId ? { versionId } : {}) },
        ],
        idempotencyKey: randomUUID(),
      };
      const first = await f.service.select(f.context, f.serverId, request);
      await f.service.drain();
      const snapshot = await f.service.snapshot(f.context, f.serverId);
      expect(snapshot.blockers).toEqual([]);
      expect(snapshot.changes).toMatchObject([{ state: 'ready', metadata: { versionId: 'v1' } }]);
      expect(snapshot.roots[0]?.versionId).toBe(versionId);
      expect(f.resolve).toHaveBeenCalledTimes(2);
      expect(versions).toHaveBeenCalledTimes(1);
      const memo = f.resolve.mock.calls[0]?.[2]?.metadataMemo;
      expect(memo).toBeDefined();
      expect(f.resolve.mock.calls[1]?.[2]?.metadataMemo).toBe(memo);
      expect(f.resolve.mock.calls[1]?.[2]?.installedVersions).toBe(
        f.resolve.mock.calls[0]?.[2]?.installedVersions,
      );
      expect(f.http.download).toHaveBeenCalledTimes(1);
      expect(f.uploadFile).toHaveBeenCalledTimes(1);
      expect(f.renameFiles).not.toHaveBeenCalled();
      expect(f.sendCommand).not.toHaveBeenCalled();
      expect(await f.service.select(f.context, f.serverId, request)).toEqual(first);
      await f.service.drain();
      expect(f.resolve).toHaveBeenCalledTimes(2);
      expect(f.uploadFile).toHaveBeenCalledTimes(1);
    },
  );

  it('recognizes a resolved alternative already installed without downloading or publishing again', async () => {
    const f = await catalogFixture();
    const first = await f.select();
    await f.service.drain();
    await f.service.apply(f.context, f.serverId, {
      revision: first.revision,
      idempotencyKey: randomUUID(),
    });
    await f.service.drain();
    vi.mocked(f.http.download).mockClear();
    f.uploadFile.mockClear();
    f.renameFiles.mockClear();
    const requested = { ...f.version, id: 'v2', publishedAt: '2026-10-01T00:00:00Z' };
    const blocked = {
      ...f.resolution,
      catalog: {
        ...f.resolution.catalog,
        items: f.resolution.catalog.items.map((item) => ({ ...item, version: requested })),
        blocked: [
          {
            provider: 'modrinth' as const,
            projectId: 'missing',
            name: 'Missing',
            requiredBy: 'example',
            reason: 'unresolved' as const,
          },
        ],
      },
    };
    f.resolve.mockImplementation(async (roots) =>
      roots[0]?.versionId === 'v1' ? f.resolution : blocked,
    );
    vi.spyOn(ModrinthProvider.prototype, 'modVersions').mockResolvedValue({
      items: [requested, f.version],
      offset: 0,
      limit: 20,
      total: 2,
    });
    await f.service.select(f.context, f.serverId, {
      roots: [{ provider: 'modrinth', projectId: 'example', versionId: 'v2' }],
      idempotencyKey: randomUUID(),
    });
    await f.service.drain();
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot).toMatchObject({
      preparing: false,
      blockers: [],
      changes: [],
      roots: [{ versionId: 'v2' }],
      packs: [{ metadata: { versionId: 'v1' } }],
    });
    expect(snapshot.error).toBeUndefined();
    expect(f.http.download).not.toHaveBeenCalled();
    expect(f.uploadFile).not.toHaveBeenCalled();
    expect(f.renameFiles).not.toHaveBeenCalled();
  });

  it('respects the configured automatic budget and retains the unresolved diagnostics', async () => {
    const f = await catalogFixture();
    await updateSettings(f.db, f.owner, { minecraftModAlternativeLimit: 1 }, f.env);
    const requested = { ...f.version, id: 'v3' };
    const blocked = {
      ...f.resolution,
      plan: { ...f.resolution.plan, artifacts: [{ ...f.artifact, versionId: 'v3' }] },
      catalog: {
        ...f.resolution.catalog,
        items: f.resolution.catalog.items.map((item) => ({ ...item, version: requested })),
        blocked: [
          {
            provider: 'modrinth' as const,
            projectId: 'missing',
            name: 'Missing',
            requiredBy: 'example',
            reason: 'unresolved' as const,
          },
        ],
      },
    };
    f.resolve.mockImplementation(async (roots) =>
      roots[0]?.versionId === 'v1' ? f.resolution : blocked,
    );
    vi.spyOn(ModrinthProvider.prototype, 'modVersions').mockResolvedValue({
      items: [{ ...f.version, id: 'v2', publishedAt: '2026-10-01T00:00:00Z' }, f.version],
      offset: 0,
      limit: 20,
      total: 2,
    });
    await f.select();
    await f.service.drain();
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot.blockers).toMatchObject([{ projectId: 'missing', reason: 'unresolved' }]);
    expect(snapshot.error).toBeUndefined();
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.http.download).not.toHaveBeenCalled();
    expect(f.uploadFile).not.toHaveBeenCalled();
  });

  it('never replaces an explicitly forced selection', async () => {
    const f = await catalogFixture();
    f.resolve.mockResolvedValue({
      ...f.resolution,
      catalog: {
        ...f.resolution.catalog,
        blocked: [
          {
            provider: 'modrinth',
            projectId: 'missing',
            name: 'Missing',
            requiredBy: 'example',
            reason: 'unresolved',
          },
        ],
      },
    });
    const versions = vi.spyOn(ModrinthProvider.prototype, 'modVersions');
    await f.service.select(f.context, f.serverId, {
      roots: [
        {
          provider: 'modrinth',
          projectId: 'example',
          versionId: 'forced',
          forceIncompatible: true,
        },
      ],
      idempotencyKey: randomUUID(),
    });
    await f.service.drain();
    expect(versions).not.toHaveBeenCalled();
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.http.download).not.toHaveBeenCalled();
  });
  it('checks updates from local receipts, coalesces requests and rechecks revoked authorization before cache', async () => {
    const f = await catalogFixture();
    const selected = await f.select();
    await f.service.drain();
    await f.service.apply(f.context, f.serverId, {
      revision: selected.revision,
      idempotencyKey: randomUUID(),
    });
    await f.service.drain();
    f.listFiles.mockClear();
    const current = vi.spyOn(ModrinthProvider.prototype, 'modVersion').mockResolvedValue(f.version);
    const newest = { ...f.version, id: 'v2', version: '2.0', publishedAt: '2026-02-01T00:00:00Z' };
    const versions = vi
      .spyOn(ModrinthProvider.prototype, 'modVersions')
      .mockResolvedValue({ items: [newest], offset: 0, total: 1, limit: 20 });
    const beforeDownloads = vi.mocked(f.http.download).mock.calls.length;
    const results = await Promise.all([
      f.service.updates(f.context, f.serverId),
      f.service.updates(f.context, f.serverId),
    ]);
    expect(results[0].items).toEqual([
      expect.objectContaining({
        path: 'mods/example.jar',
        currentVersionId: 'v1',
        status: 'update',
        version: expect.objectContaining({ id: 'v2' }),
      }),
    ]);
    expect(current).toHaveBeenCalledTimes(1);
    expect(versions).toHaveBeenCalledTimes(1);
    expect(f.listFiles).not.toHaveBeenCalled();
    expect(f.http.download).toHaveBeenCalledTimes(beforeDownloads);
    await f.db
      .deleteFrom('session')
      .where('id', '=', f.context[authSessionId] ?? '')
      .execute();
    await expect(f.service.updates(f.context, f.serverId)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
  it('preserves a disabled installed mod when replacing its version', async () => {
    const f = await catalogFixture();
    const first = await f.select();
    await f.service.drain();
    await f.service.apply(f.context, f.serverId, {
      revision: first.revision,
      idempotencyKey: randomUUID(),
    });
    await f.service.drain();
    await f.service.change(f.context, f.serverId, {
      path: 'mods/example.jar',
      action: 'disable',
      idempotencyKey: randomUUID(),
    });
    const changed = await f.service.snapshot(f.context, f.serverId);
    await f.service.apply(f.context, f.serverId, {
      revision: changed.revision,
      idempotencyKey: randomUUID(),
    });
    await f.service.drain();
    f.resolve.mockResolvedValue({
      ...f.resolution,
      plan: {
        ...f.resolution.plan,
        artifacts: [{ ...f.artifact, path: 'mods/example-v2.jar', versionId: 'v2' }],
      },
      catalog: {
        ...f.resolution.catalog,
        items: f.resolution.catalog.items.map((item) => ({
          ...item,
          version: { ...item.version, id: 'v2', version: '2.0', filename: 'example-v2.jar' },
        })),
      },
    });
    const second = await f.select();
    await f.service.drain();
    expect((await f.service.snapshot(f.context, f.serverId)).changes[0]?.path).toBe(
      'mods/example-v2.jar.disabled',
    );
    await f.service.apply(f.context, f.serverId, {
      revision: second.revision,
      idempotencyKey: randomUUID(),
    });
    expect((await f.service.snapshot(f.context, f.serverId)).packs).toEqual([
      expect.objectContaining({ state: 'disabled' }),
    ]);
  });
  it('does not search alternatives for stale drafts or projects outside selected roots', async () => {
    const f = await catalogFixture();
    const selected = await f.select();
    await f.service.drain();
    const versions = vi
      .spyOn(ModrinthProvider.prototype, 'modVersions')
      .mockResolvedValue({ items: [f.version], offset: 0, total: 1, limit: 20 });
    await expect(
      f.service.alternatives(f.context, f.serverId, 'modrinth', 'example', selected.revision - 1),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      f.service.alternatives(f.context, f.serverId, 'modrinth', 'foreign', selected.revision),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(versions).not.toHaveBeenCalled();
  });
  it('treats a missing mods directory reported unavailable by Wings as empty after one root observation', async () => {
    const f = await fixture();
    f.directories.delete('mods');
    const original = f.adapter.listDirectoriesBatch.bind(f.adapter);
    vi.spyOn(f.adapter, 'listDirectoriesBatch').mockImplementation(async (identifier, paths) =>
      paths.length === 1 && paths[0] === 'mods'
        ? [{ directory: 'mods', error: 'unavailable' }]
        : original(identifier, paths),
    );
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot.packs).toEqual([]);
    expect(snapshot.supported).toBe(true);
    expect(f.listFiles.mock.calls.filter(([, path]) => path === '')).toHaveLength(1);
    expect(f.uploadFile).not.toHaveBeenCalled();
    expect(f.renameFiles).not.toHaveBeenCalled();
  });
  it('keeps an unavailable existing mods directory as an error', async () => {
    const f = await fixture();
    const original = f.adapter.listDirectoriesBatch.bind(f.adapter);
    vi.spyOn(f.adapter, 'listDirectoriesBatch').mockImplementation(async (identifier, paths) =>
      paths.length === 1 && paths[0] === 'mods'
        ? [{ directory: 'mods', error: 'unavailable' }]
        : original(identifier, paths),
    );
    await expect(f.service.snapshot(f.context, f.serverId)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(f.listFiles.mock.calls.filter(([, path]) => path === '')).toHaveLength(1);
  });
  it('retries a rejected storage admission and creates a missing mods directory before upload', async () => {
    const f = await catalogFixture();
    f.directories.delete('mods');
    const createDirectory = vi.spyOn(f.adapter, 'createDirectory');
    const upload = f.uploadFile.getMockImplementation();
    f.uploadFile.mockImplementation(async (...args) => {
      expect(f.directories.has('mods')).toBe(true);
      if (!upload) throw new Error('Missing upload fixture');
      await upload(...args);
    });
    f.env.NH_CONTENT_SOURCE_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    await f.select();
    await f.service.drain();
    expect((await f.service.snapshot(f.context, f.serverId)).changes[0]).toMatchObject({
      state: 'failed',
      error: 'content_storage_unavailable',
    });
    expect(await f.db.selectFrom('minecraft_sources').select('id').execute()).toEqual([]);
    expect(createDirectory).not.toHaveBeenCalled();
    expect(f.uploadFile).not.toHaveBeenCalled();
    f.env.NH_CONTENT_SOURCE_FREE_BYTES = '0';
    const selected = await f.select();
    await f.service.drain();
    expect(createDirectory).toHaveBeenCalledExactlyOnceWith(expect.any(String), '', 'mods');
    expect((await f.service.snapshot(f.context, f.serverId)).changes[0]?.state).toBe('ready');
    await f.service.apply(f.context, f.serverId, {
      revision: selected.revision,
      idempotencyKey: randomUUID(),
    });
    expect(f.files.get('mods/example.jar')).toEqual(f.bytes);
    expect(f.sendCommand).not.toHaveBeenCalled();
  });
  it('prepares verified pending bytes, publishes with a single rename and never powers/reloads a running server', async () => {
    const f = await catalogFixture();
    const selected = await f.select();
    await f.service.drain();
    const ready = await f.service.snapshot(f.context, f.serverId);
    expect(ready.changes).toHaveLength(1);
    expect(ready.changes[0]?.state).toBe('ready');
    expect(f.files.has('mods/example.jar')).toBe(false);
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
    const key = randomUUID();
    expect(
      await f.service.apply(f.context, f.serverId, {
        revision: selected.revision,
        idempotencyKey: key,
      }),
    ).toEqual({ state: 'published', restartRequired: true });
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.files.get('mods/example.jar')).toEqual(f.bytes);
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect((await f.service.snapshot(f.context, f.serverId)).packs[0]?.metadata?.side).toBe('both');
    await f.service.apply(f.context, f.serverId, {
      revision: selected.revision,
      idempotencyKey: key,
    });
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
  });
  it('deduplicates replayed selection and reuses prepared files when adding/removing roots', async () => {
    const f = await catalogFixture(),
      key = randomUUID(),
      request = { roots: [{ provider: 'modrinth', projectId: 'example' }], idempotencyKey: key };
    await f.service.select(f.context, f.serverId, request);
    await f.service.drain();
    await f.service.select(f.context, f.serverId, request);
    await f.service.drain();
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
    await f.select();
    await f.service.drain();
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
    expect((await f.service.snapshot(f.context, f.serverId)).changes).toHaveLength(1);
    await f.select([]);
    await f.service.drain();
    expect((await f.service.snapshot(f.context, f.serverId)).changes).toHaveLength(0);
  });
  it('fences a lost rename response and reconciles its effects without replaying the batch', async () => {
    const f = await catalogFixture();
    const selected = await f.select();
    await f.service.drain();
    const original = f.renameFiles.getMockImplementation();
    f.renameFiles.mockImplementationOnce(async (...args) => {
      await original?.(...args);
      throw new Error('Lost response');
    });
    await expect(
      f.service.apply(f.context, f.serverId, {
        revision: selected.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'operation_uncertain' });
    expect((await f.service.snapshot(f.context, f.serverId)).changes[0]?.state).toBe('uncertain');
    expect(await f.service.recover(f.context, f.serverId)).toMatchObject({
      recovered: 1,
      uncertain: 0,
    });
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect((await f.service.snapshot(f.context, f.serverId)).packs).toHaveLength(1);
  });
  it('refuses filename collisions and foreign server identity before mutation', async () => {
    const f = await catalogFixture();
    const selected = await f.select();
    await f.service.drain();
    f.files.set('mods/example.jar', Buffer.from('unmanaged'));
    await expect(
      f.service.apply(f.context, f.serverId, {
        revision: selected.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.renameFiles).not.toHaveBeenCalled();
    await f.db
      .updateTable('managed_servers')
      .set({ external_id: 'foreign' })
      .where('id', '=', f.serverId)
      .execute();
    await expect(
      f.service.change(f.context, f.serverId, {
        path: 'mods/example.jar',
        action: 'delete',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeDefined();
    expect(f.renameFiles).not.toHaveBeenCalled();
  });
  it('requires manager authority and live session before changing a selection', async () => {
    const f = await catalogFixture();
    await f.db
      .deleteFrom('session')
      .where('id', '=', f.context[authSessionId] as string)
      .execute();
    await expect(f.select()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it('blocks removing an enabled mod needed by another retained mod', async () => {
    const f = await catalogFixture();
    const selected = await f.select();
    await f.service.drain();
    await f.service.apply(f.context, f.serverId, {
      revision: selected.revision,
      idempotencyKey: randomUUID(),
    });
    const receipt = await f.db
      .selectFrom('minecraft_mod_receipts')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    const plan = receipt.receipt as Record<string, unknown>;
    f.files.set('mods/dependent.jar', f.bytes);
    await f.db
      .insertInto('minecraft_mod_receipts')
      .values({
        server_id: f.serverId,
        path: 'mods/dependent.jar',
        receipt: JSON.stringify({
          ...plan,
          metadata: { ...(plan.metadata as object), projectId: 'dependent' },
          dependencies: [{ provider: 'modrinth', projectId: 'example' }],
        }),
      })
      .execute();
    await f.service.change(f.context, f.serverId, {
      path: 'mods/example.jar',
      action: 'disable',
      idempotencyKey: randomUUID(),
    });
    await expect(
      f.service.apply(f.context, f.serverId, {
        revision: selected.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'content_dependency_missing' });
    expect(f.files.has('mods/example.jar')).toBe(true);
  });
  it('keeps the restart marker until a strictly newer process start is observed', async () => {
    const f = await fixture();
    const now = new Date();
    await f.db
      .insertInto('minecraft_mod_restart')
      .values({ server_id: f.serverId, changed_at: now })
      .execute();
    vi.spyOn(f.runtime.lifecycle, 'observeProviderProcessStart').mockResolvedValue(
      new Date(now.getTime() - 1000).toISOString(),
    );
    expect((await f.service.restartStatus(f.context, f.serverId)).required).toBe(true);
    vi.mocked(f.runtime.lifecycle.observeProviderProcessStart).mockRejectedValueOnce(
      new Error('observer unavailable'),
    );
    expect((await f.service.restartStatus(f.context, f.serverId)).required).toBe(true);
    vi.mocked(f.runtime.lifecycle.observeProviderProcessStart).mockImplementationOnce(async () => {
      await f.db
        .updateTable('minecraft_mod_restart')
        .set({
          changed_at: new Date(now.getTime() + 2000),
        })
        .where('server_id', '=', f.serverId)
        .execute();
      return new Date(now.getTime() + 1000).toISOString();
    });
    expect((await f.service.restartStatus(f.context, f.serverId)).required).toBe(true);
    vi.mocked(f.runtime.lifecycle.observeProviderProcessStart).mockResolvedValue(
      new Date(now.getTime() + 3000).toISOString(),
    );
    expect((await f.service.restartStatus(f.context, f.serverId)).required).toBe(false);
    expect(f.listFiles).not.toHaveBeenCalled();
  });
  it('accepts queue edits during an active upload and reuses its verified bytes', async () => {
    const f = await catalogFixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.uploadFile.getMockImplementation();
    f.uploadFile.mockImplementationOnce(async (...args) => {
      entered();
      await hold;
      await original?.(...args);
    });
    await f.select();
    await waiting;
    const changed = await f.select();
    release();
    await f.service.drain();
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot.revision).toBe(changed.revision);
    expect(snapshot.changes).toHaveLength(1);
    expect(snapshot.changes[0]?.state).toBe('ready');
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
    expect(f.http.download).toHaveBeenCalledTimes(1);
  });
  it('does not poison source acquisition when queue selection changes during download', async () => {
    const f = await catalogFixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    const original = vi.mocked(f.http.download).getMockImplementation();
    vi.mocked(f.http.download).mockImplementationOnce(async (...args) => {
      entered();
      await hold;
      return (await original?.(...args)) as Awaited<ReturnType<ContentHttp['download']>>;
    });
    await f.select();
    await waiting;
    await f.select();
    release();
    await f.service.drain();
    expect((await f.service.snapshot(f.context, f.serverId)).changes[0]?.state).toBe('ready');
    expect(f.http.download).toHaveBeenCalledTimes(1);
  });
  it('reconciles a completed preparation with a lost upload response and releases only its scoped claim', async () => {
    const f = await catalogFixture(),
      original = f.uploadFile.getMockImplementation();
    f.uploadFile.mockImplementationOnce(async (...args) => {
      await original?.(...args);
      throw new Error('Lost upload response');
    });
    await f.select();
    await f.service.drain();
    expect((await f.service.snapshot(f.context, f.serverId)).changes[0]?.state).toBe('uncertain');
    expect(await f.service.recover(f.context, f.serverId)).toMatchObject({
      recovered: 1,
      uncertain: 0,
    });
    expect((await f.service.snapshot(f.context, f.serverId)).changes[0]?.state).toBe('ready');
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toHaveLength(0);
  });
  it('removes only ledger-owned pending and retired files asynchronously', async () => {
    const f = await catalogFixture();
    f.files.set('mods/.unrelated.pending', Buffer.from('keep'));
    await f.select();
    await f.service.drain();
    await f.select([]);
    await f.service.drain();
    expect([...f.files.keys()].filter((path) => /^mods\/\.nh-/.test(path))).toHaveLength(0);
    expect(f.files.has('mods/.unrelated.pending')).toBe(true);
    const selected = await f.select();
    await f.service.drain();
    await f.service.apply(f.context, f.serverId, {
      revision: selected.revision,
      idempotencyKey: randomUUID(),
    });
    await f.service.drain();
    await f.service.change(f.context, f.serverId, {
      action: 'delete',
      path: 'mods/example.jar',
      idempotencyKey: randomUUID(),
    });
    await f.service.apply(f.context, f.serverId, {
      revision: selected.revision,
      idempotencyKey: randomUUID(),
    });
    await f.service.drain();
    expect([...f.files.keys()].filter((path) => /^mods\/\.nh-/.test(path))).toHaveLength(0);
    expect(f.files.has('mods/.unrelated.pending')).toBe(true);
  });
  it('rejects a prepared plan after the server changes Minecraft version', async () => {
    const f = await catalogFixture();
    const selected = await f.select();
    await f.service.drain();
    const profile = await f.db
      .selectFrom('minecraft_server_profiles')
      .select('combination_id')
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    const combination = await f.db
      .selectFrom('minecraft_combinations')
      .select('combination')
      .where('id', '=', profile.combination_id)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('minecraft_combinations')
      .set({
        combination: JSON.stringify({ ...(combination.combination as object), release: '1.20.1' }),
      })
      .where('id', '=', profile.combination_id)
      .execute();
    await expect(
      f.service.apply(f.context, f.serverId, {
        revision: selected.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'content_plan_expired' });
    expect(f.renameFiles).not.toHaveBeenCalled();
  });
  it('coalesces the same Fabric artifact from two providers, preserves aliases and publishes once', async () => {
    const f = await catalogFixture();
    const curseforge = new CurseForgeProvider(f.http, { apiKey: 'fixture-key' });
    const item = f.resolution.catalog.items[0];
    if (!item) throw new Error('Missing catalog fixture');
    vi.spyOn(curseforge, 'resolveMods').mockResolvedValue({
      plan: {
        ...f.resolution.plan,
        artifacts: [
          {
            ...f.artifact,
            projectId: '123',
            versionId: '456',
          },
        ],
      },
      catalog: {
        ...f.resolution.catalog,
        items: [
          {
            ...item,
            project: { ...item.project, provider: 'curseforge', id: '123' },
            version: { ...item.version, provider: 'curseforge', id: '456', projectId: '123' },
          },
        ],
      },
    });
    const service = createMinecraftModsService({
      db: f.db,
      runtime: f.runtime,
      env: f.env,
      http: f.http,
      curseforge,
    });
    drainCleanup = () => service.drain();
    const selected = await service.select(f.context, f.serverId, {
      roots: [
        { provider: 'modrinth', projectId: 'example' },
        { provider: 'curseforge', projectId: '123' },
      ],
      preferBeta: true,
      idempotencyKey: randomUUID(),
    });
    await service.drain();
    const ready = await service.snapshot(f.context, f.serverId);
    expect(ready.blockers).toEqual([]);
    expect(ready.changes).toHaveLength(1);
    const canonical = ready.changes[0];
    if (!canonical) throw new Error('Missing canonical change');
    expect(
      [
        canonical.metadata?.provider,
        ...(canonical.aliases ?? []).map((alias) => alias.provider),
      ].sort(),
    ).toEqual(['curseforge', 'modrinth']);
    expect(f.listFiles.mock.calls.filter(([, path]) => path === '')).toHaveLength(1);
    await service.apply(f.context, f.serverId, {
      revision: selected.revision,
      idempotencyKey: randomUUID(),
    });
    await service.drain();
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect(f.renameFiles.mock.calls[0]?.[2]).toHaveLength(1);
    const installed = await service.snapshot(f.context, f.serverId);
    expect(installed.packs).toHaveLength(1);
    expect(installed.packs[0]?.aliases).toHaveLength(1);
    expect(installed.preferBeta).toBe(true);
    expect([...f.files.keys()].filter((path) => path.startsWith('mods/.nh-'))).toEqual([]);
    // A later provider identity for the same verified bytes adds provenance only:
    // no second live JAR, no restart boundary change, and no leaked pending upload.
    vi.mocked(curseforge.resolveMods).mockResolvedValue({
      plan: {
        ...f.resolution.plan,
        artifacts: [
          { ...f.artifact, path: 'mods/alternate.jar', projectId: '789', versionId: '987' },
        ],
      },
      catalog: {
        ...f.resolution.catalog,
        items: [
          {
            ...item,
            project: { ...item.project, provider: 'curseforge', id: '789' },
            version: { ...item.version, provider: 'curseforge', id: '987', projectId: '789' },
          },
        ],
      },
    });
    const beforeMarker = await f.db
      .selectFrom('minecraft_mod_restart')
      .select('changed_at')
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    const next = await service.select(f.context, f.serverId, {
      roots: [{ provider: 'curseforge', projectId: '789' }],
      idempotencyKey: randomUUID(),
    });
    await service.drain();
    await service.apply(f.context, f.serverId, {
      revision: next.revision,
      idempotencyKey: randomUUID(),
    });
    await service.drain();
    expect(f.renameFiles).toHaveBeenCalledTimes(1);
    expect((await service.snapshot(f.context, f.serverId)).packs).toHaveLength(1);
    expect([...f.files.keys()].filter((path) => path.startsWith('mods/.nh-'))).toEqual([]);
    expect(
      await f.db
        .selectFrom('minecraft_mod_restart')
        .select('changed_at')
        .where('server_id', '=', f.serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeMarker);
  });
  it('blocks conflicting Fabric IDs across providers even with a shared filename', async () => {
    const f = await catalogFixture();
    const zip = new ZipFile();
    zip.addBuffer(
      Buffer.from('{"schemaVersion":1,"id":"fixture","version":"2.0","environment":"*"}'),
      'fabric.mod.json',
    );
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const http = {
      ...f.http,
      download: vi.fn(async (_artifact: unknown, path: string) => {
        await writeFile(path, bytes);
        return { size: bytes.length, sha256 };
      }),
    } as ContentHttp;
    const curseforge = new CurseForgeProvider(http, { apiKey: 'fixture-key' });
    const item = f.resolution.catalog.items[0];
    if (!item) throw new Error('Missing catalog fixture');
    vi.spyOn(curseforge, 'resolveMods').mockResolvedValue({
      plan: {
        ...f.resolution.plan,
        artifacts: [
          {
            ...f.artifact,
            projectId: '123',
            versionId: '456',
            size: bytes.length,
            hashes: { sha256 },
          },
        ],
      },
      catalog: {
        ...f.resolution.catalog,
        items: [
          {
            ...item,
            project: { ...item.project, provider: 'curseforge', id: '123' },
            version: {
              ...item.version,
              provider: 'curseforge',
              id: '456',
              projectId: '123',
              bytes: bytes.length,
            },
          },
        ],
      },
    });
    const service = createMinecraftModsService({
      db: f.db,
      runtime: f.runtime,
      env: f.env,
      http: f.http,
      curseforge,
    });
    drainCleanup = () => service.drain();
    const selected = await service.select(f.context, f.serverId, {
      roots: [
        { provider: 'modrinth', projectId: 'example' },
        { provider: 'curseforge', projectId: '123' },
      ],
      idempotencyKey: randomUUID(),
    });
    await service.drain();
    expect((await service.snapshot(f.context, f.serverId)).blockers).toEqual([
      expect.objectContaining({ reason: 'conflict' }),
    ]);
    await expect(
      service.apply(f.context, f.serverId, {
        revision: selected.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'content_dependency_conflict' });
    expect(f.renameFiles).not.toHaveBeenCalled();
  });
  it('requires explicit force for archive-declared client mods and reuses already verified local bytes', async () => {
    const f = await catalogFixture('client');
    await f.select();
    await f.service.drain();
    const failed = await f.service.snapshot(f.context, f.serverId);
    expect(failed.changes[0]).toMatchObject({
      state: 'failed',
      error: 'client_only',
      metadata: { side: 'client' },
    });
    expect(f.uploadFile).not.toHaveBeenCalled();
    const item = f.resolution.catalog.items[0];
    if (!item) throw new Error('Missing catalog fixture');
    item.forced = true;
    await f.service.select(f.context, f.serverId, {
      roots: [
        { provider: 'modrinth', projectId: 'example', versionId: 'v1', forceIncompatible: true },
      ],
      idempotencyKey: randomUUID(),
    });
    await f.service.drain();
    expect((await f.service.snapshot(f.context, f.serverId)).changes[0]).toMatchObject({
      state: 'ready',
      forceIncompatible: true,
      metadata: { side: 'client', environment: { source: 'archive' } },
    });
    expect(f.http.download).toHaveBeenCalledTimes(1);
    expect(f.uploadFile).toHaveBeenCalledTimes(1);
  });
});
