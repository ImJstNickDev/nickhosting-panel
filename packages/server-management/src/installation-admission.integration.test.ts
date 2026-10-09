import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reserveInstallation, reserveStart, setUserLimits } from './admission.js';
import { setManagedNode, setPhysicalHost } from './configuration.js';
import { createManagedServer, enqueueServerOperation } from './registry.js';
import { managementFixture } from './test-fixtures.js';

describe('physical installation resource admission', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  beforeEach(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db);
  });
  afterEach(async () => {
    await database?.destroy();
  });
  const pending = (limits?: { memory: number; cpu: number }) =>
    createManagedServer(
      f.db,
      f.adapter,
      f.context,
      f.input(limits ? { limits: { ...f.limits, ...limits } } : {}),
    );
  const nodeInput = (patch: Record<string, unknown> = {}) => ({
    id: f.nodeId,
    physicalHostId: f.hostId,
    pterodactylNodeId: f.providerNodeId,
    provisionUserId: 1,
    ...patch,
  });
  const hostInput = (patch: Record<string, unknown> = {}) => ({
    id: f.hostId,
    name: 'isolated fixture',
    memoryLimitMiB: 8192,
    cpuLimitPercent: 800,
    storagePoolMiB: 1000000,
    memoryHeadroomMiB: 256,
    cpuHeadroomPercent: 20,
    diskHeadroomMiB: 256,
    localDiskPath: '/isolated-fixture',
    observerId: 'isolated-observer',
    ...patch,
  });

  it('serializes concurrent installers below the physical memory ceiling', async () => {
    const jobs = await Promise.all(Array.from({ length: 8 }, () => pending()));
    await f.db
      .updateTable('physical_hosts')
      .set({ memory_limit_mib: 3200 })
      .where('id', '=', f.hostId)
      .execute();
    const outcomes = await Promise.allSettled(
      jobs.map((job) => reserveInstallation(f.db, job.serverId, job.jobId)),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
    const denied = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(denied).toHaveLength(6);
    for (const result of denied)
      expect(result.reason).toMatchObject({ code: 'resources_unavailable' });
    const reservations = await f.db.selectFrom('installation_reservations').selectAll().execute();
    expect(reservations).toHaveLength(2);
    expect(reservations.reduce((sum, row) => sum + row.memory_mib, 0)).toBe(2356);
    expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toEqual([]);
  });
  it('enforces installer CPU floors independently of ample memory', async () => {
    const jobs = await Promise.all(Array.from({ length: 5 }, () => pending()));
    await f.db
      .updateTable('physical_hosts')
      .set({ cpu_limit_percent: 220 })
      .where('id', '=', f.hostId)
      .execute();
    const results = await Promise.allSettled(
      jobs.map((job) => reserveInstallation(f.db, job.serverId, job.jobId)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(
      (await f.db.selectFrom('installation_reservations').selectAll().execute()).reduce(
        (sum, row) => sum + row.cpu_percent,
        0,
      ),
    ).toBe(200);
  });
  it('uses the same lock for simultaneous game starts and installation', async () => {
    const game = await f.server({ limits: { ...f.limits, memory: 512 } }),
      install = await pending();
    await f.db
      .updateTable('physical_hosts')
      .set({ memory_limit_mib: 1536 })
      .where('id', '=', f.hostId)
      .execute();
    const results = await Promise.allSettled([
      reserveStart(f.db, game, randomUUID(), 'start'),
      reserveInstallation(f.db, install.serverId, install.jobId),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const active = await f.db.selectFrom('resource_reservations').selectAll().execute();
    const installations = await f.db.selectFrom('installation_reservations').selectAll().execute();
    expect([...active, ...installations]).toHaveLength(1);
    expect(
      active.reduce((sum, row) => sum + row.physical_memory_mib, 0) +
        installations.reduce((sum, row) => sum + row.memory_mib, 0),
    ).toBeLessThanOrEqual(1280);
  });
  it.each(['installation', 'game'] as const)(
    'counts an existing %s reservation against competing work',
    async (first) => {
      const game = await f.server({ limits: { ...f.limits, memory: 512 } }),
        install = await pending();
      await f.db
        .updateTable('physical_hosts')
        .set({ memory_limit_mib: 1536 })
        .where('id', '=', f.hostId)
        .execute();
      if (first === 'installation') {
        await reserveInstallation(f.db, install.serverId, install.jobId);
        await expect(reserveStart(f.db, game, randomUUID(), 'start')).rejects.toThrow(
          'resources_unavailable',
        );
      } else {
        await reserveStart(f.db, game, randomUUID(), 'start');
        await expect(reserveInstallation(f.db, install.serverId, install.jobId)).rejects.toThrow(
          'resources_unavailable',
        );
      }
    },
  );
  it('does not charge installation floors against user active quotas or quota edits', async () => {
    const install = await pending(),
      game = await f.server({ limits: { ...f.limits, memory: 64, cpu: 1 } });
    await reserveInstallation(f.db, install.serverId, install.jobId, {
      NH_DEFAULT_USER_MEMORY_MIB: '64',
      NH_DEFAULT_USER_CPU_PERCENT: '1',
    });
    await setUserLimits(f.db, f.owner, {
      userId: f.context.subjectUserId,
      memoryMiB: 64,
      cpuPercent: 1,
      storageMiB: 4096,
      reason: 'Isolated installation quota test',
    });
    await reserveStart(f.db, game, randomUUID(), 'start');
    const other = await f.server({ limits: { ...f.limits, memory: 64, cpu: 1 } });
    await expect(reserveStart(f.db, other, randomUUID(), 'start')).rejects.toThrow(
      'resources_unavailable',
    );
    expect(
      (await f.db.selectFrom('installation_reservations').selectAll().executeTakeFirstOrThrow())
        .memory_mib,
    ).toBe(1178);
    expect(
      (await f.db.selectFrom('resource_reservations').selectAll().executeTakeFirstOrThrow())
        .memory_mib,
    ).toBe(64);
  });
  it('uses the larger server limits or configured installer floors and audits Owner configuration', async () => {
    await setManagedNode(
      f.db,
      f.adapter,
      f.owner,
      nodeInput({ installerMemoryMiB: 256, installerCpuPercent: 25 }),
    );
    const job = await pending({ memory: 512, cpu: 40 });
    await reserveInstallation(f.db, job.serverId, job.jobId);
    expect(
      await f.db
        .selectFrom('installation_reservations')
        .select(['memory_mib', 'cpu_percent'])
        .executeTakeFirstOrThrow(),
    ).toEqual({ memory_mib: 589, cpu_percent: 40 });
    const audit = await f.db
      .selectFrom('audit_events')
      .select('metadata')
      .where('action', '=', 'resource.node.updated')
      .executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({
      nodeId: f.nodeId,
      installerMemoryMiB: 256,
      installerCpuPercent: 25,
    });
    await expect(
      setManagedNode(
        f.db,
        f.adapter,
        f.owner,
        nodeInput({ installerMemoryMiB: 2048, installerCpuPercent: 200 }),
      ),
    ).rejects.toThrow('conflict');
    await expect(setManagedNode(f.db, f.adapter, f.context, nodeInput())).rejects.toThrow(
      'forbidden',
    );
    await expect(
      setManagedNode(f.db, f.adapter, f.owner, nodeInput({ installerMemoryMiB: 0 })),
    ).rejects.toThrow('validation_failed');
    await expect(
      setManagedNode(f.db, f.adapter, f.owner, nodeInput({ installerCpuPercent: 0 })),
    ).rejects.toThrow('validation_failed');
  });
  it('defaults Owner node configuration to the installed Wings installer floors', async () => {
    await setManagedNode(f.db, f.adapter, f.owner, nodeInput());
    const node = await f.db
      .selectFrom('managed_nodes')
      .select(['installer_memory_mib', 'installer_cpu_percent'])
      .where('id', '=', f.nodeId)
      .executeTakeFirstOrThrow();
    expect(node).toEqual({ installer_memory_mib: 1024, installer_cpu_percent: 100 });
  });
  it('deduplicates the same operation while rechecking fresh capacity and excluding its own row', async () => {
    const job = await pending();
    await f.db
      .updateTable('physical_hosts')
      .set({ memory_limit_mib: 1434, cpu_limit_percent: 120 })
      .where('id', '=', f.hostId)
      .execute();
    await Promise.all(
      Array.from({ length: 8 }, () => reserveInstallation(f.db, job.serverId, job.jobId)),
    );
    expect(await f.db.selectFrom('installation_reservations').selectAll().execute()).toHaveLength(
      1,
    );
    await f.observe({ availableMemoryMiB: 8191 });
    await expect(reserveInstallation(f.db, job.serverId, job.jobId)).rejects.toThrow(
      'resources_unavailable',
    );
    expect(await f.db.selectFrom('installation_reservations').selectAll().execute()).toHaveLength(
      1,
    );
    await f.observe();
    await expect(reserveInstallation(f.db, job.serverId, randomUUID())).rejects.toThrow('conflict');
  });
  it('refuses stale, mismatched or unavailable observations and disabled nodes', async () => {
    const job = await pending();
    await f.observe({}, new Date(Date.now() - 31_000));
    await expect(reserveInstallation(f.db, job.serverId, job.jobId)).rejects.toThrow(
      'resources_unavailable',
    );
    await f.observe({ availableMemoryMiB: 1100 });
    await expect(reserveInstallation(f.db, job.serverId, job.jobId)).rejects.toThrow(
      'resources_unavailable',
    );
    await f.observe({ cpuBusyPercent: 701 });
    await expect(reserveInstallation(f.db, job.serverId, job.jobId)).rejects.toThrow(
      'resources_unavailable',
    );
    await f.observe();
    await f.db
      .updateTable('host_observations')
      .set({ observer_id: 'untrusted-observer' })
      .where('host_id', '=', f.hostId)
      .execute();
    await expect(reserveInstallation(f.db, job.serverId, job.jobId)).rejects.toThrow(
      'resources_unavailable',
    );
    await f.observe();
    await f.db
      .updateTable('managed_nodes')
      .set({ enabled: false })
      .where('id', '=', f.nodeId)
      .execute();
    await expect(reserveInstallation(f.db, job.serverId, job.jobId)).rejects.toThrow(
      'resources_unavailable',
    );
    expect(await f.db.selectFrom('installation_reservations').selectAll().execute()).toEqual([]);
  });
  it('preserves all installer plus game commitments when lowering host policy', async () => {
    const install = await pending(),
      game = await f.server({ limits: { ...f.limits, memory: 512, cpu: 25 } });
    await reserveInstallation(f.db, install.serverId, install.jobId);
    await reserveStart(f.db, game, randomUUID(), 'start');
    await expect(
      setPhysicalHost(f.db, f.owner, hostInput({ memoryLimitMiB: 2022 })),
    ).rejects.toThrow('conflict');
    await expect(
      setPhysicalHost(f.db, f.owner, hostInput({ cpuLimitPercent: 144 })),
    ).rejects.toThrow('conflict');
    await setPhysicalHost(f.db, f.owner, hostInput({ memoryLimitMiB: 2023, cpuLimitPercent: 145 }));
    expect(await f.db.selectFrom('installation_reservations').selectAll().execute()).toHaveLength(
      1,
    );
    expect(await f.db.selectFrom('resource_reservations').selectAll().execute()).toHaveLength(1);
  });
  it('applies explicit environment host policy limits to installation admission', async () => {
    const job = await pending();
    const env = {
      NH_HOST_POLICIES: JSON.stringify({ [f.hostId]: hostInput({ memoryLimitMiB: 1024 }) }),
    };
    await expect(reserveInstallation(f.db, job.serverId, job.jobId, env)).rejects.toThrow(
      'resources_unavailable',
    );
    expect(await f.db.selectFrom('installation_reservations').selectAll().execute()).toEqual([]);
  });
  it('rejects unrelated durable jobs and jobs whose action cannot install', async () => {
    const target = await f.server(),
      unrelated = await pending();
    await expect(reserveInstallation(f.db, target, unrelated.jobId)).rejects.toThrow('forbidden');
    const stop = await enqueueServerOperation(f.db, f.context, target, {
      action: 'stop',
      idempotencyKey: randomUUID(),
    });
    await expect(reserveInstallation(f.db, target, stop.jobId)).rejects.toThrow('forbidden');
    expect(await f.db.selectFrom('installation_reservations').selectAll().execute()).toEqual([]);
  });
});
