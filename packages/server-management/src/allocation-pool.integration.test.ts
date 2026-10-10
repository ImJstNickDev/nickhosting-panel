import { updateSettings } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertServerBackendAllocations,
  backendAllocationPoolSchema,
  effectiveBackendAllocationPool,
} from './allocation-pool.js';
import { setManagedNode } from './configuration.js';
import { createManagedServer } from './registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  await database.db.deleteFrom('platform_settings').where('key', '=', 'platform').execute();
  f = await managementFixture(database.db);
});
afterAll(async () => {
  await database?.destroy();
});
function input(pool: unknown = f.backendAllocationPool) {
  return {
    id: f.nodeId,
    physicalHostId: f.hostId,
    pterodactylNodeId: f.providerNodeId,
    provisionUserId: 1,
    backendAllocationPool: pool,
  };
}
async function pinFirst(count = 1) {
  const pool = {
    ...f.backendAllocationPool,
    allocations: f.backendAllocationPool.allocations.slice(0, count),
  };
  await setManagedNode(f.db, f.adapter, f.owner, input(pool));
  return pool;
}
async function expectNoClaims() {
  expect(
    await f.db.selectFrom('managed_servers').select('id').where('node_id', '=', f.nodeId).execute(),
  ).toHaveLength(0);
  expect(
    await f.db
      .selectFrom('server_allocations')
      .select('id')
      .where('node_id', '=', f.nodeId)
      .execute(),
  ).toHaveLength(0);
  expect(
    await f.db
      .selectFrom('operation_jobs')
      .select('id')
      .where('actor_id', '=', f.context.actorUserId)
      .execute(),
  ).toHaveLength(0);
}

