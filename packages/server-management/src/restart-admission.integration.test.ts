import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reserveInstallation, reserveStart } from './admission.js';
import { createManagedServer, enqueueServerOperation } from './registry.js';
import { managementFixture } from './test-fixtures.js';

/** No provider operations: isolated database fixtures model already committed
 * running work and fresh host pressure from unrelated services. */
describe('delta admission for retained game reservations', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  beforeEach(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db);
  });
  afterEach(async () => {
    await database?.destroy();
  });
  async function running(memory = 256, cpu = 10) {
    const server = await f.server({ limits: { ...f.limits, memory, cpu } });
    await reserveStart(f.db, server, randomUUID(), 'start');
    await f.db
      .updateTable('resource_reservations')
      .set({ state: 'running', updated_at: new Date(Date.now() - 1000) })
      .where('server_id', '=', server)
      .execute();
    return server;
  }
  const reservation = (server: string) =>
    f.db
      .selectFrom('resource_reservations')
      .selectAll()
      .where('server_id', '=', server)
      .executeTakeFirstOrThrow();
  async function limits(server: string, memory: number, cpu: number) {
    // Models changed effective requirements without claiming active build edits
    // are permitted by the public API. Admission must account them safely.
    await f.db
      .updateTable('managed_servers')
      .set({ limits: JSON.stringify({ ...f.limits, memory, cpu }) })
      .where('id', '=', server)
      .execute();
  }

  it('admits a same-resource restart and repeated worker admission under high RAM and CPU load', async () => {
    const target = await running(2048, 200);
    await running(2048, 200);
    const stopped = await f.server();
    await f.observe({ availableMemoryMiB: 600, cpuBusyPercent: 740 });
    const restart = await enqueueServerOperation(f.db, f.context, target, {
      action: 'restart',
      idempotencyKey: randomUUID(),
    });
    await Promise.all(
      Array.from({ length: 8 }, () => reserveStart(f.db, target, restart.jobId, 'restart')),
    );
    expect(await reservation(target)).toMatchObject({
      memory_mib: 2048,
      physical_memory_mib: 2356,
      cpu_percent: 200,
      state: 'restarting',
      operation_id: restart.jobId,
    });
    expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toHaveLength(2);
    await expect(reserveStart(f.db, stopped, randomUUID(), 'start')).rejects.toThrow(
      'resources_unavailable',
    );
  });

  it('retains a same-job starting reservation without charging it a second time', async () => {
    const server = await f.server({ limits: { ...f.limits, memory: 2048, cpu: 200 } });
    const jobId = randomUUID();
    await reserveStart(f.db, server, jobId, 'start');
    await f.observe({ availableMemoryMiB: 300, cpuBusyPercent: 775 });
    await reserveStart(f.db, server, jobId, 'start');
    expect(await reservation(server)).toMatchObject({
      memory_mib: 2048,
      physical_memory_mib: 2356,
      cpu_percent: 200,
      operation_id: jobId,
      state: 'starting',
    });
  });

  it('retains installer commitments at the hard ceiling without charging them again to restart headroom', async () => {
    const server = await running(2048, 200);
    const installation = await createManagedServer(f.db, f.adapter, f.context, f.input());
    await reserveInstallation(f.db, installation.serverId, installation.jobId);
    await f.observe({ availableMemoryMiB: 300, cpuBusyPercent: 775 });
    const jobId = randomUUID();
    await reserveStart(f.db, server, jobId, 'restart');
    expect(await f.db.selectFrom('installation_reservations').selectAll().execute()).toHaveLength(
      1,
    );
    // Two independent full commitments: game2356 + installer1178 + headroom256.
    await f.db
      .updateTable('physical_hosts')
      .set({ memory_limit_mib: 3789 })
      .where('id', '=', f.hostId)
      .execute();
    await f.observe();
    await expect(reserveStart(f.db, server, jobId, 'restart')).rejects.toThrow(
      'resources_unavailable',
    );
    expect((await reservation(server)).physical_memory_mib).toBe(2356);
  });

  it.each(['memory', 'cpu'] as const)(
    'admits only the positive %s growth delta against a newer sample',
    async (kind) => {
      const server = await running();
      await limits(server, kind === 'memory' ? 384 : 256, kind === 'cpu' ? 40 : 10);
      await f.observe({
        availableMemoryMiB: kind === 'memory' ? 405 : 300,
        cpuBusyPercent: kind === 'cpu' ? 745 : 775,
      });
      await reserveStart(f.db, server, randomUUID(), 'restart');
      expect(await reservation(server)).toMatchObject({
        memory_mib: kind === 'memory' ? 384 : 256,
        physical_memory_mib: kind === 'memory' ? 442 : 295,
        cpu_percent: kind === 'cpu' ? 40 : 10,
      });
    },
  );

  it.each(['memory', 'cpu'] as const)(
    'refuses %s growth beyond sampled headroom without shrinking the prior commitment',
    async (kind) => {
      const server = await running();
      const before = await reservation(server);
      await limits(server, kind === 'memory' ? 384 : 256, kind === 'cpu' ? 40 : 10);
      await f.observe({
        availableMemoryMiB: kind === 'memory' ? 402 : 8192,
        cpuBusyPercent: kind === 'cpu' ? 751 : 0,
      });
      await expect(reserveStart(f.db, server, randomUUID(), 'restart')).rejects.toThrow(
        'resources_unavailable',
      );
      expect(await reservation(server)).toEqual(before);
    },
  );

  it.each(['memory', 'cpu'] as const)(
    'serializes competing %s growth against one host sample',
    async (kind) => {
      const servers = [await running(), await running()];
      for (const server of servers)
        await limits(server, kind === 'memory' ? 384 : 256, kind === 'cpu' ? 40 : 10);
      await f.observe({
        availableMemoryMiB: kind === 'memory' ? 700 : 8192,
        cpuBusyPercent: kind === 'cpu' ? 740 : 0,
      });
      const outcomes = await Promise.allSettled(
        servers.map((server) => reserveStart(f.db, server, randomUUID(), 'restart')),
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      const rows = await f.db.selectFrom('resource_reservations').selectAll().execute();
      expect(rows.reduce((sum, row) => sum + row.physical_memory_mib, 0)).toBe(
        kind === 'memory' ? 737 : 590,
      );
      expect(rows.reduce((sum, row) => sum + row.cpu_percent, 0)).toBe(kind === 'cpu' ? 50 : 20);
    },
  );

  it.each(['memory', 'cpu'] as const)(
    'cannot repeatedly spend one sample on same-job %s growth',
    async (kind) => {
      const server = await running();
      const jobId = randomUUID();
      await limits(server, kind === 'memory' ? 384 : 256, kind === 'cpu' ? 40 : 10);
      await f.observe({
        availableMemoryMiB: kind === 'memory' ? 700 : 8192,
        cpuBusyPercent: kind === 'cpu' ? 740 : 0,
      });
      await reserveStart(f.db, server, jobId, 'restart');
      await reserveStart(f.db, server, jobId, 'restart');
      const before = await reservation(server);
      await limits(server, kind === 'memory' ? 512 : 256, kind === 'cpu' ? 70 : 10);
      await expect(reserveStart(f.db, server, jobId, 'restart')).rejects.toThrow(
        'resources_unavailable',
      );
      expect(await reservation(server)).toEqual(before);
    },
  );

  it('charges a higher environment overhead as growth and never credits a later decrease', async () => {
    const server = await running();
    const jobId = randomUUID();
    await f.observe({ availableMemoryMiB: 500 });
    await reserveStart(f.db, server, jobId, 'restart', { NH_NODE_MEMORY_OVERHEAD_PERCENT: '200' });
    expect((await reservation(server)).physical_memory_mib).toBe(512);
    await f.observe({ availableMemoryMiB: 300, cpuBusyPercent: 775 });
    await reserveStart(f.db, server, jobId, 'restart', { NH_NODE_MEMORY_OVERHEAD_PERCENT: '100' });
    expect((await reservation(server)).physical_memory_mib).toBe(512);
    await expect(
      reserveStart(f.db, server, jobId, 'restart', { NH_NODE_MEMORY_OVERHEAD_PERCENT: '300' }),
    ).rejects.toThrow('resources_unavailable');
    expect((await reservation(server)).physical_memory_mib).toBe(512);
  });

  it('never lowers previously committed raw RAM or CPU during a repeated admission', async () => {
    const server = await running(512, 100);
    await limits(server, 128, 10);
    await f.observe({ availableMemoryMiB: 300, cpuBusyPercent: 775 });
    await reserveStart(f.db, server, randomUUID(), 'restart');
    expect(await reservation(server)).toMatchObject({
      memory_mib: 512,
      physical_memory_mib: 589,
      cpu_percent: 100,
    });
  });

  it.each(['memory', 'cpu'] as const)(
    'still enforces reduced effective user %s quotas',
    async (kind) => {
      const server = await running(512, 100);
      await f.observe({ availableMemoryMiB: 300, cpuBusyPercent: 775 });
      await expect(
        reserveStart(
          f.db,
          server,
          randomUUID(),
          'restart',
          kind === 'memory'
            ? { NH_DEFAULT_USER_MEMORY_MIB: '511' }
            : { NH_DEFAULT_USER_CPU_PERCENT: '99' },
        ),
      ).rejects.toThrow('resources_unavailable');
      expect((await reservation(server)).state).toBe('running');
    },
  );

  it.each(['policy memory', 'physical memory', 'policy CPU', 'physical CPU'] as const)(
    'enforces the aggregate %s hard ceiling for zero growth',
    async (kind) => {
      const server = await running(2048, 200);
      await running(2048, 200);
      if (kind === 'policy memory')
        await f.db
          .updateTable('physical_hosts')
          .set({ memory_limit_mib: 4967 })
          .where('id', '=', f.hostId)
          .execute();
      if (kind === 'policy CPU')
        await f.db
          .updateTable('physical_hosts')
          .set({ cpu_limit_percent: 419 })
          .where('id', '=', f.hostId)
          .execute();
      await f.observe({
        ...(kind === 'physical memory' ? { totalMemoryMiB: 4967, availableMemoryMiB: 4967 } : {}),
        ...(kind === 'physical CPU' ? { cpuCapacityPercent: 419 } : {}),
      });
      await expect(reserveStart(f.db, server, randomUUID(), 'restart')).rejects.toThrow(
        'resources_unavailable',
      );
    },
  );

  it.each(['memory', 'cpu'] as const)(
    'still refuses exhausted actual %s safety headroom at zero growth',
    async (kind) => {
      const server = await running();
      await f.observe(kind === 'memory' ? { availableMemoryMiB: 255 } : { cpuBusyPercent: 781 });
      await expect(reserveStart(f.db, server, randomUUID(), 'restart')).rejects.toThrow(
        'resources_unavailable',
      );
    },
  );

  it.each(['stale', 'future', 'observer', 'node', 'host'] as const)(
    'does not bypass %s safety validation for a retained reservation',
    async (kind) => {
      const server = await running();
      if (kind === 'stale' || kind === 'future')
        await f.observe({}, new Date(Date.now() + (kind === 'stale' ? -31000 : 10000)));
      if (kind === 'observer')
        await f.db
          .updateTable('host_observations')
          .set({ observer_id: 'wrong-observer' })
          .where('host_id', '=', f.hostId)
          .execute();
      if (kind === 'node')
        await f.db
          .updateTable('managed_nodes')
          .set({ enabled: false })
          .where('id', '=', f.nodeId)
          .execute();
      if (kind === 'host')
        await f.db
          .updateTable('physical_hosts')
          .set({ enabled: false })
          .where('id', '=', f.hostId)
          .execute();
      await expect(reserveStart(f.db, server, randomUUID(), 'restart')).rejects.toThrow(
        'resources_unavailable',
      );
    },
  );

  it.each(['owner', 'host'] as const)(
    'cannot credit a reservation with a mismatched %s identity',
    async (kind) => {
      const server = await running();
      const other = await managementFixture(f.db);
      await f.db
        .updateTable('resource_reservations')
        .set(
          kind === 'owner'
            ? { owner_id: other.context.subjectUserId }
            : { physical_host_id: other.hostId },
        )
        .where('server_id', '=', server)
        .execute();
      await expect(reserveStart(f.db, server, randomUUID(), 'restart')).rejects.toThrow('conflict');
    },
  );

  it('cannot take over an uncertain or another active operation reservation', async () => {
    const server = await running();
    await f.db
      .updateTable('resource_reservations')
      .set({ state: 'uncertain' })
      .where('server_id', '=', server)
      .execute();
    const before = await reservation(server);
    await f.observe({ availableMemoryMiB: 300, cpuBusyPercent: 775 });
    await expect(reserveStart(f.db, server, randomUUID(), 'restart')).rejects.toThrow('conflict');
    expect(await reservation(server)).toEqual(before);
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: randomUUID() })
      .where('id', '=', server)
      .execute();
    await expect(reserveStart(f.db, server, before.operation_id, 'restart')).rejects.toThrow(
      'conflict',
    );
    expect(await reservation(server)).toEqual(before);
  });
});
