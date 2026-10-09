import { readFile } from 'node:fs/promises';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertServerBackendAllocations,
  type BackendAllocationPool,
  backendAllocationPoolSchema,
  validatedBackendInventory,
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
  f = await managementFixture(database.db);
});
afterAll(async () => {
  await database?.destroy();
});
const remap = {
  wingsVersion: '1.11.13' as const,
  networkMode: 'fixture-private-games',
  networkDriver: 'bridge' as const,
  gatewayMode: 'nat' as const,
  interfaceAddress: '10.0.0.5',
  ispn: false as const,
  verifiedEggs: [{ nestId: 1, eggId: 1, forceOutgoingIp: false as const }],
};
function pool(): BackendAllocationPool {
  const entry = f.inventory[0];
  if (!entry) throw new Error('fixture missing');
  return {
    allocations: [
      {
        allocationId: entry.id,
        address: '127.0.0.1',
        backendAddress: remap.interfaceAddress,
        port: entry.port,
      },
    ],
    gatewayBindAddresses: ['192.0.2.10'],
    loopbackRemap: structuredClone(remap),
  };
}
function nodeInput(value: BackendAllocationPool) {
  return {
    id: f.nodeId,
    physicalHostId: f.hostId,
    pterodactylNodeId: f.providerNodeId,
    provisionUserId: 1,
    backendAllocationPool: value,
  };
}
async function configure(value = pool()) {
  const entry = f.inventory[0];
  if (!entry) throw new Error('fixture missing');
  entry.ip = '127.0.0.1';
  await setManagedNode(f.db, f.adapter, f.owner, nodeInput(value));
  return value;
}
async function rawPool(value: BackendAllocationPool | null) {
  await f.db
    .updateTable('managed_nodes')
    .set({ backend_allocation_pool: value ? JSON.stringify(value) : null })
    .where('id', '=', f.nodeId)
    .execute();
}
async function noClaims() {
  expect(
    await f.db.selectFrom('managed_servers').select('id').where('node_id', '=', f.nodeId).execute(),
  ).toHaveLength(0);
}

