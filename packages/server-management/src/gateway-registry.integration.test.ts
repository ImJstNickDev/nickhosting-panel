import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lockResources } from './admission.js';
import {
  getGatewayState,
  reconcileGatewayState,
  requestGatewayWake,
  setGatewayPolicy,
} from './gateway-orchestration.js';
import { getGatewaySnapshot, requireGatewayRoute, setGatewayRoute } from './gateway-registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>,
  f: Awaited<ReturnType<typeof managementFixture>>,
  serverId: string,
  allocationId: string;
let env: Record<string, string>;
const policy = {
  enabled: true,
  protocolId: 'fixture',
  gameVersion: '1',
  idleTimeoutSeconds: 10,
  readinessTimeoutSeconds: 60,
  readinessMaxAgeSeconds: 15,
  estimateMaxAgeSeconds: 86400,
  wakeRetrySeconds: 10,
};
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  serverId = await f.server();
  allocationId = (
    await f.db
      .selectFrom('server_allocations')
      .select('id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow()
  ).id;
  env = {
    NH_GATEWAY_ENABLED: 'true',
    NH_GATEWAY_ID: randomUUID(),
    NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
  };
  await setGatewayPolicy(f.db, f.context, serverId, policy);
});
afterAll(async () => {
  await database?.destroy();
});
const input = () => ({
  serverId,
  allocationId,
  publicAddress: f.backendAllocationPool.gatewayBindAddresses[0],
  publicPort: 26000,
  transport: 'tcp' as const,
});
describe('durable explicit Gateway route registry', () => {
  const directPin = (port: number) => ({
    allocationId: 987654,
    address: input().publicAddress,
    port,
    delivery: 'direct',
    directEndpoint: { hostname: 'direct.example.test', port },
  });
  async function withDirectPin(port: number) {
    await f.db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          ...f.backendAllocationPool,
          allocations: [...f.backendAllocationPool.allocations, directPin(port)],
        }),
      })
      .where('id', '=', f.nodeId)
      .execute();
  }
  it('allows direct and Gateway on one IP at different ports, including same-number backend ports', async () => {
    await withDirectPin(27000);
    const row = await setGatewayRoute(f.db, f.owner, { ...input(), publicPort: 20000 }, env);
    const snapshot = await getGatewaySnapshot(f.db, env);
    expect(snapshot.routes[0]).toMatchObject({ id: row.id, backend: { port: 20000 } });
  });
  it.each(['tcp', 'udp'] as const)(
    'rejects configured direct pin collision on %s',
    async (transport) => {
      await withDirectPin(input().publicPort);
      await expect(setGatewayRoute(f.db, f.owner, { ...input(), transport }, env)).rejects.toThrow(
        'allocation_unavailable',
      );
    },
  );
  it('includes environment-overridden pools when reserving public listeners', async () => {
    const overrides = {
      [f.nodeId]: {
        ...f.backendAllocationPool,
        allocations: [...f.backendAllocationPool.allocations, directPin(input().publicPort)],
      },
    };
    await expect(
      setGatewayRoute(f.db, f.owner, input(), {
        ...env,
        NH_BACKEND_ALLOCATION_POOLS: JSON.stringify(overrides),
      }),
    ).rejects.toThrow('allocation_unavailable');
  });
  it('permits revoking an existing route after an environment pool override introduces a collision', async () => {
    const route = await setGatewayRoute(f.db, f.owner, input(), env);
    const changedEnv = {
      ...env,
      NH_BACKEND_ALLOCATION_POOLS: JSON.stringify({
        [f.nodeId]: {
          ...f.backendAllocationPool,
          allocations: [...f.backendAllocationPool.allocations, directPin(input().publicPort)],
        },
      }),
    };
    await expect(
      setGatewayRoute(f.db, f.owner, { ...input(), id: route.id, enabled: false }, changedEnv),
    ).resolves.toEqual(route);
    expect((await getGatewaySnapshot(f.db, changedEnv)).routes).toEqual([]);
    await expect(
      setGatewayRoute(f.db, f.owner, { ...input(), id: route.id }, changedEnv),
    ).rejects.toThrow('allocation_unavailable');
  });
  it.each(['192.0.2.10', '0.0.0.0', '::', '::ffff:c000:20a'])(
    'retains collision protection for disabled-node claims removed from editable pools (%s)',
    async (address) => {
      const other = await managementFixture(f.db);
      const directId = await other.server();
      await f.db
        .updateTable('managed_servers')
        .set({ connection_mode: 'direct' })
        .where('id', '=', directId)
        .execute();
      await f.db
        .updateTable('managed_nodes')
        .set({ physical_host_id: f.hostId, enabled: false, backend_allocation_pool: null })
        .where('id', '=', other.nodeId)
        .execute();
      await f.db
        .insertInto('server_allocations')
        .values({
          id: randomUUID(),
          server_id: directId,
          node_id: other.nodeId,
          pterodactyl_allocation_id: 987655,
          address,
          backend_address: address,
          port: input().publicPort,
          role: 'retained-direct',
          protocols: ['tcp'],
          is_primary: false,
        })
        .execute();
      await expect(setGatewayRoute(f.db, f.owner, input(), env)).rejects.toThrow(
        'allocation_unavailable',
      );
    },
  );
  it('reserves disabled routes across Gateway identities on the same host', async () => {
    await setGatewayRoute(f.db, f.owner, { ...input(), enabled: false }, env);
    await expect(
      setGatewayRoute(f.db, f.owner, input(), { ...env, NH_GATEWAY_ID: randomUUID() }),
    ).rejects.toThrow('allocation_unavailable');
  });
  it('refuses direct servers in route, policy, wake, reconciliation and snapshot paths', async () => {
    await setGatewayRoute(f.db, f.owner, input(), env);
    const state = await getGatewayState(f.db, serverId);
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'direct' })
      .where('id', '=', serverId)
      .execute();
    await expect(setGatewayPolicy(f.db, f.context, serverId, policy)).rejects.toThrow(
      'integration_unavailable',
    );
    await expect(setGatewayRoute(f.db, f.owner, input(), env)).rejects.toThrow(
      'integration_unavailable',
    );
    await expect(
      requestGatewayWake(f.db, serverId, { generation: state.generation, intent: 'join' }),
    ).rejects.toThrow('integration_unavailable');
    await expect(reconcileGatewayState(f.db, serverId)).rejects.toThrow('integration_unavailable');
    expect((await getGatewaySnapshot(f.db, env)).routes).toEqual([]);
  });
  it('registers only an Owner-selected managed claim and returns immutable raw/effective endpoints', async () => {
    const row = await setGatewayRoute(f.db, f.owner, input(), env),
      first = await getGatewaySnapshot(f.db, env),
      second = await getGatewaySnapshot(f.db, env);
    expect(first.routes).toHaveLength(1);
    expect(first.routes[0]).toMatchObject({
      id: row.id,
      serverId,
      allocationId,
      mode: 'sleeping',
      backend: { address: '10.0.0.2', allocationAddress: '10.0.0.2', port: 20000 },
    });
    expect(second.revision).toBe(first.revision);
    expect(second.routes).toEqual(first.routes);
    const stored = await f.db
      .selectFrom('gateway_routes')
      .select('lease_expires_at')
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(stored.lease_expires_at?.getTime()).toBeGreaterThanOrEqual(Date.parse(second.expiresAt));
  });
  it('rejects ordinary users, foreign claims, wrong hosts and unconfigured public endpoints', async () => {
    await expect(setGatewayRoute(f.db, f.context, input(), env)).rejects.toThrow('forbidden');
    await expect(
      setGatewayRoute(f.db, f.owner, { ...input(), allocationId: randomUUID() }, env),
    ).rejects.toThrow('allocation_unavailable');
    await expect(
      setGatewayRoute(f.db, f.owner, input(), {
        ...env,
        NH_GATEWAY_PHYSICAL_HOST_ID: randomUUID(),
      }),
    ).rejects.toThrow('allocation_unavailable');
    await expect(
      setGatewayRoute(f.db, f.owner, { ...input(), publicAddress: '203.0.113.77' }, env),
    ).rejects.toThrow('allocation_unavailable');
    await expect(
      setGatewayRoute(f.db, f.owner, { ...input(), serverId: randomUUID() }, env),
    ).rejects.toThrow('not_found');
  });
  it.each(['0.0.0.0', '::', '::ffff:192.0.2.1', 'hostname.example.test'])(
    'rejects unsafe listener address %s',
    async (publicAddress) => {
      await expect(
        setGatewayRoute(f.db, f.owner, { ...input(), publicAddress }, env),
      ).rejects.toThrow('validation_failed');
    },
  );
  it('changes persistent snapshot and route revisions when consent or mode changes', async () => {
    const row = await setGatewayRoute(f.db, f.owner, input(), env),
      first = await getGatewaySnapshot(f.db, env);
    await setGatewayPolicy(f.db, f.context, serverId, { ...policy, mode: 'manually_stopped' });
    const next = await getGatewaySnapshot(f.db, env);
    expect(next.revision).toBeGreaterThan(first.revision);
    expect(next.routes[0]?.revision).toBeGreaterThan(first.routes[0]?.revision ?? 0);
    expect(next.routes[0]?.mode).toBe('manually_stopped');
    await expect(requireGatewayRoute(f.db, row.id, first.routes[0]?.revision, env)).rejects.toThrow(
      'conflict',
    );
  });
  it('never renews disabled routes and does not import unrelated provider IDs', async () => {
    const row = await setGatewayRoute(f.db, f.owner, input(), env);
    await getGatewaySnapshot(f.db, env);
    const before = await f.db
      .selectFrom('gateway_routes')
      .select('lease_expires_at')
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    await setGatewayRoute(f.db, f.owner, { ...input(), id: row.id, enabled: false }, env);
    expect((await getGatewaySnapshot(f.db, env)).routes).toEqual([]);
    const after = await f.db
      .selectFrom('gateway_routes')
      .select('lease_expires_at')
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    await expect(requireGatewayRoute(f.db, randomUUID(), undefined, env)).rejects.toThrow(
      'not_found',
    );
  });
  it('serializes concurrent snapshots without regressing or spuriously changing revisions', async () => {
    await setGatewayRoute(f.db, f.owner, input(), env);
    const values = await Promise.all(
      Array.from({ length: 20 }, () => getGatewaySnapshot(f.db, env)),
    );
    expect(new Set(values.map((v) => v.revision)).size).toBe(1);
  });
  it('refuses route retarget and active-operation changes', async () => {
    const row = await setGatewayRoute(f.db, f.owner, input(), env);
    await expect(
      setGatewayRoute(f.db, f.owner, { ...input(), id: row.id, publicPort: 27000 }, env),
    ).rejects.toThrow('conflict');
    const job = await f.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: job.job_id })
      .where('id', '=', serverId)
      .execute();
    await expect(setGatewayRoute(f.db, f.owner, { ...input(), id: row.id }, env)).rejects.toThrow(
      'conflict',
    );
  });
  it('withdraws deleted or disabled node routes without changing unrelated registry entries', async () => {
    await setGatewayRoute(f.db, f.owner, input(), env);
    await getGatewaySnapshot(f.db, env);
    await f.db
      .updateTable('managed_nodes')
      .set({ enabled: false })
      .where('id', '=', f.nodeId)
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes).toEqual([]);
    expect(
      await f.db
        .selectFrom('gateway_routes')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
  });
});

