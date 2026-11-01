import { randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type {
  ApplicationServer,
  PterodactylAdapter,
  Resources,
} from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { processServerOperation } from './lifecycle.js';
import { consumeStopEscalation, requestStopEscalation, stopEscalation } from './stop-escalation.js';

let providerId = 0;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
async function fixture() {
  const db = database.db;
  const provider = ++providerId;
  const userId = randomUUID(),
    hostId = randomUUID(),
    nodeId = randomUUID(),
    mappingId = randomUUID(),
    serverId = randomUUID(),
    jobId = randomUUID(),
    sessionId = randomUUID();
  await db
    .insertInto('user')
    .values({ id: userId, name: 'Fixture', email: `${userId}@example.test`, role: 'user' })
    .execute();
  await db
    .insertInto('session')
    .values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 60000) })
    .execute();
  await db
    .insertInto('game_integrations')
    .values({ id: mappingId, version: '1', manifest: '{}' })
    .execute();
  await db
    .insertInto('physical_hosts')
    .values({
      id: hostId,
      name: 'Fixture',
      memory_limit_mib: 2048,
      cpu_limit_percent: 200,
      storage_pool_mib: '10000',
      memory_headroom_mib: 128,
      cpu_headroom_percent: 10,
      disk_headroom_mib: '100',
      local_disk_path: 'fixture',
      observer_id: hostId,
    })
    .execute();
  await db
    .insertInto('managed_nodes')
    .values({
      id: nodeId,
      physical_host_id: hostId,
      pterodactyl_node_id: provider,
      provision_user_id: 1,
      backend_allocation_pool: '{}',
    })
    .execute();
  await db
    .insertInto('runtime_egg_mappings')
    .values({
      id: mappingId,
      game_id: mappingId,
      runtime_id: 'fixture',
      node_id: nodeId,
      nest_id: 1,
      egg_id: 1,
      docker_image: 'fixture',
      startup: 'fixture',
      environment: '{}',
      port_roles: '[]',
      feature_limits: JSON.stringify({ memory: 128, cpu: 10, disk: 64, swap: 0, io: 500 }),
    })
    .execute();
  await db
    .insertInto('operation_jobs')
    .values({
      id: jobId,
      actor_id: userId,
      subject_id: userId,
      resource_owner_id: userId,
      support_session_id: null,
      idempotency_key: jobId,
      command_hash: 'a'.repeat(64),
      command: JSON.stringify({
        type: 'server.operation',
        version: 1,
        payload: { serverId, operationId: jobId },
      }),
      policy_snapshot: '{}',
      max_attempts: 5,
      error_code: null,
      completed_at: null,
    })
    .execute();
  await db
    .insertInto('managed_servers')
    .values({
      id: serverId,
      owner_id: userId,
      provider_user_id: 1,
      project_id: null,
      mapping_id: mappingId,
      node_id: nodeId,
      name: 'fixture',
      external_id: `nh:${serverId}`,
      pterodactyl_id: provider,
      pterodactyl_uuid: randomUUID(),
      pterodactyl_identifier: serverId.slice(0, 8),
      limits: JSON.stringify({ memory: 128, cpu: 10, disk: 64, swap: 0, io: 500 }),
      active_operation_id: jobId,
      last_observed_at: null,
      deleted_at: null,
    })
    .execute();
  await db
    .insertInto('server_operations')
    .values({
      job_id: jobId,
      server_id: serverId,
      action: 'stop',
      phase: 'power',
      plan: JSON.stringify({ stopProcessStartedAt: '2026-01-01T00:00:00.000Z' }),
      effect_started_at: new Date(),
      lease_until: null,
      lease_token: null,
    })
    .execute();
  await db
    .insertInto('resource_reservations')
    .values({
      server_id: serverId,
      owner_id: userId,
      physical_host_id: hostId,
      memory_mib: 128,
      physical_memory_mib: 128,
      cpu_percent: 10,
      operation_id: jobId,
      state: 'stopping',
    })
    .execute();
  await db
    .insertInto('server_allocations')
    .values({
      id: randomUUID(),
      server_id: serverId,
      node_id: nodeId,
      pterodactyl_allocation_id: provider,
      address: '10.0.0.2',
      backend_address: '10.0.0.2',
      port: 25000,
      role: 'game',
      protocols: ['tcp'],
      is_primary: true,
    })
    .execute();
  const context: AuthContext = {
    actorUserId: userId,
    subjectUserId: userId,
    role: 'user',
    sessionType: 'regular',
    ownerElevation: false,
    [authSessionId]: sessionId,
  };
  const input = { action: 'kill', confirm: true, operationId: jobId, idempotencyKey: randomUUID() };
  const request = () => requestStopEscalation(db, context, serverId, input, {});
  const receipt = async () =>
    stopEscalation(
      (
        await db
          .selectFrom('operation_jobs')
          .select('policy_snapshot')
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow()
      ).policy_snapshot,
    );
  return { db, serverId, jobId, sessionId, context, input, request, receipt, provider };
}
it('concurrent same-key requests attach once to exact parent and retain reservation', async () => {
  const f = await fixture();
  const results = await Promise.all([f.request(), f.request(), f.request()]);
  expect(results).toEqual(Array(3).fill({ serverId: f.serverId, jobId: f.jobId }));
  expect((await f.receipt())?.state).toBe('requested');
  expect(
    await f.db
      .selectFrom('resource_reservations')
      .select('server_id')
      .where('server_id', '=', f.serverId)
      .executeTakeFirst(),
  ).toBeDefined();
  await expect(
    requestStopEscalation(
      f.db,
      f.context,
      f.serverId,
      { ...f.input, idempotencyKey: randomUUID() },
      {},
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
});
it('requires confirmation, exact active stop target, and active session', async () => {
  const f = await fixture();
  await expect(
    requestStopEscalation(f.db, f.context, f.serverId, { ...f.input, confirm: false }, {}),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await expect(
    requestStopEscalation(
      f.db,
      f.context,
      f.serverId,
      { ...f.input, operationId: randomUUID() },
      {},
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
  await f.db
    .updateTable('session')
    .set({ expiresAt: new Date(0) })
    .where('id', '=', f.sessionId)
    .execute();
  await expect(f.request()).rejects.toMatchObject({ code: 'unauthenticated' });
});
it('journals handoff before kill and never replays unknown outcome on worker recovery', async () => {
  const f = await fixture();
  await f.request();
  const power = vi.fn(async () => {
    expect((await f.receipt())?.state).toBe('prepared');
    throw new Error('lost response');
  });
  await consumeStopEscalation(f.db, f.serverId, f.jobId, {}, { verify: async () => true, power });
  expect((await f.receipt())?.state).toBe('unknown');
  await consumeStopEscalation(f.db, f.serverId, f.jobId, {}, { verify: async () => true, power });
  expect(power).toHaveBeenCalledTimes(1);
  expect(
    await f.db
      .selectFrom('resource_reservations')
      .select('server_id')
      .where('server_id', '=', f.serverId)
      .executeTakeFirst(),
  ).toBeDefined();
});
it('rechecks revocation and refuses nonstopping or replaced parent without power', async () => {
  const f = await fixture();
  await f.request();
  const power = vi.fn(async () => {});
  await consumeStopEscalation(f.db, f.serverId, f.jobId, {}, { verify: async () => false, power });
  expect((await f.receipt())?.state).toBe('rejected');
  await requestStopEscalation(
    f.db,
    f.context,
    f.serverId,
    { ...f.input, idempotencyKey: randomUUID() },
    {},
  );
  await f.db
    .updateTable('session')
    .set({ expiresAt: new Date(0) })
    .where('id', '=', f.sessionId)
    .execute();
  await consumeStopEscalation(f.db, f.serverId, f.jobId, {}, { verify: async () => true, power });
  expect((await f.receipt())?.state).toBe('rejected');
  expect(power).not.toHaveBeenCalled();
  const g = await fixture();
  await g.request();
  await g.db
    .updateTable('managed_servers')
    .set({ active_operation_id: null })
    .where('id', '=', g.serverId)
    .execute();
  await consumeStopEscalation(g.db, g.serverId, g.jobId, {}, { verify: async () => true, power });
  expect((await g.receipt())?.state).toBe('rejected');
  expect(power).not.toHaveBeenCalled();
});
it('accepted kill preserves parent and compute until lifecycle confirms terminal proof', async () => {
  const f = await fixture();
  await f.request();
  const power = vi.fn(async () => {});
  await consumeStopEscalation(f.db, f.serverId, f.jobId, {}, { verify: async () => true, power });
  expect((await f.receipt())?.state).toBe('confirmed');
  expect(power).toHaveBeenCalledTimes(1);
  expect(
    await f.db
      .selectFrom('managed_servers')
      .select(['active_operation_id', 'intent'])
      .where('id', '=', f.serverId)
      .executeTakeFirst(),
  ).toMatchObject({ active_operation_id: f.jobId, intent: 'manually_stopped' });
  expect(
    await f.db
      .selectFrom('resource_reservations')
      .select('server_id')
      .where('server_id', '=', f.serverId)
      .executeTakeFirst(),
  ).toBeDefined();
});

it('does not dispatch when stopping proof changes during durable preparation', async () => {
  const f = await fixture();
  await f.request();
  const power = vi.fn(async () => {});
  const verify = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await consumeStopEscalation(f.db, f.serverId, f.jobId, {}, { verify, power });
  expect(power).not.toHaveBeenCalled();
  expect((await f.receipt())?.state).toBe('rejected');
});

it('accepted request withdraws consent before worker or graceful completion; rejected retry preserves replay', async () => {
  const f = await fixture();
  await f.request();
  expect(
    (
      await f.db
        .selectFrom('managed_servers')
        .select('intent')
        .where('id', '=', f.serverId)
        .executeTakeFirst()
    )?.intent,
  ).toBe('manually_stopped');
  const power = vi.fn(async () => {});
  await consumeStopEscalation(
    f.db,
    f.serverId,
    f.jobId,
    {},
    {
      verify: async () => {
        throw new Error('identity');
      },
      power,
    },
  );
  expect((await f.receipt())?.state).toBe('rejected');
  const next = { ...f.input, idempotencyKey: randomUUID() };
  await requestStopEscalation(f.db, f.context, f.serverId, next, {});
  await f.request();
  expect((await f.receipt())?.key).toBe(next.idempotencyKey);
  await consumeStopEscalation(f.db, f.serverId, f.jobId, {}, { verify: async () => true, power });
  expect(power).toHaveBeenCalledTimes(1);
});
async function lifecycleFixture() {
  const f = await fixture();
  await f.request();
  const server = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', f.serverId)
    .executeTakeFirstOrThrow();
  const remote = {
    id: f.provider,
    external_id: server.external_id,
    uuid: server.pterodactyl_uuid,
    identifier: server.pterodactyl_identifier,
    node: f.provider,
    user: 1,
    allocation: f.provider,
    relationships: {
      allocations: {
        data: [{ attributes: { id: f.provider, ip: '10.0.0.2', port: 25000, assigned: true } }],
      },
    },
  } as ApplicationServer;
  let state: Resources['current_state'] = 'stopping';
  let stopped = false;
  const power = vi.fn(async () => {
    state = 'offline';
    stopped = true;
  });
  const adapter = {
    getApplicationServer: async () => remote,
    getResources: async () => ({
      current_state: state,
      is_suspended: false,
      resources: {
        memory_bytes: 0,
        cpu_absolute: 0,
        disk_bytes: 0,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
      },
    }),
    power,
  } as unknown as PterodactylAdapter;
  return {
    ...f,
    power,
    options: {
      adapter,
      authorizeEffect: async () => {},
      observeReconciliationProcessStart: async () => '2026-01-01T00:00:00.000Z',
      confirmAlreadyStopped: async () => stopped,
    },
    stopped: () => {
      stopped = true;
      state = 'offline';
    },
  };
}
it('lifecycle recovery consumes pending Kill and releases only after trusted terminal proof', async () => {
  const f = await lifecycleFixture();
  expect(await processServerOperation(f.db, f.jobId, f.options)).toBe('succeeded');
  expect(f.power).toHaveBeenCalledTimes(1);
  expect(
    await f.db
      .selectFrom('resource_reservations')
      .select('server_id')
      .where('server_id', '=', f.serverId)
      .executeTakeFirst(),
  ).toBeUndefined();
  expect((await f.receipt())?.state).toBe('confirmed');
});
it('lost stop recovery still consumes pending Kill when its process is running', async () => {
  const f = await lifecycleFixture();
  await f.db
    .updateTable('server_operations')
    .set({
      effect_state: 'uncertain',
      plan: JSON.stringify({
        powerEffectPrepared: true,
        stopProcessStartedAt: '2026-01-01T00:00:00.000Z',
      }),
    })
    .where('job_id', '=', f.jobId)
    .execute();
  const originalProof = f.options.confirmAlreadyStopped;
  const proofs: boolean[] = [];
  f.options.confirmAlreadyStopped = async () => {
    const result = await originalProof();
    proofs.push(result);
    return result;
  };
  expect(await processServerOperation(f.db, f.jobId, f.options)).toBe('succeeded');
  expect(proofs[0]).toBe(false);
  expect(proofs.at(-1)).toBe(true);
  expect(f.power).toHaveBeenCalledTimes(1);
  expect((await f.receipt())?.state).toBe('confirmed');
});
it('lifecycle refuses a different process epoch and retains the reservation', async () => {
  const f = await lifecycleFixture();
  f.options.observeReconciliationProcessStart = async () => '2026-01-01T01:00:00.000Z';
  expect(await processServerOperation(f.db, f.jobId, f.options)).toBe('waiting');
  expect(f.power).not.toHaveBeenCalled();
  expect(
    await f.db
      .selectFrom('resource_reservations')
      .select('server_id')
      .where('server_id', '=', f.serverId)
      .executeTakeFirst(),
  ).toBeDefined();
});
it('lifecycle recovers prepared crash without replaying kill and waits for physical stop', async () => {
  const f = await lifecycleFixture();
  const job = await f.db
    .selectFrom('operation_jobs')
    .select('policy_snapshot')
    .where('id', '=', f.jobId)
    .executeTakeFirstOrThrow();
  await f.db
    .updateTable('operation_jobs')
    .set({
      policy_snapshot: JSON.stringify({
        ...job.policy_snapshot,
        stopEscalation: { ...(await f.receipt()), state: 'prepared' },
      }),
    })
    .where('id', '=', f.jobId)
    .execute();
  expect(await processServerOperation(f.db, f.jobId, f.options)).toBe('waiting');
  expect(f.power).not.toHaveBeenCalled();
  f.stopped();
  await f.db
    .updateTable('operation_jobs')
    .set({ next_attempt_at: new Date(0) })
    .where('id', '=', f.jobId)
    .execute();
  expect(await processServerOperation(f.db, f.jobId, f.options)).toBe('succeeded');
  expect(f.power).not.toHaveBeenCalled();
});

it('recovery rejects cached stopping when the process is replaced during resources fetch', async () => {
  const f = await lifecycleFixture();
  let epoch = '2026-01-01T00:00:00.000Z';
  const original = f.options.adapter.getResources.bind(f.options.adapter);
  f.options.adapter.getResources = async (identifier) => {
    const result = await original(identifier);
    epoch = '2026-01-01T01:00:00.000Z';
    return result;
  };
  f.options.observeReconciliationProcessStart = async () => epoch;
  expect(await processServerOperation(f.db, f.jobId, f.options)).toBe('waiting');
  expect(f.power).not.toHaveBeenCalled();
});

it('does not accept legacy stop operations without a process baseline', async () => {
  const f = await fixture();
  await f.db
    .updateTable('server_operations')
    .set({ plan: '{}' })
    .where('job_id', '=', f.jobId)
    .execute();
  await expect(f.request()).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.receipt()).toBeUndefined();
});
