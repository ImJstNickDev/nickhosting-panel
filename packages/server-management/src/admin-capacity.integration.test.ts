import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockResources, reserveInstallation, reserveStart } from './admission.js';
import {
  createManagedServer,
  enqueueLockedServerOperation,
  enqueueServerOperation,
} from './registry.js';
import { managementFixture } from './test-fixtures.js';

describe('administrator-requested physical compute admission', () => {
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

  it('does not grant automatic work Owner capacity at initial enqueue', async () => {
    const serverId = await f.server();
    await pressure();
    await expect(
      f.db.transaction().execute(async (tx) => {
        await lockResources(tx);
        return enqueueLockedServerOperation(tx, f.owner, serverId, request(), {}, undefined, {
          requestSource: 'automation',
        });
      }),
    ).rejects.toThrow('resources_unavailable');
    expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
  });

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

  it('retains the resource owner active-compute quota for manual Owner requests', async () => {
    const serverId = await f.server();
    await expect(
      enqueueServerOperation(f.db, f.owner, serverId, request(), {
        NH_DEFAULT_USER_MEMORY_MIB: '64',
      }),
    ).rejects.toThrow('resources_unavailable');
    expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
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