describe('route authorization after resource-lock waits', () => {
  it.each(['logout', 'demotion'] as const)(
    'rejects %s while queued for the lock',
    async (action) => {
      let release!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = f.db.transaction().execute(async (tx) => {
        await lockResources(tx);
        acquired();
        await released;
      });
      await held;
      const pending = setGatewayRoute(f.db, f.owner, input(), env).then(
        () => 'unexpected success',
        (error: Error) => error.message,
      );
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await sql<{ waiting: boolean }>`select exists(
          select 1 from pg_stat_activity where datname = current_database()
          and cardinality(pg_blocking_pids(pid)) > 0
        ) as waiting`.execute(f.db);
          if (result.rows[0]?.waiting) {
            waiting = true;
            break;
          }
          await delay(10);
        }
        expect(waiting).toBe(true);
        if (action === 'logout')
          await f.db
            .deleteFrom('session')
            .where('id', '=', f.owner[authSessionId] ?? 'missing-fixture-session')
            .execute();
        else
          await f.db
            .updateTable('user')
            .set({ role: 'user' })
            .where('id', '=', f.owner.actorUserId)
            .execute();
      } finally {
        release();
        await blocker;
      }
      expect(await pending).toBe(action === 'logout' ? 'unauthenticated' : 'forbidden');
      expect(
        await f.db
          .selectFrom('gateway_routes')
          .selectAll()
          .where('server_id', '=', serverId)
          .execute(),
      ).toEqual([]);
      // The shared isolated Owner is restored only for later fixture setup.
      await f.db
        .updateTable('user')
        .set({ role: 'owner' })
        .where('id', '=', f.owner.actorUserId)
        .execute();
    },
  );
});
