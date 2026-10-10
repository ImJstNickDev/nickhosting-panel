import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setManagedNode } from './configuration.js';
import {
  authorizeServer,
  createManagedServer,
  createProject,
  enqueueServerOperation,
  listServers,
  setProjectMember,
  setRuntimeMapping,
} from './registry.js';
import { managementFixture, pendingUploadFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  f = await managementFixture(database.db);
});
afterAll(async () => {
  await database?.destroy();
});
function mappingInput() {
  return {
    id: f.mappingId,
    gameId: f.gameId,
    runtimeId: 'fixture',
    nodeId: f.nodeId,
    nestId: 1,
    eggId: 1,
    dockerImage: 'fixture/image:1',
    startup: 'fixture',
    environment: {},
    portRoles: [{ role: 'game', protocols: ['tcp', 'udp'], primary: true }],
    featureLimits: { databases: 0, allocations: 3, backups: 1 },
    enabled: true,
  };
}

describe('managed registry, projects, runtime mapping and allocation ownership', () => {
  it('assigns the Owner disk default in shared storage and freezes idempotent retries', async () => {
    const input = f.input();
    const { disk: _disk, ...limits } = input.limits;
    const request = { ...input, limits };
    const result = await createManagedServer(f.db, f.adapter, f.context, request, {
      NH_DEFAULT_SERVER_STORAGE_MIB: '512',
    });
    const stored = await f.db
      .selectFrom('managed_servers')
      .select('limits')
      .where('id', '=', result.serverId)
      .executeTakeFirstOrThrow();
    expect(stored.limits.disk).toBe(512);
    expect(
      await createManagedServer(f.db, f.adapter, f.context, request, {
        NH_DEFAULT_SERVER_STORAGE_MIB: '1024',
      }),
    ).toEqual(result);
  });
  it('requires explicit disk under personal budgets and keeps global-pool admission', async () => {
    const input = f.input();
    const { disk: _disk, ...limits } = input.limits;
    await expect(
      createManagedServer(
        f.db,
        f.adapter,
        f.context,
        { ...input, limits },
        {
          NH_STORAGE_POLICY: 'PER_USER_BUDGET',
        },
      ),
    ).rejects.toThrow('validation_failed');
    await expect(
      createManagedServer(
        f.db,
        f.adapter,
        f.context,
        { ...input, limits },
        {
          NH_DEFAULT_SERVER_STORAGE_MIB: '1000000',
        },
      ),
    ).rejects.toThrow('storage_exhausted');
  });
  it('refuses lifecycle work while a persisted ambiguous upload still owns its server', async () => {
    const serverId = await f.server();
    await pendingUploadFixture(f.db, serverId);
    for (const action of ['start', 'restart', 'stop', 'backup', 'delete'] as const) {
      await expect(
        enqueueServerOperation(f.db, f.context, serverId, {
          action,
          idempotencyKey: randomUUID(),
          ...(action === 'delete' ? { confirm: true } : {}),
        }),
      ).rejects.toThrow('operation_uncertain');
    }
    const server = await f.db
      .selectFrom('managed_servers')
      .select('active_operation_id')
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect(server.active_operation_id).toBeNull();
  });
  it('deduplicates concurrent creation and rejects reusing an idempotency key for different limits', async () => {
    const input = f.input();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createManagedServer(f.db, f.adapter, f.context, input)),
    );
    expect(new Set(results.map((result) => result.serverId)).size).toBe(1);
    expect(
      await f.db
        .selectFrom('managed_servers')
        .select('id')
        .where('owner_id', '=', f.context.subjectUserId)
        .execute(),
    ).toHaveLength(1);
    await expect(
      createManagedServer(f.db, f.adapter, f.context, {
        ...input,
        limits: { ...f.limits, memory: 256 },
      }),
    ).rejects.toThrow('conflict');
  });
  it('reserves stable multiport roles and both transports while the server is offline', async () => {
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({
        port_roles: JSON.stringify([
          { role: 'game', protocols: ['tcp', 'udp'], primary: true },
          { role: 'query', protocols: ['udp'], primary: false },
          { role: 'control', protocols: ['tcp'], primary: false },
        ]),
      })
      .where('id', '=', f.mappingId)
      .execute();
    const server = await f.server();
    const rows = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', server)
      .orderBy('role')
      .execute();
    expect(rows.map((row) => [row.role, row.protocols])).toEqual([
      ['control', ['tcp']],
      ['game', ['tcp', 'udp']],
      ['query', ['udp']],
    ]);
    expect(rows.filter((row) => row.is_primary)).toHaveLength(1);
    expect(new Set(rows.map((row) => row.port)).size).toBe(3);
    const next = await createManagedServer(f.db, f.adapter, f.context, f.input());
    const others = await f.db
      .selectFrom('server_allocations')
      .select('port')
      .where('server_id', '=', next.serverId)
      .execute();
    expect(others.every((row) => rows.every((old) => old.port !== row.port))).toBe(true);
  });
  it('never selects provider-assigned allocations and reports exhaustion transactionally', async () => {
    for (const allocation of f.inventory) allocation.assigned = true;
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
    expect(
      await f.db
        .selectFrom('managed_servers')
        .select('id')
        .where('owner_id', '=', f.context.subjectUserId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await f.db
        .selectFrom('server_allocations')
        .select('id')
        .where('node_id', '=', f.nodeId)
        .execute(),
    ).toHaveLength(0);
  });
  it('rejects same-address claims across two nodes sharing a physical host', async () => {
    const second = await managementFixture(f.db);
    await f.server();
    await second.db
      .updateTable('managed_nodes')
      .set({ physical_host_id: f.hostId })
      .where('id', '=', second.nodeId)
      .execute();
    await second.db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          ...second.backendAllocationPool,
          allocations: second.backendAllocationPool.allocations.slice(0, 1),
        }),
      })
      .where('id', '=', second.nodeId)
      .execute();
    await expect(
      createManagedServer(second.db, second.adapter, second.context, second.input()),
    ).rejects.toThrow('allocation_unavailable');
  });
  it('fails closed for assigned wildcard or equivalent IPv6 collisions with the pinned pool', async () => {
    for (const [assigned, candidate] of [
      ['0.0.0.0', '10.0.0.2'],
      ['::ffff:10.0.0.2', '10.0.0.2'],
      ['::', 'fd00::2'],
      ['fd00:0000:0000:0000:0000:0000:0000:0002', 'fd00::2'],
      ['10.0.0.2', '10.0.0.2'],
    ]) {
      f.inventory.splice(
        0,
        f.inventory.length,
        { id: 1, ip: assigned ?? '', port: 20000, assigned: true },
        { id: 2, ip: candidate ?? '', port: 20000, assigned: false },
      );
      await f.db
        .updateTable('managed_nodes')
        .set({
          backend_allocation_pool: JSON.stringify({
            gatewayBindAddresses: ['192.0.2.10'],
            allocations: [{ allocationId: 2, address: candidate, port: 20000 }],
          }),
        })
        .where('id', '=', f.nodeId)
        .execute();
      await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
        'allocation_unavailable',
      );
    }
    f.inventory.push({ id: 3, ip: '10.0.0.2', port: 20001, assigned: false });
    await f.db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          gatewayBindAddresses: ['192.0.2.10'],
          allocations: [{ allocationId: 3, address: '10.0.0.2', port: 20001 }],
        }),
      })
      .where('id', '=', f.nodeId)
      .execute();
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    const selected = await f.db
      .selectFrom('server_allocations')
      .select('pterodactyl_allocation_id')
      .where('server_id', '=', created.serverId)
      .executeTakeFirstOrThrow();
    expect(selected.pterodactyl_allocation_id).toBe(3);
  });
  it('quarantines a retained installer reservation after the prior operation ends', async () => {
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    await f.db
      .updateTable('managed_servers')
      .set({
        active_operation_id: null,
        installation_state: 'installed',
        pterodactyl_id: 99,
        pterodactyl_uuid: randomUUID(),
        pterodactyl_identifier: 'fixture1',
      })
      .where('id', '=', created.serverId)
      .execute();
    await f.db
      .insertInto('installation_reservations')
      .values({
        server_id: created.serverId,
        operation_id: created.jobId,
        physical_host_id: f.hostId,
        memory_mib: 1178,
        cpu_percent: 100,
      })
      .execute();
    for (const action of [
      'start',
      'stop',
      'restart',
      'backup',
      'reinstall',
      'wipe',
      'delete',
    ] as const) {
      await expect(
        enqueueServerOperation(f.db, f.context, created.serverId, {
          action,
          idempotencyKey: randomUUID(),
          ...(['reinstall', 'wipe', 'delete'].includes(action) ? { confirm: true } : {}),
        }),
      ).rejects.toThrow('operation_uncertain');
    }
  });
  it('isolates project viewers, operators, managers and unrelated users', async () => {
    const peer = await managementFixture(f.db);
    const project = await createProject(f.db, f.context, { name: 'My project' });
    const server = await f.server({ projectId: project.id });
    await expect(authorizeServer(f.db, peer.context, server)).rejects.toThrow('forbidden');
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'viewer',
    });
    expect((await authorizeServer(f.db, peer.context, server)).id).toBe(server);
    await expect(
      enqueueServerOperation(f.db, peer.context, server, {
        action: 'start',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('forbidden');
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'operator',
    });
    await expect(authorizeServer(f.db, peer.context, server, 'server:manage')).rejects.toThrow(
      'forbidden',
    );
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'manager',
    });
    expect((await authorizeServer(f.db, peer.context, server, 'server:manage')).id).toBe(server);
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: null,
    });
    await expect(authorizeServer(f.db, peer.context, server)).rejects.toThrow('forbidden');
  });
  it('rejects assigning new servers to another user project and blocks project grants by outsiders', async () => {
    const peer = await managementFixture(f.db);
    const project = await createProject(f.db, f.context, { name: 'Private' });
    await expect(
      createManagedServer(
        peer.db,
        peer.adapter,
        peer.context,
        peer.input({ projectId: project.id }),
      ),
    ).rejects.toThrow('forbidden');
    await expect(
      setProjectMember(f.db, peer.context, project.id, {
        userId: peer.context.subjectUserId,
        role: 'manager',
      }),
    ).rejects.toThrow('forbidden');
  });
  it('filters list responses and excludes privileged provider identities', async () => {
    const own = await f.server();
    const peer = await managementFixture(f.db);
    await peer.server();
    const rows = await listServers(f.db, f.context);
    expect(rows.map((row) => row.id)).toEqual([own]);
    expect(JSON.stringify(rows)).not.toMatch(/pterodactyl_uuid|pterodactyl_id|external_id/);
    const now = new Date();
    const support: AuthContext = {
      ...f.owner,
      subjectUserId: f.context.subjectUserId,
      sessionType: 'support',
      ownerElevation: true,
      support: {
        id: 'fixture-support',
        reason: 'Requested isolated support',
        startedAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + 60000),
        revokedAt: null,
      },
    };
    expect((await listServers(f.db, support)).map((row) => row.id)).toEqual([own]);
  });
  it('does not publish lower configured resource limits before remote confirmation', async () => {
    const server = await f.server({ limits: { ...f.limits, memory: 4096, cpu: 100 } });
    const queued = await enqueueServerOperation(f.db, f.context, server, {
      action: 'configure',
      idempotencyKey: randomUUID(),
      limits: { ...f.limits, memory: 32, cpu: 1 },
    });
    const row = await f.db
      .selectFrom('managed_servers')
      .select('limits')
      .where('id', '=', server)
      .executeTakeFirstOrThrow();
    expect(row.limits.memory).toBe(4096);
    expect(row.limits.cpu).toBe(100);
    const operation = await f.db
      .selectFrom('server_operations')
      .select('plan')
      .where('job_id', '=', queued.jobId)
      .executeTakeFirstOrThrow();
    expect(operation.plan.build).toMatchObject({ memory: 32, cpu: 1 });
    expect(operation.plan.previousLimits).toMatchObject({ memory: 4096, cpu: 100 });
  });
  it('allows explicit failed-installation recovery while denying starts and destructive unconfirmed requests', async () => {
    const failed = await f.server();
    await f.db
      .updateTable('managed_servers')
      .set({ installation_state: 'failed' })
      .where('id', '=', failed)
      .execute();
    await expect(
      enqueueServerOperation(f.db, f.context, failed, {
        action: 'start',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('conflict');
    await expect(
      enqueueServerOperation(f.db, f.context, failed, {
        action: 'reinstall',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('validation_failed');
    expect(
      await enqueueServerOperation(f.db, f.context, failed, {
        action: 'reinstall',
        confirm: true,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ serverId: failed });
  });
  it('allows Owner disabling mappings and nodes while preserving live identity mappings', async () => {
    await f.server();
    await expect(setRuntimeMapping(f.db, f.adapter, f.context, mappingInput())).rejects.toThrow(
      'forbidden',
    );
    await setRuntimeMapping(f.db, f.adapter, f.owner, { ...mappingInput(), enabled: false });
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'not_found',
    );
    await expect(
      setRuntimeMapping(f.db, f.adapter, f.owner, { ...mappingInput(), startup: 'different' }),
    ).rejects.toThrow('conflict');
    await setManagedNode(f.db, f.adapter, f.owner, {
      id: f.nodeId,
      physicalHostId: f.hostId,
      pterodactylNodeId: f.providerNodeId,
      provisionUserId: 1,
      enabled: false,
    });
    await expect(
      setManagedNode(f.db, f.adapter, f.owner, {
        id: f.nodeId,
        physicalHostId: randomUUID(),
        pterodactylNodeId: f.providerNodeId,
        provisionUserId: 1,
        enabled: false,
      }),
    ).rejects.toThrow();
  });
  it('validates mapping runtime, egg image and protocol roles against the registered game contract', async () => {
    await expect(
      setRuntimeMapping(f.db, f.adapter, f.owner, { ...mappingInput(), runtimeId: 'unknown' }),
    ).rejects.toThrow('validation_failed');
    await expect(
      setRuntimeMapping(f.db, f.adapter, f.owner, {
        ...mappingInput(),
        dockerImage: 'unverified/image',
      }),
    ).rejects.toThrow('validation_failed');
    await expect(
      setRuntimeMapping(f.db, f.adapter, f.owner, {
        ...mappingInput(),
        portRoles: [{ role: 'game', protocols: ['tcp'], primary: true }],
      }),
    ).rejects.toThrow('validation_failed');
    await setRuntimeMapping(f.db, f.adapter, f.owner, mappingInput());
  });
  it('filters visibility in SQL before the result limit', async () => {
    const own = await f.server();
    const peer = await managementFixture(f.db);
    await f.db
      .insertInto('managed_servers')
      .values(
        Array.from({ length: 1001 }, () => ({
          id: randomUUID(),
          owner_id: peer.context.subjectUserId,
          project_id: null,
          mapping_id: peer.mappingId,
          node_id: peer.nodeId,
          name: 'unrelated fixture',
          external_id: randomUUID(),
          pterodactyl_id: null,
          pterodactyl_uuid: null,
          pterodactyl_identifier: null,
          limits: JSON.stringify(f.limits),
          active_operation_id: null,
          last_observed_at: null,
          deleted_at: null,
          created_at: new Date(Date.now() + 1000),
        })),
      )
      .execute();
    expect((await listServers(f.db, f.context)).map((row) => row.id)).toEqual([own]);
  });
  it('binds runtime environment variables to assigned multiport roles', async () => {
    await setRuntimeMapping(f.db, f.adapter, f.owner, {
      ...mappingInput(),
      environment: { GAME_PORT: 'stale', QUERY_PORT: 'stale' },
      portRoles: [
        {
          role: 'game',
          protocols: ['tcp', 'udp'],
          primary: true,
          environmentVariable: 'GAME_PORT',
        },
        { role: 'query', protocols: ['udp'], primary: false, environmentVariable: 'QUERY_PORT' },
      ],
    });
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    const plan = (
      await f.db
        .selectFrom('server_operations')
        .select('plan')
        .where('job_id', '=', created.jobId)
        .executeTakeFirstOrThrow()
    ).plan;
    expect(plan.provision).toMatchObject({
      environment: { GAME_PORT: '20000', QUERY_PORT: '20001' },
    });
  });
  it('rejects egg stop modes whose signals cannot prove container exit', async () => {
    const egg = await f.adapter.getEgg(1, 1);
    vi.spyOn(f.adapter, 'getEgg').mockResolvedValue({
      ...egg,
      config: { ...egg.config, stop: '^SIGTERM' },
    });
    await expect(setRuntimeMapping(f.db, f.adapter, f.owner, mappingInput())).rejects.toThrow(
      'validation_failed',
    );
    vi.mocked(f.adapter.getEgg).mockResolvedValue({ ...egg, config: { ...egg.config, stop: '' } });
    await expect(setRuntimeMapping(f.db, f.adapter, f.owner, mappingInput())).rejects.toThrow(
      'validation_failed',
    );
    vi.mocked(f.adapter.getEgg).mockResolvedValue({
      ...egg,
      config: { ...egg.config, stop: '^C' },
    });
    await expect(setRuntimeMapping(f.db, f.adapter, f.owner, mappingInput())).resolves.toEqual({
      id: f.mappingId,
    });
  });
  it('refuses queuing offline destructive operations with retained uncertain resources', async () => {
    const server = await f.server();
    await f.db
      .insertInto('resource_reservations')
      .values({
        server_id: server,
        owner_id: f.context.subjectUserId,
        physical_host_id: f.hostId,
        memory_mib: 128,
        physical_memory_mib: 148,
        cpu_percent: 10,
        operation_id: randomUUID(),
        state: 'uncertain',
      })
      .execute();
    for (const action of ['wipe', 'reinstall', 'delete', 'restore', 'configure']) {
      const input =
        action === 'configure'
          ? { action, limits: f.limits }
          : action === 'restore'
            ? { action, backupId: randomUUID(), confirm: true }
            : { action, confirm: true };
      await expect(
        enqueueServerOperation(f.db, f.context, server, { ...input, idempotencyKey: randomUUID() }),
      ).rejects.toThrow('operation_uncertain');
    }
  });
});
