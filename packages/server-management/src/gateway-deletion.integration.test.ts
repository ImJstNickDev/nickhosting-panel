import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { type PterodactylAdapter, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lockResources } from './admission.js';
import { setGatewayPolicy } from './gateway-orchestration.js';
import { getGatewaySnapshot, setGatewayRoute } from './gateway-registry.js';
import { processServerOperation } from './lifecycle.js';
import { enqueueServerOperation } from './registry.js';
import { authorizeQueuedEffect } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
async function fixture() {
  const f = await managementFixture(database.db, { interactive: true }),
    serverId = await f.server();
  const server = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  const claims = await f.db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .execute();
  const claim = claims[0];
  if (!claim) throw new Error('missing fixture allocation');
  const env = {
    NH_GATEWAY_ENABLED: 'true',
    NH_GATEWAY_ID: randomUUID(),
    NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
  };
  await setGatewayPolicy(f.db, f.context, serverId, {
    enabled: true,
    protocolId: 'fixture',
    gameVersion: '1',
    idleTimeoutSeconds: null,
    readinessTimeoutSeconds: 60,
    readinessMaxAgeSeconds: 15,
    estimateMaxAgeSeconds: 86400,
    wakeRetrySeconds: 10,
  });
  const input = {
    serverId,
    allocationId: claim.id,
    publicAddress: '192.0.2.10',
    publicPort: claim.port,
    transport: 'tcp',
  };
  const route = await setGatewayRoute(f.db, f.owner, input, env);
  await f.db
    .insertInto('gateway_reachability_proofs')
    .values({ route_id: route.id, proof: '{}' })
    .execute();
  let exists = true,
    now = new Date();
  const getServer = vi.fn(async () => {
    if (!exists) throw new PterodactylError('not_found', 'application', 'rejected', 404);
    return {
      id: server.pterodactyl_id,
      uuid: server.pterodactyl_uuid,
      external_id: server.external_id,
      identifier: server.pterodactyl_identifier,
      node: f.providerNodeId,
      user: 1,
      allocation: claim.pterodactyl_allocation_id,
      relationships: {
        allocations: {
          data: claims.map((row) => ({
            attributes: {
              id: row.pterodactyl_allocation_id,
              ip: row.address,
              port: row.port,
              assigned: true,
            },
          })),
        },
      },
    };
  });
  const remove = vi.fn(async () => {
    exists = false;
  });
  const adapter = {
    getApplicationServer: getServer,
    deleteServer: remove,
    getResources: async () => ({
      current_state: 'offline',
      resources: {
        memory_bytes: 0,
        cpu_absolute: 0,
        disk_bytes: 0,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
      },
    }),
  } as unknown as PterodactylAdapter;
  const process = async (jobId: string) => {
    await f.db
      .updateTable('operation_jobs')
      .set({ next_attempt_at: new Date(0) })
      .where('id', '=', jobId)
      .execute();
    return processServerOperation(f.db, jobId, {
      adapter,
      now: () => now,
      settleMs: 0,
      authorizeEffect: async (id, target, db) => {
        await authorizeQueuedEffect(db, id, target);
      },
    });
  };
  return {
    ...f,
    serverId,
    route,
    input,
    env,
    process,
    remove,
    getServer,
    setNow(value: Date) {
      now = value;
    },
    setAbsent() {
      exists = false;
    },
  };
}

