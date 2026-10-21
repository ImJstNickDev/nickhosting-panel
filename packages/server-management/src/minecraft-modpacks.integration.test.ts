import { randomUUID } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMinecraftModpacksService,
  type MinecraftModpackHooks,
} from './minecraft-modpacks.js';
import { modpackDigest, type PreparedMinecraftModpack } from './minecraft-modpacks-plan.js';
import { enqueueServerOperation } from './registry.js';
import { managementFixture } from './test-fixtures.js';

describe('Modpacks durable preparation and apply', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    await database?.destroy();
  });

  async function fixture() {
    const f = await managementFixture(database.db, { interactive: true });
    const serverId = await f.server();
    const combinationId = randomUUID();
    await f.db
      .insertInto('minecraft_combinations')
      .values({
        id: combinationId,
        mapping_id: f.mappingId,
        identity_digest: '1'.repeat(64),
        mapping_digest: '2'.repeat(64),
        combination: '{}',
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
    const target = {
      minecraftVersion: '1.21.1',
      loader: 'fabric' as const,
      loaderVersion: '0.16.10',
    };
    const prepared: PreparedMinecraftModpack = {
      pack: {
        project: {
          provider: 'modrinth',
          id: 'pack',
          name: 'Pack',
          summary: '',
          websiteUrl: 'https://example.test/pack',
          authors: [],
        },
        version: {
          id: 'v1',
          projectId: 'pack',
          name: 'First',
          version: '1.0',
          minecraftVersions: ['1.21.1'],
          loaders: ['fabric'],
          channel: 'release',
          available: true,
          source: 'modrinth-index',
        },
      },
      target,
      stagingKey: '/private/staged',
      blockers: [],
      files: [{ path: 'mods/example.jar', size: 20, sha256: 'a'.repeat(64) }],
    };
    const observation = {
      combinationId,
      mappingId: f.mappingId,
      entries: [],
      worldRoots: ['world'],
      protectedPaths: ['server.jar'],
      replacePaths: [],
    };
    const calls: string[] = [];
    const scope = {
      inspect: vi.fn(async () => observation),
      stop: vi.fn(async () => {
        calls.push('stop');
      }),
      backup: vi.fn(async () => {
        calls.push('backup');
        return 'verified-backup';
      }),
      configureRuntime: vi.fn(async () => {
        calls.push('runtime');
      }),
      publish: vi.fn(async () => {
        calls.push('publish');
      }),
      verify: vi.fn(async () => {
        calls.push('verify');
        return prepared.files.map((file) => ({ ...file, modifiedAt: '2026-01-01T00:00:00Z' }));
      }),
    };
    const hooks: MinecraftModpackHooks = {
      wake: vi.fn(),
      authorize: vi.fn(async () => {}),
      prepare: vi.fn(async () => structuredClone(prepared)),
      inspect: vi.fn(async () => observation),
      resolveRuntime: vi.fn(async () => ({ combinationId, mappingId: f.mappingId, target })),
      withServerLock: async (_row, work) => work(scope),
      recover: vi.fn(async () => ({ state: 'unknown' as const })),
      cleanup: vi.fn(async () => {}),
    };
    const service = createMinecraftModpacksService({ db: database.db, hooks });
    const selection = {
      provider: 'modrinth',
      projectId: 'pack',
      versionId: 'v1',
      mode: 'install',
      idempotencyKey: randomUUID(),
    };
    const prepare = () => service.prepare(f.context, serverId, selection);
    async function ready() {
      const queued = await prepare();
      const operationId = queued.operation?.id as string;
      await service.process(operationId);
      const operation = (await service.snapshot(f.context, serverId)).operation;
      if (!operation) throw new Error('Expected operation');
      return operation;
    }
    async function apply() {
      const operation = await ready();
      const request = {
        operationId: operation.id,
        planDigest: operation.planDigest,
        confirm: true,
        backupBefore: true,
        expectedDeletePaths: operation.deletePaths,
        idempotencyKey: randomUUID(),
      };
      await service.apply(f.context, serverId, request);
      return { operationId: operation.id, request };
    }
    return {
      ...f,
      serverId,
      combinationId,
      prepared,
      observation,
      scope,
      hooks,
      calls,
      service,
      selection,
      prepare,
      ready,
      apply,
    };
  }

  it('prepares without game effects, binds a durable manifest, and replays selection idempotently', async () => {
    const f = await fixture();
    const first = await f.prepare();
    expect(f.hooks.prepare).not.toHaveBeenCalled();
    expect(await f.service.pending()).toEqual([first.operation?.id]);
    expect((await f.prepare()).operation?.id).toBe(first.operation?.id);
    const privateRow = await f.db
      .selectFrom('minecraft_modpack_operations')
      .selectAll()
      .where('id', '=', first.operation?.id as string)
      .executeTakeFirstOrThrow();
    expect(privateRow.actor_session_id).toBe(f.context[authSessionId]);
    await f.service.process(first.operation?.id as string);
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot.operation?.state).toBe('ready');
    expect(snapshot.operation?.changes?.write).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('/private/staged');
    expect(f.calls).toEqual([]);
    await expect(
      f.service.prepare(f.context, f.serverId, { ...f.selection, versionId: 'different' }),
    ).rejects.toThrow('conflict');
  });
  it('prioritizes queued work over repeatedly deferred private staging cleanup', async () => {
    const f = await fixture();
    const old = await f.ready();
    await f.db
      .updateTable('minecraft_modpack_operations')
      .set({
        state: 'failed',
        held_bytes: '50',
        staging_root: '/private/old',
        updated_at: new Date(Date.now() - 60000),
      })
      .where('id', '=', old.id)
      .execute();
    const next = await f.service.prepare(f.context, f.serverId, {
      ...f.selection,
      idempotencyKey: randomUUID(),
    });
    expect(await f.service.pending(1)).toEqual([next.operation?.id]);
  });
  it('refuses apply admission while a generic operation owns the server', async () => {
    const f = await fixture();
    const operation = await f.ready();
    await enqueueServerOperation(f.db, f.context, f.serverId, {
      action: 'stop',
      idempotencyKey: randomUUID(),
    });
    await expect(
      f.service.apply(f.context, f.serverId, {
        operationId: operation.id,
        planDigest: operation.planDigest,
        confirm: true,
        backupBefore: true,
        expectedDeletePaths: operation.deletePaths,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'operation_busy' });
    expect((await f.service.snapshot(f.context, f.serverId)).operation?.state).toBe('ready');
    expect(f.calls).toEqual([]);
  });
  it('fences generic admission immediately after apply is queued', async () => {
    const f = await fixture();
    await f.apply();
    await expect(
      enqueueServerOperation(f.db, f.context, f.serverId, {
        action: 'stop',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'operation_busy' });
    expect(f.calls).toEqual([]);
  });
  it('applies once in stop/backup/publication/verification order and persists observed receipt', async () => {
    const f = await fixture();
    const { operationId, request } = await f.apply();
    await f.service.process(operationId);
    expect(f.calls).toEqual(['stop', 'backup', 'publish', 'verify']);
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot.operation?.state).toBe('applied');
    expect(snapshot.installed?.pack.version.id).toBe('v1');
    expect(snapshot.operation?.backupId).toBe('verified-backup');
    await f.service.apply(f.context, f.serverId, request);
    await f.service.process(operationId);
    expect(f.scope.publish).toHaveBeenCalledTimes(1);
    const row = await f.db
      .selectFrom('minecraft_modpack_receipts')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(row.receipt).toMatchObject({ files: [{ modifiedAt: '2026-01-01T00:00:00Z' }] });
  });
  it('prevents a second preparation while ready and accepts explicit cancellation', async () => {
    const f = await fixture();
    const operation = await f.ready();
    await expect(
      f.service.prepare(f.context, f.serverId, { ...f.selection, idempotencyKey: randomUUID() }),
    ).rejects.toThrow('operation_busy');
    await f.service.cancel(f.context, f.serverId, operation.id);
    expect(
      (
        await f.service.prepare(f.context, f.serverId, {
          ...f.selection,
          idempotencyKey: randomUUID(),
        })
      ).operation?.state,
    ).toBe('queued');
  });
  it('keeps partial publication uncertain and never blindly replays it', async () => {
    const f = await fixture();
    f.scope.publish.mockImplementation(async () => {
      throw new Error('connection lost after first rename');
    });
    const { operationId } = await f.apply();
    await f.service.process(operationId);
    expect((await f.service.snapshot(f.context, f.serverId)).operation?.state).toBe('uncertain');
    expect((await f.service.snapshot(f.context, f.serverId)).installed).toBeNull();
    await f.service.process(operationId);
    await f.service.recover(f.context, f.serverId, operationId);
    expect(f.scope.publish).toHaveBeenCalledTimes(1);
    expect((await f.service.snapshot(f.context, f.serverId)).operation?.state).toBe('uncertain');
  });
  it('recovers only after complete read-only publication proof', async () => {
    const f = await fixture();
    f.scope.verify.mockResolvedValueOnce(null as never);
    const { operationId } = await f.apply();
    await f.service.process(operationId);
    f.hooks.recover = vi.fn(async () => ({ state: 'applied' as const, files: f.prepared.files }));
    const result = await f.service.recover(f.context, f.serverId, operationId);
    expect(result.operation?.state).toBe('applied');
    expect(f.scope.publish).toHaveBeenCalledTimes(1);
  });
  it('marks expired applying leases uncertain before any further effects', async () => {
    const f = await fixture();
    const { operationId } = await f.apply();
    await f.db
      .updateTable('minecraft_modpack_operations')
      .set({ state: 'applying', lease_token: randomUUID(), lease_until: new Date(0) })
      .where('id', '=', operationId)
      .execute();
    await f.service.process(operationId);
    expect((await f.service.snapshot(f.context, f.serverId)).operation?.state).toBe('uncertain');
    expect(f.calls).toEqual([]);
  });
  it('rejects a stale inventory after confirmed stop before any publication', async () => {
    const f = await fixture();
    const { operationId } = await f.apply();
    f.scope.inspect.mockResolvedValue({ ...f.observation, combinationId: randomUUID() });
    await f.service.process(operationId);
    expect((await f.service.snapshot(f.context, f.serverId)).operation?.state).toBe('failed');
    expect(f.calls).toEqual(['stop', 'backup']);
  });
  it('rejects tampered prepared bytes even if the apply request retained the approved digest', async () => {
    const f = await fixture();
    const { operationId } = await f.apply();
    await f.db
      .updateTable('minecraft_modpack_operations')
      .set({ prepared: JSON.stringify({ ...f.prepared, stagingKey: '/other-stage' }) })
      .where('id', '=', operationId)
      .execute();
    await f.service.process(operationId);
    expect((await f.service.snapshot(f.context, f.serverId)).operation?.state).toBe('failed');
    expect(f.calls).toEqual([]);
  });
  it('blocks unsupported loader mappings without publication', async () => {
    const f = await fixture();
    f.hooks.resolveRuntime = vi.fn(async () => null);
    const operation = await f.ready();
    expect(operation.state).toBe('blocked');
    expect(operation.blockers).toContainEqual({ reason: 'runtime' });
    expect(f.calls).toEqual([]);
  });
  it('retains reservation after failed cleanup and releases it only when cleanup succeeds', async () => {
    const f = await fixture();
    f.hooks.prepare = vi.fn(async ({ reservation }) => {
      await reservation({
        physicalHostId: f.hostId,
        bytes: 50,
        stagingRoot: '/private/owned-stage',
      });
      throw new Error('download failed');
    });
    f.hooks.cleanup = vi.fn(async () => {
      throw new Error('disk unavailable');
    });
    const queued = await f.prepare();
    await f.service.process(queued.operation?.id as string);
    let row = await f.db
      .selectFrom('minecraft_modpack_operations')
      .selectAll()
      .where('id', '=', queued.operation?.id as string)
      .executeTakeFirstOrThrow();
    expect(row.held_bytes).toBe('50');
    expect(await f.service.pending()).toEqual([row.id]);
    f.hooks.cleanup = vi.fn(async () => {});
    await f.service.process(row.id);
    row = await f.db
      .selectFrom('minecraft_modpack_operations')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(row.held_bytes).toBe('0');
    expect(modpackDigest(row.selection)).toHaveLength(64);
  });
  it('serializes competing workers and cancels preparation before any game effect', async () => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    f.hooks.prepare = vi.fn(async ({ progress }) => {
      started.resolve();
      await proceed.promise;
      await progress('inspecting', null);
      return f.prepared;
    });
    const queued = await f.prepare();
    const id = queued.operation?.id as string;
    const worker = f.service.process(id);
    await started.promise;
    await f.service.process(id);
    await f.service.cancel(f.context, f.serverId, id);
    proceed.resolve();
    await worker;
    expect(f.hooks.prepare).toHaveBeenCalledTimes(1);
    expect((await f.service.snapshot(f.context, f.serverId)).operation?.state).toBe('cancelled');
    expect(f.calls).toEqual([]);
  });
  it('journals restoration only after verified files and clears restart requirement on confirmed restoration', async () => {
    const f = await fixture();
    let locked = false;
    f.hooks.withServerLock = async (_row, work) => {
      locked = true;
      try {
        return await work(f.scope);
      } finally {
        locked = false;
      }
    };
    f.hooks.restoreRunningState = async (row) => {
      expect(locked).toBe(false);
      expect(row.state).toBe('applied');
      expect(row.apply_actor_session_id).toBe(f.context[authSessionId]);
      f.calls.push('restore');
      return true;
    };
    const { operationId } = await f.apply();
    await f.service.process(operationId);
    expect(f.calls).toEqual(['stop', 'backup', 'publish', 'verify', 'restore']);
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot.operation?.state).toBe('applied');
    expect(snapshot.operation?.restartRequired).toBe(false);
  });
  it('does not restore a running state when publication proof is incomplete', async () => {
    const f = await fixture();
    const restore = vi.fn(async () => true);
    f.scope.verify.mockResolvedValue([]);
    f.hooks.restoreRunningState = restore;
    const { operationId } = await f.apply();
    await f.service.process(operationId);
    expect(restore).not.toHaveBeenCalled();
    expect((await f.service.snapshot(f.context, f.serverId)).operation?.state).toBe('uncertain');
  });
  it('retains an applied receipt and a restart requirement when ordinary start admission fails', async () => {
    const f = await fixture();
    f.hooks.restoreRunningState = async () => {
      throw new Error('Admission refused');
    };
    const { operationId } = await f.apply();
    await f.service.process(operationId);
    const snapshot = await f.service.snapshot(f.context, f.serverId);
    expect(snapshot.installed?.operationId).toBe(operationId);
    expect(snapshot.operation).toMatchObject({
      state: 'applied',
      restartRequired: true,
      error: 'integration_unavailable',
    });
    await f.service.process(operationId);
    expect(f.scope.publish).toHaveBeenCalledTimes(1);
  });
});
