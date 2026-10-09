import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { installedContentChange } from '@nickhosting/content-providers';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftVerificationChecks } from '@nickhosting/minecraft';
import type { ApplicationServer, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { canonicalMinecraftJarSha256 } from '../../../games/minecraft/src/generated-launcher.js';
import { planMinecraftPlayerList } from '../../../games/minecraft/src/management.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { type LifecycleOptions, processServerOperation } from './lifecycle.js';
import {
  configureMinecraftProvision,
  type MinecraftContentOptions,
  type MinecraftPreparedContent,
  prepareMinecraftContentPlan,
  processMinecraftContent,
  verifyMinecraftPendingContent,
  verifyMinecraftRestore,
} from './minecraft-content.js';
import { minecraftMappingDigest, signMinecraftEvidence } from './minecraft-registry.js';
import { createMinecraftSourceStore } from './minecraft-sources.js';
import { enqueueServerOperation } from './registry.js';
import { managementFixture } from './test-fixtures.js';
import { reserveUploadIngestion } from './upload-admission.js';

describe('Minecraft durable lifecycle and ingestion boundaries', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
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

  async function minecraftFixture(launcher?: {
    bootstrap: Buffer;
    installed: Buffer;
    digest: string;
    boundPath?: string;
    semantic?: boolean;
  }) {
    const profile = launcher ? 'fabric' : 'vanilla';
    const image = 'fixture-java:21';
    const startup = `java -jar ${launcher ? (launcher.boundPath ?? 'fabric-server-launch.jar') : 'server.jar'} nogui`;
    const f = await managementFixture(database.db);
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
      .values({ id: 'minecraft-java', version: 'fixture', manifest: {} })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ game_id: 'minecraft-java', runtime_id: profile, docker_image: image, startup })
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

  it.each([true, false])(
    'consented replacement (old files: %s) verifies removals and selection and safely retries the same job',
    async (oldContent) => {
      const selected = { provider: 'modrinth' as const, projectId: 'packA', versionId: 'versionA' };
      const f = await installedPackFixture(selected);
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
            disk_bytes: 100,
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
