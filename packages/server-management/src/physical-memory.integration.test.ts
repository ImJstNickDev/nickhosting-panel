import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  physicalMemoryMiB,
  reservedPhysicalCompute,
  reserveInstallation,
  reserveStart,
} from './admission.js';
import { effectiveNodeOverhead, setManagedNode, setPhysicalHost } from './configuration.js';
import { createManagedServer } from './registry.js';
import { managementFixture } from './test-fixtures.js';

describe('Wings physical memory overhead accounting', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  beforeEach(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db);
  });
  afterEach(async () => {
    await database?.destroy();
  });
  const hostPolicy = (memoryLimitMiB: number) => ({
    id: f.hostId,
    name: 'fixture',
    memoryLimitMiB,
    cpuLimitPercent: 800,
    storagePoolMiB: 1000000,
    memoryHeadroomMiB: 256,
    cpuHeadroomPercent: 20,
    diskHeadroomMiB: 256,
    localDiskPath: '/isolated-fixture',
    observerId: 'isolated-observer',
  });
  const nodePolicy = (memoryOverheadPercent: number) => ({
    id: f.nodeId,
    physicalHostId: f.hostId,
    pterodactylNodeId: f.providerNodeId,
    provisionUserId: 1,
    memoryOverheadPercent,
  });
  const installer = () => createManagedServer(f.db, f.adapter, f.context, f.input());

  it('atomically refuses two starts whose raw RAM fits but physical maxima do not', async () => {
    const servers = await Promise.all([
      f.server({ limits: { ...f.limits, memory: 256 } }),
      f.server({ limits: { ...f.limits, memory: 256 } }),
    ]);
    await f.db
      .updateTable('physical_hosts')
      .set({ memory_limit_mib: 768 })
      .where('id', '=', f.hostId)
      .execute();
    const results = await Promise.allSettled(
      servers.map((id) =>
        reserveStart(f.db, id, randomUUID(), 'start', { NH_DEFAULT_USER_MEMORY_MIB: '512' }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select(['memory_mib', 'physical_memory_mib'])
        .execute(),
    ).toEqual([{ memory_mib: 256, physical_memory_mib: 295 }]);
    // The verified live limit was 294,400,000 bytes for raw256. Integer binary
    // MiB at the maximum115% bound intentionally includes conversion headroom.
    expect(295 * 1048576).toBeGreaterThanOrEqual(294400000);
  });
  it('continues charging user quotas in raw configured memory', async () => {
    for (let i = 0; i < 2; i++) {
      const server = await f.server({ limits: { ...f.limits, memory: 256 } });
      await reserveStart(f.db, server, randomUUID(), 'start', {
        NH_DEFAULT_USER_MEMORY_MIB: '512',
      });
    }
    const reservations = await f.db.selectFrom('resource_reservations').selectAll().execute();
    expect(reservations.reduce((sum, row) => sum + row.memory_mib, 0)).toBe(512);
    expect(reservations.reduce((sum, row) => sum + row.physical_memory_mib, 0)).toBe(590);
  });
  it('raises old game commitments immediately under a higher environment bound and never lowers them', async () => {
    const first = await f.server({ limits: { ...f.limits, memory: 256 } }),
      second = await f.server({ limits: { ...f.limits, memory: 256 } }),
      job = randomUUID();
    await reserveStart(f.db, first, job, 'start');
    await f.db
      .updateTable('physical_hosts')
      .set({ memory_limit_mib: 1152 })
      .where('id', '=', f.hostId)
      .execute();
    const env = { NH_NODE_MEMORY_OVERHEAD_PERCENT: '200' };
    await expect(reserveStart(f.db, second, randomUUID(), 'start', env)).rejects.toThrow(
      'resources_unavailable',
    );
    expect(await reservedPhysicalCompute(f.db, f.hostId, env)).toEqual({
      memoryMiB: 512,
      cpuPercent: 10,
    });
    await reserveStart(f.db, first, job, 'start', env);
    await reserveStart(f.db, first, job, 'start', { NH_NODE_MEMORY_OVERHEAD_PERCENT: '100' });
    expect(
      (await f.db.selectFrom('resource_reservations').selectAll().executeTakeFirstOrThrow())
        .physical_memory_mib,
    ).toBe(512);
  });
  it('reserves installer overhead and increases old installer commitments under environment overrides', async () => {
    const install = await installer(),
      game = await f.server({ limits: { ...f.limits, memory: 256 } });
    await reserveInstallation(f.db, install.serverId, install.jobId);
    expect(
      (await f.db.selectFrom('installation_reservations').selectAll().executeTakeFirstOrThrow())
        .memory_mib,
    ).toBe(1178);
    expect(1178 * 1048576).toBeGreaterThanOrEqual(1177600000);
    await f.db
      .updateTable('physical_hosts')
      .set({ memory_limit_mib: 2200 })
      .where('id', '=', f.hostId)
      .execute();
    const env = { NH_NODE_MEMORY_OVERHEAD_PERCENT: '200' };
    await expect(reserveStart(f.db, game, randomUUID(), 'start', env)).rejects.toThrow(
      'resources_unavailable',
    );
    expect((await reservedPhysicalCompute(f.db, f.hostId, env)).memoryMiB).toBe(2048);
    await f.db
      .updateTable('physical_hosts')
      .set({ memory_limit_mib: 8192 })
      .where('id', '=', f.hostId)
      .execute();
    await reserveInstallation(f.db, install.serverId, install.jobId, env);
    await reserveInstallation(f.db, install.serverId, install.jobId, {
      NH_NODE_MEMORY_OVERHEAD_PERCENT: '100',
    });
    expect(
      (await f.db.selectFrom('installation_reservations').selectAll().executeTakeFirstOrThrow())
        .memory_mib,
    ).toBe(2048);
  });
  it.each(['game', 'installer'] as const)(
    'applies current overhead to %s reservations before host policy reductions',
    async (kind) => {
      if (kind === 'game')
        await reserveStart(
          f.db,
          await f.server({ limits: { ...f.limits, memory: 256 } }),
          randomUUID(),
          'start',
        );
      else {
        const job = await installer();
        await reserveInstallation(f.db, job.serverId, job.jobId);
      }
      await expect(
        setPhysicalHost(f.db, f.owner, hostPolicy(kind === 'game' ? 700 : 2000), {
          NH_NODE_MEMORY_OVERHEAD_PERCENT: '200',
        }),
      ).rejects.toThrow('conflict');
    },
  );
  it.each(['game', 'installer'] as const)(
    'blocks overhead changes while a node has any %s reservation',
    async (kind) => {
      if (kind === 'game') await reserveStart(f.db, await f.server(), randomUUID(), 'start');
      else {
        const job = await installer();
        await reserveInstallation(f.db, job.serverId, job.jobId);
      }
      await expect(setManagedNode(f.db, f.adapter, f.owner, nodePolicy(120))).rejects.toThrow(
        'conflict',
      );
      expect(
        (
          await f.db
            .selectFrom('managed_nodes')
            .select('memory_overhead_percent')
            .where('id', '=', f.nodeId)
            .executeTakeFirstOrThrow()
        ).memory_overhead_percent,
      ).toBe(115);
    },
  );
  it('validates Owner and environment bounds and gives explicit environment values precedence', async () => {
    await setManagedNode(f.db, f.adapter, f.owner, nodePolicy(130));
    const node = await f.db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', f.nodeId)
      .executeTakeFirstOrThrow();
    expect(effectiveNodeOverhead(node)).toBe(130);
    expect(effectiveNodeOverhead(node, { NH_NODE_MEMORY_OVERHEAD_PERCENT: '150' })).toBe(150);
    await expect(
      setManagedNode(f.db, f.adapter, f.owner, nodePolicy(140), {
        NH_NODE_MEMORY_OVERHEAD_PERCENT: '150',
      }),
    ).rejects.toThrow('conflict');
    const { memoryOverheadPercent: _ignored, ...unchanged } = nodePolicy(130);
    await setManagedNode(f.db, f.adapter, f.owner, unchanged, {
      NH_NODE_MEMORY_OVERHEAD_PERCENT: '150',
    });
    expect(
      (
        await f.db
          .selectFrom('managed_nodes')
          .select('memory_overhead_percent')
          .where('id', '=', f.nodeId)
          .executeTakeFirstOrThrow()
      ).memory_overhead_percent,
    ).toBe(130);
    for (const value of ['99', '401', '115.1', 'NaN', ''])
      expect(() => effectiveNodeOverhead(node, { NH_NODE_MEMORY_OVERHEAD_PERCENT: value })).toThrow(
        'configuration_invalid',
      );
    await expect(setManagedNode(f.db, f.adapter, f.owner, nodePolicy(99))).rejects.toThrow(
      'validation_failed',
    );
    expect(physicalMemoryMiB(33, 115)).toBe(38);
    expect(
      (
        await f.db
          .selectFrom('audit_events')
          .select('metadata')
          .where('action', '=', 'resource.node.updated')
          .executeTakeFirstOrThrow()
      ).metadata,
    ).toMatchObject({ memoryOverheadPercent: 130 });
  });
  it('backfills existing game and installer reservations without changing raw user quota', async () => {
    const game = await f.server({ limits: { ...f.limits, memory: 256 } }),
      install = await installer();
    await reserveStart(f.db, game, randomUUID(), 'start');
    await reserveInstallation(f.db, install.serverId, install.jobId);
    // Reconstruct only this isolated schema's005 layout, with live reservation rows,
    // then execute the exact production006 SQL against that upgrade fixture.
    await database.pool.query(
      'ALTER TABLE resource_reservations DROP COLUMN physical_memory_mib; ALTER TABLE managed_nodes DROP COLUMN memory_overhead_percent; UPDATE installation_reservations SET memory_mib=1024',
    );
    const migration = await readFile(
      new URL('../../database/migrations/006_physical_memory.sql', import.meta.url),
      'utf8',
    );
    await database.pool.query(migration);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select(['memory_mib', 'physical_memory_mib'])
        .execute(),
    ).toEqual([{ memory_mib: 256, physical_memory_mib: 295 }]);
    expect(
      (await f.db.selectFrom('installation_reservations').selectAll().executeTakeFirstOrThrow())
        .memory_mib,
    ).toBe(1178);
    expect((await reservedPhysicalCompute(f.db, f.hostId)).memoryMiB).toBe(1473);
  });
});
