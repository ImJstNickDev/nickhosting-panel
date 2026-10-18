import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type AuthContext,
  authSessionId,
  createLogger,
  type LogRecord,
  SecretCodec,
} from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ApplicationServer, PrivateTransferCache } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryIdentityCache } from './directory-identity.js';
import { processServerOperation } from './lifecycle.js';
import {
  createManagedServer,
  createProject,
  enqueueServerOperation,
  setProjectMember,
} from './registry.js';
import { authorizeQueuedEffect, createManagementRuntime } from './runtime.js';
import { managementFixture, pendingUploadFixture } from './test-fixtures.js';

describe('management runtime execution-time authorization', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  beforeEach(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db);
  });
  afterEach(async () => {
    await database?.destroy();
  });
  async function providerIdentity(serverId: string): Promise<ApplicationServer> {
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
    return {
      id: server.pterodactyl_id,
      uuid: server.pterodactyl_uuid,
      identifier: server.pterodactyl_identifier,
      external_id: server.external_id,
      node: f.providerNodeId,
      user: 1,
      allocation: allocations.find((row) => row.is_primary)?.pterodactyl_allocation_id,
      relationships: {
        allocations: {
          data: allocations.map((row) => ({
            attributes: {
              id: row.pterodactyl_allocation_id,
              ip: row.address,
              port: row.port,
              assigned: true,
            },
          })),
        },
      },
    } as ApplicationServer;
  }
  async function stop(context: AuthContext = f.context, serverId?: string) {
    const server = serverId ?? (await f.server());
    const operation = await enqueueServerOperation(f.db, context, server, {
      action: 'stop',
      idempotencyKey: randomUUID(),
    });
    return { server, job: operation.jobId };
  }
  async function support() {
    const id = randomUUID(),
      parentId = randomUUID(),
      startedAt = new Date();
    const expiresAt = new Date(Date.now() + 600_000);
    await database.pool.query(
      'INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,$4)',
      [parentId, randomUUID(), f.owner.actorUserId, expiresAt],
    );
    await database.pool.query(
      'INSERT INTO support_sessions(id,token_hash,actor_user_id,subject_user_id,parent_session_id,reason,origin,audit_correlation_id,started_at,expires_at,last_activity_at) VALUES($1,$2,$3,$4,$5,$6,$7,$1,$8,$9,$8)',
      [
        id,
        randomUUID(),
        f.owner.actorUserId,
        f.context.subjectUserId,
        parentId,
        'Isolated runtime test',
        'http://localhost:3999',
        startedAt,
        expiresAt,
      ],
    );
    const context: AuthContext = {
      ...f.owner,
      [authSessionId]: parentId,
      subjectUserId: f.context.subjectUserId,
      sessionType: 'support',
      ownerElevation: true,
      support: {
        id,
        startedAt,
        expiresAt,
        lastActivityAt: startedAt,
        revokedAt: null,
        reason: 'Isolated runtime test',
      },
    };
    return { id, parentId, context };
  }

  it('binds lifecycle observation to the configured physical host before new effects', async () => {
    const queued = await stop();
    const observer = { preflight: vi.fn(async () => {}), stopped: vi.fn(async () => true) };
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'wrong-host' },
    });
    await expect(
      runtime.lifecycle.authorizeEffect(queued.job, queued.server, f.db),
    ).rejects.toThrow('configuration_invalid');
    expect(observer.preflight).not.toHaveBeenCalled();
    const correct = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'isolated-observer' },
    });
    await correct.lifecycle.authorizeEffect(queued.job, queued.server, f.db);
    expect(observer.preflight).toHaveBeenCalledTimes(1);
  });
  it.each(['remove', 'import'] as const)(
    'authorizes inactive-world %s without a host observer and still rejects revoked authority',
    async (kind) => {
      const queued = await stop();
      await f.db
        .updateTable('server_operations')
        .set({
          action: 'minecraft-content',
          plan: JSON.stringify({
            minecraftContent: {
              combinationId: randomUUID(),
              command:
                kind === 'remove'
                  ? { kind: 'world-remove', world: 'spare', confirm: true, backupBefore: false }
                  : { kind: 'world-import', archiveRef: randomUUID(), targetWorld: 'spare' },
              world: { existing: kind === 'remove' },
              deletePaths: [],
              backupBefore: false,
            },
          }),
        })
        .where('job_id', '=', queued.job)
        .execute();
      const observer = {
        preflight: vi.fn(async () => {
          throw new Error('Unused observer');
        }),
        stopped: vi.fn(async () => false),
      };
      const runtime = await createManagementRuntime({
        db: f.db,
        codec,
        adapter: f.adapter,
        containerObserver: observer,
        env: { NH_OBSERVER_ID: 'wrong-host' },
      });
      await runtime.lifecycle.authorizeEffect(queued.job, queued.server, f.db);
      expect(observer.preflight).not.toHaveBeenCalled();
      expect(observer.stopped).not.toHaveBeenCalled();
      await f.db
        .updateTable('operation_jobs')
        .set({ resource_owner_id: f.owner.subjectUserId })
        .where('id', '=', queued.job)
        .execute();
      await expect(
        runtime.lifecycle.authorizeEffect(queued.job, queued.server, f.db),
      ).rejects.toMatchObject({ code: 'forbidden' });
    },
  );
  it.each([false, true])(
    'keeps standalone final authorization, delegates it only to the lifecycle guard: %s',
    async (defer) => {
      const queued = await stop();
      await f.db
        .updateTable('server_operations')
        .set({ action: 'start' })
        .where('job_id', '=', queued.job)
        .execute();
      const stages: string[] = [];
      const runtime = await createManagementRuntime({
        db: f.db,
        codec,
        adapter: f.adapter,
        containerObserver: {
          preflight: async () => {},
          stopped: async () => true,
          processStartedAt: async () => null,
        },
        env: { NH_OBSERVER_ID: 'isolated-observer' },
        logger: createLogger((event) => {
          if (event.event === 'server.runtime_stage')
            stages.push(String((event.data as { stage?: string } | undefined)?.stage));
        }),
      });
      await runtime.lifecycle.authorizeEffect(queued.job, queued.server, f.db, {
        ...(defer ? { deferFinalIntentCheck: true } : {}),
      });
      expect(stages.filter((stage) => stage === 'authorize_effect.authorization')).toHaveLength(1);
      expect(
        stages.filter((stage) => stage === 'authorize_effect.final_authorization'),
      ).toHaveLength(defer ? 0 : 1);
    },
  );
  async function preparedStart(context: AuthContext = f.context, serverId?: string) {
    const queued = await stop(context, serverId);
    await f.db
      .updateTable('server_operations')
      .set({ action: 'start', phase: 'power', effect_state: 'prepared' })
      .where('job_id', '=', queued.job)
      .execute();
    await f.db
      .insertInto('resource_reservations')
      .values({
        server_id: queued.server,
        owner_id: f.context.subjectUserId,
        physical_host_id: f.hostId,
        memory_mib: 128,
        physical_memory_mib: 148,
        cpu_percent: 10,
        operation_id: queued.job,
        state: 'starting',
      })
      .execute();
    return queued;
  }
  it('authorizes admitted Start handoff locally without repeated observer or provider calls', async () => {
    const queued = await preparedStart();
    const preflight = vi.fn(async () => {
      throw new Error('unexpected observer call');
    });
    const getApplicationServer = vi.fn(async (): Promise<ApplicationServer> => {
      throw new Error('unexpected provider call');
    });
    const getResources = vi.fn(async () => {
      throw new Error('unexpected resources call');
    });
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: { ...f.adapter, getApplicationServer, getResources },
      containerObserver: { preflight, stopped: async () => true },
    });
    await runtime.lifecycle.authorizeEffect(queued.job, queued.server, f.db, {
      startAdmissionValidated: true,
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(getApplicationServer).not.toHaveBeenCalled();
    expect(getResources).not.toHaveBeenCalled();
  });
  it.each(['absent', 'wrong-job', 'wrong-state', 'nonstart', 'unprepared', 'inactive'] as const)(
    'rejects admitted Start handoff with %s durable admission',
    async (reason) => {
      const queued = await preparedStart();
      if (reason === 'absent')
        await f.db
          .deleteFrom('resource_reservations')
          .where('server_id', '=', queued.server)
          .execute();
      if (reason === 'wrong-job') {
        const other = await f.db
          .selectFrom('operation_jobs')
          .select('id')
          .where('id', '!=', queued.job)
          .executeTakeFirstOrThrow();
        await f.db
          .updateTable('resource_reservations')
          .set({ operation_id: other.id })
          .where('server_id', '=', queued.server)
          .execute();
      }
      if (reason === 'wrong-state')
        await f.db
          .updateTable('resource_reservations')
          .set({ state: 'running' })
          .where('server_id', '=', queued.server)
          .execute();
      if (reason === 'nonstart')
        await f.db
          .updateTable('server_operations')
          .set({ action: 'stop' })
          .where('job_id', '=', queued.job)
          .execute();
      if (reason === 'unprepared')
        await f.db
          .updateTable('server_operations')
          .set({ effect_state: 'none' })
          .where('job_id', '=', queued.job)
          .execute();
      if (reason === 'inactive')
        await f.db
          .updateTable('managed_servers')
          .set({ active_operation_id: null })
          .where('id', '=', queued.server)
          .execute();
      const runtime = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter });
      await expect(
        runtime.lifecycle.authorizeEffect(queued.job, queued.server, f.db, {
          startAdmissionValidated: true,
        }),
      ).rejects.toThrow('conflict');
    },
  );
  it('rejects admitted Start handoff after project permission is revoked', async () => {
    const peer = await managementFixture(f.db);
    const project = await createProject(f.db, f.context, { name: 'Start permission test' });
    const server = await f.server({ projectId: project.id });
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'operator',
    });
    const queued = await preparedStart(peer.context, server);
    const runtime = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter });
    await runtime.lifecycle.authorizeEffect(queued.job, server, f.db, {
      startAdmissionValidated: true,
    });
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'viewer',
    });
    await expect(
      runtime.lifecycle.authorizeEffect(queued.job, server, f.db, {
        startAdmissionValidated: true,
      }),
    ).rejects.toThrow('forbidden');
  });
  it('binds internal console reuse to the exact injected provider instance', async () => {
    const first = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter });
    const same = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter });
    const changed = await createManagementRuntime({ db: f.db, codec, adapter: { ...f.adapter } });
    expect(first.consoleProviderBinding).toBe(same.consoleProviderBinding);
    expect(changed.consoleProviderBinding).not.toBe(first.consoleProviderBinding);
  });
  it('invalidates console base binding on provider changes and ignores obsolete global Client credentials', async () => {
    const env = {
      NH_PTERODACTYL_BASE_URL: 'https://provider.example.test',
      NH_PTERODACTYL_APPLICATION_KEY: 'fixture-application',
      NH_PTERODACTYL_CLIENT_KEY: 'fixture-client',
    };
    const binding = async (patch = {}) =>
      (await createManagementRuntime({ db: f.db, codec, env: { ...env, ...patch } }))
        .consoleProviderBinding;
    const initial = await binding();
    expect(await binding()).toBe(initial);
    for (const patch of [
      { NH_PTERODACTYL_BASE_URL: 'https://other.example.test' },
      { NH_PTERODACTYL_APPLICATION_KEY: 'rotated-application' },
      { NH_PTERODACTYL_WEBSOCKET_ORIGINS: '["wss://other.example.test"]' },
    ])
      expect(await binding(patch)).not.toBe(initial);
    expect(await binding({ NH_PTERODACTYL_CLIENT_KEY: 'ignored-legacy' })).toBe(initial);
    expect(initial).not.toContain('fixture');
  });
  it('fences console reuse when the managed owner Client credential rotates', async () => {
    const serverId = await f.server();
    const account = await f.db
      .selectFrom('provider_accounts')
      .selectAll()
      .where('user_id', '=', f.context.subjectUserId)
      .executeTakeFirstOrThrow();
    const seal = (operationId: string, token: string) =>
      codec.encrypt(
        token,
        `provider-client:${account.instance_id}:${account.user_id}:${operationId}`,
      );
    await f.db
      .updateTable('provider_accounts')
      .set({ key_envelope: seal(account.key_operation_id, 'isolated-client-a') })
      .where('user_id', '=', account.user_id)
      .execute();
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      env: { NH_PTERODACTYL_APPLICATION_KEY: 'fixture-application' },
    });
    const first = await runtime.consoleBindingForServer(serverId);
    expect(await runtime.consoleBindingForServer(serverId)).toBe(first);
    const operation = randomUUID();
    await f.db
      .updateTable('provider_accounts')
      .set({
        key_operation_id: operation,
        key_identifier: 'rotated',
        key_envelope: seal(operation, 'isolated-client-b'),
      })
      .where('user_id', '=', account.user_id)
      .execute();
    expect(await runtime.consoleBindingForServer(serverId)).not.toBe(first);
    await f.db
      .updateTable('managed_servers')
      .set({ provider_user_id: 999 })
      .where('id', '=', serverId)
      .execute();
    await expect(runtime.consoleBindingForServer(serverId)).rejects.toThrow(
      'integration_unavailable',
    );
  });
  it('binds restart process evidence to the host and current provider identity', async () => {
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
      allocation: allocations.find((row) => row.is_primary)?.pterodactyl_allocation_id,
      relationships: {
        allocations: {
          data: allocations.map((row) => ({
            attributes: {
              id: row.pterodactyl_allocation_id,
              ip: row.address,
              port: row.port,
              assigned: true,
            },
          })),
        },
      },
    } as ApplicationServer;
    Object.assign(f.adapter, { getApplicationServer: vi.fn(async () => remote) });
    const stamp = new Date(Date.now() - 1000).toISOString();
    const observer = {
      preflight: vi.fn(async () => {}),
      stopped: vi.fn(async () => true),
      processStartedAt: vi.fn(async () => stamp),
    };
    const wrong = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'another-host' },
    });
    await expect(wrong.lifecycle.observeProcessStart(serverId, f.db)).rejects.toThrow(
      'configuration_invalid',
    );
    expect(observer.processStartedAt).not.toHaveBeenCalled();
    const correct = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'isolated-observer' },
    });
    expect(await correct.lifecycle.observeProcessStart(serverId, f.db)).toBe(stamp);
    expect(observer.processStartedAt).toHaveBeenCalledWith(server.pterodactyl_uuid);
    observer.processStartedAt.mockClear();
    remote.external_id = 'different-identity';
    await expect(correct.lifecycle.observeProcessStart(serverId, f.db)).rejects.toThrow(
      'provenance_mismatch',
    );
    // A speculative read of this registered container cannot authorize a
    // mismatched provider identity, even when its Docker epoch is available.
    expect(observer.processStartedAt).toHaveBeenCalledWith(server.pterodactyl_uuid);
  });
  it('provider-ready refresh reads only the current host-bound managed process epoch', async () => {
    const serverId = await f.server();
    const remote = await providerIdentity(serverId);
    const provider = vi.fn(async () => {
      throw new Error('must not repeat provider verification');
    });
    Object.assign(f.adapter, { getApplicationServer: provider });
    const epoch = new Date().toISOString();
    const observer = {
      preflight: vi.fn(async () => {}),
      stopped: vi.fn(async () => false),
      processStartedAt: vi.fn(async (): Promise<string | null> => epoch),
    };
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'isolated-observer' },
    });
    expect(await runtime.lifecycle.observeProviderProcessStart(serverId, f.db)).toBe(epoch);
    expect(observer.processStartedAt).toHaveBeenCalledWith(remote.uuid);
    expect(provider).not.toHaveBeenCalled();
    observer.processStartedAt.mockResolvedValue(null);
    expect(await runtime.lifecycle.observeProviderProcessStart(serverId, f.db)).toBeNull();
    const wrong = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'wrong-host' },
    });
    observer.processStartedAt.mockClear();
    await expect(wrong.lifecycle.observeProviderProcessStart(serverId, f.db)).rejects.toThrow(
      'configuration_invalid',
    );
    expect(observer.processStartedAt).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it('overlaps the host-bound process read with provider verification without granting early evidence', async () => {
    const serverId = await f.server();
    const remote = await providerIdentity(serverId);
    let finishPreflight!: () => void;
    const preflight = new Promise<void>((resolve) => {
      finishPreflight = resolve;
    });
    let finishProvider!: (value: ApplicationServer) => void;
    const provider = new Promise<ApplicationServer>((resolve) => {
      finishProvider = resolve;
    });
    const readProvider = vi.fn(() => provider);
    Object.assign(f.adapter, { getApplicationServer: readProvider });
    const stamp = new Date(Date.now() - 1000).toISOString();
    const observer = {
      preflight: vi.fn(() => preflight),
      stopped: vi.fn(async () => true),
      processStartedAt: vi.fn(async () => stamp),
    };
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'isolated-observer' },
    });
    let settled = false;
    const observation = runtime.lifecycle.observeProcessStart(serverId, f.db).then((value) => {
      settled = true;
      return value;
    });
    try {
      await vi.waitFor(() => {
        expect(observer.preflight).toHaveBeenCalledOnce();
        expect(readProvider).toHaveBeenCalledOnce();
      });
      expect(observer.processStartedAt).not.toHaveBeenCalled();
      finishPreflight();
      await vi.waitFor(() => expect(observer.processStartedAt).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
    } finally {
      finishPreflight();
      finishProvider(remote);
    }
    await expect(observation).resolves.toBe(stamp);
    expect(observer.processStartedAt).toHaveBeenCalledOnce();
  });
  it('settles outstanding provider reads after a failed host preflight without observing the process', async () => {
    const serverId = await f.server();
    const remote = await providerIdentity(serverId);
    let finishProvider!: (value: ApplicationServer) => void;
    const provider = new Promise<ApplicationServer>((resolve) => {
      finishProvider = resolve;
    });
    const readProvider = vi.fn(() => provider);
    Object.assign(f.adapter, { getApplicationServer: readProvider });
    const observer = {
      preflight: vi.fn(async () => {
        throw new Error('preflight failed');
      }),
      stopped: vi.fn(async () => true),
      processStartedAt: vi.fn(async () => new Date().toISOString()),
    };
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'isolated-observer' },
    });
    let settled = false;
    const observation = runtime.lifecycle.observeProcessStart(serverId, f.db).catch((error) => {
      settled = true;
      return error;
    });
    try {
      await vi.waitFor(() => expect(observer.preflight).toHaveBeenCalledOnce());
      await delay(10);
      expect(readProvider).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(observer.processStartedAt).not.toHaveBeenCalled();
    } finally {
      finishProvider(remote);
    }
    expect(await observation).toEqual(new Error('preflight failed'));
    expect(observer.processStartedAt).not.toHaveBeenCalled();
  });
  it('settles an outstanding process read before rejecting a mismatched provider identity', async () => {
    const serverId = await f.server();
    const remote = await providerIdentity(serverId);
    remote.external_id = 'foreign-server';
    Object.assign(f.adapter, { getApplicationServer: vi.fn(async () => remote) });
    let finishProcess!: (value: string | null) => void;
    const pendingProcess = new Promise<string | null>((resolve) => {
      finishProcess = resolve;
    });
    const observer = {
      preflight: vi.fn(async () => {}),
      stopped: vi.fn(async () => true),
      processStartedAt: vi.fn(() => pendingProcess),
    };
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'isolated-observer' },
    });
    let settled = false;
    const observation = runtime.lifecycle.observeProcessStart(serverId, f.db).catch((error) => {
      settled = true;
      return error;
    });
    try {
      await vi.waitFor(() => expect(observer.processStartedAt).toHaveBeenCalledOnce());
      await delay(10);
      expect(settled).toBe(false);
    } finally {
      finishProcess(new Date().toISOString());
    }
    expect(await observation).toMatchObject({ code: 'provenance_mismatch' });
  });
  it.each([
    'valid',
    'absent',
    'api',
    'later-start',
    'tied-start',
    'old',
    'replaced',
    'foreign',
  ] as const)(
    'corroborates an interactive external stop with exact terminal evidence: %s',
    async (condition) => {
      const serverId = await f.server();
      const remote = await providerIdentity(serverId);
      Object.assign(f.adapter, { getApplicationServer: vi.fn(async () => remote) });
      const at = Math.floor(Date.now() / 1000) * 1000 - 2000;
      const terminal = {
        containerId: 'a'.repeat(64),
        startedAt: new Date(at - 10000).toISOString(),
        finishedAt: new Date(at + 500).toISOString(),
      };
      const stopEvent = {
        id: 'stop-receipt',
        event: 'server:power.kill',
        timestamp: new Date(at).toISOString(),
        is_api: false,
      };
      const events =
        condition === 'absent'
          ? []
          : [
              {
                ...stopEvent,
                ...(condition === 'api' ? { is_api: true } : {}),
                ...(condition === 'old' ? { timestamp: new Date(at - 20000).toISOString() } : {}),
              },
            ];
      if (condition === 'later-start' || condition === 'tied-start')
        events.unshift({
          ...stopEvent,
          id: 'new-start',
          event: 'server:power.start',
          is_api: true,
          timestamp: new Date(at + (condition === 'later-start' ? 1000 : 0)).toISOString(),
        });
      const activity = vi.fn(async () => events);
      Object.assign(f.adapter, { listPowerActivity: activity });
      const observer = {
        preflight: vi.fn(async () => {}),
        stopped: vi.fn(async () => true),
        terminalProcess: vi.fn(async () => terminal),
      };
      if (condition === 'replaced')
        observer.terminalProcess
          .mockResolvedValueOnce(terminal)
          .mockResolvedValue({ ...terminal, containerId: 'b'.repeat(64) });
      if (condition === 'foreign') remote.external_id = 'foreign';
      const management = await createManagementRuntime({
        db: f.db,
        codec,
        adapter: f.adapter,
        containerObserver: observer,
        env: { NH_OBSERVER_ID: 'isolated-observer' },
      });
      if (condition === 'foreign') {
        await expect(management.lifecycle.observeExternalStop(serverId, f.db)).rejects.toThrow(
          'provenance_mismatch',
        );
        expect(activity).not.toHaveBeenCalled();
      } else if (condition === 'valid') {
        await expect(management.lifecycle.observeExternalStop(serverId, f.db)).resolves.toEqual({
          ...terminal,
          activityId: stopEvent.id,
          activityAt: stopEvent.timestamp,
          action: 'kill',
        });
      } else
        await expect(management.lifecycle.observeExternalStop(serverId, f.db)).resolves.toBeNull();
    },
  );
  it('refuses new lifecycle effects when the physical observer is absent or unavailable', async () => {
    const queued = await stop();
    const absent = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      env: { NH_OBSERVER_ID: 'isolated-observer' },
    });
    await expect(absent.lifecycle.authorizeEffect(queued.job, queued.server, f.db)).rejects.toThrow(
      'configuration_invalid',
    );
    const unavailable = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      env: { NH_OBSERVER_ID: 'isolated-observer' },
      containerObserver: {
        preflight: async () => {
          throw new Error('isolated observer unavailable');
        },
        stopped: async () => true,
      },
    });
    await expect(
      unavailable.lifecycle.authorizeEffect(queued.job, queued.server, f.db),
    ).rejects.toThrow('isolated observer unavailable');
  });
  it('binds no-op stop proof to the host, current identity and exact server container', async () => {
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
      allocation: allocations.find((row) => row.is_primary)?.pterodactyl_allocation_id,
      relationships: {
        allocations: {
          data: allocations.map((row) => ({
            attributes: {
              id: row.pterodactyl_allocation_id,
              ip: row.address,
              port: row.port,
              assigned: true,
            },
          })),
        },
      },
    } as ApplicationServer;
    Object.assign(f.adapter, { getApplicationServer: vi.fn(async () => remote) });
    const observer = {
      preflight: vi.fn(async () => {}),
      stopped: vi.fn(async () => true),
    };
    const wrong = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'another-host' },
    });
    await expect(wrong.lifecycle.confirmAlreadyStopped(serverId, f.db)).rejects.toThrow(
      'configuration_invalid',
    );
    expect(observer.stopped).not.toHaveBeenCalled();
    const correct = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: observer,
      env: { NH_OBSERVER_ID: 'isolated-observer' },
    });
    expect(await correct.lifecycle.confirmAlreadyStopped(serverId, f.db)).toBe(true);
    expect(observer.stopped).toHaveBeenCalledWith(server.pterodactyl_uuid, 'server');
    observer.preflight.mockClear();
    vi.mocked(f.adapter.getApplicationServer).mockClear();
    const sharedProofs = {
      providerServer: Promise.resolve(remote),
      observerPreflight: Promise.resolve(),
    };
    expect(await correct.lifecycle.confirmAlreadyStopped(serverId, f.db, sharedProofs)).toBe(true);
    expect(observer.preflight).not.toHaveBeenCalled();
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    expect(
      await correct.lifecycle.confirmAlreadyStopped(serverId, f.db, {
        providerServer: Promise.resolve(remote),
      }),
    ).toBe(true);
    expect(observer.preflight).toHaveBeenCalledOnce();
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    observer.stopped.mockClear();
    await expect(
      correct.lifecycle.confirmAlreadyStopped(serverId, f.db, {
        ...sharedProofs,
        providerServer: Promise.resolve({ ...remote, uuid: randomUUID() }),
      }),
    ).rejects.toThrow('provenance_mismatch');
    expect(observer.stopped).not.toHaveBeenCalled();
    observer.stopped.mockResolvedValue(false);
    expect(await correct.lifecycle.confirmAlreadyStopped(serverId, f.db)).toBe(false);
    observer.stopped.mockRejectedValue(new Error('isolated observer unavailable'));
    await expect(correct.lifecycle.confirmAlreadyStopped(serverId, f.db)).rejects.toThrow(
      'isolated observer unavailable',
    );
    observer.stopped.mockClear();
    remote.uuid = randomUUID();
    await expect(correct.lifecycle.confirmAlreadyStopped(serverId, f.db)).rejects.toThrow(
      'provenance_mismatch',
    );
    expect(observer.stopped).not.toHaveBeenCalled();
  });

  it.each([
    ['properties', false],
    ['properties', true],
    ['player', false],
    ['player', true],
  ] as const)(
    'shares one host preflight for %s handoff while rechecking revocation=%s',
    async (kind, revoke) => {
      const queued = await stop();
      await f.db
        .updateTable('server_operations')
        .set({
          action: 'minecraft-content',
          plan: JSON.stringify({
            minecraftContent: {
              combinationId: randomUUID(),
              backupBefore: false,
              command:
                kind === 'properties'
                  ? { kind, changes: { motd: 'fixture' } }
                  : { kind, list: 'operators', action: 'add', name: 'Player' },
            },
          }),
        })
        .where('job_id', '=', queued.job)
        .execute();
      const remote = await providerIdentity(queued.server);
      const getRemote = vi.fn(async () => remote);
      Object.assign(f.adapter, { getApplicationServer: getRemote });
      const observer = {
        preflight: vi.fn(async () => {}),
        stopped: vi.fn(async () => {
          if (revoke)
            await f.db
              .updateTable('operation_jobs')
              .set({ resource_owner_id: f.owner.subjectUserId })
              .where('id', '=', queued.job)
              .execute();
          return true;
        }),
      };
      const runtime = await createManagementRuntime({
        db: f.db,
        codec,
        adapter: f.adapter,
        containerObserver: observer,
        env: { NH_OBSERVER_ID: 'isolated-observer' },
      });
      const write = vi.fn(async () => {});
      const result = await processServerOperation(f.db, queued.job, {
        ...runtime.lifecycle,
        processGameContent: async (context) => {
          await context.authorize();
          await context.effect('minecraft.text.fixture', write);
          return true;
        },
      });
      expect(result).toBe(revoke ? 'failed' : 'succeeded');
      expect(observer.preflight).toHaveBeenCalledTimes(1);
      expect(observer.stopped).toHaveBeenCalledTimes(1);
      expect(getRemote).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(revoke ? 0 : 1);
    },
  );

  it.each(['unchanged', 'allocation removed', 'host changed', 'permission revoked'] as const)(
    'uses one final world-selection proof and keeps current authority when %s',
    async (change) => {
      const queued = await stop();
      await f.db
        .updateTable('server_operations')
        .set({
          action: 'minecraft-content',
          plan: JSON.stringify({
            minecraftContent: {
              combinationId: randomUUID(),
              command: { kind: 'world-select', world: 'selected_world' },
              world: { existing: true, dataVersion: 3955 },
              backupBefore: false,
            },
          }),
        })
        .where('job_id', '=', queued.job)
        .execute();
      const remote = await providerIdentity(queued.server);
      const getApplicationServer = vi.fn(async () => remote);
      const getDirectoryBatchSettings = vi.fn(async () => ({
        directoryBatchLimit: 1,
        directoryConcurrency: 1,
        directoryTimeoutSeconds: 10,
      }));
      const listDirectoriesBatch = vi.fn(async (_identifier: string, directories: string[]) =>
        directories.map((directory) => ({ directory, files: [] })),
      );
      Object.assign(f.adapter, {
        getApplicationServer,
        getDirectoryBatchSettings,
        listDirectoriesBatch,
      });
      const observer = {
        preflight: vi.fn(async () => {}),
        stopped: vi.fn(async () => {
          if (change === 'permission revoked' && observer.stopped.mock.calls.length === 1)
            await f.db
              .updateTable('operation_jobs')
              .set({ resource_owner_id: f.owner.subjectUserId })
              .where('id', '=', queued.job)
              .execute();
          return true;
        }),
      };
      const timings: LogRecord[] = [];
      const runtime = await createManagementRuntime({
        db: f.db,
        codec,
        adapter: f.adapter,
        containerObserver: observer,
        env: { NH_OBSERVER_ID: 'isolated-observer' },
        logger: createLogger((record) => timings.push(record), { level: 'debug' }),
      });
      const write = vi.fn(async () => {});
      const result = await processServerOperation(f.db, queued.job, {
        ...runtime.lifecycle,
        checkpoint: async (phase) => {
          if (phase !== 'prepared') return;
          if (change === 'allocation removed')
            await f.db
              .deleteFrom('server_allocations')
              .where('server_id', '=', queued.server)
              .execute();
          if (change === 'host changed')
            await f.db
              .updateTable('physical_hosts')
              .set({ observer_id: 'another-host' })
              .where('id', '=', f.hostId)
              .execute();
        },
        processGameContent: async (context) => {
          await context.authorize();
          if (change === 'unchanged') {
            const files = context.fileman?.readScope?.();
            expect(files).toBeDefined();
            expect(await files?.listMany(['', 'selected_world'])).toEqual([
              { directory: '', files: [] },
              { directory: 'selected_world', files: [] },
            ]);
          }
          await context.effect('minecraft.text.fixture', write);
          return true;
        },
      });
      expect(result).toBe(change === 'unchanged' ? 'succeeded' : 'failed');
      expect(write).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
      expect(getApplicationServer).toHaveBeenCalledOnce();
      if (change === 'unchanged') {
        expect(getDirectoryBatchSettings).toHaveBeenCalledOnce();
        expect(listDirectoriesBatch.mock.calls.map((call) => call.slice(0, 2))).toEqual([
          [remote.identifier, ['']],
          [remote.identifier, ['selected_world']],
        ]);
        const summary = timings.find((record) => record.event === 'servers.world_selection_timing')
          ?.data as {
          stages: Record<string, unknown>;
          spanGroups: { name: string }[][];
        };
        const spans = summary.spanGroups.flat().map((span) => span.name);
        expect(spans).toEqual(
          expect.arrayContaining([
            'stop.final.host.binding',
            'stop.final.host.preflight',
            'stop.final.process',
            'auth.intent',
            'auth.job',
            'directories.settings.miss',
            'directories.batch',
          ]),
        );
        expect(summary.stages['auth.intent']).toEqual(
          expect.objectContaining({ count: expect.any(Number) }),
        );
      }
      expect(observer.preflight).toHaveBeenCalledTimes(change === 'host changed' ? 0 : 1);
      expect(observer.stopped).toHaveBeenCalledTimes(
        ['unchanged', 'permission revoked'].includes(change) ? 1 : 0,
      );
      const operation = await f.db
        .selectFrom('server_operations')
        .select('effect_state')
        .where('job_id', '=', queued.job)
        .executeTakeFirstOrThrow();
      expect(operation.effect_state).toBe(change === 'unchanged' ? 'confirmed' : 'none');
    },
  );

  it.each([
    'unchanged',
    'running',
    'host changed',
    'observer override changed',
    'new power job',
    'permission revoked',
    'cache missing',
  ] as const)(
    'reuses Worlds-opening preparation without physical or provider reads at Select: %s',
    async (change) => {
      const queued = await stop();
      await f.db
        .updateTable('server_operations')
        .set({
          action: 'minecraft-content',
          plan: JSON.stringify({
            minecraftContent: {
              combinationId: randomUUID(),
              command: { kind: 'world-select', world: 'selected_world' },
              world: { existing: true, dataVersion: 3955 },
              backupBefore: false,
            },
          }),
        })
        .where('job_id', '=', queued.job)
        .execute();
      // Fixture installs the selection job first; expose the same pre-enqueue
      // state that Worlds observes in production, then restore its active job.
      await f.db
        .updateTable('managed_servers')
        .set({ active_operation_id: null })
        .where('id', '=', queued.server)
        .execute();
      const values = new Map<string, string>();
      const cache: PrivateTransferCache = {
        get: async (key) => values.get(key),
        take: async (key) => {
          const result = values.get(key);
          values.delete(key);
          return result;
        },
        put: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      };
      const identityCache = createDirectoryIdentityCache(undefined, cache);
      const remote = await providerIdentity(queued.server);
      const getApplicationServer = vi.fn(async () => remote);
      const prepareFileWrite = vi.fn(async () => {});
      Object.assign(f.adapter, { getApplicationServer, prepareFileWrite });
      const observer = { preflight: vi.fn(async () => {}), stopped: vi.fn(async () => true) };
      const runtime = await createManagementRuntime({
        db: f.db,
        codec,
        adapter: f.adapter,
        directoryIdentityCache: identityCache,
        transferCache: cache,
        containerObserver: observer,
        env: { NH_OBSERVER_ID: 'isolated-observer' },
      });
      try {
        const sessionId = randomUUID();
        await database.pool.query(
          `INSERT INTO session (id, token, "userId", "expiresAt", "createdAt", "updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`,
          [sessionId, randomUUID(), f.context.actorUserId],
        );
        await runtime.fileReadAccess(
          { ...f.context, [authSessionId]: sessionId },
          queued.server,
          async (_id, connection, _actor, server) => {
            await runtime.prepareWorldSelection(server, connection);
          },
        );
        expect(observer.stopped).toHaveBeenCalledOnce();
        expect(prepareFileWrite).toHaveBeenCalledWith(remote.identifier, 'server.properties');
        expect(getApplicationServer).toHaveBeenCalledOnce();
        if (change === 'new power job') {
          const newStop = await stop(f.context, queued.server);
          await f.db
            .updateTable('operation_jobs')
            .set({ state: 'succeeded', completed_at: new Date() })
            .where('id', '=', newStop.job)
            .execute();
        }
        await f.db
          .updateTable('managed_servers')
          .set({
            active_operation_id: queued.job,
            ...(change === 'running' ? { runtime_state: 'running' as const } : {}),
          })
          .where('id', '=', queued.server)
          .execute();
        if (change === 'cache missing') values.clear();
        let lifecycle = runtime.lifecycle;
        if (change === 'observer override changed') {
          const host = await f.db
            .selectFrom('physical_hosts')
            .selectAll()
            .where('id', '=', f.hostId)
            .executeTakeFirstOrThrow();
          const changed = await createManagementRuntime({
            db: f.db,
            codec,
            adapter: f.adapter,
            directoryIdentityCache: identityCache,
            transferCache: cache,
            containerObserver: observer,
            env: {
              NH_OBSERVER_ID: 'isolated-observer',
              NH_HOST_POLICIES: JSON.stringify({
                [host.id]: {
                  name: host.name,
                  memoryLimitMiB: host.memory_limit_mib,
                  cpuLimitPercent: host.cpu_limit_percent,
                  storagePoolMiB: Number(host.storage_pool_mib),
                  memoryHeadroomMiB: host.memory_headroom_mib,
                  cpuHeadroomPercent: host.cpu_headroom_percent,
                  diskHeadroomMiB: Number(host.disk_headroom_mib),
                  localDiskPath: host.local_disk_path,
                  observerId: 'another-observer',
                  enabled: true,
                },
              }),
            },
          });
          lifecycle = changed.lifecycle;
        }
        const write = vi.fn(async () => {});
        const result = await processServerOperation(f.db, queued.job, {
          ...lifecycle,
          checkpoint: async (phase) => {
            if (phase !== 'prepared') return;
            if (change === 'host changed')
              await f.db
                .updateTable('physical_hosts')
                .set({ observer_id: 'different-host' })
                .where('id', '=', f.hostId)
                .execute();
            if (change === 'permission revoked')
              await f.db
                .updateTable('operation_jobs')
                .set({ resource_owner_id: f.owner.subjectUserId })
                .where('id', '=', queued.job)
                .execute();
          },
          processGameContent: async (context) => {
            await context.authorize();
            await context.effect('minecraft.text.fixture', write);
            return true;
          },
        });
        expect(result).toBe(change === 'unchanged' ? 'succeeded' : 'failed');
        expect(write).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
        expect(getApplicationServer).toHaveBeenCalledOnce();
        expect(observer.stopped).toHaveBeenCalledOnce();
        expect(observer.preflight).toHaveBeenCalledOnce();
      } finally {
        identityCache.close();
      }
    },
  );

  it('awaits a generic game provider proof before the final revocable authority check', async () => {
    const server = await f.server();
    const job = await enqueueServerOperation(f.db, f.owner, server, {
      action: 'start',
      idempotencyKey: randomUUID(),
    });
    const remote = await providerIdentity(server);
    const provider = Promise.withResolvers<ApplicationServer>();
    const authorized = Promise.withResolvers<void>();
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: { preflight: async () => {}, stopped: async () => true },
      env: { NH_OBSERVER_ID: 'isolated-observer' },
      logger: createLogger((record) => {
        if (
          record.event === 'server.runtime_stage' &&
          (record.data as { stage?: string } | undefined)?.stage ===
            'authorize_effect.authorization'
        )
          authorized.resolve();
      }),
    });
    let completed = false;
    const proof = runtime.lifecycle.authorizeEffect(job.jobId, server, f.db, {
      providerServer: provider.promise,
    });
    const outcome = proof.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    try {
      await authorized.promise;
      await delay(10);
      expect(completed).toBe(false);
      await f.db
        .updateTable('user')
        .set({ role: 'user' })
        .where('id', '=', f.owner.actorUserId)
        .execute();
    } finally {
      provider.resolve(remote);
      await outcome;
    }
    await expect(proof).rejects.toThrow('forbidden');
  });
  it('reloads the current role instead of trusting a queued Owner snapshot', async () => {
    const queued = await stop(f.owner);
    expect((await authorizeQueuedEffect(f.db, queued.job, queued.server)).role).toBe('owner');
    await f.db
      .updateTable('user')
      .set({ role: 'user' })
      .where('id', '=', f.owner.actorUserId)
      .execute();
    await expect(authorizeQueuedEffect(f.db, queued.job, queued.server)).rejects.toThrow(
      'forbidden',
    );
  });
  it.each([
    'regular-revoked',
    'regular-expired',
    'owner-demoted',
    'support-revoked',
    'support-expired',
    'support-idle-expired',
    'support-parent-revoked',
    'support-parent-expired',
  ] as const)(
    'revalidates %s on the pinned connection after provider identity lookup waits',
    async (reason) => {
      const server = await f.server();
      const supportSession = reason.startsWith('support') ? await support() : undefined;
      const sessionId = supportSession?.parentId ?? randomUUID();
      const context: AuthContext = supportSession?.context ?? {
        ...f.owner,
        [authSessionId]: sessionId,
      };
      if (!supportSession)
        await database.pool.query(
          'INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
          [sessionId, randomUUID(), context.actorUserId],
        );
      const remote = await providerIdentity(server);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const getRemote = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return remote;
      });
      Object.assign(f.adapter, { getApplicationServer: getRemote });
      const runtime = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter });
      const effect = vi.fn(async () => {});
      const outcome = runtime.access(context, server, true, effect).then(
        () => ({ success: true }),
        (error: unknown) => error,
      );
      try {
        await entered.promise;
        if (reason === 'regular-revoked' || reason === 'support-parent-revoked')
          await database.pool.query('DELETE FROM session WHERE id=$1', [sessionId]);
        else if (reason === 'regular-expired' || reason === 'support-parent-expired')
          await database.pool.query(
            'UPDATE session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',
            [sessionId],
          );
        else if (reason === 'owner-demoted')
          await f.db
            .updateTable('user')
            .set({ role: 'user' })
            .where('id', '=', f.owner.actorUserId)
            .execute();
        else if (reason === 'support-revoked')
          await database.pool.query('UPDATE support_sessions SET revoked_at=now() WHERE id=$1', [
            supportSession?.id,
          ]);
        else if (reason === 'support-expired')
          await database.pool.query(
            "UPDATE support_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
            [supportSession?.id],
          );
        else if (reason === 'support-idle-expired')
          await database.pool.query(
            "UPDATE support_sessions SET started_at=now()-interval '8 minutes',last_activity_at=now()-interval '6 minutes' WHERE id=$1",
            [supportSession?.id],
          );
      } finally {
        release.resolve();
      }
      expect(await outcome).toMatchObject({
        code:
          reason === 'owner-demoted'
            ? 'forbidden'
            : reason.includes('parent') || reason.startsWith('regular')
              ? 'unauthenticated'
              : reason === 'support-revoked'
                ? 'support_invalid'
                : 'support_expired',
      });
      expect(getRemote).toHaveBeenCalledOnce();
      expect(effect).not.toHaveBeenCalled();
    },
  );
  async function interactiveFilesFixture() {
    const serverId = await f.server();
    const sessionId = randomUUID();
    await database.pool.query(
      'INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
      [sessionId, randomUUID(), f.context.actorUserId],
    );
    const context = { ...f.context, [authSessionId]: sessionId };
    const remote = await providerIdentity(serverId);
    const getRemote = vi.fn(async () => remote);
    const read = vi.fn(async () => Buffer.from('fixture'));
    const batch = vi.fn(async (_id: string, directories: string[]) =>
      directories.map((directory) => ({ directory, files: [] })),
    );
    const prepare = vi.fn(async () => {});
    Object.assign(f.adapter, {
      getApplicationServer: getRemote,
      readFileForEditor: read,
      getDirectoryBatchSettings: vi.fn(async () => ({
        directoryBatchLimit: 48,
        directoryConcurrency: 2,
        directoryTimeoutSeconds: 10,
      })),
      listDirectoriesBatch: batch,
      prepareFileWrite: prepare,
    });
    const runtime = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter });
    return { serverId, sessionId, context, getRemote, read, batch, prepare, runtime };
  }

  it('shares one interactive Fileman read phase and rechecks authority only at its boundaries', async () => {
    const files = await interactiveFilesFixture();
    const select = vi.spyOn(f.db, 'selectFrom');
    try {
      const result = await files.runtime.fileReadScope(
        files.context,
        files.serverId,
        async (scope) => {
          await scope.list('');
          await scope.list('');
          return scope.readMany([
            { path: 'ops.json', maxBytes: 1024 },
            { path: 'whitelist.json', maxBytes: 1024 },
          ]);
        },
      );
      expect(result.size).toBe(2);
      expect(files.getRemote).toHaveBeenCalledTimes(1);
      expect(files.batch).toHaveBeenCalledTimes(1);
      expect(files.read).toHaveBeenCalledTimes(2);
      expect(f.adapter.prefetchDownloads).toHaveBeenCalledTimes(1);
      // Initial auth, fresh auth after remote identity proof, and final return guard.
      expect(select.mock.calls.filter(([table]) => table === 'session')).toHaveLength(3);
    } finally {
      select.mockRestore();
    }
  });

  it.each(['session revoked', 'provider binding changed'] as const)(
    'rejects a private read result when %s while bytes are being read',
    async (change) => {
      const files = await interactiveFilesFixture();
      files.read.mockImplementationOnce(async () => {
        if (change === 'session revoked')
          await f.db.deleteFrom('session').where('id', '=', files.sessionId).execute();
        else
          await f.db
            .updateTable('managed_servers')
            .set({ pterodactyl_identifier: 'changed-id' })
            .where('id', '=', files.serverId)
            .execute();
        return Buffer.from('must not be returned');
      });
      await expect(
        files.runtime.fileReadScope(files.context, files.serverId, (scope) =>
          scope.read({ path: 'server.properties', maxBytes: 1024 }),
        ),
      ).rejects.toMatchObject({
        code: change === 'session revoked' ? 'unauthenticated' : 'conflict',
      });
    },
  );

  it('prepares private write grants together only with current management authority', async () => {
    const files = await interactiveFilesFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    files.prepare.mockImplementation(async () => {
      if (files.prepare.mock.calls.length === 3) entered.resolve();
      await release.promise;
    });
    const pending = files.runtime.prepareFileWrites(files.context, files.serverId, [
      'server.properties',
      'ops.json',
      'whitelist.json',
    ]);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('Preparation finished before all grants started');
        }),
      ]);
      expect(files.prepare).toHaveBeenCalledTimes(3);
    } finally {
      release.resolve();
    }
    await pending;
    files.prepare.mockClear();
    await f.db.deleteFrom('session').where('id', '=', files.sessionId).execute();
    await expect(
      files.runtime.prepareFileWrites(files.context, files.serverId, ['server.properties']),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(files.prepare).not.toHaveBeenCalled();
  });

  it('keeps the shared identity proof when an active job prevents optional write preparation', async () => {
    const files = await interactiveFilesFixture();
    await files.runtime.fileReadScope(files.context, files.serverId, async () => undefined);
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: randomUUID() })
      .where('id', '=', files.serverId)
      .execute();
    await expect(
      files.runtime.prepareFileWrites(files.context, files.serverId, ['ops.json']),
    ).rejects.toMatchObject({ code: 'conflict' });
    await files.runtime.fileReadScope(files.context, files.serverId, async () => undefined);
    expect(files.prepare).not.toHaveBeenCalled();
    expect(files.getRemote).toHaveBeenCalledTimes(1);
  });

  it('blocks later interactive mutations after an ambiguous upload, while preserving authorized reads', async () => {
    const serverId = await f.server();
    const sessionId = randomUUID();
    await database.pool.query(
      'INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
      [sessionId, randomUUID(), f.context.actorUserId],
    );
    const context = { ...f.context, [authSessionId]: sessionId };
    const remote = await providerIdentity(serverId);
    Object.assign(f.adapter, { getApplicationServer: vi.fn(async () => remote) });
    await pendingUploadFixture(f.db, serverId);
    const runtime = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter });
    const write = vi.fn(async () => {});
    await expect(runtime.access(context, serverId, true, write)).rejects.toThrow(
      'operation_uncertain',
    );
    expect(write).not.toHaveBeenCalled();
    await expect(runtime.access(context, serverId, false, async () => 'read')).resolves.toBe(
      'read',
    );
  });
  it('keeps a two-connection pool available for reads and revocation while an upload holds its server lock', async () => {
    const serverId = await f.server(),
      sessionId = randomUUID();
    await database.pool.query(
      'INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
      [sessionId, randomUUID(), f.context.actorUserId],
    );
    const context = { ...f.context, [authSessionId]: sessionId };
    const remote = await providerIdentity(serverId);
    Object.assign(f.adapter, { getApplicationServer: vi.fn(async () => remote) });
    const small = createDatabase(process.env.NH_TEST_DATABASE_URL ?? '', {
      max: 2,
      options: `-c search_path=${database.schema}`,
    });
    const runtime = await createManagementRuntime({ db: small.db, codec, adapter: f.adapter });
    const entered = Promise.withResolvers<void>();
    let finish = false,
      checks = 0;
    const transfer = runtime
      .access(context, serverId, true, async (_id, connection, current) => {
        entered.resolve();
        while (!finish) {
          await runtime.authorizeTransfer(current, serverId, true, connection);
          checks++;
          await delay(5);
        }
      })
      .then(
        () => ({ success: true }),
        (error: unknown) => error,
      );
    try {
      await entered.promise;
      const effect = vi.fn(async () => {});
      const contenders = await Promise.all(
        Array.from({ length: 12 }, () =>
          runtime.access(context, serverId, true, effect).then(
            () => ({ success: true }),
            (error: unknown) => error,
          ),
        ),
      );
      expect(contenders).toEqual(
        Array.from({ length: 12 }, () => expect.objectContaining({ code: 'operation_busy' })),
      );
      expect(effect).not.toHaveBeenCalled();
      await expect(runtime.access(context, serverId, false, async () => 'read')).resolves.toBe(
        'read',
      );
      await small.db.deleteFrom('session').where('id', '=', sessionId).execute();
      await expect(transfer).resolves.toMatchObject({ code: 'unauthenticated' });
      expect(checks).toBeGreaterThan(0);
    } finally {
      finish = true;
      await transfer;
      await small.db.destroy();
    }
  });
  it('refuses an unbound interactive context while durable regular jobs survive logout', async () => {
    const queued = await stop();
    const runtime = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter });
    await expect(runtime.access(f.context, queued.server, true, async () => {})).rejects.toThrow(
      'unauthenticated',
    );
    expect((await authorizeQueuedEffect(f.db, queued.job, queued.server)).actorUserId).toBe(
      f.context.actorUserId,
    );
  });
  it('uses only the already pinned connection for fresh interactive authorization', async () => {
    const serverId = await f.server(),
      sessionId = randomUUID();
    await database.pool.query(
      'INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
      [sessionId, randomUUID(), f.context.actorUserId],
    );
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
      allocation: allocations.find((row) => row.is_primary)?.pterodactyl_allocation_id,
      relationships: {
        allocations: {
          data: allocations.map((row) => ({
            attributes: {
              id: row.pterodactyl_allocation_id,
              ip: row.address,
              port: row.port,
              assigned: true,
            },
          })),
        },
      },
    } as ApplicationServer;
    Object.assign(f.adapter, { getApplicationServer: vi.fn(async () => remote) });
    await f.db.connection().execute(async (connection) => {
      const acquire = vi.spyOn(database.pool, 'connect');
      try {
        const runtime = await createManagementRuntime({
          db: connection,
          codec,
          adapter: f.adapter,
        });
        const effect = vi.fn(async (_id, pinned, current) => {
          expect(pinned).toBeDefined();
          expect(current.role).toBe('user');
          expect(current[authSessionId]).toBe(sessionId);
        });
        await runtime.access({ ...f.context, [authSessionId]: sessionId }, serverId, true, effect);
        expect(effect).toHaveBeenCalledOnce();
        expect(acquire).not.toHaveBeenCalled();
      } finally {
        acquire.mockRestore();
      }
    });
  });
  it('rechecks project membership and operation-specific authority', async () => {
    const peer = await managementFixture(f.db);
    const project = await createProject(f.db, f.context, { name: 'Runtime project' });
    const server = await f.server({ projectId: project.id });
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'operator',
    });
    const queued = await stop(peer.context, server);
    expect((await authorizeQueuedEffect(f.db, queued.job, server)).actorUserId).toBe(
      peer.context.actorUserId,
    );
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'viewer',
    });
    await expect(authorizeQueuedEffect(f.db, queued.job, server)).rejects.toThrow('forbidden');
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: null,
    });
    await expect(authorizeQueuedEffect(f.db, queued.job, server)).rejects.toThrow('forbidden');
  });
  it('fails closed when the resource owner changes or a job/server pair is forged', async () => {
    const queued = await stop(f.owner);
    await expect(authorizeQueuedEffect(f.db, queued.job, randomUUID())).rejects.toThrow(
      'forbidden',
    );
    await f.db
      .updateTable('managed_servers')
      .set({ owner_id: f.owner.actorUserId })
      .where('id', '=', queued.server)
      .execute();
    await expect(authorizeQueuedEffect(f.db, queued.job, queued.server)).rejects.toThrow(
      'forbidden',
    );
  });
  it.each([
    'parent-expired',
    'parent-revoked',
    'support-expired',
    'support-revoked',
    'idle-expired',
    'owner-demoted',
  ] as const)('refuses queued support effects after %s', async (reason) => {
    const session = await support();
    const queued = await stop(session.context);
    expect((await authorizeQueuedEffect(f.db, queued.job, queued.server)).support?.id).toBe(
      session.id,
    );
    if (reason === 'parent-expired')
      await database.pool.query(
        'UPDATE session SET "expiresAt"=now()-interval \'1 minute\' WHERE id=$1',
        [session.parentId],
      );
    if (reason === 'parent-revoked')
      await database.pool.query('DELETE FROM session WHERE id=$1', [session.parentId]);
    if (reason === 'support-expired')
      await database.pool.query(
        "UPDATE support_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
        [session.id],
      );
    if (reason === 'support-revoked')
      await database.pool.query('UPDATE support_sessions SET revoked_at=now() WHERE id=$1', [
        session.id,
      ]);
    if (reason === 'idle-expired')
      await database.pool.query(
        "UPDATE support_sessions SET started_at=now()-interval '8 minutes',last_activity_at=now()-interval '6 minutes' WHERE id=$1",
        [session.id],
      );
    if (reason === 'owner-demoted')
      await f.db
        .updateTable('user')
        .set({ role: 'user' })
        .where('id', '=', f.owner.actorUserId)
        .execute();
    await expect(authorizeQueuedEffect(f.db, queued.job, queued.server)).rejects.toThrow(
      /support_(invalid|expired)/,
    );
  });
  it.each(['mapping', 'node', 'rollout'] as const)(
    'rechecks %s eligibility before a queued provision',
    async (resource) => {
      const queued = await createManagedServer(f.db, f.adapter, f.context, f.input());
      await expect(
        authorizeQueuedEffect(f.db, queued.jobId, queued.serverId),
      ).resolves.toMatchObject({ actorUserId: f.context.actorUserId });
      if (resource === 'mapping')
        await f.db
          .updateTable('runtime_egg_mappings')
          .set({ enabled: false })
          .where('id', '=', f.mappingId)
          .execute();
      if (resource === 'node')
        await f.db
          .updateTable('managed_nodes')
          .set({ enabled: false })
          .where('id', '=', f.nodeId)
          .execute();
      if (resource === 'rollout')
        await f.db
          .updateTable('game_rollouts')
          .set({ state: 'disabled-for-new-servers' })
          .where('integration_id', '=', f.gameId)
          .execute();
      await expect(authorizeQueuedEffect(f.db, queued.jobId, queued.serverId)).rejects.toThrow(
        'forbidden',
      );
    },
  );
  it('allows a file mutation while reconciliation waits for the provider', async () => {
    const serverId = await f.server(),
      sessionId = randomUUID();
    await database.pool.query(
      'INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
      [sessionId, randomUUID(), f.context.actorUserId],
    );
    const remote = { ...(await providerIdentity(serverId)), container: { installed: true } };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    Object.assign(f.adapter, {
      getApplicationServer: vi.fn(async () => remote),
      getResources: vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return {
          current_state: 'offline',
          is_suspended: false,
          resources: {
            memory_bytes: 0,
            cpu_absolute: 0,
            disk_bytes: 0,
            network_rx_bytes: 0,
            network_tx_bytes: 0,
            uptime: 0,
          },
        };
      }),
    });
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      reconcileExternal: async () => ({ recovered: 0, failed: 0 }),
    });
    const collecting = runtime.reconcile();
    const removeFiles = vi.fn(async () => {});
    try {
      await entered.promise;
      await runtime.access(
        { ...f.context, [authSessionId]: sessionId },
        serverId,
        true,
        removeFiles,
      );
      expect(removeFiles).toHaveBeenCalledOnce();
      const row = await f.db
        .selectFrom('managed_servers')
        .select('last_observed_at')
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();
      expect(row.last_observed_at).toBeNull();
    } finally {
      release.resolve();
      await collecting;
    }
    expect(await collecting).toMatchObject({ observed: 1, deferred: [], unavailable: [] });
    expect(removeFiles).toHaveBeenCalledOnce();
  });
  it('reports lock-deferred reconciliation separately from confirmed observations', async () => {
    const serverId = await f.server();
    const remote = { ...(await providerIdentity(serverId)), container: { installed: true } };
    Object.assign(f.adapter, {
      getApplicationServer: vi.fn(async () => remote),
      getResources: vi.fn(async () => ({
        current_state: 'offline',
        is_suspended: false,
        resources: {
          memory_bytes: 0,
          cpu_absolute: 0,
          disk_bytes: 0,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
          uptime: 0,
        },
      })),
    });
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      reconcileExternal: async () => ({ recovered: 0, failed: 0 }),
    });
    const holder = await database.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended(current_schema() || $1,0))', [
        `:nickhosting:server:${serverId}`,
      ]);
      expect(await runtime.reconcile()).toEqual({
        observed: 0,
        deferred: [serverId],
        unavailable: [],
        external: { recovered: 0, failed: 0 },
      });
      const row = await f.db
        .selectFrom('managed_servers')
        .select('last_observed_at')
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();
      expect(row.last_observed_at).toBeNull();
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  });
  it('reports partial external recovery failures to the caller', async () => {
    const reconcileExternal = vi.fn(async () => ({ recovered: 2, failed: 1 }));
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      reconcileExternal,
    });
    expect(await runtime.reconcile()).toEqual({
      observed: 0,
      deferred: [],
      unavailable: [],
      external: { recovered: 2, failed: 1 },
    });
    expect(reconcileExternal).toHaveBeenCalledOnce();
  });
  it.each(['node-disabled', 'sample-removed'] as const)(
    'defers start reservation and rechecks atomic admission after preparation: %s',
    async (change) => {
      const queued = await stop();
      await f.db
        .updateTable('physical_hosts')
        .set({ local_disk_path: process.cwd() })
        .where('id', '=', f.hostId)
        .execute();
      await f.db.deleteFrom('host_observations').execute();
      const runtime = await createManagementRuntime({
        db: f.db,
        codec,
        adapter: f.adapter,
        containerObserver: { preflight: async () => {}, stopped: async () => true },
        env: { NH_OBSERVER_ID: 'isolated-observer' },
      });
      const reserve = await runtime.lifecycle.prepareStartAdmission?.(
        queued.server,
        queued.job,
        f.db,
      );
      expect(reserve).toBeTypeOf('function');
      expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
      const sample = await f.db
        .selectFrom('host_observations')
        .selectAll()
        .where('host_id', '=', f.hostId)
        .executeTakeFirstOrThrow();
      expect(sample.observer_id).toBe('isolated-observer');
      expect(Number(sample.snapshot.availableMemoryMiB)).toBeGreaterThan(0);
      if (change === 'node-disabled')
        await f.db
          .updateTable('managed_nodes')
          .set({ enabled: false })
          .where('id', '=', f.nodeId)
          .execute();
      else await f.db.deleteFrom('host_observations').where('host_id', '=', f.hostId).execute();
      await expect(reserve?.()).rejects.toThrow();
      expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
    },
  );
  it('does not prepare a start reservation when the host observer preflight fails', async () => {
    const queued = await stop();
    await f.db
      .updateTable('physical_hosts')
      .set({ local_disk_path: process.cwd() })
      .where('id', '=', f.hostId)
      .execute();
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      containerObserver: {
        preflight: async () => {
          throw new Error('isolated observer unavailable');
        },
        stopped: async () => true,
      },
      env: { NH_OBSERVER_ID: 'isolated-observer' },
    });
    await expect(
      runtime.lifecycle.prepareStartAdmission?.(queued.server, queued.job, f.db),
    ).rejects.toThrow('isolated observer unavailable');
    expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
  });
  it('resolves the explicit enabled host override before selecting local observations', async () => {
    await f.db
      .updateTable('physical_hosts')
      .set({ enabled: false })
      .where('id', '=', f.hostId)
      .execute();
    await f.db.deleteFrom('host_observations').execute();
    const policy = {
      name: 'fixture',
      memoryLimitMiB: 8192,
      cpuLimitPercent: 800,
      storagePoolMiB: 1000000,
      memoryHeadroomMiB: 256,
      cpuHeadroomPercent: 20,
      diskHeadroomMiB: 256,
      localDiskPath: process.cwd(),
      observerId: 'runtime-test',
      enabled: true,
    };
    const runtime = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      env: {
        NH_OBSERVER_ID: 'runtime-test',
        NH_HOST_POLICIES: JSON.stringify({ [f.hostId]: policy }),
      },
    });
    await runtime.refreshObservations();
    const observed = await f.db
      .selectFrom('host_observations')
      .selectAll()
      .where('host_id', '=', f.hostId)
      .executeTakeFirstOrThrow();
    expect(observed.observer_id).toBe('runtime-test');
    expect(Number(observed.snapshot.availableMemoryMiB)).toBeGreaterThan(0);
    await f.db.deleteFrom('host_observations').execute();
    const disabled = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: f.adapter,
      env: {
        NH_OBSERVER_ID: 'runtime-test',
        NH_HOST_POLICIES: JSON.stringify({ [f.hostId]: { ...policy, enabled: false } }),
      },
    });
    await disabled.refreshObservations();
    expect(await f.db.selectFrom('host_observations').select('host_id').execute()).toEqual([]);
  });
});
