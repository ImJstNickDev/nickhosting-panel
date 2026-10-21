import { randomUUID } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ApplicationServer, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { minecraftModpackPrepareSchema } from '../../../games/minecraft/src/modpack-contracts.js';
import type { MinecraftModpackOperationRow } from './minecraft-modpacks.js';
import {
  modpackDigest,
  type PreparedMinecraftModpack,
  planMinecraftModpack,
} from './minecraft-modpacks-plan.js';
import { createMinecraftModpackBridge } from './modpack-bridge.js';
import {
  completeModpackJob,
  createModpackContext,
  withModpackServerLock,
} from './modpack-context.js';
import type { ManagementRuntime } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

async function fixture(running = true) {
  const f = await managementFixture(database.db, { interactive: true });
  const serverId = await f.server();
  await f.db
    .updateTable('managed_servers')
    .set({ connection_mode: 'direct' })
    .where('id', '=', serverId)
    .execute();
  const originalJob = await f.db
    .selectFrom('server_operations')
    .select('job_id')
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
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
            assigned: true,
            ip: a.address,
            port: a.port,
          },
        })),
      },
    },
  } as unknown as ApplicationServer;
  const adapter = {
    ...f.adapter,
    getApplicationServer: vi.fn(async () => remote),
    stopWithConfirmation: vi.fn(async (_id, _identifier, options) => {
      expect(await options.authorize()).toBe(true);
      await options.beforePower();
      running = false;
      await options.onConfirmed();
      return { confirmed: true };
    }),
  } as unknown as PterodactylAdapter;
  const runtime = {
    adapter,
    containerObserver: { stopped: vi.fn(async (_uuid, kind) => kind === 'installer' || !running) },
    lifecycle: {},
    fileDirectoryBatch: vi.fn(async () => []),
  } as unknown as ManagementRuntime;
  const row = await f.db
    .insertInto('minecraft_modpack_operations')
    .values({
      id: randomUUID(),
      server_id: serverId,
      actor_user_id: f.context.actorUserId,
      actor_session_id: f.context[authSessionId] as string,
      subject_user_id: f.context.subjectUserId,
      support_session_id: null,
      resource_owner_id: server.owner_id,
      physical_host_id: f.hostId,
      held_bytes: '0',
      staging_root: null,
      idempotency_key: randomUUID(),
      selection: '{}',
      state: 'applying',
      phase: 'checking',
      progress: 'null',
      prepared: 'null',
      plan: 'null',
      plan_digest: null,
      blockers: '[]',
      apply_request: 'null',
      apply_actor_user_id: f.context.actorUserId,
      apply_actor_session_id: f.context[authSessionId] as string,
      apply_subject_user_id: f.context.subjectUserId,
      apply_support_session_id: null,
      apply_idempotency_key: randomUUID(),
      journal: '[]',
      backup_id: null,
      restart_required: false,
      error: null,
      lease_token: randomUUID(),
      lease_until: new Date(Date.now() + 60000),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const options = {
    db: f.db,
    runtime,
    operation: row,
    env: {},
    currentAuth: async () => f.context,
  };
  return { ...f, serverId, runtime, adapter, row, options, originalJob: originalJob.job_id };
}

describe('Modpacks real lifecycle and Fileman context', () => {
  it.each([false, true])(
    'recovers a missing synthetic job only without dispatch evidence=%s',
    async (dispatched) => {
      const f = await fixture(false);
      const combinationId = randomUUID();
      await f.db
        .insertInto('minecraft_combinations')
        .values({
          id: combinationId,
          mapping_id: f.mappingId,
          identity_digest: 'a'.repeat(64),
          mapping_digest: 'b'.repeat(64),
          combination: '{}',
          resolved_runtime: '{}',
          binding: '{}',
        })
        .execute();
      await f.db
        .insertInto('minecraft_server_profiles')
        .values({
          server_id: f.serverId,
          combination_id: combinationId,
          installed: true,
          configuration: '{}',
        })
        .execute();
      const selection = minecraftModpackPrepareSchema.parse({
        provider: 'modrinth',
        projectId: 'pack',
        versionId: 'v1',
        mode: 'install',
        idempotencyKey: 'recovery',
      });
      const prepared: PreparedMinecraftModpack = {
        pack: {
          project: {
            provider: 'modrinth',
            id: 'pack',
            name: 'Pack',
            summary: '',
            authors: [],
            websiteUrl: 'https://example.test/pack',
          },
          version: {
            id: 'v1',
            projectId: 'pack',
            name: 'v1',
            version: '1',
            minecraftVersions: ['1.21.1'],
            loaders: ['vanilla'],
            available: true,
            channel: 'release',
            source: 'modrinth-index',
          },
        },
        target: { minecraftVersion: '1.21.1', loader: 'vanilla' },
        stagingKey: 'private',
        files: [],
        blockers: [],
      };
      const plan = planMinecraftModpack({
        selection,
        prepared,
        observation: {
          combinationId,
          mappingId: f.mappingId,
          entries: [],
          worldRoots: ['world'],
          protectedPaths: [],
          replacePaths: [],
        },
        previous: null,
        runtime: { combinationId, mappingId: f.mappingId, target: prepared.target },
      });
      await f.db
        .updateTable('minecraft_modpack_operations')
        .set({
          state: 'uncertain',
          lease_token: null,
          lease_until: null,
          selection: JSON.stringify(selection),
          prepared: JSON.stringify(prepared),
          plan: JSON.stringify(plan),
          plan_digest: modpackDigest({ prepared, plan }),
          journal: JSON.stringify(
            dispatched
              ? [{ phase: 'stopping', state: 'dispatched', at: new Date().toISOString() }]
              : [],
          ),
        })
        .where('id', '=', f.row.id)
        .execute();
      const bridge = createMinecraftModpackBridge({ db: f.db, runtime: f.runtime });
      const snapshot = await bridge.recover(f.context, f.serverId, f.row.id);
      expect(snapshot.operation?.state).toBe(dispatched ? 'uncertain' : 'failed');
      expect(
        await f.db
          .selectFrom('server_operations')
          .select('job_id')
          .where('job_id', '=', f.row.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
      expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
    },
  );
  it('creates one synthetic reinstall with the same operation id and no generic outbox delivery', async () => {
    const f = await fixture();
    const host = await withModpackServerLock(f.db, f.serverId, (db) =>
      createModpackContext({ ...f.options, db }),
    );
    expect(host.context.fileman).toBeDefined();
    const operation = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', f.row.id)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({
      action: 'reinstall',
      server_id: f.serverId,
      plan: { modpackOperationId: f.row.id },
    });
    expect(
      await f.db
        .selectFrom('job_outbox')
        .select('job_id')
        .where('job_id', '=', f.row.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      (
        await f.db
          .selectFrom('managed_servers')
          .select('active_operation_id')
          .where('id', '=', f.serverId)
          .executeTakeFirstOrThrow()
      ).active_operation_id,
    ).toBe(f.row.id);
  });
  it.each([true, false])(
    'stops a direct server and records prior running state=%s without Gateway state',
    async (running) => {
      const f = await fixture(running);
      const host = await createModpackContext(f.options);
      await host.stop();
      expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(running ? 1 : 0);
      const operation = await f.db
        .selectFrom('server_operations')
        .select('plan')
        .where('job_id', '=', f.row.id)
        .executeTakeFirstOrThrow();
      expect(operation.plan.wasRunning).toBe(running);
      expect(
        (
          await f.db
            .selectFrom('managed_servers')
            .select('runtime_state')
            .where('id', '=', f.serverId)
            .executeTakeFirstOrThrow()
        ).runtime_state,
      ).toBe('offline');
      expect(
        await f.db
          .selectFrom('resource_reservations')
          .select('server_id')
          .where('server_id', '=', f.serverId)
          .executeTakeFirst(),
      ).toBeUndefined();
    },
  );
  it('refuses publication authority after another operation owns the server', async () => {
    const f = await fixture();
    const host = await createModpackContext(f.options);
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: f.originalJob })
      .where('id', '=', f.serverId)
      .execute();
    await expect(host.authorize()).rejects.toMatchObject({ code: 'conflict' });
    const readScope = host.context.fileman?.readScope?.();
    if (!readScope) throw new Error('Fileman read scope missing');
    await expect(readScope.list('mods')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.runtime.fileDirectoryBatch).not.toHaveBeenCalled();
  });
  it.each(['changed', 'expired'] as const)(
    'refuses effects after the Modpacks worker lease is %s',
    async (reason) => {
      const f = await fixture();
      const host = await createModpackContext(f.options);
      await f.db
        .updateTable('minecraft_modpack_operations')
        .set(
          reason === 'changed'
            ? { lease_token: randomUUID() }
            : { lease_until: new Date(Date.now() - 1000) },
        )
        .where('id', '=', f.row.id)
        .execute();
      await expect(host.stop()).rejects.toMatchObject({ code: 'operation_uncertain' });
      expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
    },
  );
  it('cleanup releases a failed pre-publication job without claiming successful installation', async () => {
    const f = await fixture(false);
    await createModpackContext(f.options);
    await f.db
      .updateTable('minecraft_modpack_operations')
      .set({ state: 'failed', error: 'conflict', lease_token: null, lease_until: null })
      .where('id', '=', f.row.id)
      .execute();
    const bridge = createMinecraftModpackBridge({ db: f.db, runtime: f.runtime });
    await bridge.process(f.row.id);
    expect(
      (
        await f.db
          .selectFrom('managed_servers')
          .select('active_operation_id')
          .where('id', '=', f.serverId)
          .executeTakeFirstOrThrow()
      ).active_operation_id,
    ).toBeNull();
    expect(
      await f.db
        .selectFrom('operation_jobs')
        .select(['state', 'error_code'])
        .where('id', '=', f.row.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: 'failed', error_code: 'conflict' });
    expect(
      await f.db
        .selectFrom('minecraft_modpack_receipts')
        .select('server_id')
        .where('server_id', '=', f.serverId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
  });
  it('completed cleanup cannot clear a newer operation guard', async () => {
    const f = await fixture(false);
    await createModpackContext(f.options);
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: f.originalJob })
      .where('id', '=', f.serverId)
      .execute();
    await completeModpackJob(f.db, { ...f.row, state: 'applied' } as MinecraftModpackOperationRow);
    expect(
      (
        await f.db
          .selectFrom('managed_servers')
          .select('active_operation_id')
          .where('id', '=', f.serverId)
          .executeTakeFirstOrThrow()
      ).active_operation_id,
    ).toBe(f.originalJob);
  });
});