describe('explicit Owner backend allocation pools', () => {
  it('fails closed without a pool and never falls back to available public allocations', async () => {
    await f.db
      .updateTable('managed_nodes')
      .set({ backend_allocation_pool: null })
      .where('id', '=', f.nodeId)
      .execute();
    f.inventory.push({ id: 99999, ip: '203.0.113.8', port: 25565, assigned: false });
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
    expect(f.adapter.listAllocations).not.toHaveBeenCalled();
    await expectNoClaims();
  });
  it('selects only pinned IDs despite earlier public/private free allocations and holds offline ownership', async () => {
    const pool = await pinFirst(2);
    f.inventory.unshift(
      { id: 99991, ip: '203.0.113.8', port: 20000, assigned: false },
      { id: 99992, ip: '10.0.0.3', port: 21000, assigned: false },
    );
    const first = await f.server();
    const second = await f.server();
    const claims = await f.db
      .selectFrom('server_allocations')
      .select(['server_id', 'pterodactyl_allocation_id'])
      .where('node_id', '=', f.nodeId)
      .execute();
    expect(claims.map((claim) => claim.pterodactyl_allocation_id).sort()).toEqual(
      pool.allocations.map((pin) => pin.allocationId).sort(),
    );
    expect(new Set(claims.map((claim) => claim.server_id))).toEqual(new Set([first, second]));
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
  });
  it.each([
    '0.0.0.0',
    '::',
    '127.0.0.1',
    '::1',
    '8.8.8.8',
    '203.0.113.2',
    '169.254.1.2',
    '100.64.0.2',
    '2001:db8::2',
    '::ffff:10.0.0.2',
    '10.0.0.2/24',
    'backend.example.test',
    'fd00::2%eth0',
  ])(
    'rejects non-private exact backend address %s before any provider mutation',
    async (address) => {
      await expect(
        setManagedNode(
          f.db,
          f.adapter,
          f.owner,
          input({
            ...f.backendAllocationPool,
            allocations: [{ allocationId: 1, address, port: 20000 }],
          }),
        ),
      ).rejects.toThrow('validation_failed');
      await expectNoClaims();
    },
  );
  it.each(['10.0.0.2', '172.16.0.2', '172.31.255.2', '192.168.0.2', 'fd00::2', 'fc00::2'])(
    'accepts explicit private backend address %s with separate gateway binding',
    (address) => {
      expect(
        backendAllocationPoolSchema.safeParse({
          allocations: [{ allocationId: 1, address, port: 20000 }],
          gatewayBindAddresses: ['203.0.113.2'],
        }).success,
      ).toBe(true);
    },
  );
  it.each(
    [
      [],
      ['0.0.0.0'],
      ['::ffff:a00:2'],
      ['fd00::2%eth0'],
      ['::'],
      ['10.0.0.2'],
      ['203.0.113.2', '203.0.113.2'],
    ].map((gatewayBindAddresses) => ({ gatewayBindAddresses })),
  )(
    'rejects missing, wildcard, colliding or duplicate gateway bindings %j',
    async ({ gatewayBindAddresses }) => {
      await expect(
        setManagedNode(
          f.db,
          f.adapter,
          f.owner,
          input({ ...f.backendAllocationPool, gatewayBindAddresses }),
        ),
      ).rejects.toThrow('validation_failed');
    },
  );
  it('requires explicit direct delivery for public bindings and canonicalizes endpoint aliases', () => {
    const pin = {
      allocationId: 1,
      address: '203.0.113.9',
      port: 25565,
      directEndpoint: { hostname: 'GAME.Example.Test.', port: 25565 },
    };
    expect(
      backendAllocationPoolSchema.safeParse({ allocations: [pin], gatewayBindAddresses: [] })
        .success,
    ).toBe(false);
    const direct = backendAllocationPoolSchema.parse({
      allocations: [{ ...pin, delivery: 'direct' }],
      gatewayBindAddresses: [],
    });
    expect(direct.allocations[0]?.directEndpoint?.hostname).toBe('game.example.test');
    expect(
      backendAllocationPoolSchema.safeParse({
        allocations: [
          {
            ...pin,
            delivery: 'direct',
            directEndpoint: { hostname: '2001:0DB8:0000::1', port: 25565 },
          },
          {
            ...pin,
            allocationId: 2,
            port: 25566,
            delivery: 'direct',
            directEndpoint: { hostname: '2001:db8::1', port: 25565 },
          },
        ],
        gatewayBindAddresses: [],
      }).success,
    ).toBe(false);
  });
  it('cannot convert a claimed Gateway allocation to direct-only delivery', async () => {
    const pool = await pinFirst();
    await f.server();
    await expect(
      setManagedNode(
        f.db,
        f.adapter,
        f.owner,
        input({
          ...pool,
          allocations: pool.allocations.map((pin) => ({
            ...pin,
            delivery: 'direct',
            directEndpoint: { hostname: 'game.example.test', port: pin.port },
          })),
        }),
      ),
    ).rejects.toThrow('conflict');
  });
  it('preserves a frozen direct endpoint during Owner pool edits and worker revalidation', async () => {
    const pool = await pinFirst();
    const serverId = await f.server();
    const endpoint = { hostname: `${f.nodeId}.example.test`, port: 25565 };
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'direct' })
      .where('id', '=', serverId)
      .execute();
    await f.db
      .updateTable('server_allocations')
      .set({ direct_endpoint: JSON.stringify(endpoint) })
      .where('server_id', '=', serverId)
      .execute();
    const directPool = {
      ...pool,
      allocations: pool.allocations.map((pin) => ({ ...pin, directEndpoint: endpoint })),
    };
    await setManagedNode(f.db, f.adapter, f.owner, input(directPool));
    await expect(assertServerBackendAllocations(f.db, f.adapter, serverId)).resolves.toHaveLength(
      1,
    );
    await expect(setManagedNode(f.db, f.adapter, f.owner, input(pool))).rejects.toThrow('conflict');
    await expect(
      setManagedNode(
        f.db,
        f.adapter,
        f.owner,
        input({
          ...directPool,
          allocations: directPool.allocations.map((pin) => ({
            ...pin,
            directEndpoint: { ...endpoint, port: 25566 },
          })),
        }),
      ),
    ).rejects.toThrow('conflict');
  });
  it('rejects foreign node identity and missing or duplicate inventory IDs', async () => {
    const pool = await pinFirst();
    vi.mocked(f.adapter.getNode).mockResolvedValue({ id: f.providerNodeId + 1 } as Awaited<
      ReturnType<typeof f.adapter.getNode>
    >);
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
    vi.mocked(f.adapter.getNode).mockResolvedValue({ id: f.providerNodeId } as Awaited<
      ReturnType<typeof f.adapter.getNode>
    >);
    const entry = f.inventory.find(
      (allocation) => allocation.id === pool.allocations[0]?.allocationId,
    );
    if (!entry) throw new Error('fixture missing');
    f.inventory.push({ ...entry });
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
    f.inventory.splice(0, f.inventory.length);
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
    await expectNoClaims();
  });
  it.each(['ip', 'port'] as const)(
    'rejects drift in pinned %s before enqueuing or issuing a create',
    async (field) => {
      await pinFirst();
      const entry = f.inventory[0];
      if (!entry) throw new Error('fixture missing');
      if (field === 'ip') entry.ip = '10.0.0.3';
      else entry.port += 1;
      await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
        'allocation_unavailable',
      );
      await expectNoClaims();
    },
  );
  it('canonicalizes expanded uppercase provider IPv6 for durable claims, worker validation and node edits', async () => {
    const entry = f.inventory[0];
    if (!entry) throw new Error('fixture missing');
    entry.ip = 'FDAB:0000:0000:0000:0000:0000:0000:0002';
    const pool = {
      allocations: [{ allocationId: entry.id, address: 'fdab::2', port: entry.port }],
      gatewayBindAddresses: ['203.0.113.2'],
    };
    await setManagedNode(f.db, f.adapter, f.owner, input(pool));
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    const claim = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', created.serverId)
      .executeTakeFirstOrThrow();
    expect(claim.address).toBe('fdab::2');
    const verified = await assertServerBackendAllocations(f.db, f.adapter, created.serverId);
    expect(verified.map((allocation) => allocation.id)).toEqual([entry.id]);
    await expect(setManagedNode(f.db, f.adapter, f.owner, input(pool))).resolves.toEqual({
      id: f.nodeId,
    });
    entry.assigned = true;
    await expect(setManagedNode(f.db, f.adapter, f.owner, input(pool))).resolves.toEqual({
      id: f.nodeId,
    });
  });
  it('validates again after enqueue and returns only unassigned stable claims for the durable plan', async () => {
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    const claimed = await assertServerBackendAllocations(f.db, f.adapter, created.serverId);
    expect(claimed).toHaveLength(1);
    const entry = f.inventory.find((allocation) => allocation.id === claimed[0]?.id);
    if (!entry) throw new Error('fixture missing');
    entry.assigned = true;
    await expect(assertServerBackendAllocations(f.db, f.adapter, created.serverId)).rejects.toThrow(
      'allocation_unavailable',
    );
    entry.assigned = false;
    entry.port += 1;
    await expect(assertServerBackendAllocations(f.db, f.adapter, created.serverId)).rejects.toThrow(
      'allocation_unavailable',
    );
  });
  it('cannot remove owned allocations while offline, but can retain and expand the pool', async () => {
    await pinFirst(2);
    await f.server();
    await expect(setManagedNode(f.db, f.adapter, f.owner, input(null))).rejects.toThrow('conflict');
    await expect(
      setManagedNode(
        f.db,
        f.adapter,
        f.owner,
        input({
          ...f.backendAllocationPool,
          allocations: f.backendAllocationPool.allocations.slice(1, 2),
        }),
      ),
    ).rejects.toThrow('conflict');
    await expect(setManagedNode(f.db, f.adapter, f.owner, input())).resolves.toEqual({
      id: f.nodeId,
    });
  });
  it('refuses adopting assigned allocations without an existing local claim', async () => {
    if (!f.inventory[0]) throw new Error('fixture missing');
    f.inventory[0].assigned = true;
    await expect(setManagedNode(f.db, f.adapter, f.owner, input())).rejects.toThrow(
      'allocation_unavailable',
    );
  });
  it('applies locked environment overrides over DB and permits explicit null to disable provisioning', async () => {
    const pool = await pinFirst(2);
    const override = { ...pool, allocations: pool.allocations.slice(1) };
    const env = { NH_BACKEND_ALLOCATION_POOLS: JSON.stringify({ [f.nodeId]: override }) };
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input(), env);
    const claims = await f.db
      .selectFrom('server_allocations')
      .select('pterodactyl_allocation_id')
      .where('server_id', '=', created.serverId)
      .execute();
    expect(claims.map((claim) => claim.pterodactyl_allocation_id)).toEqual(
      override.allocations.map((allocation) => allocation.allocationId),
    );
    await expect(setManagedNode(f.db, f.adapter, f.owner, input(null), env)).rejects.toThrow(
      'conflict',
    );
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input(), {
        NH_BACKEND_ALLOCATION_POOLS: JSON.stringify({ [f.nodeId]: null }),
      }),
    ).rejects.toThrow('allocation_unavailable');
    expect(
      effectiveBackendAllocationPool({ id: f.nodeId, backend_allocation_pool: pool }, env),
    ).toEqual(override);
    expect(() =>
      effectiveBackendAllocationPool(
        { id: f.nodeId, backend_allocation_pool: pool },
        { NH_BACKEND_ALLOCATION_POOLS: '{}broken' },
      ),
    ).toThrow('configuration_invalid');
  });
  it('rejects backend overlap and backend/gateway inversion across nodes on the same physical host', async () => {
    const other = await managementFixture(f.db);
    await f.db
      .updateTable('managed_nodes')
      .set({ physical_host_id: f.hostId })
      .where('id', '=', other.nodeId)
      .execute();
    await expect(setManagedNode(f.db, f.adapter, f.owner, input())).rejects.toThrow(
      'allocation_unavailable',
    );
    await f.db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          allocations: [{ allocationId: 77, address: '10.0.0.3', port: 30000 }],
          gatewayBindAddresses: ['10.0.0.2'],
        }),
      })
      .where('id', '=', other.nodeId)
      .execute();
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
    await expectNoClaims();
  });
});

