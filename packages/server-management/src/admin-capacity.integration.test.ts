import { randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockResources, reserveInstallation, reserveStart } from './admission.js';
import {
  createManagedServer,
  enqueueLockedServerOperation,
  enqueueServerOperation,
} from './registry.js';
import { authorizeQueuedEffect } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

describe('administrator-requested compute admission', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  beforeEach(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db);
  });
  afterEach(async () => {
    await database?.destroy();
  });

  async function setActorRole(role: AuthContext['role']) {
    // The schema permits exactly one platform Owner. These isolated transitions
    // model a transfer of that role instead of creating a second administrator.
    if (role === 'owner')
      await f.db
        .updateTable('user')
        .set({ role: 'user' })
        .where('id', '=', f.owner.actorUserId)
        .execute();
    await f.db.updateTable('user').set({ role }).where('id', '=', f.context.actorUserId).execute();
  }
  async function pending(role: AuthContext['role'] = 'user') {
    await setActorRole(role);
    return createManagedServer(f.db, f.adapter, { ...f.context, role }, f.input());
  }
  const pressure = () => f.observe({ availableMemoryMiB: 100, cpuBusyPercent: 799 });
  const request = (action: 'start' | 'restart' | 'reinstall' = 'start') => ({
    action,
    idempotencyKey: randomUUID(),
    ...(action === 'reinstall' ? { confirm: true } : {}),
  });
  const queuedCounts = () =>
    Promise.all(
      (['operation_jobs', 'server_operations', 'job_outbox', 'server_events'] as const).map(
        (table) =>
          f.db
            .selectFrom(table)
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow(),
      ),
    );

  it.each(['memory', 'cpu'] as const)(
    'allows Owner provisioning under %s pressure and still records its installer commitment',
    async (resource) => {
      const user = await pending();
      const owner = await pending('owner');
      await f.observe(
        resource === 'memory' ? { availableMemoryMiB: 100 } : { cpuBusyPercent: 799 },
      );
      await expect(reserveInstallation(f.db, user.serverId, user.jobId)).rejects.toThrow(
        'resources_unavailable',
      );
      await reserveInstallation(f.db, owner.serverId, owner.jobId);
      await reserveInstallation(f.db, owner.serverId, owner.jobId);
      expect(await f.db.selectFrom('installation_reservations').selectAll().execute()).toEqual([
        expect.objectContaining({
          server_id: owner.serverId,
          operation_id: owner.jobId,
          memory_mib: 1178,
          cpu_percent: 100,
        }),
      ]);
    },
  );

  it.each(['start', 'restart'] as const)(
    'admits an Owner %s for another user at enqueue and worker admission',
    async (action) => {
      const serverId = await f.server();
      await pressure();
      const input = request(action);
      const before = await queuedCounts();
      await expect(enqueueServerOperation(f.db, f.context, serverId, input)).rejects.toThrow(
        'resources_unavailable',
      );
      expect(await queuedCounts()).toEqual(before);
      expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
      const operation = await enqueueServerOperation(f.db, f.owner, serverId, input);
      await reserveStart(f.db, serverId, operation.jobId, action);
      expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([
        expect.objectContaining({
          server_id: serverId,
          owner_id: f.context.subjectUserId,
          operation_id: operation.jobId,
          memory_mib: 128,
          physical_memory_mib: 148,
          cpu_percent: 10,
          state: action === 'restart' ? 'restarting' : 'starting',
        }),
      ]);
    },
  );

  it('also waives the physical commitment ceiling without lowering the reservation', async () => {
    const serverId = await f.server({ limits: { ...f.limits, memory: 512, cpu: 200 } });
    await f.db
      .updateTable('physical_hosts')
      .set({ memory_limit_mib: 512, cpu_limit_percent: 100 })
      .where('id', '=', f.hostId)
      .execute();
    const operation = await enqueueServerOperation(f.db, f.owner, serverId, request());
    await reserveStart(f.db, serverId, operation.jobId, 'start');
    expect(
      await f.db.selectFrom('resource_reservations').selectAll().executeTakeFirst(),
    ).toMatchObject({
      physical_memory_mib: 589,
      cpu_percent: 200,
    });
  });

  it.each(['demoted', 'promoted', 'operator'] as const)(
    'does not grant the exception to a %s actor',
    async (transition) => {
      const operation = await pending(transition === 'demoted' ? 'owner' : 'operator');
      if (transition !== 'operator')
        await setActorRole(transition === 'demoted' ? 'user' : 'owner');
      await pressure();
      await expect(reserveInstallation(f.db, operation.serverId, operation.jobId)).rejects.toThrow(
        'resources_unavailable',
      );
    },
  );

  it('does not reuse an Owner request for a different server or resource owner', async () => {
    const first = await f.server();
    const second = await f.server();
    const operation = await enqueueServerOperation(f.db, f.owner, first, request());
    await pressure();
    await expect(reserveStart(f.db, second, operation.jobId, 'start')).rejects.toThrow(
      'resources_unavailable',
    );
    await f.db
      .updateTable('operation_jobs')
      .set({ resource_owner_id: f.owner.actorUserId })
      .where('id', '=', operation.jobId)
      .execute();
    await expect(reserveStart(f.db, first, operation.jobId, 'start')).rejects.toThrow(
      'resources_unavailable',
    );
  });

  it.each(['physical', 'user-quota'] as const)(
    'does not grant automatic work Owner %s capacity at initial enqueue',
    async (capacity) => {
      const serverId = await f.server();
      if (capacity === 'physical') await pressure();
      const env = capacity === 'user-quota' ? { NH_DEFAULT_USER_MEMORY_MIB: '64' } : {};
      const before = await queuedCounts();
      await expect(
        f.db.transaction().execute(async (tx) => {
          await lockResources(tx);
          return enqueueLockedServerOperation(tx, f.owner, serverId, request(), env, undefined, {
            requestSource: 'automation',
          });
        }),
      ).rejects.toThrow('resources_unavailable');
      expect(await queuedCounts()).toEqual(before);
      expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
      expect(
        await f.db
          .selectFrom('audit_events')
          .select('id')
          .where('action', '=', 'server.capacity.overridden')
          .execute(),
      ).toEqual([]);
    },
  );

  it.each(['gatewayAutomation', 'gatewayConsole', 'scheduleAutomation', 'requestSource'])(
    'keeps %s work constrained during worker admission',
    async (marker) => {
      const serverId = await f.server();
      const operation = await enqueueServerOperation(f.db, f.owner, serverId, request('reinstall'));
      const row = await f.db
        .selectFrom('server_operations')
        .select('plan')
        .where('job_id', '=', operation.jobId)
        .executeTakeFirstOrThrow();
      await f.db
        .updateTable('server_operations')
        .set({
          plan: JSON.stringify({
            ...row.plan,
            [marker]: marker === 'requestSource' ? 'automation' : {},
          }),
        })
        .where('job_id', '=', operation.jobId)
        .execute();
      await pressure();
      await expect(reserveInstallation(f.db, serverId, operation.jobId)).rejects.toThrow(
        'resources_unavailable',
      );
    },
  );

  it.each(['stale observation', 'disabled node', 'disabled host'] as const)(
    'still rejects Owner admission with a %s',
    async (condition) => {
      const operation = await pending('owner');
      if (condition === 'stale observation') await f.observe({}, new Date(Date.now() - 10_000));
      if (condition === 'disabled node')
        await f.db
          .updateTable('managed_nodes')
          .set({ enabled: false })
          .where('id', '=', f.nodeId)
          .execute();
      if (condition === 'disabled host')
        await f.db
          .updateTable('physical_hosts')
          .set({ enabled: false })
          .where('id', '=', f.hostId)
          .execute();
      await expect(reserveInstallation(f.db, operation.serverId, operation.jobId)).rejects.toThrow(
        'resources_unavailable',
      );
    },
  );

  it.each(['memory', 'cpu'] as const)(
    'waives the resource owner %s quota only for manual Owner requests and audits once',
    async (resource) => {
      const serverId = await f.server({ limits: { ...f.limits, cpu: 600 } });
      const env =
        resource === 'memory'
          ? { NH_DEFAULT_USER_MEMORY_MIB: '64', NH_DEFAULT_USER_CPU_PERCENT: '1000' }
          : { NH_DEFAULT_USER_CPU_PERCENT: '400' };
      await expect(
        enqueueServerOperation(f.db, f.context, serverId, request(), env),
      ).rejects.toThrow('resources_unavailable');
      const operation = await enqueueServerOperation(f.db, f.owner, serverId, request(), env);
      await reserveStart(f.db, serverId, operation.jobId, 'start', env);
      await expect(
        authorizeQueuedEffect(f.db, operation.jobId, serverId, env),
      ).resolves.toMatchObject({
        actorUserId: f.owner.actorUserId,
        role: 'owner',
      });
      expect(
        await f.db.selectFrom('resource_reservations').selectAll().executeTakeFirst(),
      ).toMatchObject({ server_id: serverId, cpu_percent: 600, owner_id: f.context.subjectUserId });
      expect(
        await f.db
          .selectFrom('audit_events')
          .select(['actor_user_id', 'subject_user_id', 'metadata'])
          .where('action', '=', 'server.capacity.overridden')
          .execute(),
      ).toEqual([
        {
          actor_user_id: f.owner.actorUserId,
          subject_user_id: f.owner.subjectUserId,
          metadata: {
            serverId,
            jobId: operation.jobId,
            resourceOwnerId: f.context.subjectUserId,
            checks: ['user_compute'],
          },
        },
      ]);
    },
  );

  it('revokes a consumed capacity override at dispatch even if the demoted actor owns the server', async () => {
    const serverId = await f.server({ limits: { ...f.limits, cpu: 600 } });
    await setActorRole('owner');
    const context = { ...f.context, role: 'owner' } as const;
    const operation = await enqueueServerOperation(f.db, context, serverId, request(), {
      NH_DEFAULT_USER_CPU_PERCENT: '400',
    });
    await setActorRole('user');
    await expect(authorizeQueuedEffect(f.db, operation.jobId, serverId)).rejects.toThrow(
      'forbidden',
    );
    await expect(
      reserveStart(f.db, serverId, operation.jobId, 'start', {
        NH_DEFAULT_USER_CPU_PERCENT: '400',
      }),
    ).rejects.toThrow('resources_unavailable');
  });

  it('does not trust a caller-supplied Owner role when the actual actor is ordinary', async () => {
    const serverId = await f.server();
    await expect(
      enqueueServerOperation(f.db, { ...f.context, role: 'owner' }, serverId, request(), {
        NH_DEFAULT_USER_MEMORY_MIB: '64',
      }),
    ).rejects.toThrow('resources_unavailable');
    expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
  });

  it('audits additional capacity exceptions discovered at worker admission without duplicating them', async () => {
    const serverId = await f.server();
    const env = { NH_DEFAULT_USER_MEMORY_MIB: '64' };
    const operation = await enqueueServerOperation(f.db, f.owner, serverId, request(), env);
    await pressure();
    await reserveStart(f.db, serverId, operation.jobId, 'start', env);
    await reserveStart(f.db, serverId, operation.jobId, 'start', env);
    const audits = await f.db
      .selectFrom('audit_events')
      .select('metadata')
      .where('action', '=', 'server.capacity.overridden')
      .orderBy('created_at')
      .execute();
    expect(audits).toHaveLength(2);
    expect(audits[0]?.metadata.checks).toEqual(['user_compute']);
    expect(audits[1]?.metadata.checks).toEqual(['user_compute', 'physical_compute']);
  });

  it.each(['actor', 'resource-owner', 'automation'] as const)(
    'does not reuse a consumed override with changed %s attribution',
    async (change) => {
      const serverId = await f.server();
      const operation = await enqueueServerOperation(f.db, f.owner, serverId, request(), {
        NH_DEFAULT_USER_MEMORY_MIB: '64',
      });
      if (change === 'automation') {
        const row = await f.db
          .selectFrom('server_operations')
          .select('plan')
          .where('job_id', '=', operation.jobId)
          .executeTakeFirstOrThrow();
        await f.db
          .updateTable('server_operations')
          .set({ plan: JSON.stringify({ ...row.plan, requestSource: 'automation' }) })
          .where('job_id', '=', operation.jobId)
          .execute();
      } else {
        const job = await f.db
          .selectFrom('operation_jobs')
          .select('policy_snapshot')
          .where('id', '=', operation.jobId)
          .executeTakeFirstOrThrow();
        await f.db
          .updateTable('operation_jobs')
          .set({
            policy_snapshot: JSON.stringify({
              ...job.policy_snapshot,
              capacityOverride: {
                actorId: change === 'actor' ? f.context.actorUserId : f.owner.actorUserId,
                resourceOwnerId:
                  change === 'resource-owner' ? f.owner.actorUserId : f.context.subjectUserId,
              },
            }),
          })
          .where('id', '=', operation.jobId)
          .execute();
      }
      await expect(authorizeQueuedEffect(f.db, operation.jobId, serverId)).rejects.toThrow(
        'forbidden',
      );
    },
  );

  it('attributes a support override to its actual Owner actor and rechecks support revocation', async () => {
    const serverId = await f.server({ limits: { ...f.limits, cpu: 600 } });
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
        'Isolated capacity test',
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
        reason: 'Isolated capacity test',
      },
    };
    const operation = await enqueueServerOperation(f.db, context, serverId, request(), {
      NH_DEFAULT_USER_CPU_PERCENT: '400',
    });
    await expect(authorizeQueuedEffect(f.db, operation.jobId, serverId)).resolves.toMatchObject({
      role: 'owner',
      actorUserId: f.owner.actorUserId,
      subjectUserId: f.context.subjectUserId,
    });
    const audit = await f.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'server.capacity.overridden')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actor_user_id: f.owner.actorUserId,
      subject_user_id: f.context.subjectUserId,
      correlation_id: id,
    });
    await database.pool.query('UPDATE support_sessions SET revoked_at=now() WHERE id=$1', [id]);
    await expect(authorizeQueuedEffect(f.db, operation.jobId, serverId)).rejects.toThrow(
      'support_invalid',
    );
  });

  it('rejects an uncertain reservation owned by another operation before activating an Owner job', async () => {
    const serverId = await f.server();
    const priorJobId = randomUUID();
    await reserveStart(f.db, serverId, priorJobId, 'start');
    await f.db
      .updateTable('resource_reservations')
      .set({ state: 'uncertain' })
      .where('server_id', '=', serverId)
      .execute();
    const before = await queuedCounts();
    await pressure();
    await expect(enqueueServerOperation(f.db, f.owner, serverId, request())).rejects.toThrow(
      'conflict',
    );
    expect(await queuedCounts()).toEqual(before);
    expect(
      await f.db.selectFrom('resource_reservations').selectAll().executeTakeFirst(),
    ).toMatchObject({ operation_id: priorJobId, state: 'uncertain' });
    expect(
      await f.db
        .selectFrom('managed_servers')
        .select('active_operation_id')
        .where('id', '=', serverId)
        .executeTakeFirst(),
    ).toEqual({ active_operation_id: null });
  });

  it('charges bypassed installer commitments to competing ordinary requests', async () => {
    const installer = await f.server();
    const game = await f.server();
    const operation = await enqueueServerOperation(f.db, f.owner, installer, request('reinstall'));
    await pressure();
    await reserveInstallation(f.db, installer, operation.jobId);
    await f.observe({ cpuBusyPercent: 680 });
    await expect(enqueueServerOperation(f.db, f.context, game, request())).rejects.toThrow(
      'resources_unavailable',
    );
    expect(await f.db.selectFrom('installation_reservations').selectAll().execute()).toHaveLength(
      1,
    );
    expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
  });
});