describe('explicit verified Wings loopback remapping', () => {
  it('persists raw provider identity separately from effective bind and revalidates both before create', async () => {
    const configured = await configure();
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    const claim = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', created.serverId)
      .executeTakeFirstOrThrow();
    expect(claim).toMatchObject({ address: '127.0.0.1', backend_address: '10.0.0.5', port: 20000 });
    expect(await assertServerBackendAllocations(f.db, f.adapter, created.serverId)).toEqual([
      expect.objectContaining({ ip: '127.0.0.1', backendAddress: '10.0.0.5', port: 20000 }),
    ]);
    await expect(setManagedNode(f.db, f.adapter, f.owner, nodeInput(configured))).resolves.toEqual({
      id: f.nodeId,
    });
  });
  it('keeps old direct private configuration compatible and rejects arbitrary rewrites', async () => {
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    const claim = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', created.serverId)
      .executeTakeFirstOrThrow();
    expect(claim.backend_address).toBe(claim.address);
    const configured = f.backendAllocationPool;
    expect(
      backendAllocationPoolSchema.safeParse({
        ...configured,
        allocations: configured.allocations.map((pin) => ({ ...pin, backendAddress: pin.address })),
      }).success,
    ).toBe(true);
    expect(
      backendAllocationPoolSchema.safeParse({
        ...configured,
        allocations: configured.allocations.map((pin) => ({ ...pin, backendAddress: '10.0.0.9' })),
      }).success,
    ).toBe(false);
  });
  it.each(['127.0.0.2', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost'])(
    'rejects unsupported loopback provider identity %s',
    (address) => {
      const configured = pool();
      expect(
        backendAllocationPoolSchema.safeParse({
          ...configured,
          allocations: configured.allocations.map((pin) => ({ ...pin, address })),
        }).success,
      ).toBe(false);
    },
  );
  it('requires explicit matching effective bind and an attested remap for exact loopback', () => {
    const configured = pool();
    expect(
      backendAllocationPoolSchema.safeParse({ ...configured, loopbackRemap: undefined }).success,
    ).toBe(false);
    for (const backendAddress of [undefined, '10.0.0.9', '127.0.0.1', '203.0.113.3', 'fd00::5'])
      expect(
        backendAllocationPoolSchema.safeParse({
          ...configured,
          allocations: configured.allocations.map((pin) => ({ ...pin, backendAddress })),
        }).success,
      ).toBe(false);
    expect(
      backendAllocationPoolSchema.safeParse({
        ...configured,
        gatewayBindAddresses: [remap.interfaceAddress],
      }).success,
    ).toBe(false);
  });
  it.each([
    { wingsVersion: '1.11.12' },
    { networkMode: 'host' },
    { networkMode: 'none' },
    { networkMode: 'container:fixture' },
    { networkMode: 'service:fixture' },
    { networkMode: 'invalid network' },
    { networkMode: '' },
    { networkDriver: 'overlay' },
    { gatewayMode: 'routed' },
    { gatewayMode: 'nat-unprotected' },
    { gatewayMode: undefined },
    { ispn: true },
    { interfaceAddress: '127.0.0.1' },
    { interfaceAddress: 'fd00::5' },
    { verifiedEggs: [] },
    { verifiedEggs: [{ nestId: 1, eggId: 1, forceOutgoingIp: true }] },
    { verifiedEggs: [{ nestId: 1, eggId: 1 }] },
    {
      verifiedEggs: [
        { nestId: 1, eggId: 1, forceOutgoingIp: false },
        { nestId: 1, eggId: 1, forceOutgoingIp: false },
      ],
    },
  ])('rejects unsupported or incomplete declaration %j', (patch) => {
    const configured = pool();
    expect(
      backendAllocationPoolSchema.safeParse({
        ...configured,
        loopbackRemap: { ...remap, ...patch },
      }).success,
    ).toBe(false);
  });
  it('refuses unattested eggs at enqueue and after mapping drift before remote create', async () => {
    const configured = await configure();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ egg_id: 2 })
      .where('id', '=', f.mappingId)
      .execute();
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
    await noClaims();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ egg_id: 1 })
      .where('id', '=', f.mappingId)
      .execute();
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ egg_id: 2 })
      .where('id', '=', f.mappingId)
      .execute();
    await expect(assertServerBackendAllocations(f.db, f.adapter, created.serverId)).rejects.toThrow(
      'allocation_unavailable',
    );
    const env = {
      NH_BACKEND_ALLOCATION_POOLS: JSON.stringify({
        [f.nodeId]: {
          ...configured,
          loopbackRemap: {
            ...remap,
            verifiedEggs: [{ nestId: 2, eggId: 2, forceOutgoingIp: false }],
          },
        },
      }),
    };
    await expect(
      assertServerBackendAllocations(f.db, f.adapter, created.serverId, env),
    ).rejects.toThrow('allocation_unavailable');
  });
  it('can select an eligible direct pin in a mixed pool when loopback egg is unattested', async () => {
    const direct = f.backendAllocationPool.allocations[1];
    if (!direct) throw new Error('fixture missing');
    const configured = {
      ...pool(),
      allocations: [...pool().allocations, direct],
      loopbackRemap: {
        ...remap,
        verifiedEggs: [{ nestId: 1, eggId: 2, forceOutgoingIp: false as const }],
      },
    };
    await configure(configured);
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    const claims = await assertServerBackendAllocations(f.db, f.adapter, created.serverId);
    expect(claims.map((claim) => claim.id)).toEqual([direct.allocationId]);
  });
  it('rejects duplicate loopback and direct aliases of the same effective address/port', () => {
    const configured = pool();
    expect(
      backendAllocationPoolSchema.safeParse({
        ...configured,
        allocations: [
          ...configured.allocations,
          { allocationId: 999, address: remap.interfaceAddress, port: 20000 },
        ],
      }).success,
    ).toBe(false);
  });
  it.each(['10.0.0.5', '0.0.0.0', '::', '::ffff:10.0.0.5'])(
    'rejects assigned direct/wildcard %s colliding with selected loopback effective bind',
    async (ip) => {
      await configure();
      f.inventory.push({ id: 90001, ip, port: 20000, assigned: true });
      await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
        'allocation_unavailable',
      );
      await noClaims();
    },
  );
  it('maps assigned unpinned loopback for collision checks using explicit node declaration', async () => {
    const direct = f.inventory[0];
    if (!direct) throw new Error('fixture missing');
    direct.ip = remap.interfaceAddress;
    const configured = {
      ...pool(),
      allocations: [
        { allocationId: direct.id, address: remap.interfaceAddress, port: direct.port },
      ],
    };
    await rawPool(configured);
    f.inventory.push({ id: 90001, ip: '127.0.0.1', port: direct.port, assigned: true });
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
    const configuredPin = configured.allocations[0];
    if (!configuredPin) throw new Error('fixture missing');
    configuredPin.address = '10.0.0.6';
    direct.ip = '10.0.0.6';
    await rawPool(configured);
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input()),
    ).resolves.toHaveProperty('serverId');
  });
  it('blocks unknown assigned loopback semantics at the same port but leaves distinct ports usable', async () => {
    const first = f.inventory[0];
    if (!first) throw new Error('fixture missing');
    await rawPool({
      ...f.backendAllocationPool,
      allocations: f.backendAllocationPool.allocations.slice(0, 1),
    });
    f.inventory.push({ id: 90001, ip: '127.0.0.1', port: first.port, assigned: true });
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
    const assigned = f.inventory[f.inventory.length - 1];
    if (!assigned) throw new Error('fixture missing');
    assigned.port = first.port + 1;
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input()),
    ).resolves.toHaveProperty('serverId');
  });
  it('preserves immutable effective claims against Owner/environment retargeting even after pool removal', async () => {
    const configured = await configure();
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input());
    const changed = {
      ...configured,
      allocations: configured.allocations.map((pin) => ({ ...pin, backendAddress: '10.0.0.9' })),
      loopbackRemap: { ...remap, interfaceAddress: '10.0.0.9' },
    };
    await expect(setManagedNode(f.db, f.adapter, f.owner, nodeInput(changed))).rejects.toThrow(
      'conflict',
    );
    const env = { NH_BACKEND_ALLOCATION_POOLS: JSON.stringify({ [f.nodeId]: changed }) };
    await expect(
      assertServerBackendAllocations(f.db, f.adapter, created.serverId, env),
    ).rejects.toThrow('allocation_unavailable');
    await rawPool(null);
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input(), env)).rejects.toThrow(
      'allocation_unavailable',
    );
    await expect(
      f.db
        .updateTable('server_allocations')
        .set({ backend_address: '10.0.0.9' })
        .where('server_id', '=', created.serverId)
        .execute(),
    ).rejects.toThrow('allocation identity is immutable');
    const next = f.inventory[1];
    if (!next) throw new Error('fixture missing');
    next.ip = '127.0.0.1';
    const differentPin = {
      ...changed,
      allocations: [
        {
          allocationId: next.id,
          address: '127.0.0.1',
          backendAddress: '10.0.0.9',
          port: next.port,
        },
      ],
    };
    await expect(
      createManagedServer(f.db, f.adapter, f.context, f.input(), {
        NH_BACKEND_ALLOCATION_POOLS: JSON.stringify({ [f.nodeId]: differentPin }),
      }),
    ).rejects.toThrow('allocation_unavailable');
  });
  it('reserves stable multiport loopback roles with both transports using effective binds', async () => {
    const second = f.inventory[1];
    if (!second) throw new Error('fixture missing');
    second.ip = '127.0.0.1';
    const configured = pool();
    configured.allocations.push({
      allocationId: second.id,
      address: second.ip,
      backendAddress: remap.interfaceAddress,
      port: second.port,
    });
    await configure(configured);
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({
        port_roles: JSON.stringify([
          { role: 'game', protocols: ['tcp', 'udp'], primary: true },
          { role: 'query', protocols: ['udp'], primary: false },
        ]),
      })
      .where('id', '=', f.mappingId)
      .execute();
    const server = await f.server();
    const claims = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', server)
      .orderBy('port')
      .execute();
    expect(
      claims.map((claim) => [
        claim.address,
        claim.backend_address,
        claim.port,
        claim.role,
        claim.protocols,
      ]),
    ).toEqual([
      ['127.0.0.1', remap.interfaceAddress, 20000, 'game', ['tcp', 'udp']],
      ['127.0.0.1', remap.interfaceAddress, 20001, 'query', ['udp']],
    ]);
    await expect(createManagedServer(f.db, f.adapter, f.context, f.input())).rejects.toThrow(
      'allocation_unavailable',
    );
  });
  it('rejects colliding sibling configured pools before either has claims', async () => {
    await configure();
    const peer = await managementFixture(f.db);
    const first = peer.inventory[0];
    if (!first) throw new Error('fixture missing');
    first.ip = remap.interfaceAddress;
    const peerPool = {
      ...peer.backendAllocationPool,
      allocations: [{ allocationId: first.id, address: first.ip, port: first.port }],
    };
    await f.db
      .updateTable('managed_nodes')
      .set({ physical_host_id: f.hostId, backend_allocation_pool: JSON.stringify(peerPool) })
      .where('id', '=', peer.nodeId)
      .execute();
    await expect(
      createManagedServer(peer.db, peer.adapter, peer.context, peer.input()),
    ).rejects.toThrow('allocation_unavailable');
    await f.db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          ...peerPool,
          allocations: [{ allocationId: first.id, address: '10.0.0.6', port: first.port }],
          gatewayBindAddresses: [remap.interfaceAddress],
        }),
      })
      .where('id', '=', peer.nodeId)
      .execute();
    first.ip = '10.0.0.6';
    await expect(
      createManagedServer(peer.db, peer.adapter, peer.context, peer.input()),
    ).rejects.toThrow('allocation_unavailable');
    await noClaims();
  });
  it('checks sibling effective pools and retained claims when old pool is disabled', async () => {
    await configure();
    await f.server();
    const peer = await managementFixture(f.db);
    const first = peer.inventory[0];
    if (!first) throw new Error('fixture missing');
    first.ip = remap.interfaceAddress;
    const peerPool = {
      ...peer.backendAllocationPool,
      allocations: [{ allocationId: first.id, address: first.ip, port: first.port }],
    };
    await f.db
      .updateTable('managed_nodes')
      .set({ physical_host_id: f.hostId, backend_allocation_pool: JSON.stringify(peerPool) })
      .where('id', '=', peer.nodeId)
      .execute();
    await expect(
      createManagedServer(peer.db, peer.adapter, peer.context, peer.input()),
    ).rejects.toThrow('allocation_unavailable');
    await rawPool(null);
    await expect(
      createManagedServer(peer.db, peer.adapter, peer.context, peer.input()),
    ).rejects.toThrow('allocation_unavailable');
    await f.db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          ...peerPool,
          allocations: [{ allocationId: first.id, address: '10.0.0.6', port: first.port }],
          gatewayBindAddresses: [remap.interfaceAddress],
        }),
      })
      .where('id', '=', peer.nodeId)
      .execute();
    first.ip = '10.0.0.6';
    await expect(
      createManagedServer(peer.db, peer.adapter, peer.context, peer.input()),
    ).rejects.toThrow('allocation_unavailable');
  });
  it('detects provider raw-IP drift despite matching effective address', async () => {
    await configure();
    const first = f.inventory[0];
    if (!first) throw new Error('fixture missing');
    first.ip = remap.interfaceAddress;
    const node = await f.db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', f.nodeId)
      .executeTakeFirstOrThrow();
    await expect(validatedBackendInventory(f.adapter, node)).rejects.toThrow(
      'allocation_unavailable',
    );
  });
  it('backfills direct existing claims without creating accounts or instance settings', async () => {
    const isolated = await createTestDatabase();
    try {
      const fixture = await managementFixture(isolated.db);
      const created = await fixture.server();
      const before = await isolated.db
        .selectFrom('server_allocations')
        .selectAll()
        .where('server_id', '=', created)
        .executeTakeFirstOrThrow();
      await isolated.pool.query(
        'DROP TRIGGER immutable_allocation_identity ON server_allocations; DROP FUNCTION prevent_allocation_identity_retarget(); ALTER TABLE server_allocations DROP COLUMN backend_address',
      );
      const migration = await readFile(
        new URL('../../database/migrations/009_allocation_backend_address.sql', import.meta.url),
        'utf8',
      );
      await isolated.pool.query(migration);
      const after = await isolated.db
        .selectFrom('server_allocations')
        .selectAll()
        .where('id', '=', before.id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual(before);
      expect(after.backend_address).toBe(after.address);
      expect(await isolated.db.selectFrom('platform_settings').selectAll().execute()).toHaveLength(
        0,
      );
    } finally {
      await isolated.destroy();
    }
  });
});