describe('optional server count with bounded pending provisioning', () => {
  it('allows more than twenty completed offline servers by default without active compute', async () => {
    for (let index = 0; index < 25; index++) await f.server();
    expect(
      await f.db
        .selectFrom('managed_servers')
        .select('id')
        .where('owner_id', '=', f.context.subjectUserId)
        .execute(),
    ).toHaveLength(25);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('owner_id', '=', f.context.subjectUserId)
        .execute(),
    ).toHaveLength(0);
  });
  it('retains storage admission with the count cap disabled', async () => {
    await f.db
      .updateTable('physical_hosts')
      .set({ storage_pool_mib: '384' })
      .where('id', '=', f.hostId)
      .execute();
    for (let index = 0; index < 3; index++) await f.server();
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'storage_exhausted',
    );
  });
  it('enforces an explicit DB cap and an environment numeric cap atomically', async () => {
    await updateSettings(f.db, f.owner, { maxServersPerUser: 2 });
    await f.server();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => createManagedServer(f.db, f.adapter, f.context, f.input())),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input(), { NH_MAX_SERVERS_PER_USER: '3' }),
    ).resolves.toHaveProperty('serverId');
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input(), { NH_MAX_SERVERS_PER_USER: '3' }),
    ).rejects.toThrow('resources_unavailable');
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input(), {
        NH_MAX_SERVERS_PER_USER: 'null',
      }),
    ).resolves.toHaveProperty('serverId');
  });
  it('limits concurrent pending provisioning, including retained installer quarantine, without capping offline totals', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createManagedServer(f.db, f.adapter, f.context, f.input())),
    );
    const created = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(created).toHaveLength(4);
    const first = created[0];
    if (!first) throw new Error('fixture missing');
    await f.db
      .insertInto('installation_reservations')
      .values({
        server_id: first.serverId,
        physical_host_id: f.hostId,
        operation_id: first.jobId,
        memory_mib: 1178,
        cpu_percent: 100,
      })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', first.serverId)
      .execute();
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'resources_unavailable',
    );
    await f.db
      .deleteFrom('installation_reservations')
      .where('server_id', '=', first.serverId)
      .execute();
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input()),
    ).resolves.toHaveProperty('serverId');
  });
  it('allows an Owner-controlled independent provisioning concurrency override', async () => {
    await updateSettings(f.db, f.owner, { maxConcurrentProvisionsPerUser: 1 });
    await createManagedServer(f.db, f.adapter, f.context, f.input());
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'resources_unavailable',
    );
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input(), {
        NH_MAX_CONCURRENT_PROVISIONS_PER_USER: '2',
      }),
    ).resolves.toHaveProperty('serverId');
  });
});
