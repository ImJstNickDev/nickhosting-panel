import { createHash, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  installedContentChange,
  readArchiveFile,
  visitArchive,
} from '@nickhosting/content-providers';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  minecraftDigest,
  minecraftVerificationChecks,
  minecraftWorldDataVersion,
} from '@nickhosting/minecraft';
import {
  type ApplicationServer,
  type PterodactylAdapter,
  PterodactylError,
} from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { canonicalMinecraftJarSha256 } from '../../../games/minecraft/src/generated-launcher.js';
import { planMinecraftPlayerList } from '../../../games/minecraft/src/management.js';
import * as minecraftWorld from '../../../games/minecraft/src/world.js';
import * as contentDisk from '../../content-providers/src/disk.js';
import { createFilemanReadService } from './fileman-read.js';
import {
  createFilemanJobServices,
  filemanTransferDigest,
  filemanTransferReceiptStep,
} from './fileman-transfers.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { type LifecycleOptions, processServerOperation } from './lifecycle.js';
import {
  assertMinecraftLaunchInputs,
  configureMinecraftProvision,
  inspectMinecraftWorlds,
  type MinecraftContentOptions,
  type MinecraftPreparedContent,
  prepareMinecraftContentPlan,
  prepareMinecraftCreationConfig,
  processMinecraftContent,
  verifyMinecraftInitialInstallation,
  verifyMinecraftPendingContent,
  verifyMinecraftRestore,
} from './minecraft-content.js';
import { minecraftMappingDigest, signMinecraftEvidence } from './minecraft-registry.js';
import { createMinecraftSourceStore } from './minecraft-sources.js';
import { createMinecraftWorldPreparation } from './minecraft-world-preparation.js';
import { createOperationTiming } from './operation-timing.js';
import { enqueueServerOperation } from './registry.js';
import { managementFixture } from './test-fixtures.js';
import { reserveUploadIngestion } from './upload-admission.js';

