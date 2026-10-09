import { randomUUID } from 'node:crypto';
import { getSettings, updateSettings } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkedObservation, checkStorage, reserveStart, setUserLimits } from './admission.js';
import { setPhysicalHost } from './configuration.js';
import { createManagedServer, enqueueServerOperation } from './registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  await database.db.deleteFrom('platform_settings').execute();
  f = await managementFixture(database.db);
});
afterAll(async () => {
  await database?.destroy();
});

describe('atomic active compute and persistent resource admission', () => {
  it('permits many stopped high-RAM servers without consuming active compute', async () => {
    const results = [];
    // Complete each fixture provision before the next: this tests retaining many
    // stopped servers, independently of the concurrent-provision anti-abuse cap.
    for (let i = 0; i < 12; i++)
      results.push(await f.server({ limits: { ...f.limits, memory: 16384 } }));
    expect(results).toHaveLength(12);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('owner_id', '=', f.context.subjectUserId)
        .execute(),
    ).toHaveLength(0);
    const rows = await f.db
      .selectFrom('managed_servers')
      .select('limits')
      .where('owner_id', '=', f.context.subjectUserId)
      .execute();
    expect(rows.reduce((sum, row) => sum + row.limits.memory, 0)).toBe(196608);
    expect(
      new Set(
        (
          await f.db
            .selectFrom('server_allocations')
            .select('pterodactyl_allocation_id')
            .where('node_id', '=', f.nodeId)
            .execute()
        ).map((r) => r.pterodactyl_allocation_id),
      ).size,
    ).toBe(12);
  });
  it('serializes simultaneous starts at the user memory limit', async () => {
    const servers = await Promise.all([
      f.server({ limits: { ...f.limits, memory: 256 } }),
      f.server({ limits: { ...f.limits, memory: 256 } }),
    ]);
    const outcomes = await Promise.allSettled(
      servers.map((server) =>
        enqueueServerOperation(
          f.db,
          f.context,
          server,
          { action: 'start', idempotencyKey: randomUUID() },
          { NH_DEFAULT_USER_MEMORY_MIB: '256' },
        ),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (
        await f.db
          .selectFrom('resource_reservations')
          .selectAll()
          .where('owner_id', '=', f.context.subjectUserId)
          .execute()
      ).reduce((sum, r) => sum + r.memory_mib, 0),
    ).toBe(256);
  });
  it('enforces CPU quota independently from RAM', async () => {
    const server = await f.server({ limits: { ...f.limits, cpu: 40 } });
    await expect(
      reserveStart(f.db, server, randomUUID(), 'start', { NH_DEFAULT_USER_CPU_PERCENT: '30' }),
    ).rejects.toThrow('resources_unavailable');
  });
  it('rejects physical pressure caused by unrelated workloads without mutating them', async () => {
    const server = await f.server({ limits: { ...f.limits, memory: 1024 } });
    await f.observe({ availableMemoryMiB: 1100 });
    await expect(reserveStart(f.db, server, randomUUID(), 'start')).rejects.toThrow(
      'resources_unavailable',
    );
    await f.observe({ cpuBusyPercent: 780 });
    await expect(reserveStart(f.db, server, randomUUID(), 'start')).rejects.toThrow(
      'resources_unavailable',
    );
  });
  it('does not credit stale high managed usage against fresh free host memory', async () => {
    const first = await f.server({ limits: { ...f.limits, memory: 2048 } });
    const second = await f.server({ limits: { ...f.limits, memory: 1024 } });
    await reserveStart(f.db, first, randomUUID(), 'start');
    await f.observe({
      availableMemoryMiB: 2500,
      managed: { [first]: { memoryMiB: 2048, cpuPercent: 10 } },
    });
    await expect(reserveStart(f.db, second, randomUUID(), 'start')).rejects.toThrow(
      'resources_unavailable',
    );
  });
  it('rejects stale, future, malformed and wrong-observer host samples', async () => {
    for (const at of [new Date(Date.now() - 31000), new Date(Date.now() + 10000)]) {
      await f.observe({}, at);
      await expect(checkedObservation(f.db, f.hostId)).rejects.toThrow('resources_unavailable');
    }
    await f.observe({ availableMemoryMiB: 99999 });
    await expect(checkedObservation(f.db, f.hostId)).rejects.toThrow('resources_unavailable');
    await f.observe();
    await f.db
      .updateTable('host_observations')
      .set({ observer_id: 'other' })
      .where('host_id', '=', f.hostId)
      .execute();
    await expect(checkedObservation(f.db, f.hostId)).rejects.toThrow('resources_unavailable');
  });
  it('deduplicates identical start requests without double reservation', async () => {
    const server = await f.server();
    const input = { action: 'start', idempotencyKey: randomUUID() };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => enqueueServerOperation(f.db, f.context, server, input)),
    );
    expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', server)
        .execute(),
    ).toHaveLength(1);
    await expect(
      enqueueServerOperation(f.db, f.context, server, { ...input, action: 'restart' }),
    ).rejects.toThrow('conflict');
  });
  it('retains reservations while restart and stop are merely queued', async () => {
    const server = await f.server();
    const previous = randomUUID();
    await reserveStart(f.db, server, previous, 'start');
    await f.db
      .updateTable('resource_reservations')
      .set({ state: 'running' })
      .where('server_id', '=', server)
      .execute();
    const restart = await enqueueServerOperation(f.db, f.context, server, {
      action: 'restart',
      idempotencyKey: randomUUID(),
    });
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select(['memory_mib', 'state'])
        .where('server_id', '=', server)
        .executeTakeFirst(),
    ).toEqual({ memory_mib: 128, state: 'restarting' });
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', server)
      .execute();
    await f.db
      .updateTable('operation_jobs')
      .set({ state: 'succeeded', completed_at: new Date() })
      .where('id', '=', restart.jobId)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'sleeping' })
      .where('id', '=', server)
      .execute();
    await enqueueServerOperation(f.db, f.context, server, {
      action: 'stop',
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await f.db
          .selectFrom('resource_reservations')
          .select('state')
          .where('server_id', '=', server)
          .executeTakeFirst()
      )?.state,
    ).toBe('stopping');
    expect(
      (
        await f.db
          .selectFrom('managed_servers')
          .select('intent')
          .where('id', '=', server)
          .executeTakeFirstOrThrow()
      ).intent,
    ).toBe('manually_stopped');
  });
  it('reserves disk and backup slots for stopped servers under the global pool', async () => {
    await f.server({ limits: { ...f.limits, disk: 128 } });
    await f.db
      .updateTable('physical_hosts')
      .set({ storage_pool_mib: '300' })
      .where('id', '=', f.hostId)
      .execute();
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'storage_exhausted',
    );
    expect((await getSettings(f.db)).values.storagePolicy).toBe('GLOBAL_POOL');
  });
  it('does not credit old disk telemetry after files shrink', async () => {
    const server = await f.server({ limits: { ...f.limits, disk: 256 } });
    await f.db
      .insertInto('server_metrics')
      .values({
        server_id: server,
        observed_at: new Date(0),
        memory_bytes: '0',
        cpu_percent: 0,
        disk_bytes: String(512 * 1048576),
        network_rx_bytes: '0',
        network_tx_bytes: '0',
      })
      .execute();
    await f.observe({ availableDiskMiB: 800 });
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'storage_exhausted',
    );
  });
  it('enforces per-user storage independently from global capacity', async () => {
    await f.server();
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input(), {
        NH_STORAGE_POLICY: 'PER_USER_BUDGET',
        NH_DEFAULT_USER_STORAGE_MIB: '200',
      }),
    ).rejects.toThrow('storage_exhausted');
  });
  it('validates a policy switch against already reserved storage', async () => {
    await f.server({ limits: { ...f.limits, disk: 256 } });
    await expect(
      updateSettings(f.db, f.owner, {
        storagePolicy: 'PER_USER_BUDGET',
        defaultUserStorageMiB: 256,
      }),
    ).rejects.toThrow('conflict');
    expect((await getSettings(f.db)).values.storagePolicy).toBe('GLOBAL_POOL');
  });
  it('requires a reason and audits temporary Owner quota exceptions', async () => {
    const server = await f.server({ limits: { ...f.limits, memory: 256 } });
    await setUserLimits(f.db, f.owner, {
      userId: f.context.subjectUserId,
      memoryMiB: 512,
      cpuPercent: 50,
      storageMiB: 1024,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      reason: 'Approved isolated quota test',
    });
    await reserveStart(f.db, server, randomUUID(), 'start', { NH_DEFAULT_USER_MEMORY_MIB: '128' });
    const audit = await f.db
      .selectFrom('audit_events')
      .select('metadata')
      .where('action', '=', 'resource.user_limits.updated')
      .where('subject_user_id', '=', f.owner.subjectUserId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.metadata.reason).toBe('Approved isolated quota test');
    await expect(
      setUserLimits(f.db, f.context, {
        userId: f.context.subjectUserId,
        memoryMiB: 512,
        cpuPercent: 50,
        storageMiB: 1024,
        reason: 'Unauthorized attempt',
      }),
    ).rejects.toThrow('forbidden');
  });
  it('refuses reducing quotas or physical policy below committed allowances', async () => {
    const server = await f.server({ limits: { ...f.limits, memory: 512, disk: 512 } });
    await reserveStart(f.db, server, randomUUID(), 'start');
    await expect(
      setUserLimits(f.db, f.owner, {
        userId: f.context.subjectUserId,
        memoryMiB: 128,
        cpuPercent: 50,
        storageMiB: 2048,
        reason: 'Would understate active resources',
      }),
    ).rejects.toThrow('conflict');
    await expect(
      setPhysicalHost(f.db, f.owner, {
        id: f.hostId,
        name: 'same',
        memoryLimitMiB: 8192,
        cpuLimitPercent: 800,
        storagePoolMiB: 512,
        memoryHeadroomMiB: 256,
        cpuHeadroomPercent: 20,
        diskHeadroomMiB: 256,
        localDiskPath: '/isolated-fixture',
        observerId: 'isolated-observer',
      }),
    ).rejects.toThrow('conflict');
  });
  it('resolves environment host limits above DB values and locks overridden edits', async () => {
    const override = {
      id: f.hostId,
      name: 'override',
      memoryLimitMiB: 512,
      cpuLimitPercent: 100,
      storagePoolMiB: 1024,
      memoryHeadroomMiB: 256,
      cpuHeadroomPercent: 20,
      diskHeadroomMiB: 256,
      localDiskPath: '/isolated-fixture',
      observerId: 'isolated-observer',
    };
    const env = { NH_HOST_POLICIES: JSON.stringify({ [f.hostId]: override }) };
    expect((await checkedObservation(f.db, f.hostId, env)).host.memory_limit_mib).toBe(512);
    await expect(setPhysicalHost(f.db, f.owner, override, env)).rejects.toThrow('conflict');
    await expect(
      f.db
        .transaction()
        .execute((tx) => checkStorage(tx, f.context.subjectUserId, f.hostId, 2048, env)),
    ).rejects.toThrow('storage_exhausted');
  });
});