describe('Gateway lease fence before M2 provider deletion and allocation reuse', () => {
  it('revokes at enqueue, waits without locks, cannot renew, then deletes only after expiry', async () => {
    const f = await fixture();
    const first = await getGatewaySnapshot(f.db, f.env);
    expect(first.routes).toHaveLength(1);
    const lease = await f.db
      .selectFrom('gateway_routes')
      .select('lease_expires_at')
      .where('id', '=', f.route.id)
      .executeTakeFirstOrThrow();
    expect(lease.lease_expires_at?.getTime()).toBe(new Date(first.expiresAt).getTime() + 1000);
    const operation = await enqueueServerOperation(f.db, f.context, f.serverId, {
      action: 'delete',
      idempotencyKey: randomUUID(),
      confirm: true,
    });
    expect(await f.process(operation.jobId)).toBe('waiting');
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.getServer).not.toHaveBeenCalled();
    await f.db.transaction().execute((tx) => lockResources(tx));
    expect((await getGatewaySnapshot(f.db, f.env)).routes).toHaveLength(0);
    expect(
      (
        await f.db
          .selectFrom('gateway_routes')
          .select('lease_expires_at')
          .where('id', '=', f.route.id)
          .executeTakeFirstOrThrow()
      ).lease_expires_at,
    ).toEqual(lease.lease_expires_at);
    await expect(
      setGatewayRoute(f.db, f.owner, { ...f.input, id: f.route.id, enabled: true }, f.env),
    ).rejects.toThrow('conflict');
    f.setNow(lease.lease_expires_at ?? new Date());
    expect(await f.process(operation.jobId)).toBe('waiting');
    expect(f.remove).not.toHaveBeenCalled();
    f.setNow(new Date((lease.lease_expires_at?.getTime() ?? 0) + 1));
    // Existing M2 deletion observes offline twice even with a zero fixture
    // settle interval. Lease expiry does not bypass that confirmation.
    expect(await f.process(operation.jobId)).toBe('waiting');
    expect(f.remove).not.toHaveBeenCalled();
    expect(await f.process(operation.jobId)).toBe('waiting');
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(await f.process(operation.jobId)).toBe('succeeded');
    expect(
      await f.db
        .selectFrom('server_allocations')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await f.db
        .selectFrom('gateway_routes')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await f.db
        .selectFrom('gateway_reachability_proofs')
        .selectAll()
        .where('route_id', '=', f.route.id)
        .execute(),
    ).toHaveLength(0);
  });
  it('also fences previously queued deletion and remote-absence recovery before releasing allocations', async () => {
    const f = await fixture();
    const operation = await enqueueServerOperation(f.db, f.context, f.serverId, {
      action: 'delete',
      idempotencyKey: randomUUID(),
      confirm: true,
    });
    const deadline = new Date(Date.now() + 30000);
    // Isolated legacy queued-operation state, not a supported live route mutation.
    await f.db
      .updateTable('gateway_routes')
      .set({ enabled: true, lease_expires_at: deadline })
      .where('id', '=', f.route.id)
      .execute();
    await f.db
      .updateTable('server_operations')
      .set({ phase: 'delete', effect_state: 'uncertain', effect_started_at: new Date() })
      .where('job_id', '=', operation.jobId)
      .execute();
    f.setAbsent();
    expect(await f.process(operation.jobId)).toBe('waiting');
    expect(f.getServer).not.toHaveBeenCalled();
    expect(
      await f.db
        .selectFrom('server_allocations')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
    ).toHaveLength(1);
    expect(
      (
        await f.db
          .selectFrom('gateway_routes')
          .select('enabled')
          .where('id', '=', f.route.id)
          .executeTakeFirstOrThrow()
      ).enabled,
    ).toBe(false);
    f.setNow(new Date(deadline.getTime() + 1));
    expect(await f.process(operation.jobId)).toBe('succeeded');
    expect(f.remove).not.toHaveBeenCalled();
    expect(
      await f.db
        .selectFrom('server_allocations')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
    ).toHaveLength(0);
  });
  it('does not add a delay for a route whose snapshot has never been issued', async () => {
    const f = await fixture();
    const operation = await enqueueServerOperation(f.db, f.context, f.serverId, {
      action: 'delete',
      idempotencyKey: randomUUID(),
      confirm: true,
    });
    expect(await f.process(operation.jobId)).toBe('waiting');
    expect(f.getServer).toHaveBeenCalled();
    expect(await f.process(operation.jobId)).toBe('waiting');
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(await f.process(operation.jobId)).toBe('succeeded');
  });
});
