import { randomBytes, randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ApplicationServer } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedServer,
  createProject,
  enqueueServerOperation,
  setProjectMember,
} from './registry.js';
import { authorizeQueuedEffect, createManagementRuntime } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

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
          data: allocations.map((row) => ({ attributes: { id: row.pterodactyl_allocation_id } })),
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
    expect(observer.processStartedAt).not.toHaveBeenCalled();
  });
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
          data: allocations.map((row) => ({ attributes: { id: row.pterodactyl_allocation_id } })),
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
    'revalidates %s on the pinned connection after a blocking interactive server lock',
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
      const getRemote = vi.fn(async () => {
        throw new Error('Unauthorized provider call');
      });
      Object.assign(f.adapter, { getApplicationServer: getRemote });
      const runtime = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter });
      const effect = vi.fn(async () => {});
      const lock = await database.pool.connect();
      let outcome: Promise<unknown> | undefined;
      try {
        const {
          rows: [backend],
        } = await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!backend) throw new Error('Missing lock fixture PID');
        await lock.query('SELECT pg_advisory_lock(hashtextextended(current_schema() || $1,0))', [
          `:nickhosting:server:${server}`,
        ]);
        outcome = runtime.access(context, server, true, effect).then(
          () => ({ success: true }),
          (error: unknown) => error,
        );
        await vi.waitFor(
          async () => {
            const pending = await database.pool.query<{ count: string }>(
              'SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
              [backend.pid],
            );
            expect(Number(pending.rows[0]?.count)).toBe(1);
          },
          { timeout: 3000, interval: 10 },
        );
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
        await lock.query('SELECT pg_advisory_unlock_all()');
        lock.release();
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
      expect(getRemote).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
    },
  );
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
          data: allocations.map((row) => ({ attributes: { id: row.pterodactyl_allocation_id } })),
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
      unavailable: [],
      external: { recovered: 2, failed: 1 },
    });
    expect(reconcileExternal).toHaveBeenCalledOnce();
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