describe('Minecraft durable lifecycle and ingestion boundaries', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await database?.destroy();
  });
  async function launcherJar(
    mtime: string,
    properties = 'launch.mainClass=net.fabricmc.loader.impl.launch.knot.KnotServer\n',
  ) {
    const zip = new ZipFile();
    zip.addBuffer(
      Buffer.from(
        'Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.loader.impl.launch.server.FabricServerLauncher\r\n\r\n',
      ),
      'META-INF/MANIFEST.MF',
      { mtime: new Date(mtime) },
    );
    zip.addBuffer(Buffer.from(properties), 'fabric-server-launch.properties', {
      mtime: new Date(mtime),
    });
    zip.end();
    const chunks: Buffer[] = [];
    await pipeline(
      zip.outputStream,
      new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      }),
    );
    return Buffer.concat(chunks);
  }

  it('does not replay the installer when game configuration changes phase and waits', async () => {
    const f = await managementFixture(database.db);
    const serverId = await f.server();
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
      user: 1,
      egg: 1,
      allocation: allocations.find((a) => a.is_primary)?.pterodactyl_allocation_id,
      status: null,
      suspended: false,
      container: { installed: true },
      limits: server.limits,
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
    const reinstalled = vi.fn(
      async (_id: number, _identifier: string, callbacks: { onConfirmed: () => Promise<void> }) => {
        await callbacks.onConfirmed();
        return { confirmed: true };
      },
    );
    const adapter = {
      ...f.adapter,
      getApplicationServer: async () => remote,
      getResources: async () => ({
        current_state: 'offline',
        is_suspended: false,
        resources: {
          memory_bytes: 0,
          cpu_absolute: 0,
          disk_bytes: 0,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
        },
      }),
      reinstallWithConfirmation: reinstalled,
    } as unknown as PterodactylAdapter;
    const operation = await enqueueServerOperation(f.db, f.context, serverId, {
      action: 'reinstall',
      confirm: true,
      idempotencyKey: randomUUID(),
      backupBefore: false,
    });
    let time = Date.now();
    const hook = vi.fn(
      async (context: Parameters<NonNullable<LifecycleOptions['configureGameProvision']>>[0]) => {
        if (hook.mock.calls.length === 1) {
          await context.update({ phase: 'minecraft.config.prepared' });
          return false;
        }
        return true;
      },
    );
    const options: LifecycleOptions = {
      adapter,
      settleMs: 0,
      now: () => new Date(time),
      authorizeEffect: async () => {},
      reserveInstallation: async () => {},
      configureGameProvision: hook,
    };
    const results: string[] = [];
    for (let index = 0; index < 6; index++) {
      results.push(await processServerOperation(f.db, operation.jobId, options));
      time += 20_000;
      if (results.at(-1) === 'succeeded') break;
    }
    expect(results.at(-1)).toBe('succeeded');
    expect(hook).toHaveBeenCalledTimes(2);
    expect(reinstalled).toHaveBeenCalledOnce();
  });

  it('permits ingestion only for the exact running lifecycle operation and its attributed actor', async () => {
    const f = await managementFixture(database.db);
    const serverId = await f.server();
    const provision = await f.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('operation_jobs')
      .set({ state: 'running', completed_at: null })
      .where('id', '=', provision.job_id)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: provision.job_id })
      .where('id', '=', serverId)
      .execute();
    await f.db
      .updateTable('physical_hosts')
      .set({
        upload_policy: JSON.stringify({
          providerMaxFileBytes: 1024 ** 2,
          temporaryDiskPath: '/isolated-minecraft-upload',
          temporaryDiskBudgetBytes: 16 * 1024 ** 2,
          temporaryDiskHeadroomBytes: 1024 ** 2,
        }),
      })
      .where('id', '=', f.hostId)
      .execute();
    const env = { NH_OBSERVER_ID: 'isolated-observer' };
    const disk = { availableBytes: async () => 1024n ** 3n };
    await f.db.connection().execute(async (connection) => {
      await expect(
        reserveUploadIngestion(connection, f.context, serverId, 1, env, disk),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        reserveUploadIngestion(connection, f.context, serverId, 1, env, {
          ...disk,
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        reserveUploadIngestion(connection, f.owner, serverId, 1, env, {
          ...disk,
          operationId: provision.job_id,
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      const claim = await reserveUploadIngestion(connection, f.context, serverId, 1, env, {
        ...disk,
        operationId: provision.job_id,
      });
      await claim.complete();
      await claim.unlock();
    });
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
  });

  async function minecraftFixture(
    launcher?: {
      bootstrap: Buffer;
      installed: Buffer;
      digest: string;
      boundPath?: string;
      semantic?: boolean;
    },
    interactive = false,
  ) {
    const profile = launcher ? 'fabric' : 'vanilla';
    const image = 'fixture-java:21';
    const startup = `java -jar ${launcher ? (launcher.boundPath ?? 'fabric-server-launch.jar') : 'server.jar'} nogui`;
    const f = await managementFixture(database.db, { interactive });
    const serverId = await f.server();
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    const operation = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const combinationId = randomUUID();
    await f.db
      .insertInto('game_integrations')
      .values({ id: 'minecraft', version: 'fixture', manifest: {} })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ game_id: 'minecraft', runtime_id: profile, docker_image: image, startup })
      .where('id', '=', f.mappingId)
      .execute();
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    const runtimeBytes = Buffer.from('fixture runtime jar');
    const runtimeHash = createHash('sha256').update(runtimeBytes).digest('hex');
    const combination = {
      release: '1.21.1',
      releaseType: 'release',
      protocolId: 767,
      family: 'netty',
      profile,
      javaMajor: 21,
      runtimeDigest: 'a'.repeat(64),
      protocolSource: { url: 'https://example.test/protocols', sha256: 'b'.repeat(64) },
    };
    const imageDigest = `sha256:${'f'.repeat(64)}`;
    const binding = {
      profile,
      release: '1.21.1',
      image,
      imageJavaMajor: 21,
      declaredEggVariables: ['VERSION'],
      bindings: { release: 'VERSION' },
      fixedVariables: {},
      installationKind: launcher ? 'fabric-installer' : 'server-jar',
      artifactPaths: {
        server: launcher ? (launcher.boundPath ?? 'fabric-server-launch.jar') : 'server.jar',
      },
      supportedProperties: ['motd'],
    };
    const runtime = {
      profile,
      release: '1.21.1',
      javaMajor: 21,
      installation: { kind: launcher ? 'fabric-installer' : 'server-jar', args: [] },
      artifacts: [{ role: 'server', sha256: runtimeHash, size: runtimeBytes.length }],
    };
    await f.db
      .insertInto('minecraft_combinations')
      .values({
        id: combinationId,
        mapping_id: f.mappingId,
        identity_digest: '1'.repeat(64),
        combination: JSON.stringify(combination),
        resolved_runtime: JSON.stringify(runtime),
        binding: JSON.stringify(binding),
        mapping_digest: minecraftMappingDigest(mapping),
      })
      .execute();
    const env = { NH_MINECRAFT_EVIDENCE_KEY: '1'.repeat(64) };
    const report = {
      runId: randomUUID(),
      kind: 'real-server',
      combinationDigest: minecraftDigest(combination),
      choiceDigest: '1'.repeat(64),
      mappingDigest: minecraftMappingDigest(mapping),
      recordedAt: new Date().toISOString(),
      checks: Object.fromEntries(minecraftVerificationChecks.map((check) => [check, true])),
      evidenceSha256: 'd'.repeat(64),
      server: {
        uuid: randomUUID(),
        externalId: 'isolated-fixture',
        artifactSha256: runtimeHash,
        imageDigest,
        javaMajor: 21,
        ...(launcher
          ? {
              installedFiles: [
                { path: 'server.jar', sha256: runtimeHash, size: runtimeBytes.length },
                {
                  path: 'fabric-server-launch.jar',
                  sha256: createHash('sha256').update(launcher.bootstrap).digest('hex'),
                  size: launcher.bootstrap.length,
                  ...(launcher.semantic === false
                    ? {}
                    : {
                        role: 'fabric-launcher',
                        jarEntriesSha256: launcher.digest,
                        minecraftServerPath: 'server.jar',
                      }),
                },
              ],
            }
          : {}),
      },
      client: { implementation: 'test-fixture', version: '1.0.0', protocolId: 767 },
    };
    await f.db
      .insertInto('minecraft_verification_evidence')
      .values({
        id: report.runId,
        combination_id: combinationId,
        report: JSON.stringify(report),
        signature: signMinecraftEvidence(report, env),
      })
      .execute();
    await f.db
      .insertInto('minecraft_server_profiles')
      .values({
        server_id: serverId,
        combination_id: combinationId,
        configuration: JSON.stringify({ eula: true }),
        installed: false,
      })
      .execute();
    const files = new Map<string, Buffer>([
      ['eula.txt', Buffer.from('eula=true\n')],
      ['server.jar', runtimeBytes],
      ['server.properties', Buffer.from('motd=Fixture\n')],
    ]);
    if (launcher) files.set('fabric-server-launch.jar', launcher.installed);
    const adapter = {
      getEgg: async () => ({
        id: mapping.egg_id,
        nest: mapping.nest_id,
        relationships: {
          variables: { object: 'list', data: [{ attributes: { env_variable: 'VERSION' } }] },
        },
      }),
      getApplicationServer: async () => ({
        egg: mapping.egg_id,
        uuid: server.pterodactyl_uuid,
        limits: server.limits,
        container: { image, startup_command: startup, environment: { VERSION: '1.21.1' } },
      }),
      listFiles: async (_id: string, root = '') =>
        [
          ...new Set(
            [...files.keys()]
              .filter((path) => !root || path.startsWith(`${root}/`))
              .map((path) => (root ? path.slice(root.length + 1) : path).split('/')[0] as string),
          ),
        ].map((name) => ({
          name,
          is_file: files.has([root, name].filter(Boolean).join('/')),
          is_symlink: false,
          size: files.get([root, name].filter(Boolean).join('/'))?.length ?? 0,
        })),
      writeFile: async (_id: string, path: string, content: string) => {
        files.set(path, Buffer.from(content));
      },
      readFile: async (_id: string, path: string) => files.get(path) ?? Buffer.alloc(0),
      readFileForEditor: async (_id: string, path: string) => files.get(path) ?? Buffer.alloc(0),
      prefetchDownloads: async () => {},
      downloadFile: async (_id: string, path: string) => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(files.get(path) ?? Buffer.alloc(0));
            controller.close();
          },
        }),
      }),
    } as unknown as PterodactylAdapter;
    const context = {
      db: f.db,
      server,
      adapter,
      operation: () => operation,
      authorize: async () => {},
      assertStopped: async () => {},
      event: async () => {},
      update: async (patch) => {
        Object.assign(operation, patch);
      },
      effect: async (phase, perform) => {
        operation.phase = phase;
        operation.effect_state = 'prepared';
        await perform();
        operation.effect_state = 'confirmed';
        return true;
      },
      backup: async () => false,
    } as GameLifecycleContext;
    const options: MinecraftContentOptions = {
      env,
      userAgent: 'isolated fixture',
      mountdataRoot: '/unused/mountdata',
      http: { json: vi.fn(), download: vi.fn() },
      observedImageDigest: async () => imageDigest,
      authorizeJob: async () => f.context,
    };
    return { f, serverId, operation, combinationId, files, context, options };
  }

  async function worldSelectionFixture(
    version = minecraftWorldDataVersion('1.21.1') ?? -1,
    batch = true,
  ) {
    const f = await minecraftFixture();
    await f.f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: true, configuration_state: '{}' })
      .where('server_id', '=', f.serverId)
      .execute();
    const named = (type: number, name: string, body: Buffer) => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(Buffer.byteLength(name));
      return Buffer.concat([Buffer.from([type]), length, Buffer.from(name), body]);
    };
    const versionBytes = Buffer.alloc(4);
    versionBytes.writeInt32BE(version);
    f.files.set(
      'selected/level.dat',
      Buffer.concat([
        Buffer.from([10, 0, 0]),
        named(10, 'Data', Buffer.concat([named(3, 'DataVersion', versionBytes), Buffer.from([0])])),
        Buffer.from([0]),
      ]),
    );
    f.files.set('server.properties', Buffer.from('motd=Fixture\nlevel-name=old_world\n'));
    const providerList = f.context.adapter.listFiles;
    const list = vi.spyOn(f.context.adapter, 'listFiles');
    const read = vi.spyOn(f.context.adapter, 'readFileForEditor');
    const download = vi.spyOn(f.context.adapter, 'downloadFile');
    const write = vi.spyOn(f.context.adapter, 'writeFile');
    const prepare = vi.spyOn(f.context.adapter, 'prefetchDownloads');
    const listDirectories = vi.fn(async (directories: string[]) =>
      Promise.all(
        directories.map(async (directory) => ({
          directory,
          files: await providerList(f.context.server.pterodactyl_identifier ?? '', directory),
        })),
      ),
    );
    f.context.fileman = createFilemanJobServices(f.context, {
      authorize: async () => f.f.context,
      ...(batch ? { listDirectories } : {}),
    });
    const stopped = vi.fn(async () => {});
    f.context.assertStopped = stopped;
    const prepared = await prepareMinecraftContentPlan(
      f.f.db,
      f.serverId,
      { kind: 'world-select', world: 'selected' },
      { ...f.options, adapter: f.context.adapter },
    );
    expect(list).not.toHaveBeenCalled();
    f.operation.action = 'minecraft-content';
    f.operation.phase = 'planned';
    f.operation.effect_state = 'none';
    f.operation.plan = { minecraftContent: prepared };
    return { ...f, providerList, list, listDirectories, read, download, write, prepare, stopped };
  }

  async function observedWorldSelectionFixture() {
    const f = await worldSelectionFixture();
    const entries = new Map<string, string>();
    const cache = {
      async get(key: string) {
        return entries.get(key);
      },
      async take(key: string) {
        const value = entries.get(key);
        entries.delete(key);
        return value;
      },
      async put(key: string, value: string) {
        entries.set(key, value);
      },
      async delete(key: string) {
        entries.delete(key);
      },
    };
    const apiPreparation = createMinecraftWorldPreparation(cache, 'isolated-provider');
    await inspectMinecraftWorlds(
      f.f.db,
      f.context.adapter,
      f.serverId,
      async () => {},
      f.options.env,
      undefined,
      undefined,
      apiPreparation,
    );
    const options = { ...f.options, worldPreparation: apiPreparation, adapter: f.context.adapter };
    const prepared = await prepareMinecraftContentPlan(
      f.f.db,
      f.serverId,
      { kind: 'world-select', world: 'selected' },
      options,
    );
    expect(prepared.world?.observation?.name).toBe('selected');
    f.operation.plan = { minecraftContent: prepared };
    // A separate consumer models the worker; there is no process-local warm state.
    f.options.worldPreparation = createMinecraftWorldPreparation(cache, 'isolated-provider');
    for (const spy of [f.list, f.listDirectories, f.read, f.download, f.write, f.prepare])
      spy.mockClear();
    return { ...f, entries, options };
  }
  it('selects an inspected world with one properties comparison and no world reinspection', async () => {
    const f = await observedWorldSelectionFixture();
    const queries = vi.spyOn(f.context.db, 'selectFrom');
    expect(await processMinecraftContent(f.context, f.options)).toBe(true);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.listDirectories).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.read.mock.calls.map((call) => call[1])).toEqual(['server.properties']);
    expect(f.download).not.toHaveBeenCalled();
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.stopped).not.toHaveBeenCalled();
    // Only the text-write receipt is relevant; selection cannot change a modpack.
    expect(queries.mock.calls.filter(([table]) => table === 'job_steps')).toHaveLength(1);
    expect(f.files.get('server.properties')?.toString()).toContain('level-name=selected');
    const cached = await f.options.worldPreparation?.read(f.context.server, f.combinationId);
    expect(cached?.properties.content).toContain('level-name=selected');
  });
  it.each(['read', 'persist'] as const)(
    'overlaps the fresh comparison and plan persistence, waiting for both before final authorization (%s first)',
    async (first) => {
      const f = await observedWorldSelectionFixture();
      const reading = Promise.withResolvers<void>();
      const persisting = Promise.withResolvers<void>();
      const events: string[] = [];
      const update = f.context.update;
      const effect = f.context.effect;
      const authorize = vi.fn(async () => {});
      f.context.authorize = authorize;
      f.read.mockImplementation(async (_identifier, path) => {
        events.push('read.start');
        await reading.promise;
        events.push('read.done');
        return f.files.get(path) ?? Buffer.alloc(0);
      });
      f.context.update = async (patch) => {
        if (patch.plan?.minecraftText) {
          events.push('persist.start');
          await persisting.promise;
        }
        await update(patch);
        events.push('persist.done');
      };
      f.context.effect = async (...args) => {
        expect(events).toContain('read.done');
        expect(events).toContain('persist.done');
        expect(f.operation.plan.minecraftText).toBeDefined();
        // Model the lifecycle's final authorization at the mutation boundary.
        await f.context.authorize();
        events.push('effect');
        return effect(...args);
      };
      const selecting = processMinecraftContent(f.context, f.options);
      try {
        await vi.waitFor(() => {
          expect(events).toContain('read.start');
          expect(events).toContain('persist.start');
        });
        expect(f.write).not.toHaveBeenCalled();
        (first === 'read' ? reading : persisting).resolve();
        await vi.waitFor(() => expect(events).toContain(`${first}.done`));
        expect(f.write).not.toHaveBeenCalled();
        expect(events).not.toContain('effect');
      } finally {
        reading.resolve();
        persisting.resolve();
        await selecting;
      }
      expect(await selecting).toBe(true);
      expect(f.read).toHaveBeenCalledOnce();
      expect(f.write).toHaveBeenCalledOnce();
      // Entry, fresh Fileman scope, final effect: no adjacent outer read check.
      expect(authorize).toHaveBeenCalledTimes(3);
    },
  );
  it.each(['build', 'persist'] as const)(
    'settles an in-flight fresh comparison after local %s failure without writing',
    async (failurePoint) => {
      const f = await observedWorldSelectionFixture();
      const reading = Promise.withResolvers<void>();
      const failed = Promise.withResolvers<void>();
      const failure = new Error(`isolated ${failurePoint} failure`);
      let readFinished = false;
      let selectionFinished = false;
      f.read.mockImplementation(async (_identifier, path) => {
        await reading.promise;
        readFinished = true;
        return f.files.get(path) ?? Buffer.alloc(0);
      });
      if (failurePoint === 'build') {
        const preparation = f.options.worldPreparation;
        if (!preparation) throw new Error('Missing preparation fixture');
        vi.spyOn(preparation, 'read').mockImplementationOnce(async () => {
          failed.resolve();
          throw failure;
        });
      } else {
        f.context.update = async () => {
          failed.resolve();
          throw failure;
        };
      }
      const selecting = processMinecraftContent(f.context, f.options).then(
        () => {
          selectionFinished = true;
          return undefined;
        },
        (error: unknown) => {
          selectionFinished = true;
          return error;
        },
      );
      try {
        await failed.promise;
        await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
        expect(selectionFinished).toBe(false);
        expect(f.write).not.toHaveBeenCalled();
      } finally {
        reading.resolve();
      }
      expect(await selecting).toBe(failure);
      expect(readFinished).toBe(true);
      expect(f.write).not.toHaveBeenCalled();
      expect(f.operation.effect_state).toBe('none');
    },
  );
  it('keeps the persisted plan after a failed speculative read and retries with fresh bytes', async () => {
    const f = await observedWorldSelectionFixture();
    const failure = new PterodactylError('unavailable', 'client', 'rejected');
    f.read.mockRejectedValueOnce(failure);
    await expect(processMinecraftContent(f.context, f.options)).rejects.toBe(failure);
    const persisted = f.operation.plan.minecraftText;
    expect(persisted).toBeDefined();
    expect(f.operation.effect_state).toBe('none');
    expect(f.write).not.toHaveBeenCalled();
    expect(await processMinecraftContent(f.context, f.options)).toBe(true);
    expect(f.operation.plan.minecraftText).toBe(persisted);
    expect(f.read.mock.calls.map((call) => call[1])).toEqual([
      'server.properties',
      'server.properties',
    ]);
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('preserves a concurrent properties edit even when Worlds prepared the selection', async () => {
    const f = await observedWorldSelectionFixture();
    f.files.set('server.properties', Buffer.from('motd=External edit\nlevel-name=old_world\n'));
    await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledOnce();
  });
  it('recovers an observed selection with a lost reply without another world inspection or write', async () => {
    const f = await observedWorldSelectionFixture();
    f.write.mockImplementationOnce(async (_identifier, path, content) => {
      f.files.set(path, Buffer.from(content));
      throw new Error('lost write reply');
    });
    await expect(processMinecraftContent(f.context, f.options)).rejects.toThrow('lost write reply');
    expect(await processMinecraftContent(f.context, f.options)).toBe(true);
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.listDirectories).not.toHaveBeenCalled();
    expect(f.read.mock.calls.map((call) => call[1])).toEqual([
      'server.properties',
      'server.properties',
    ]);
  });
  it('keeps an inspected selection usable if optional preparation is evicted before dispatch', async () => {
    const f = await observedWorldSelectionFixture();
    f.entries.clear();
    f.files.set('server.properties', Buffer.from('motd=New source\nlevel-name=old_world\n'));
    expect(await processMinecraftContent(f.context, f.options)).toBe(true);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.read.mock.calls.map((call) => call[1])).toEqual(['server.properties']);
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.files.get('server.properties')?.toString()).toContain('motd=New source');
    expect(f.files.get('server.properties')?.toString()).toContain('level-name=selected');
  });
  it('does not build or write from a failed fresh source when optional preparation is missing', async () => {
    const f = await observedWorldSelectionFixture();
    f.entries.clear();
    const failure = new PterodactylError('unavailable', 'client', 'rejected');
    f.read.mockRejectedValueOnce(failure);
    await expect(processMinecraftContent(f.context, f.options)).rejects.toBe(failure);
    expect(f.operation.plan.minecraftText).toBeUndefined();
    expect(f.operation.effect_state).toBe('none');
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('does not retain a trusted preparation when the next inventory sees a properties symlink', async () => {
    const f = await observedWorldSelectionFixture();
    const providerList = f.providerList;
    f.list.mockImplementation(async (...args) =>
      (await providerList(...args)).map((entry) => ({
        ...entry,
        is_symlink: entry.name === 'server.properties',
      })),
    );
    await inspectMinecraftWorlds(
      f.f.db,
      f.context.adapter,
      f.serverId,
      async () => {},
      f.options.env,
      undefined,
      undefined,
      f.options.worldPreparation,
    );
    const prepared = await prepareMinecraftContentPlan(
      f.f.db,
      f.serverId,
      { kind: 'world-select', world: 'selected' },
      f.options,
    );
    expect(prepared.world?.observation).toBeUndefined();
    f.context.fileman = undefined;
    f.operation.plan = { minecraftContent: prepared };
    await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('does not accept world verification from a public operation command', async () => {
    const f = await observedWorldSelectionFixture();
    await expect(
      prepareMinecraftContentPlan(
        f.f.db,
        f.serverId,
        {
          kind: 'world-select',
          world: 'selected',
          observation: { dataVersion: 3955 },
        },
        f.options,
      ),
    ).rejects.toBeDefined();
  });

  it.each([true, false])(
    'selects a compatible world through shared Fileman reads, batch=%s',
    async (batch) => {
      const f = await worldSelectionFixture(undefined, batch);
      expect(await processMinecraftContent(f.context, f.options)).toBe(true);
      expect(f.files.get('server.properties')?.toString()).toContain('level-name=selected');
      expect(f.files.get('server.properties')?.toString()).toContain('motd=Fixture');
      expect(f.list.mock.calls.map((call) => call[1] ?? '')).toEqual(batch ? [] : ['', 'selected']);
      if (batch) expect(f.listDirectories).toHaveBeenCalledExactlyOnceWith(['', 'selected']);
      else expect(f.listDirectories).not.toHaveBeenCalled();
      expect(f.read.mock.calls.map((call) => call[1])).toEqual([
        'selected/level.dat',
        'server.properties',
        'server.properties',
      ]);
      expect(f.prepare).toHaveBeenCalledExactlyOnceWith(f.context.server.pterodactyl_identifier, [
        'server.properties',
        'selected/level.dat',
      ]);
      expect(f.download).not.toHaveBeenCalled();
      expect(f.write).toHaveBeenCalledOnce();
      expect(f.stopped).not.toHaveBeenCalled();
    },
  );
  it('rejects a forbidden world-selection batch instead of falling back to native reads', async () => {
    const f = await worldSelectionFixture();
    f.listDirectories.mockRejectedValueOnce(
      new PterodactylError('permission_denied', 'client', 'rejected', 403),
    );
    await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
      upstreamStatus: 403,
    });
    expect(f.list).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('traces world-selection reads and comparison without adding provider work or private data', async () => {
    const f = await worldSelectionFixture();
    const timing = createOperationTiming();
    f.context.timing = timing;
    expect(await processMinecraftContent(f.context, f.options)).toBe(true);
    expect(f.listDirectories).toHaveBeenCalledExactlyOnceWith(['', 'selected']);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.read.mock.calls.map((call) => call[1])).toEqual([
      'selected/level.dat',
      'server.properties',
      'server.properties',
    ]);
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.files.get('server.properties')?.toString()).toContain('level-name=selected');
    const stages = timing.snapshot();
    for (const name of [
      'minecraft.profile.read',
      'minecraft.combination.inspect',
      'minecraft.world.prepare',
      'minecraft.world.levelRead',
      'minecraft.world.propertiesRead',
      'minecraft.world.validate',
      'minecraft.text.compare',
      'minecraft.text.persist',
      'files.read1.total',
      'files.read2.total',
      'files.read3.total',
    ])
      expect(stages[name]?.count, name).toBe(1);
    for (const value of ['server.properties', 'selected/level.dat', 'motd=Fixture', f.serverId])
      expect(JSON.stringify(timing.report())).not.toContain(value);
  });
  it.each(['selected', 'level.dat'])(
    'rejects a symlink %s from the world-selection batch before reading bytes',
    async (name) => {
      const f = await worldSelectionFixture();
      const batch = f.listDirectories.getMockImplementation();
      if (!batch) throw new Error('Missing batch fixture');
      f.listDirectories.mockImplementation(async (directories) =>
        (await batch(directories)).map((result) => ({
          ...result,
          files: result.files.map((entry) => ({
            ...entry,
            is_symlink: entry.name === name,
          })),
        })),
      );
      await expect(processMinecraftContent(f.context, f.options)).rejects.toBeDefined();
      expect(f.list).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it('rejects a changed properties source before world selection without overwriting it', async () => {
    const f = await worldSelectionFixture();
    let propertiesReads = 0;
    f.read.mockImplementation(async (...args) => {
      if (args[1] === 'server.properties' && ++propertiesReads === 2)
        f.files.set(
          'server.properties',
          Buffer.from('motd=Changed externally\nlevel-name=old_world\n'),
        );
      // The fixture stores immutable buffers; return the current provider bytes directly.
      return f.files.get(args[1]) ?? Buffer.alloc(0);
    });
    await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.files.get('server.properties')?.toString()).toContain('motd=Changed externally');
  });
  it('rejects properties created after world selection observed their absence', async () => {
    const f = await worldSelectionFixture();
    f.files.delete('server.properties');
    const update = f.context.update;
    f.context.update = async (patch) => {
      await update(patch);
      if (patch.plan?.minecraftText)
        f.files.set(
          'server.properties',
          Buffer.from('motd=Created externally\nlevel-name=old_world\n'),
        );
    };
    await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.listDirectories.mock.calls.map(([paths]) => paths)).toEqual([['', 'selected'], ['']]);
    expect(f.files.get('server.properties')?.toString()).toContain('motd=Created externally');
  });
  it('rejects an incompatible world without writing the selection', async () => {
    const f = await worldSelectionFixture(1976);
    await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'minecraft_world_data_version' },
    });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('reports a world removed since selection as missing before any properties write', async () => {
    const f = await worldSelectionFixture();
    f.files.delete('selected/level.dat');
    await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.operation.effect_state).toBe('none');
  });
  it('recovers a lost world-selection write reply by hash without replaying the write', async () => {
    const f = await worldSelectionFixture();
    f.write.mockImplementationOnce(async (_id, path, contents) => {
      f.files.set(path, Buffer.from(contents));
      throw new Error('lost write reply');
    });
    await expect(processMinecraftContent(f.context, f.options)).rejects.toThrow('lost write reply');
    expect(await processMinecraftContent(f.context, f.options)).toBe(true);
    expect(f.write).toHaveBeenCalledOnce();
  });

  it('prepares a new world online but refuses collisions and the selected missing folder', async () => {
    const { f, serverId, files, options, context } = await minecraftFixture(undefined, true);
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: true })
      .where('server_id', '=', serverId)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running' })
      .where('id', '=', serverId)
      .execute();
    options.worldArchiveResolver = vi.fn(async () => ({
      path: '/unused/world.zip',
      sha256: 'a'.repeat(64),
    }));
    const command = { kind: 'world-import', archiveRef: randomUUID(), targetWorld: 'new_world' };
    const prepared = await prepareMinecraftContentPlan(f.db, serverId, command, {
      ...options,
      adapter: context.adapter,
    });
    expect(prepared.world?.existing).toBe(false);
    expect(prepared.deletePaths).toEqual([]);
    files.set('new_world/level.dat', Buffer.from('existing world'));
    await expect(
      prepareMinecraftContentPlan(
        f.db,
        serverId,
        {
          ...command,
          replace: { wipeConsent: true, expectedDeletePaths: ['new_world'], backupBefore: false },
        },
        { ...options, adapter: context.adapter },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      prepareMinecraftContentPlan(
        f.db,
        serverId,
        { ...command, targetWorld: 'world' },
        { ...options, adapter: context.adapter },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    // The public queue accepts additive work without dropping the running reservation.
    await f.db
      .insertInto('resource_reservations')
      .values({
        server_id: serverId,
        owner_id: f.context.subjectUserId,
        physical_host_id: f.hostId,
        memory_mib: 128,
        physical_memory_mib: 148,
        cpu_percent: 10,
        operation_id: randomUUID(),
        state: 'running',
      })
      .execute();
    const queued = await enqueueServerOperation(
      f.db,
      f.context,
      serverId,
      { action: 'minecraft-content', command, idempotencyKey: randomUUID() },
      options.env,
      { minecraftPlan: prepared },
    );
    expect(queued.jobId).toBeTruthy();
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('state')
        .where('server_id', '=', serverId)
        .executeTakeFirst(),
    ).toEqual({ state: 'running' });
  });

  it.each([false, true])(
    'removes an inactive world online through the real lifecycle, with final selection protection=%s',
    async (selectedAfterQueue) => {
      const f = await minecraftFixture(undefined, true);
      const runtime = f.files.get('server.jar');
      if (!runtime) throw new Error('Missing fixture runtime');
      await f.f.db
        .updateTable('minecraft_server_profiles')
        .set({
          installed: true,
          configuration_state: '{}',
          installed_manifest: JSON.stringify([
            {
              path: 'server.jar',
              sha256: createHash('sha256').update(runtime).digest('hex'),
              size: runtime.length,
            },
          ]),
        })
        .where('server_id', '=', f.serverId)
        .execute();
      await f.f.db
        .updateTable('managed_servers')
        .set({ runtime_state: 'running' })
        .where('id', '=', f.serverId)
        .execute();
      f.files.set('server.properties', Buffer.from('level-name=world\n'));
      // Deletion does not require parsing a valid level.dat or verifying its version.
      f.files.set('spare/region/r.0.0.mca', Buffer.from('region bytes'));
      const listFiles = vi.fn(f.context.adapter.listFiles);
      const readFileForEditor = vi.fn(f.context.adapter.readFileForEditor);
      const downloadFile = vi.fn(f.context.adapter.downloadFile);
      Object.assign(f.context.adapter, { listFiles, readFileForEditor, downloadFile });
      const command = {
        kind: 'world-remove' as const,
        world: 'spare',
        confirm: true as const,
        backupBefore: false,
      };
      const prepared = await prepareMinecraftContentPlan(f.f.db, f.serverId, command, {
        ...f.options,
        adapter: f.context.adapter,
      });
      expect(listFiles).not.toHaveBeenCalled();
      expect(readFileForEditor).not.toHaveBeenCalled();
      await f.f.db
        .insertInto('resource_reservations')
        .values({
          server_id: f.serverId,
          owner_id: f.f.context.subjectUserId,
          physical_host_id: f.f.hostId,
          memory_mib: 128,
          physical_memory_mib: 148,
          cpu_percent: 10,
          operation_id: randomUUID(),
          state: 'running',
        })
        .execute();
      const queued = await enqueueServerOperation(
        f.f.db,
        f.f.context,
        f.serverId,
        { action: 'minecraft-content', command, idempotencyKey: randomUUID() },
        f.options.env,
        { minecraftPlan: prepared },
      );
      const server = await f.f.db
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', f.serverId)
        .executeTakeFirstOrThrow();
      const allocations = await f.f.db
        .selectFrom('server_allocations')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute();
      const remote = {
        id: server.pterodactyl_id,
        uuid: server.pterodactyl_uuid,
        identifier: server.pterodactyl_identifier,
        external_id: server.external_id,
        node: f.f.providerNodeId,
        user: server.provider_user_id,
        egg: 1,
        allocation: allocations.find((item) => item.is_primary)?.pterodactyl_allocation_id,
        status: null,
        suspended: false,
        container: { installed: true },
        limits: server.limits,
        relationships: {
          allocations: {
            data: allocations.map((item) => ({
              attributes: {
                id: item.pterodactyl_allocation_id,
                ip: item.address,
                port: item.port,
                assigned: true,
              },
            })),
          },
        },
      } as ApplicationServer;
      const getResources = vi.fn(async () => {
        throw new Error('No power polling for inactive world removal');
      });
      const confirmAlreadyStopped = vi.fn(async () => {
        throw new Error('No observer required for inactive world removal');
      });
      const deleteFiles = vi.fn(async (_id: string, _root: string, paths: string[]) => {
        for (const path of f.files.keys())
          if (paths.some((root) => path === root || path.startsWith(`${root}/`)))
            f.files.delete(path);
      });
      const adapter = {
        ...f.context.adapter,
        getApplicationServer: vi.fn(async () => remote),
        getResources,
        deleteFiles,
      } as PterodactylAdapter;
      const observedImageDigest = vi.fn(async () => {
        throw new Error('No runtime audit for a world deletion');
      });
      if (selectedAfterQueue) f.files.set('server.properties', Buffer.from('level-name=spare\n'));
      const result = await processServerOperation(f.f.db, queued.jobId, {
        adapter,
        env: f.options.env,
        authorizeEffect: async () => {},
        authorizeIntent: async () => {},
        confirmAlreadyStopped,
        processGameContent: (context) =>
          processMinecraftContent(context, { ...f.options, observedImageDigest }),
      });
      expect(result).toBe(selectedAfterQueue ? 'failed' : 'succeeded');
      expect(deleteFiles).toHaveBeenCalledTimes(selectedAfterQueue ? 0 : 1);
      if (!selectedAfterQueue)
        expect(deleteFiles).toHaveBeenCalledExactlyOnceWith(server.pterodactyl_identifier, '', [
          'spare',
        ]);
      expect(f.files.has('spare/region/r.0.0.mca')).toBe(selectedAfterQueue);
      expect(listFiles).toHaveBeenCalledTimes(1);
      expect(readFileForEditor).toHaveBeenCalledTimes(1);
      expect(downloadFile).not.toHaveBeenCalled();
      expect(getResources).not.toHaveBeenCalled();
      expect(confirmAlreadyStopped).not.toHaveBeenCalled();
      expect(observedImageDigest).not.toHaveBeenCalled();
      expect(
        await f.f.db
          .selectFrom('minecraft_server_profiles')
          .select(['installed', 'content_state'])
          .where('server_id', '=', f.serverId)
          .executeTakeFirst(),
      ).toEqual({ installed: true, content_state: {} });
      expect(
        await f.f.db
          .selectFrom('resource_reservations')
          .select('state')
          .where('server_id', '=', f.serverId)
          .executeTakeFirst(),
      ).toEqual({ state: 'running' });
      const final = await f.f.db
        .selectFrom('server_operations')
        .select(['effect_state', 'plan'])
        .where('job_id', '=', queued.jobId)
        .executeTakeFirstOrThrow();
      expect(final.effect_state).toBe(selectedAfterQueue ? 'none' : 'confirmed');
      expect(final.plan.offlineSince).toBeUndefined();
    },
  );

  it.each(
    [
      { label: 'matching', field: 'DataVersion', value: 3955, status: 'verified' },
      { label: 'different version', field: 'DataVersion', value: 4786, status: 'incompatible' },
      { label: 'legacy Anvil', field: 'version', value: 19133, status: 'unknown' },
    ].flatMap((version) =>
      (version.status === 'verified'
        ? ['none', 'staging', 'checkpoint', 'archive', 'archive-recover']
        : ['none', 'staging', 'archive']
      ).map((collision) => ({ ...version, collision })),
    ),
  )(
    'imports a $label world online without selecting it or overwriting collisions ($collision)',
    async ({ field, value, status, collision }) => {
      const f = await minecraftFixture(undefined, true);
      const root = `./mountdata/test-assets/world-online-${randomUUID()}`;
      const env = {
        ...f.options.env,
        NH_OBSERVER_ID: 'isolated-observer',
        NH_MINECRAFT_SOURCE_ROOT: `${root}/sources`,
        NH_MINECRAFT_CONTENT_ROOT: `${root}/expanded`,
        NH_MINECRAFT_SOURCE_FREE_BYTES: '0',
        NH_MINECRAFT_SOURCE_FREE_PERCENT: '0',
      };
      const checkDisk = contentDisk.assertContentDiskSpace;
      vi.spyOn(contentDisk, 'assertContentDiskSpace').mockImplementation(
        (directory, bytes, policy) =>
          checkDisk(directory, bytes, { ...policy, minimumFreePercent: 0, minimumFreeBytes: 0 }),
      );
      try {
        await f.f.db
          .updateTable('minecraft_server_profiles')
          .set({ installed: true, configuration_state: '{}' })
          .where('server_id', '=', f.serverId)
          .execute();
        await f.f.db
          .updateTable('managed_servers')
          .set({ runtime_state: 'running', active_operation_id: f.operation.job_id })
          .where('id', '=', f.serverId)
          .execute();
        await f.f.db
          .updateTable('operation_jobs')
          .set({ state: 'running', completed_at: null })
          .where('id', '=', f.operation.job_id)
          .execute();
        f.context.assertStopped = vi.fn(async () => {
          throw new Error('running server must not require stop');
        });
        // Different-version and legacy worlds use the same durable import path.
        const version = Buffer.alloc(4);
        version.writeInt32BE(value);
        const named = (type: number, name: string, body: Buffer) => {
          const length = Buffer.alloc(2);
          length.writeUInt16BE(Buffer.byteLength(name));
          return Buffer.concat([Buffer.from([type]), length, Buffer.from(name), body]);
        };
        const level = Buffer.concat([
          Buffer.from([10, 0, 0]),
          named(10, 'Data', Buffer.concat([named(3, field, version), Buffer.from([0])])),
          Buffer.from([0]),
        ]);
        const zip = new ZipFile();
        zip.addBuffer(level, 'map/level.dat');
        zip.addBuffer(Buffer.from('region fixture'), 'map/region/r.0.0.mca');
        // Published map packages include artwork/docs alongside the single world.
        zip.addBuffer(Buffer.from('cover fixture'), 'cover.png');
        zip.addBuffer(Buffer.from('installation instructions'), 'docs/readme.txt');
        zip.end();
        const chunks: Buffer[] = [];
        for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const store = createMinecraftSourceStore(f.f.db, f.f.context, env);
        const source = await store.reserveUpload({
          kind: 'world',
          serverId: f.serverId,
          idempotencyKey: randomUUID(),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        await store.upload(
          source.id,
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          bytes.length,
        );
        f.options = {
          ...f.options,
          env,
          mountdataRoot: resolve(env.NH_MINECRAFT_CONTENT_ROOT),
          sourceRoot: resolve(env.NH_MINECRAFT_SOURCE_ROOT),
          worldArchiveResolver: store.worldArchiveResolver,
        };
        await f.f.db
          .updateTable('physical_hosts')
          .set({
            local_disk_path: resolve(env.NH_MINECRAFT_SOURCE_ROOT),
            upload_policy: JSON.stringify({
              providerMaxFileBytes: 1024 ** 2,
              temporaryDiskPath: resolve(env.NH_MINECRAFT_SOURCE_ROOT),
              temporaryDiskBudgetBytes: 16 * 1024 ** 2,
              temporaryDiskHeadroomBytes: 0,
            }),
          })
          .where('id', '=', f.f.hostId)
          .execute();
        const command = { kind: 'world-import', archiveRef: source.id, targetWorld: 'new_world' };
        const prepared = await prepareMinecraftContentPlan(f.f.db, f.serverId, command, {
          ...f.options,
          adapter: f.context.adapter,
        });
        f.operation.action = 'minecraft-content';
        f.operation.plan.minecraftContent = prepared;
        await f.f.db
          .updateTable('server_operations')
          .set({ action: 'minecraft-content', plan: JSON.stringify(f.operation.plan) })
          .where('job_id', '=', f.operation.job_id)
          .execute();
        f.context.adapter.getResources = vi.fn(async () => ({
          current_state: 'running' as const,
          is_suspended: false,
          resources: {
            memory_bytes: 0,
            cpu_absolute: 0,
            disk_bytes: 0,
            network_rx_bytes: 0,
            network_tx_bytes: 0,
            uptime: 1000,
          },
        }));
        const directories = new Set<string>();
        const list = f.context.adapter.listFiles;
        f.context.adapter.listFiles = vi.fn(async (id, parent = '') => {
          const result = await list(id, parent);
          for (const directory of directories) {
            const pieces = directory.split('/');
            const name = pieces.pop() ?? '';
            if (pieces.join('/') === parent && !result.some((entry) => entry.name === name))
              result.push({
                name,
                is_file: false,
                is_symlink: false,
                size: 0,
              } as (typeof result)[number]);
          }
          return result;
        });
        f.context.adapter.createDirectory = vi.fn(async (_id, parent, name) => {
          directories.add([parent, name].filter(Boolean).join('/'));
        });
        f.context.adapter.uploadFile = vi.fn(async (_id, path, upload) => {
          await upload.authorize();
          expect(
            (
              await f.f.db
                .selectFrom('minecraft_server_profiles')
                .select('installed')
                .where('server_id', '=', f.serverId)
                .executeTakeFirstOrThrow()
            ).installed,
          ).toBe(true);
          const chunks: Uint8Array[] = [];
          for await (const chunk of upload.body) chunks.push(chunk);
          f.files.set(path, Buffer.concat(chunks));
        });
        f.context.adapter.prepareUploadBatch = vi.fn(async () => null);
        f.context.adapter.prepareUpload = vi.fn(
          async (identifier, path) => (input: Parameters<PterodactylAdapter['uploadFile']>[2]) =>
            f.context.adapter.uploadFile(identifier, path, input),
        );
        f.context.fileman = createFilemanJobServices(f.context, {
          env,
          authorize: async () => f.f.context,
        });
        const bulk = collision.startsWith('archive');
        let published = false;
        if (bulk) {
          f.context.adapter.getFileOperationCapabilities = vi.fn<
            PterodactylAdapter['getFileOperationCapabilities']
          >(async () => ({
            inspection: true,
            guardedDelete: true,
            archiveCommit: true,
          }));
          f.context.adapter.commitFileArchive = vi.fn<PterodactylAdapter['commitFileArchive']>(
            async (_id, request) => {
              if (!published) {
                const payload = f.files.get(
                  `.nickhosting-import-${request.operationId}/payload.zip`,
                );
                if (!payload) throw new Error('Missing archive');
                const path = resolve(root, 'received.zip');
                await writeFile(path, payload);
                await visitArchive(path, async (file) => {
                  f.files.set(file.path, await readArchiveFile(file, 1024 ** 2));
                });
                f.files.delete(`.nickhosting-import-${request.operationId}/payload.zip`);
                published = true;
                if (collision === 'archive-recover')
                  throw new PterodactylError('unavailable', 'client', 'unknown');
              }
              return {
                operationId: request.operationId,
                state: 'confirmed',
                identity: request.identity,
                destinationRoot: request.destinationRoot,
                archiveSha256: request.archiveSha256,
              };
            },
          );
        }
        const downloads = vi.spyOn(f.context.adapter, 'downloadFile');
        f.files.set('new_world/foreign.txt', Buffer.from('keep'));
        await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
          code: 'conflict',
        });
        expect(f.context.adapter.uploadFile).not.toHaveBeenCalled();
        f.files.delete('new_world/foreign.txt');
        for (const selected of ['./new_world', 'new_world/nested']) {
          f.files.set('server.properties', Buffer.from(`level-name=${selected}\n`));
          await expect(processMinecraftContent(f.context, f.options)).rejects.toThrow(
            'running server must not require stop',
          );
        }
        f.files.set('server.properties', Buffer.from('level-name=new_world\n'));
        await expect(processMinecraftContent(f.context, f.options)).rejects.toThrow(
          'running server must not require stop',
        );
        // An offline import into the selected, missing folder must retain the
        // stopped guard at subsequent effects if the process starts externally.
        vi.mocked(f.context.assertStopped).mockClear().mockResolvedValueOnce(undefined);
        if (status === 'verified') {
          await expect(processMinecraftContent(f.context, f.options)).rejects.toThrow(
            'running server must not require stop',
          );
          expect(f.context.assertStopped).toHaveBeenCalledTimes(2);
        } else {
          // An incompatible/unknown source cannot replace the selected folder,
          // even when the first stopped check succeeds. No external effect.
          await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
            code: 'validation_failed',
            details: { reason: 'minecraft_world_active_version' },
          });
          expect(f.context.assertStopped).toHaveBeenCalledTimes(1);
        }
        expect(f.context.adapter.uploadFile).not.toHaveBeenCalled();
        f.files.set('server.properties', Buffer.from('level-name=world\n'));
        vi.mocked(f.context.assertStopped).mockClear();
        const stageWorld = minecraftWorld.stageMinecraftWorld;
        const stageSpy = vi.spyOn(minecraftWorld, 'stageMinecraftWorld');
        if (collision !== 'none' && !bulk) {
          if (collision === 'staging')
            stageSpy.mockImplementationOnce(async (...args) => {
              const result = await stageWorld(...args);
              f.files.set('new_world/foreign.txt', Buffer.from('keep'));
              return result;
            });
          const server = await f.f.db
            .selectFrom('managed_servers')
            .selectAll()
            .where('id', '=', f.serverId)
            .executeTakeFirstOrThrow();
          const allocations = await f.f.db
            .selectFrom('server_allocations')
            .selectAll()
            .where('server_id', '=', f.serverId)
            .execute();
          const remote = {
            id: server.pterodactyl_id,
            uuid: server.pterodactyl_uuid,
            identifier: server.pterodactyl_identifier,
            external_id: server.external_id,
            node: f.f.providerNodeId,
            user: server.provider_user_id,
            egg: 1,
            allocation: allocations.find((item) => item.is_primary)?.pterodactyl_allocation_id,
            status: null,
            suspended: false,
            container: { installed: true },
            limits: server.limits,
            relationships: {
              allocations: {
                data: allocations.map((item) => ({
                  attributes: {
                    id: item.pterodactyl_allocation_id,
                    ip: item.address,
                    port: item.port,
                    assigned: true,
                  },
                })),
              },
            },
          } as ApplicationServer;
          f.context.adapter.getApplicationServer = vi.fn(async () => remote);
          const checkpoint = vi.fn(async (stage: string) => {
            if (collision === 'checkpoint' && stage === 'prepared')
              f.files.set('new_world/foreign.txt', Buffer.from('keep'));
          });
          const result = await processServerOperation(f.f.db, f.operation.job_id, {
            adapter: f.context.adapter,
            env,
            authorizeEffect: async () => {},
            authorizeIntent: async () => {},
            checkpoint,
            processGameContent: (context) => processMinecraftContent(context, f.options),
            fileman: (context) =>
              createFilemanJobServices(context, { env, authorize: async () => f.f.context }),
          });
          expect(result).toBe('waiting');
          expect(checkpoint).toHaveBeenCalledWith('prepared', expect.anything());
          expect(f.context.adapter.createDirectory).not.toHaveBeenCalled();
          expect(f.context.adapter.uploadFile).not.toHaveBeenCalled();
          expect(f.files.get('new_world/foreign.txt')?.toString()).toBe('keep');
          const operation = await f.f.db
            .selectFrom('server_operations')
            .select(['effect_state', 'plan'])
            .where('job_id', '=', f.operation.job_id)
            .executeTakeFirstOrThrow();
          expect(operation.effect_state).toBe('uncertain');
          expect(operation.plan.waitReason).toBe('remote_outcome_unknown');
          expect(
            await f.f.db
              .selectFrom('job_steps')
              .select('step')
              .where('job_id', '=', f.operation.job_id)
              .where('step', 'like', 'fileman.transfer.%')
              .execute(),
          ).toEqual([]);
          expect(
            (
              await f.f.db
                .selectFrom('minecraft_server_profiles')
                .select('content_state')
                .where('server_id', '=', f.serverId)
                .executeTakeFirstOrThrow()
            ).content_state,
          ).toMatchObject({ jobId: f.operation.job_id });
          return;
        }
        vi.mocked(f.context.adapter.listFiles).mockClear();
        if (bulk) {
          stageSpy.mockClear();
          if (collision === 'archive-recover') {
            await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
              code: 'operation_uncertain',
            });
            expect(published).toBe(true);
          }
          expect(await processMinecraftContent(f.context, f.options)).toBe(true);
          expect(f.context.adapter.uploadFile).toHaveBeenCalledTimes(1);
          expect(f.context.adapter.commitFileArchive).toHaveBeenCalledTimes(
            collision === 'archive-recover' ? 2 : 1,
          );
          expect(stageSpy).not.toHaveBeenCalled();
          expect(f.context.adapter.createDirectory).not.toHaveBeenCalled();
          expect(f.files.get('new_world/level.dat')).toEqual(level);
          expect(f.files.get('new_world/region/r.0.0.mca')).toEqual(Buffer.from('region fixture'));
          expect([...f.files.keys()].some((path) => /cover\.png|readme\.txt/.test(path))).toBe(
            false,
          );
          expect(
            await f.f.db
              .selectFrom('upload_ingestion_claims')
              .select('id')
              .where('server_id', '=', f.serverId)
              .execute(),
          ).toEqual([]);
          expect(
            (
              await f.f.db
                .selectFrom('minecraft_server_profiles')
                .select('content_state')
                .where('server_id', '=', f.serverId)
                .executeTakeFirstOrThrow()
            ).content_state,
          ).toEqual({});
          return;
        }
        const staged = Promise.withResolvers<void>();
        const reading = Promise.withResolvers<void>();
        stageSpy.mockImplementation(async (...args) => {
          const result = await stageWorld(...args);
          staged.resolve();
          return result;
        });
        const read = f.context.adapter.readFileForEditor;
        vi.spyOn(f.context.adapter, 'readFileForEditor').mockImplementation(async (...args) => {
          if (args[1] === 'server.properties') await reading.promise;
          return read(...args);
        });
        const importing = processMinecraftContent(f.context, f.options);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            staged.promise,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Staging waits for properties')), 2000);
            }),
          ]);
          expect(f.context.adapter.uploadFile).not.toHaveBeenCalled();
        } finally {
          clearTimeout(timeout);
          reading.resolve();
          await importing;
        }
        expect(await importing).toBe(true);
        expect(f.context.adapter.listFiles).toHaveBeenCalledTimes(2);
        expect(f.context.adapter.listFiles).toHaveBeenCalledWith(
          f.context.server.pterodactyl_identifier,
          '',
        );
        expect(f.files.get('new_world/level.dat')).toEqual(level);
        expect(f.files.get('new_world/region/r.0.0.mca')).toEqual(Buffer.from('region fixture'));
        expect([...f.files.keys()].some((path) => /cover\.png|readme\.txt/.test(path))).toBe(false);
        expect(f.context.assertStopped).not.toHaveBeenCalled();
        expect(downloads.mock.calls.some(([, path]) => path === 'server.jar')).toBe(false);
        expect(downloads.mock.calls.some(([, path]) => path === 'eula.txt')).toBe(false);
        const inventory = await inspectMinecraftWorlds(
          f.f.db,
          f.context.adapter,
          f.serverId,
          f.context.authorize,
          f.options.env,
        );
        expect(inventory.selectedWorld).toBe('world');
        expect(inventory.worlds.find((world) => world.name === 'new_world')?.status).toBe(status);
        expect(
          await f.f.db
            .selectFrom('minecraft_server_profiles')
            .select(['installed', 'content_state'])
            .where('server_id', '=', f.serverId)
            .executeTakeFirst(),
        ).toEqual({ installed: true, content_state: {} });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['properties', 'player'] as const)(
    'installed data edits (%s) retain mapping checks without reauditing runtime bytes',
    async (kind) => {
      const f = await minecraftFixture();
      await f.f.db
        .updateTable('minecraft_server_profiles')
        .set({ installed: true, configuration_state: '{}' })
        .where('server_id', '=', f.serverId)
        .execute();
      const identity = {
        name: 'Player',
        uuid: '11111111-1111-1111-1111-111111111111',
        level: 4,
        bypassesPlayerLimit: false,
      };
      f.files.set('ops.json', Buffer.from(JSON.stringify([identity])));
      const command =
        kind === 'properties'
          ? { kind: 'properties' as const, changes: { motd: 'Updated' } }
          : {
              kind: 'player' as const,
              list: 'operators' as const,
              action: 'remove' as const,
              name: identity.name,
              expectedUuid: identity.uuid,
            };
      f.operation.action = 'minecraft-content';
      f.operation.plan.minecraftContent = await prepareMinecraftContentPlan(
        f.f.db,
        f.serverId,
        command,
        { ...f.options, adapter: f.context.adapter },
      );
      const remote = vi.spyOn(f.context.adapter, 'getApplicationServer');
      const download = vi.spyOn(f.context.adapter, 'downloadFile');
      const image = vi.fn(f.options.observedImageDigest);
      f.options.observedImageDigest = image;
      const mapping = await f.f.db
        .selectFrom('runtime_egg_mappings')
        .select('startup')
        .where('id', '=', f.f.mappingId)
        .executeTakeFirstOrThrow();
      await f.f.db
        .updateTable('runtime_egg_mappings')
        .set({ startup: `${mapping.startup} changed` })
        .where('id', '=', f.f.mappingId)
        .execute();
      await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
        code: 'provenance_mismatch',
      });
      await f.f.db
        .updateTable('runtime_egg_mappings')
        .set({ startup: mapping.startup })
        .where('id', '=', f.f.mappingId)
        .execute();
      const list = vi.spyOn(f.context.adapter, 'listFiles');
      const read = vi.spyOn(f.context.adapter, 'readFileForEditor');
      const readScope = vi.fn(() => {
        let authorized: Promise<void> | undefined;
        return createFilemanReadService({
          adapter: f.context.adapter,
          identifier: f.context.server.pterodactyl_identifier ?? '',
          authorize: () => (authorized ??= f.context.authorize()),
        });
      });
      f.context.fileman = {
        readScope,
        uploadStaged: async () => {
          throw new Error('Unexpected staged upload');
        },
      };
      expect(await processMinecraftContent(f.context, f.options)).toBe(true);
      // Build and fresh pre-write comparison share one hosted directory snapshot,
      // but always fetch the actual text twice to retain concurrent-edit detection.
      expect(readScope).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(2);
      expect(remote).not.toHaveBeenCalled();
      expect(image).not.toHaveBeenCalled();
      expect(download.mock.calls.some(([, path]) => path === 'server.jar')).toBe(false);
      expect(
        f.files.get(kind === 'properties' ? 'server.properties' : 'ops.json')?.toString(),
      ).toContain(kind === 'properties' ? 'motd=Updated' : '[]');
    },
  );

  it('retains a fresh source conflict check for hosted Settings file access', async () => {
    const f = await minecraftFixture();
    await f.f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: true, configuration_state: '{}' })
      .where('server_id', '=', f.serverId)
      .execute();
    f.operation.action = 'minecraft-content';
    f.operation.plan.minecraftContent = await prepareMinecraftContentPlan(
      f.f.db,
      f.serverId,
      { kind: 'properties', changes: { motd: 'Requested' } },
      { ...f.options, adapter: f.context.adapter },
    );
    const readScope = vi.fn(() =>
      createFilemanReadService({
        adapter: f.context.adapter,
        identifier: f.context.server.pterodactyl_identifier ?? '',
        authorize: f.context.authorize,
      }),
    );
    f.context.fileman = {
      readScope,
      uploadStaged: async () => {
        throw new Error('Unexpected staged upload');
      },
    };
    const originalRead = f.context.adapter.readFileForEditor.bind(f.context.adapter);
    let reads = 0;
    vi.spyOn(f.context.adapter, 'readFileForEditor').mockImplementation(async (...args) => {
      if (++reads === 2) f.files.set('server.properties', Buffer.from('motd=External edit\n'));
      return originalRead(...args);
    });
    const write = vi.spyOn(f.context.adapter, 'writeFile');
    await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(readScope).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(f.files.get('server.properties')?.toString()).toBe('motd=External edit\n');
  });

  it('opens a new hosted scope to reconcile a lost Settings write response without replay', async () => {
    const f = await minecraftFixture();
    await f.f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: true, configuration_state: '{}' })
      .where('server_id', '=', f.serverId)
      .execute();
    f.operation.action = 'minecraft-content';
    f.operation.plan.minecraftContent = await prepareMinecraftContentPlan(
      f.f.db,
      f.serverId,
      { kind: 'properties', changes: { motd: 'Requested' } },
      { ...f.options, adapter: f.context.adapter },
    );
    const readScope = vi.fn(() =>
      createFilemanReadService({
        adapter: f.context.adapter,
        identifier: f.context.server.pterodactyl_identifier ?? '',
        authorize: f.context.authorize,
      }),
    );
    f.context.fileman = {
      readScope,
      uploadStaged: async () => {
        throw new Error('Unexpected staged upload');
      },
    };
    const originalWrite = f.context.adapter.writeFile.bind(f.context.adapter);
    const write = vi
      .spyOn(f.context.adapter, 'writeFile')
      .mockImplementationOnce(async (...args) => {
        await originalWrite(...args);
        throw new Error('lost response');
      });
    await expect(processMinecraftContent(f.context, f.options)).rejects.toThrow('lost response');
    expect(f.operation.effect_state).toBe('prepared');
    readScope.mockClear();
    const read = vi.spyOn(f.context.adapter, 'readFileForEditor');
    expect(await processMinecraftContent(f.context, f.options)).toBe(true);
    expect(readScope).toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.files.get('server.properties')?.toString()).toContain('motd=Requested');
  });

  it('accepts only the exact same-job Fileman receipt when completing a world import', async () => {
    const f = await minecraftFixture();
    const manifest = {
      id: 'minecraft.world-import',
      destinationRoot: 'imported',
      files: [{ path: 'imported/level.dat', size: 9, sha256: 'a'.repeat(64) }],
    };
    const digest = filemanTransferDigest(manifest);
    const pending = {
      jobId: f.operation.job_id,
      kind: 'world',
      planDigest: 'b'.repeat(64),
      filemanTransfer: { id: manifest.id, destinationRoot: manifest.destinationRoot, digest },
      files: manifest.files,
      absentPaths: [],
      wipes: [],
      inventory: [],
      removeInventoryPaths: [],
    };
    const save = async (value: typeof pending) => {
      await f.f.db
        .updateTable('minecraft_server_profiles')
        .set({ content_state: JSON.stringify(value) })
        .where('server_id', '=', f.serverId)
        .execute();
    };
    await save(pending);
    await expect(verifyMinecraftPendingContent(f.context)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    await f.f.db
      .insertInto('job_steps')
      .values({ job_id: f.operation.job_id, step: filemanTransferReceiptStep(digest) })
      .execute();
    await save({
      ...pending,
      files: [
        { ...manifest.files[0], path: 'imported/other.dat', size: 9, sha256: 'a'.repeat(64) },
      ],
    });
    await expect(verifyMinecraftPendingContent(f.context)).rejects.toMatchObject({
      code: 'conflict',
    });
    await save({ ...pending, jobId: randomUUID() });
    await expect(verifyMinecraftPendingContent(f.context)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    await save(pending);
    await verifyMinecraftPendingContent(f.context);
    expect(
      (
        await f.f.db
          .selectFrom('minecraft_server_profiles')
          .select('content_state')
          .where('server_id', '=', f.serverId)
          .executeTakeFirstOrThrow()
      ).content_state,
    ).toEqual({});
  });

  async function installedPackFixture(
    selection:
      | { provider: 'modrinth'; projectId: string; versionId: string }
      | { sourceId: string },
  ) {
    const f = await minecraftFixture();
    await f.f.db
      .updateTable('minecraft_server_profiles')
      .set({
        configuration: JSON.stringify({ eula: true, modpack: selection }),
        configuration_state: '{}',
      })
      .where('server_id', '=', f.serverId)
      .execute();
    await verifyMinecraftRestore(f.context, f.options);
    f.options.acquireModpack = vi.fn();
    f.options.archiveResolver = vi.fn();
    f.context.adapter.deleteFiles = vi.fn();
    f.context.adapter.uploadFile = vi.fn();
    return f;
  }

  async function playerChangeFixture(
    list: 'operators' | 'whitelist',
    action: 'add' | 'remove' = 'add',
  ) {
    const f = await minecraftFixture();
    const identity = {
      uuid: '11111111-1111-4111-8111-111111111111',
      name: 'Player',
      source: 'mojang' as const,
      verifiedAt: new Date().toISOString(),
      ...(list === 'operators' ? { level: 2, bypassesPlayerLimit: false } : {}),
    };
    const path = list === 'operators' ? 'ops.json' : 'whitelist.json';
    const initial =
      action === 'remove'
        ? planMinecraftPlayerList('[]', list, 'add', identity, {
            operatorLevel: 2,
            bypassesPlayerLimit: false,
          }).content
        : '[]';
    f.files.set(path, Buffer.from(initial));
    await f.f.db
      .updateTable('minecraft_server_profiles')
      .set({
        configuration_state: '{}',
        configuration: JSON.stringify({
          eula: true,
          [list]: action === 'remove' ? ['Player'] : [],
          playerIdentities: {
            operators: action === 'remove' && list === 'operators' ? [identity] : [],
            whitelist: action === 'remove' && list === 'whitelist' ? [identity] : [],
          },
        }),
      })
      .where('server_id', '=', f.serverId)
      .execute();
    await verifyMinecraftRestore(f.context, f.options);
    const command = {
      kind: 'player' as const,
      list,
      action,
      name: 'Player',
      ...(list === 'operators' ? { operatorLevel: 2, bypassesPlayerLimit: false } : {}),
    };
    const prepared = await prepareMinecraftContentPlan(f.f.db, f.serverId, command, {
      ...f.options,
      adapter: f.context.adapter,
    });
    f.context.update = async (patch) => {
      const { plan, ...fields } = patch;
      await f.f.db
        .updateTable('server_operations')
        .set({
          ...fields,
          ...(plan === undefined ? {} : { plan: JSON.stringify(plan) }),
        })
        .where('job_id', '=', f.operation.job_id)
        .execute();
      Object.assign(
        f.operation,
        await f.f.db
          .selectFrom('server_operations')
          .selectAll()
          .where('job_id', '=', f.operation.job_id)
          .executeTakeFirstOrThrow(),
      );
    };
    await f.context.update({
      plan: { ...f.operation.plan, pollCount: 9, minecraftContent: prepared },
    });
    const writeFile = vi.fn(f.context.adapter.writeFile);
    f.context.adapter.writeFile = writeFile;
    const provider = {
      lookupName: vi.fn(async () => ({
        id: identity.uuid.replaceAll('-', ''),
        name: identity.name,
      })),
      lookupUuid: vi.fn(async () => ({
        id: identity.uuid.replaceAll('-', ''),
        name: identity.name,
      })),
    };
    f.options.identityProvider = provider;
    const event = vi.fn(async (messageKey: string, data: Record<string, unknown> = {}) => {
      await f.f.db
        .insertInto('server_events')
        .values({
          server_id: f.serverId,
          job_id: f.operation.job_id,
          actor_id: f.f.context.actorUserId,
          subject_id: f.f.context.subjectUserId,
          support_session_id: null,
          message_key: messageKey,
          data: JSON.stringify(data),
        })
        .execute();
    });
    f.context.event = event;
    const legacy = async () => {
      const planned = planMinecraftPlayerList(initial, list, action, identity, {
        operatorLevel: 2,
        bypassesPlayerLimit: false,
      });
      const { requiresStoppedServer: _stopped, ...text } = planned;
      const phase = `minecraft.text.${createHash('sha256').update(path).digest('hex')}`;
      await f.context.update({
        plan: { ...f.operation.plan, minecraftText: [text] },
        phase,
        effect_state: 'confirmed',
      });
      f.files.set(path, Buffer.from(text.content));
      await f.f.db
        .insertInto('job_steps')
        .values({ job_id: f.operation.job_id, step: phase })
        .execute();
      return text;
    };
    return { ...f, command, path, identity, provider, event, writeFile, legacy };
  }

  it.each([
    ['operators', 'add'],
    ['operators', 'remove'],
    ['whitelist', 'add'],
    ['whitelist', 'remove'],
  ] as const)(
    'preserves the durable %s %s identity when publishing its text plan and on retry',
    async (list, action) => {
      const f = await playerChangeFixture(list, action);
      expect(await processMinecraftContent(f.context, f.options)).toBe(true);
      const plan = (
        await f.f.db
          .selectFrom('server_operations')
          .select('plan')
          .where('job_id', '=', f.operation.job_id)
          .executeTakeFirstOrThrow()
      ).plan;
      expect(plan.minecraftPlayerChange).toMatchObject({
        uuid: f.identity.uuid,
        name: f.identity.name,
        ...(list === 'operators' ? { level: 2, bypassesPlayerLimit: false } : {}),
      });
      expect(plan.minecraftText).toHaveLength(1);
      expect(plan.pollCount).toBe(9);
      const profile = await f.f.db
        .selectFrom('minecraft_server_profiles')
        .select('configuration')
        .where('server_id', '=', f.serverId)
        .executeTakeFirstOrThrow();
      expect(profile.configuration).toMatchObject({ [list]: action === 'add' ? ['Player'] : [] });
      expect(f.writeFile).toHaveBeenCalledTimes(1);
      expect(await processMinecraftContent(f.context, f.options)).toBe(true);
      expect(f.writeFile).toHaveBeenCalledTimes(1);
      expect(f.provider.lookupName).toHaveBeenCalledTimes(1);
      expect(f.provider.lookupUuid).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['operators', 'whitelist'] as const)(
    'recovers only the exact already-applied %s ADD receipt without rewriting or replacing its original text plan',
    async (list) => {
      const f = await playerChangeFixture(list);
      const text = await f.legacy();
      const beforePhase = f.operation.phase;
      expect(await processMinecraftContent(f.context, f.options)).toBe(true);
      const plan = (
        await f.f.db
          .selectFrom('server_operations')
          .select('plan')
          .where('job_id', '=', f.operation.job_id)
          .executeTakeFirstOrThrow()
      ).plan;
      expect(plan.minecraftText).toEqual([text]);
      const { verifiedAt: oldVerifiedAt, ...stableIdentity } = f.identity;
      expect(plan.minecraftPlayerChange).toMatchObject(stableIdentity);
      expect(
        Date.parse((plan.minecraftPlayerChange as { verifiedAt: string }).verifiedAt),
      ).toBeGreaterThanOrEqual(Date.parse(oldVerifiedAt));
      expect(plan.minecraftPlayerRecovery).toMatchObject({
        path: f.path,
        afterSha256: text.afterSha256,
        reason: 'missing_add_receipt_confirmed_after_image',
      });
      expect(f.operation.phase).toBe(beforePhase);
      expect(f.operation.effect_state).toBe('confirmed');
      expect(f.writeFile).not.toHaveBeenCalled();
      expect(f.event).toHaveBeenCalledExactlyOnceWith(
        'minecraft.player.receipt_recovered',
        expect.objectContaining({ path: f.path, afterSha256: text.afterSha256 }),
      );
      expect(await processMinecraftContent(f.context, f.options)).toBe(true);
      expect(f.event).toHaveBeenCalledTimes(1);
      expect(f.provider.lookupName).toHaveBeenCalledTimes(1);
      expect(f.writeFile).not.toHaveBeenCalled();
    },
  );

  it('retains the recovered identity across an audit outage but cannot finalize without its audit', async () => {
    const f = await playerChangeFixture('operators');
    const text = await f.legacy();
    f.event.mockRejectedValueOnce(new Error('isolated audit outage'));
    await expect(processMinecraftContent(f.context, f.options)).rejects.toThrow(
      'isolated audit outage',
    );
    expect(f.operation.plan.minecraftPlayerChange).toBeDefined();
    expect(f.operation.plan.minecraftText).toEqual([text]);
    const profile = await f.f.db
      .selectFrom('minecraft_server_profiles')
      .select('configuration')
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(profile.configuration).toMatchObject({ operators: [] });
    expect(await processMinecraftContent(f.context, f.options)).toBe(true);
    expect(f.event).toHaveBeenCalledTimes(2);
    expect(f.provider.lookupName).toHaveBeenCalledTimes(1);
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it.each([
    'reclaimed-uuid',
    'changed-canonical-name',
    'remote-drift',
    'after-hash',
    'path',
    'privilege',
    'malformed-receipt',
  ] as const)(
    'refuses missing-receipt recovery on %s without any remote write',
    async (problem) => {
      const f = await playerChangeFixture('operators');
      const text = await f.legacy();
      if (problem === 'reclaimed-uuid') {
        const changed = { id: '22222222222242228222222222222222', name: 'Player' };
        f.provider.lookupName.mockResolvedValue(changed);
        f.provider.lookupUuid.mockResolvedValue(changed);
      } else if (problem === 'changed-canonical-name') {
        const changed = { id: f.identity.uuid.replaceAll('-', ''), name: 'RenamedPlayer' };
        f.provider.lookupName.mockResolvedValue(changed);
        f.provider.lookupUuid.mockResolvedValue(changed);
      } else if (problem === 'remote-drift') f.files.set(f.path, Buffer.from('[]'));
      else if (problem === 'after-hash') text.afterSha256 = '0'.repeat(64);
      else if (problem === 'path') text.path = 'whitelist.json';
      else if (problem === 'privilege') {
        const rows = JSON.parse(text.content);
        rows[0].level = 4;
        text.content = `${JSON.stringify(rows, null, 2)}\n`;
        text.afterSha256 = createHash('sha256').update(text.content).digest('hex');
        f.files.set(f.path, Buffer.from(text.content));
      }
      await f.context.update({
        plan: {
          ...f.operation.plan,
          minecraftText: [text],
          ...(problem === 'malformed-receipt' ? { minecraftPlayerChange: null } : {}),
        },
      });
      await expect(processMinecraftContent(f.context, f.options)).rejects.toThrow();
      expect(f.writeFile).not.toHaveBeenCalled();
      expect(f.event).not.toHaveBeenCalled();
      expect(f.operation.plan.minecraftPlayerRecovery).toBeUndefined();
    },
  );

  it('does not infer a removed player identity from a legacy REMOVE after-image', async () => {
    const f = await playerChangeFixture('operators', 'remove');
    await f.legacy();
    await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.provider.lookupName).not.toHaveBeenCalled();
    expect(f.writeFile).not.toHaveBeenCalled();
    expect(f.event).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {
      uuid: '11111111-1111-4111-8111-111111111111',
      name: 'Player',
      source: 'mojang',
      verifiedAt: '2026-10-09T00:00:00Z',
    },
  ])(
    'rejects malformed or privilege-incomplete existing authority before an unapplied text write (%j)',
    async (receipt) => {
      const f = await playerChangeFixture('operators');
      await f.legacy();
      f.files.set(f.path, Buffer.from('[]'));
      await f.f.db.deleteFrom('job_steps').where('job_id', '=', f.operation.job_id).execute();
      await f.context.update({
        phase: 'planned',
        effect_state: 'none',
        plan: { ...f.operation.plan, minecraftPlayerChange: receipt },
      });
      await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
        code: 'operation_uncertain',
      });
      expect(f.writeFile).not.toHaveBeenCalled();
      expect(f.provider.lookupName).not.toHaveBeenCalled();
      expect(f.files.get(f.path)?.toString()).toBe('[]');
    },
  );

  it('refuses changed provider versions and uploaded packs before acquisition or server file effects', async () => {
    const selected = { provider: 'modrinth' as const, projectId: 'packA', versionId: 'versionA' };
    const f = await installedPackFixture(selected);
    const commands = [
      { kind: 'modpack', ...selected, projectId: 'packB' },
      { kind: 'modpack', ...selected, versionId: 'versionB' },
      { kind: 'modpack-upload', archiveRef: randomUUID() },
    ];
    for (const command of commands)
      await expect(
        prepareMinecraftContentPlan(f.f.db, f.serverId, command, {
          ...f.options,
          adapter: f.context.adapter,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    await f.f.db
      .updateTable('minecraft_server_profiles')
      .set({ configuration: JSON.stringify({ eula: true, modpack: { sourceId: randomUUID() } }) })
      .where('server_id', '=', f.serverId)
      .execute();
    await expect(
      prepareMinecraftContentPlan(
        f.f.db,
        f.serverId,
        { kind: 'modpack-upload', archiveRef: randomUUID() },
        { ...f.options, adapter: f.context.adapter },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(f.options.acquireModpack).not.toHaveBeenCalled();
    expect(f.options.archiveResolver).not.toHaveBeenCalled();
    expect(f.context.adapter.deleteFiles).not.toHaveBeenCalled();
    expect(f.context.adapter.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects queued pack changes against fresh persisted selection, including target-equality races', async () => {
    const selected = { sourceId: randomUUID() };
    const target = randomUUID();
    const f = await installedPackFixture(selected);
    const prepared: MinecraftPreparedContent = {
      combinationId: f.combinationId,
      command: {
        kind: 'modpack-upload',
        archiveRef: target,
        replace: { wipeConsent: true, expectedDeletePaths: ['mods'], backupBefore: false },
      },
      previousModpack: selected,
      backupBefore: false,
      deletePaths: ['mods'],
    };
    f.operation.plan.minecraftContent = JSON.parse(JSON.stringify(prepared));
    for (const sourceId of [randomUUID(), target]) {
      await f.f.db
        .updateTable('minecraft_server_profiles')
        .set({ configuration: JSON.stringify({ eula: true, modpack: { sourceId } }) })
        .where('server_id', '=', f.serverId)
        .execute();
      await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
        code: 'conflict',
      });
    }
    expect(f.context.adapter.deleteFiles).not.toHaveBeenCalled();
    expect(f.context.adapter.uploadFile).not.toHaveBeenCalled();
    expect(await f.f.db.selectFrom('minecraft_staging_claims').selectAll().execute()).toEqual([]);
  });

  it.each([
    { oldContent: true, disk: 64 },
    { oldContent: false, disk: 64 },
    { oldContent: true, disk: 0 },
  ])(
    'consented replacement $oldContent with disk=$disk verifies removals and retries safely',
    async ({ oldContent, disk }) => {
      // Tiny isolated fixtures need the absolute safety margin, not 10% of
      // a shared multi-terabyte host. Production's 10% default is unchanged.
      const checkDisk = contentDisk.assertContentDiskSpace;
      vi.spyOn(contentDisk, 'assertContentDiskSpace').mockImplementation(
        (directory, bytes, policy) =>
          checkDisk(directory, bytes, { ...policy, minimumFreePercent: 1 }),
      );

      const selected = { provider: 'modrinth' as const, projectId: 'packA', versionId: 'versionA' };
      const f = await installedPackFixture(selected);
      f.context.server.limits = { ...f.context.server.limits, disk };
      await f.f.db
        .updateTable('managed_servers')
        .set({ limits: JSON.stringify(f.context.server.limits) })
        .where('id', '=', f.serverId)
        .execute();
      const root = `./mountdata/test-assets/m4-replacement-${randomUUID()}`;
      const target = { provider: 'modrinth' as const, projectId: 'packB', versionId: 'versionB' };
      const env = {
        ...f.options.env,
        NH_MINECRAFT_SOURCE_ROOT: `${root}/sources`,
        NH_MINECRAFT_CONTENT_ROOT: `${root}/expanded`,
        NH_MINECRAFT_SOURCE_FREE_BYTES: '0',
        NH_MINECRAFT_SOURCE_FREE_PERCENT: '0',
      };
      try {
        const zip = new ZipFile();
        zip.addBuffer(
          Buffer.from(
            JSON.stringify({
              formatVersion: 1,
              game: 'minecraft',
              name: 'Isolated empty replacement pack',
              versionId: 'versionB',
              dependencies: { minecraft: '1.21.1' },
              files: [],
            }),
          ),
          'modrinth.index.json',
        );
        zip.end();
        const chunks: Buffer[] = [];
        for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const sources = createMinecraftSourceStore(f.f.db, f.f.context, env, {
          authorize: async () => f.f.context,
        });
        const source = await sources.reserveUpload({
          kind: 'modpack',
          serverId: f.serverId,
          idempotencyKey: randomUUID(),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        await sources.upload(
          source.id,
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          bytes.length,
        );
        const acquired = await sources.resolveForServer(source.id, f.serverId);
        f.options = {
          ...f.options,
          env,
          mountdataRoot: resolve(env.NH_MINECRAFT_CONTENT_ROOT),
          acquireModpack: vi.fn(async () => ({ ...acquired, sourceId: source.id })),
        };
        const oldFile = Buffer.from('old-only pack configuration');
        if (oldContent) f.files.set('config/old-only.cfg', oldFile);
        if (oldContent)
          await f.f.db
            .insertInto('minecraft_content_items')
            .values({
              server_id: f.serverId,
              path: 'config/old-only.cfg',
              installed_by: f.operation.job_id,
              artifact: JSON.stringify({
                path: 'config/old-only.cfg',
                size: oldFile.length,
                sha256: createHash('sha256').update(oldFile).digest('hex'),
              }),
            })
            .execute();
        const prepared = await prepareMinecraftContentPlan(
          f.f.db,
          f.serverId,
          {
            kind: 'modpack',
            ...target,
            replace: {
              wipeConsent: true,
              expectedDeletePaths: oldContent ? ['config'] : [],
              backupBefore: false,
            },
          },
          { ...f.options, adapter: f.context.adapter },
        );
        expect(prepared.previousModpack).toEqual(selected);
        expect(prepared.deletePaths).toEqual(oldContent ? ['config'] : []);
        f.operation.plan.minecraftContent = JSON.parse(JSON.stringify(prepared));
        await f.f.db
          .updateTable('server_operations')
          .set({ action: 'minecraft-content', plan: JSON.stringify(f.operation.plan) })
          .where('job_id', '=', f.operation.job_id)
          .execute();
        await f.f.db
          .updateTable('operation_jobs')
          .set({ state: 'running', completed_at: null })
          .where('id', '=', f.operation.job_id)
          .execute();
        await f.f.db
          .updateTable('managed_servers')
          .set({ active_operation_id: f.operation.job_id })
          .where('id', '=', f.serverId)
          .execute();
        f.context.adapter.getResources = vi.fn(async () => ({
          current_state: 'offline' as const,
          is_suspended: false,
          resources: {
            memory_bytes: 0,
            cpu_absolute: 0,
            disk_bytes: disk === 0 ? 8 * 1024 ** 3 : 100,
            network_rx_bytes: 0,
            network_tx_bytes: 0,
            uptime: 0,
          },
        }));
        f.context.adapter.deleteFiles = vi.fn(async (_identifier, _root, paths) => {
          const before = await f.f.db
            .selectFrom('minecraft_server_profiles')
            .select('configuration')
            .where('server_id', '=', f.serverId)
            .executeTakeFirstOrThrow();
          expect(before.configuration).toMatchObject({ modpack: selected });
          for (const path of paths)
            for (const file of [...f.files.keys()])
              if (file === path || file.startsWith(`${path}/`)) f.files.delete(file);
        });
        if (!oldContent) {
          // An empty preview is still an exact preview; new files cannot be wiped
          // using approval of an earlier empty directory inventory.
          f.files.set('config/queued-change.cfg', Buffer.from('new unapproved content'));
          await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
            code: 'conflict',
          });
          expect(f.context.adapter.deleteFiles).not.toHaveBeenCalled();
          expect(f.files.has('config/queued-change.cfg')).toBe(true);
          f.files.delete('config/queued-change.cfg');
        }
        expect(await processMinecraftContent(f.context, f.options)).toBe(true);
        expect(f.files.has('config/old-only.cfg')).toBe(false);
        expect(f.files.has('server.jar')).toBe(true);
        expect(await f.f.db.selectFrom('minecraft_content_items').selectAll().execute()).toEqual(
          [],
        );
        const updated = await f.f.db
          .selectFrom('minecraft_server_profiles')
          .select(['configuration', 'installed', 'content_state'])
          .where('server_id', '=', f.serverId)
          .executeTakeFirstOrThrow();
        expect(updated.configuration).toMatchObject({ modpack: target });
        expect(updated.installed).toBe(true);
        expect(updated.content_state).toEqual({});
        // Retry after the atomic selection commit, before the enclosing job finishes.
        expect(await processMinecraftContent(f.context, f.options)).toBe(true);
        expect(f.context.adapter.deleteFiles).toHaveBeenCalledTimes(oldContent ? 1 : 0);
        f.operation.plan.minecraftContent = {
          ...prepared,
          command: { ...prepared.command, versionId: 'changed-after-commit' },
        };
        await expect(processMinecraftContent(f.context, f.options)).rejects.toMatchObject({
          code: 'conflict',
        });
        expect(f.context.adapter.deleteFiles).toHaveBeenCalledTimes(oldContent ? 1 : 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('verifies timestamp-variable Fabric launchers using signed entry contents and stores the actual target receipt', async () => {
    const bootstrap = await launcherJar('2026-01-01T00:00:00Z');
    const installed = await launcherJar('2026-01-02T00:00:00Z');
    expect(installed.equals(bootstrap)).toBe(false);
    const f = await minecraftFixture({
      bootstrap,
      installed,
      digest: await canonicalMinecraftJarSha256(bootstrap),
    });
    await f.f.db
      .updateTable('minecraft_server_profiles')
      .set({ configuration_state: '{}' })
      .where('server_id', '=', f.serverId)
      .execute();
    expect(await verifyMinecraftRestore(f.context, f.options)).toBe(true);
    const profile = await f.f.db
      .selectFrom('minecraft_server_profiles')
      .select('installed_manifest')
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(profile.installed_manifest).toEqual(
      expect.arrayContaining([
        {
          path: 'fabric-server-launch.jar',
          sha256: createHash('sha256').update(installed).digest('hex'),
          size: installed.length,
        },
      ]),
    );
    const propertiesPath = 'fabric-server-launcher.properties';
    f.files.set(propertiesPath, Buffer.from('# First generated timestamp\nserverJar=server.jar\n'));
    expect(await verifyMinecraftRestore(f.context, f.options)).toBe(true);
    const properties = Buffer.from('# Different generated timestamp\nserverJar=server.jar\n');
    f.files.set(propertiesPath, properties);
    expect(await verifyMinecraftRestore(f.context, f.options)).toBe(true);
    const refreshed = await f.f.db
      .selectFrom('minecraft_server_profiles')
      .select('installed_manifest')
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(refreshed.installed_manifest).toEqual(
      expect.arrayContaining([
        {
          path: propertiesPath,
          sha256: createHash('sha256').update(properties).digest('hex'),
          size: properties.length,
        },
      ]),
    );
    f.files.set(propertiesPath, Buffer.from('serverJar=another.jar\n'));
    await expect(verifyMinecraftRestore(f.context, f.options)).rejects.toMatchObject({
      code: 'conflict',
    });
    f.files.set(propertiesPath, Buffer.from('#generated\rserverJar=other.jar\r'));
    await expect(verifyMinecraftRestore(f.context, f.options)).rejects.toMatchObject({
      code: 'conflict',
    });
    f.files.set(propertiesPath, properties);
    f.files.set(
      'fabric-server-launch.jar',
      await launcherJar('2026-01-02T00:00:00Z', 'launch.mainClass=wrong.Class\n'),
    );
    await expect(verifyMinecraftRestore(f.context, f.options)).rejects.toMatchObject({
      code: 'conflict',
    });
    f.files.set('fabric-server-launch.jar', installed);
    f.files.set('server.jar', Buffer.from('altered upstream server'));
    await expect(verifyMinecraftRestore(f.context, f.options)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('keeps raw generated-file checks without explicit signed semantic evidence and rejects an unbound launcher role', async () => {
    const bootstrap = await launcherJar('2026-01-01T00:00:00Z');
    const installed = await launcherJar('2026-01-02T00:00:00Z');
    const base = { bootstrap, installed, digest: await canonicalMinecraftJarSha256(bootstrap) };
    const raw = await minecraftFixture({ ...base, semantic: false });
    await expect(verifyMinecraftRestore(raw.context, raw.options)).rejects.toMatchObject({
      code: 'conflict',
    });
    const unbound = await minecraftFixture({ ...base, boundPath: 'another-launcher.jar' });
    await expect(verifyMinecraftRestore(unbound.context, unbound.options)).rejects.toMatchObject({
      code: 'configuration_invalid',
    });
  });

  it('attests initial Vanilla outputs without writing configuration or claiming script success', async () => {
    const { f, serverId, files, context, options, operation } = await minecraftFixture();
    operation.action = 'provision';
    operation.phase = 'installation';
    const write = vi.spyOn(context.adapter, 'writeFile');
    const receipt = await verifyMinecraftInitialInstallation(context, options);
    expect(receipt).toMatchObject({
      integrationId: 'minecraft',
      files: [{ path: 'server.jar', size: files.get('server.jar')?.length }],
    });
    expect(write).not.toHaveBeenCalled();
    expect(
      (
        await f.db
          .selectFrom('minecraft_server_profiles')
          .select('installed')
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).installed,
    ).toBe(false);
    operation.action = 'reinstall';
    expect(await verifyMinecraftInitialInstallation(context, options)).toBeNull();
    operation.action = 'wipe';
    expect(await verifyMinecraftInitialInstallation(context, options)).toBeNull();
  });
  it.each(['hash', 'image', 'authorization', 'launch'] as const)(
    'rejects initial Vanilla recovery with invalid %s evidence',
    async (failure) => {
      const { files, context, options, operation } = await minecraftFixture();
      operation.action = 'provision';
      operation.phase = 'installation';
      if (failure === 'hash') files.set('server.jar', Buffer.from('corrupted'));
      if (failure === 'image') options.observedImageDigest = async () => 'invalid-image-digest';
      if (failure === 'authorization')
        context.authorize = async () => {
          throw new Error('revoked');
        };
      if (failure === 'launch') {
        const get = context.adapter.getApplicationServer;
        context.adapter.getApplicationServer = async (id) => ({
          ...(await get(id)),
          container: { image: 'foreign', startup_command: 'foreign', installed: true },
        });
      }
      await expect(verifyMinecraftInitialInstallation(context, options)).rejects.toThrow();
    },
  );
  it('verifies a declaration-backed Vanilla installation without signatures and still rejects changed artifacts', async () => {
    const { f, serverId, files, context, options } = await minecraftFixture();
    await f.db.deleteFrom('minecraft_verification_evidence').execute();
    options.env = {};
    expect(await configureMinecraftProvision(context, options)).toBe(true);
    const profile = await f.db
      .selectFrom('minecraft_server_profiles')
      .select(['installed', 'installed_manifest'])
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect(profile.installed).toBe(true);
    expect(profile.installed_manifest).toEqual([
      {
        path: 'server.jar',
        size: files.get('server.jar')?.length,
        sha256: createHash('sha256')
          .update(files.get('server.jar') ?? '')
          .digest('hex'),
      },
    ]);
    files.set('server.jar', Buffer.from('changed runtime jar'));
    await expect(assertMinecraftLaunchInputs(context, options)).rejects.toThrow('conflict');
  });

  it('applies declared modern whitelist configuration before a first generated properties file', async () => {
    const { f, serverId, files, context, options } = await minecraftFixture();
    await f.db.deleteFrom('minecraft_verification_evidence').execute();
    options.env = {};
    files.delete('server.properties');
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({
        configuration: JSON.stringify({ eula: true, properties: { 'white-list': true } }),
      })
      .where('server_id', '=', serverId)
      .execute();
    expect(await configureMinecraftProvision(context, options)).toBe(true);
    expect(files.get('server.properties')?.toString()).toContain('white-list=true');
  });
  it('rejects unsupported legacy player management before any installation effects', async () => {
    const { f, combinationId, files, options } = await minecraftFixture();
    const choice = await f.db
      .selectFrom('minecraft_combinations')
      .select('combination')
      .where('id', '=', combinationId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('minecraft_combinations')
      .set({
        combination: JSON.stringify({
          ...(choice.combination as object),
          release: '1.6.4',
          family: 'legacy',
        }),
      })
      .where('id', '=', combinationId)
      .execute();
    const before = [...files.entries()];
    for (const configuration of [
      { eula: true, operators: ['Player'] },
      { eula: true, whitelist: ['Player'] },
      { eula: true, properties: { 'white-list': true } },
    ])
      await expect(
        prepareMinecraftCreationConfig(f.db, combinationId, configuration, options),
      ).rejects.toThrow('integration_unavailable');
    expect([...files.entries()]).toEqual(before);
    await expect(
      prepareMinecraftCreationConfig(f.db, combinationId, { eula: true }, options),
    ).resolves.toMatchObject({ configuration: { eula: true } });
  });

  it('fences initial security configuration before the first write and clears it only after a complete retry', async () => {
    const { f, serverId, operation, files, context, options } = await minecraftFixture();
    const player = {
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Player',
      source: 'mojang',
      verifiedAt: new Date().toISOString(),
    };
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({
        configuration: JSON.stringify({
          eula: true,
          whitelist: ['Player'],
          playerIdentities: { operators: [], whitelist: [player] },
        }),
      })
      .where('server_id', '=', serverId)
      .execute();
    files.delete('eula.txt');
    const originalEffect = context.effect;
    const whitelistStep = `minecraft.text.${createHash('sha256').update('whitelist.json').digest('hex')}`;
    let fail = true;
    context.effect = async (phase, perform) => {
      if (phase === whitelistStep && fail) {
        fail = false;
        throw new Error('interrupted before whitelist effect');
      }
      return originalEffect(phase, perform);
    };
    await expect(configureMinecraftProvision(context, options)).rejects.toThrow(
      'interrupted before whitelist effect',
    );
    expect(files.get('eula.txt')?.toString()).toBe('eula=true\n');
    expect(files.has('whitelist.json')).toBe(false);
    expect(
      (
        await f.db
          .selectFrom('minecraft_server_profiles')
          .selectAll()
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).configuration_state,
    ).toMatchObject({
      status: 'planned',
      jobId: operation.job_id,
      files: expect.arrayContaining([{ path: 'whitelist.json', sha256: expect.any(String) }]),
    });
    await expect(verifyMinecraftRestore(context, options)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    await expect(
      enqueueServerOperation(f.db, f.context, serverId, {
        action: 'start',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await configureMinecraftProvision(context, options)).toBe(true);
    expect(JSON.parse(files.get('whitelist.json')?.toString() ?? 'null')).toEqual([
      { uuid: player.uuid, name: player.name },
    ]);
    expect(
      await f.db
        .selectFrom('minecraft_server_profiles')
        .select(['installed', 'configuration_state'])
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ installed: true, configuration_state: {} });
    // Later authorized player changes must not remain pinned to the initial hash.
    files.set('whitelist.json', Buffer.from('[]'));
    operation.action = 'minecraft-content';
    expect(await verifyMinecraftRestore(context, options)).toBe(true);
  });

  it('does not verify a fresh installation before its configuration was even planned', async () => {
    const { context, options } = await minecraftFixture();
    await expect(verifyMinecraftRestore(context, options)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
  });
  it('requires the exact confirmed pre-operation backup to supersede incomplete configuration', async () => {
    const { f, serverId, operation, context, options } = await minecraftFixture();
    const backupId = randomUUID();
    await f.db
      .updateTable('server_operations')
      .set({ plan: JSON.stringify({ backupComplete: true, backupId }) })
      .where('job_id', '=', operation.job_id)
      .execute();
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ configuration_state: JSON.stringify({ status: 'pending', jobId: operation.job_id }) })
      .where('server_id', '=', serverId)
      .execute();
    const restore = {
      ...operation,
      action: 'restore' as const,
      job_id: randomUUID(),
      plan: { backupId: randomUUID() },
    };
    const restoreContext = { ...context, operation: () => restore };
    await expect(verifyMinecraftRestore(restoreContext, options)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    restore.plan.backupId = backupId;
    expect(await verifyMinecraftRestore(restoreContext, options)).toBe(true);
    expect(
      (
        await f.db
          .selectFrom('minecraft_server_profiles')
          .select('configuration_state')
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).configuration_state,
    ).toEqual({});
  });
  it('does not bypass requested initial modpack completion using correct configuration files alone', async () => {
    const { f, serverId, operation, files, context, options } = await minecraftFixture();
    const digest = '7'.repeat(64);
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({
        configuration_state: JSON.stringify({
          status: 'planned',
          jobId: operation.job_id,
          files: [
            {
              path: 'eula.txt',
              sha256: createHash('sha256')
                .update(files.get('eula.txt') ?? Buffer.alloc(0))
                .digest('hex'),
            },
          ],
          initialContentDigest: digest,
        }),
      })
      .where('server_id', '=', serverId)
      .execute();
    await f.db
      .insertInto('job_steps')
      .values({ job_id: operation.job_id, step: `minecraft.initial-content.${'8'.repeat(64)}` })
      .execute();
    await expect(verifyMinecraftRestore(context, options)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    await f.db
      .insertInto('job_steps')
      .values({ job_id: operation.job_id, step: `minecraft.initial-content.${digest}` })
      .execute();
    expect(await verifyMinecraftRestore(context, options)).toBe(true);
  });

  it('blocks start and verification while any partial-install file, removal or pre-wipe proof is missing', async () => {
    const { f, serverId, operation, combinationId, files, context, options } =
      await minecraftFixture();
    const desired = Buffer.from('verified dedicated-server mod');
    const sha256 = createHash('sha256').update(desired).digest('hex');
    const contentState = {
      jobId: operation.job_id,
      kind: 'content',
      planDigest: '3'.repeat(64),
      files: [{ path: 'mods/new.jar', sha256, size: desired.length }],
      absentPaths: ['mods/old.jar'],
      wipes: [{ jobId: operation.job_id, path: 'mods' }],
      inventory: [
        {
          path: 'mods/new.jar',
          sha256,
          provider: 'modrinth',
          projectId: 'fixture',
          versionId: 'fixture',
          dependencies: [],
        },
      ],
      removeInventoryPaths: ['mods/old.jar'],
    };
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({
        installed: false,
        installed_manifest: JSON.stringify([
          { path: 'server.jar', sha256: '4'.repeat(64), size: 4 },
        ]),
        content_state: JSON.stringify(contentState),
        configuration_state: '{}',
      })
      .where('server_id', '=', serverId)
      .execute();
    await expect(
      enqueueServerOperation(f.db, f.context, serverId, {
        action: 'start',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(verifyMinecraftPendingContent(context)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    await expect(verifyMinecraftRestore(context, options)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    const unrelated = {
      ...operation,
      job_id: randomUUID(),
      action: 'minecraft-content' as const,
      plan: {
        minecraftContent: {
          combinationId,
          command: { kind: 'properties', changes: { motd: 'Cannot clear fence' } },
          backupBefore: false,
        },
      },
    };
    await expect(
      processMinecraftContent({ ...context, operation: () => unrelated }, options),
    ).rejects.toMatchObject({ code: 'operation_uncertain' });
    files.set('mods/new.jar', desired);
    await expect(verifyMinecraftPendingContent(context)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    await f.db
      .insertInto('job_steps')
      .values({
        job_id: operation.job_id,
        step: `minecraft.remove.${createHash('sha256').update('mods').digest('hex')}`,
      })
      .execute();
    files.set('mods/old.jar', Buffer.from('must be removed'));
    await expect(verifyMinecraftPendingContent(context)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(
      (
        await f.db
          .selectFrom('minecraft_server_profiles')
          .select('installed')
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).installed,
    ).toBe(false);
    files.delete('mods/old.jar');
    await verifyMinecraftPendingContent(context);
    expect(
      await f.db
        .selectFrom('minecraft_server_profiles')
        .select(['installed', 'content_state'])
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ installed: true, content_state: {} });
    expect(
      (
        await f.db
          .selectFrom('minecraft_content_items')
          .selectAll()
          .where('server_id', '=', serverId)
          .execute()
      ).map((file) => file.path),
    ).toEqual(['mods/new.jar']);
    operation.action = 'minecraft-content';
    await verifyMinecraftRestore(context, options);
    const retained = await f.db
      .selectFrom('minecraft_content_items')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    expect(retained.map((file) => file.path)).toEqual(['mods/new.jar']);
    expect(
      installedContentChange(
        retained.map(
          (file) => file.artifact as Parameters<typeof installedContentChange>[0][number],
        ),
        { remove: { provider: 'modrinth', projectId: 'fixture' } },
      ).removePaths,
    ).toEqual(['mods/new.jar']);
  });
});
