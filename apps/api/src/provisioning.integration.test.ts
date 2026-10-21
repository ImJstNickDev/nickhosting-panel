import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type {
  ConsoleRelayOptions,
  PrivateTransferCache,
  ProviderChange,
  ProviderInstallationEvent,
  PterodactylAdapter,
} from '@nickhosting/pterodactyl-adapter';
import {
  applyProviderInstallationEvent,
  createInstallationCollector,
  getPlatformJob,
  getPlatformServer,
  getServerProvisioning,
  installationLogKey,
  linkProviderFeedServer,
  listPlatformActivity,
} from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerProvisioningRoutes } from './provisioning.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let fixture: Awaited<ReturnType<typeof managementFixture>>;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await managementFixture(database.db);
});
afterAll(async () => {
  await database?.destroy();
});
function cache() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: string, _ttl?: number) => {
      values.set(key, value);
    }),
    delete: async (key: string) => {
      values.delete(key);
    },
    take: async (key: string) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
  } satisfies PrivateTransferCache & { values: Map<string, string> };
}
async function installing() {
  const serverId = await fixture.server();
  const operation = await database.db
    .selectFrom('server_operations')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  await database.db
    .updateTable('operation_jobs')
    .set({
      state: 'queued',
      completed_at: null,
      next_attempt_at: new Date(Date.now() + 60_000),
      error_code: 'operation_uncertain',
    })
    .where('id', '=', operation.job_id)
    .execute();
  await database.db
    .updateTable('server_operations')
    .set({
      phase: 'installation',
      effect_started_at: new Date(Date.now() - 1000),
      plan: JSON.stringify({
        ...operation.plan,
        waitReason: 'installation_terminal_unproven',
        provisioning: { stage: 'installing' },
      }),
    })
    .where('job_id', '=', operation.job_id)
    .execute();
  await database.db
    .updateTable('managed_servers')
    .set({ active_operation_id: operation.job_id, installation_state: 'installing' })
    .where('id', '=', serverId)
    .execute();
  return { serverId, jobId: operation.job_id };
}

it('projects the linked modpack workflow in Console, Activity details and filtered lists without changing jobs', async () => {
  const target = await installing();
  await database.db
    .updateTable('operation_jobs')
    .set({ state: 'running', error_code: null })
    .where('id', '=', target.jobId)
    .execute();
  await database.db
    .updateTable('server_operations')
    .set({
      action: 'reinstall',
      phase: 'queued',
      effect_state: 'none',
      plan: JSON.stringify({ modpackOperationId: target.jobId }),
    })
    .where('job_id', '=', target.jobId)
    .execute();
  await database.db
    .insertInto('minecraft_modpack_operations')
    .values({
      id: target.jobId,
      server_id: target.serverId,
      actor_user_id: fixture.context.actorUserId,
      actor_session_id: randomUUID(),
      subject_user_id: fixture.context.subjectUserId,
      support_session_id: null,
      resource_owner_id: fixture.context.subjectUserId,
      physical_host_id: null,
      held_bytes: '0',
      staging_root: null,
      idempotency_key: randomUUID(),
      selection: '{}',
      state: 'uncertain',
      phase: 'runtime',
      progress: 'null',
      prepared: 'null',
      plan: 'null',
      plan_digest: null,
      blockers: '[]',
      apply_request: 'null',
      apply_actor_user_id: null,
      apply_actor_session_id: null,
      apply_subject_user_id: null,
      apply_support_session_id: null,
      apply_idempotency_key: null,
      journal: '[]',
      backup_id: null,
      restart_required: false,
      error: 'operation_uncertain',
      lease_token: null,
      lease_until: null,
    })
    .execute();
  expect(await getServerProvisioning(database.db, fixture.context, target.serverId)).toMatchObject({
    jobId: target.jobId,
    state: 'uncertain',
    stage: 'installing',
    canReinstall: false,
    stages: [],
    errorCode: 'operation_uncertain',
    workflow: {
      phaseKey: 'games.minecraft.modpacks.changingRuntime',
      review: { sectionId: 'modpacks' },
    },
  });
  expect(await getPlatformJob(database.db, fixture.context, target.jobId)).toMatchObject({
    state: 'uncertain',
    ownerRecovery: null,
    provisioning: { state: 'uncertain', stage: 'installing' },
  });
  expect(
    (
      await listPlatformActivity(database.db, fixture.context, {
        serverId: target.serverId,
        state: 'uncertain',
      })
    ).items.map((item) => item.jobId),
  ).toContain(target.jobId);
  expect(
    (
      await listPlatformActivity(database.db, fixture.context, {
        serverId: target.serverId,
        state: 'running',
      })
    ).items.map((item) => item.jobId),
  ).not.toContain(target.jobId);
  for (const [state, phase, publicState, presentation] of [
    ['apply_queued', 'runtime', 'queued', 'active'],
    ['applying', 'runtime', 'running', 'active'],
    ['applied', 'complete', 'succeeded', 'completed'],
  ] as const) {
    await database.db
      .updateTable('minecraft_modpack_operations')
      .set({ state, phase, error: null, updated_at: new Date() })
      .where('id', '=', target.jobId)
      .execute();
    expect(
      await getServerProvisioning(database.db, fixture.context, target.serverId),
    ).toMatchObject({ state: presentation });
    expect(await getPlatformJob(database.db, fixture.context, target.jobId)).toMatchObject({
      state: publicState,
      provisioning: { state: presentation },
    });
    expect(
      (
        await listPlatformActivity(database.db, fixture.context, {
          serverId: target.serverId,
          state: publicState,
        })
      ).items.map((item) => item.jobId),
    ).toContain(target.jobId);
  }
  expect(
    await database.db
      .selectFrom('operation_jobs')
      .select(['state', 'error_code'])
      .where('id', '=', target.jobId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ state: 'running', error_code: null });
  // A mismatched operation marker must never attach another workflow's state.
  await database.db
    .updateTable('server_operations')
    .set({ plan: JSON.stringify({ modpackOperationId: randomUUID() }) })
    .where('job_id', '=', target.jobId)
    .execute();
  expect(await getServerProvisioning(database.db, fixture.context, target.serverId)).toMatchObject({
    state: 'active',
    stage: 'preparing',
    workflow: undefined,
  });
});

it('serves authorized durable progress and bounded transcript without any provider request', async () => {
  const target = await installing(),
    store = cache();
  await store.put(
    installationLogKey(target.jobId),
    JSON.stringify({
      available: true,
      logs: [{ id: '1', at: new Date().toISOString(), text: 'Downloading server' }],
    }),
    900000,
  );
  let revoked = false;
  const app = new Hono<{ Variables: Variables }>();
  const management = vi.fn(async (): Promise<never> => {
    throw new Error('No provider reads');
  });
  registerProvisioningRoutes(app, {
    db: database.db,
    pool: database.pool,
    provisioningCache: store,
    env: {},
    principal: async () => {
      if (revoked) throw new DomainError('unauthenticated');
      return fixture.context;
    },
    management,
    acquireUploadSlot: () => () => {},
  });
  const result = await app.request(`/v1/servers/${target.serverId}/provisioning`);
  expect(await result.json()).toMatchObject({
    provisioning: {
      jobId: target.jobId,
      stage: 'installing',
      state: 'active',
      canReinstall: false,
      logsAvailable: true,
      logs: [{ text: 'Downloading server' }],
    },
  });
  const response = await app.request(`/v1/servers/${target.serverId}/provisioning/stream`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing stream');
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: provisioning');
  revoked = true;
  expect((await reader.read()).done).toBe(true);
  expect(management).not.toHaveBeenCalled();
});

it('rejects foreign viewers and offers reinstall only to managers after proven capacity release', async () => {
  const target = await installing();
  const foreign = await managementFixture(database.db);
  await expect(
    getServerProvisioning(database.db, foreign.context, target.serverId),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await database.db
    .updateTable('operation_jobs')
    .set({ state: 'failed', error_code: 'integration_unavailable', completed_at: new Date() })
    .where('id', '=', target.jobId)
    .execute();
  await database.db
    .updateTable('managed_servers')
    .set({ active_operation_id: null, installation_state: 'failed' })
    .where('id', '=', target.serverId)
    .execute();
  expect(
    (await getServerProvisioning(database.db, fixture.context, target.serverId))?.canReinstall,
  ).toBe(true);
});

it('does not emit a transcript if authorization is revoked during its cache read', async () => {
  const target = await installing(),
    store = cache();
  let revoked = false;
  store.get.mockImplementation(async () => {
    revoked = true;
    return JSON.stringify({
      available: true,
      logs: [{ id: 'private', at: new Date().toISOString(), text: 'must not escape' }],
    });
  });
  const app = new Hono<{ Variables: Variables }>();
  registerProvisioningRoutes(app, {
    db: database.db,
    env: {},
    provisioningCache: store,
    principal: async () => {
      if (revoked) throw new DomainError('unauthenticated');
      return fixture.context;
    },
    management: async (): Promise<never> => {
      throw new Error('No provider request');
    },
    acquireUploadSlot: () => () => {},
  });
  const response = await app.request(`/v1/servers/${target.serverId}/provisioning/stream`);
  expect(await response.text()).not.toContain('must not escape');
});

it('retires a first-start denial after a successful manual start, preserving its Activity history', async () => {
  const target = await installing();
  const deniedAt = new Date();
  await database.db
    .updateTable('operation_jobs')
    .set({ state: 'succeeded', completed_at: deniedAt, error_code: null })
    .where('id', '=', target.jobId)
    .execute();
  await database.db
    .updateTable('server_operations')
    .set({
      phase: 'complete',
      plan: JSON.stringify({ autoStart: true, initialStartDenied: true, installConfirmed: true }),
    })
    .where('job_id', '=', target.jobId)
    .execute();
  await database.db
    .updateTable('managed_servers')
    .set({ active_operation_id: null, installation_state: 'installed', runtime_state: 'offline' })
    .where('id', '=', target.serverId)
    .execute();
  await database.db
    .insertInto('server_events')
    .values({
      server_id: target.serverId,
      job_id: target.jobId,
      actor_id: fixture.context.actorUserId,
      subject_id: fixture.context.subjectUserId,
      support_session_id: null,
      message_key: 'servers.operation.initial_start_denied',
      created_at: deniedAt,
      data: '{}',
    })
    .execute();
  expect((await getServerProvisioning(database.db, fixture.context, target.serverId))?.state).toBe(
    'start-denied',
  );
  expect(
    (await getPlatformServer(database.db, fixture.context, target.serverId)).firstStart?.outcome,
  ).toBe('denied');
  const original = await database.db
    .selectFrom('operation_jobs')
    .selectAll()
    .where('id', '=', target.jobId)
    .executeTakeFirstOrThrow();
  const startId = randomUUID(),
    completed = new Date(deniedAt.getTime() + 1000);
  await database.db
    .insertInto('operation_jobs')
    .values({
      ...original,
      id: startId,
      idempotency_key: startId,
      created_at: completed,
      completed_at: completed,
      state: 'failed',
      command: JSON.stringify(original.command),
      policy_snapshot: JSON.stringify(original.policy_snapshot),
    })
    .execute();
  await database.db
    .insertInto('server_operations')
    .values({
      job_id: startId,
      server_id: target.serverId,
      action: 'start',
      phase: 'failed',
      plan: '{}',
      effect_state: 'none',
    })
    .execute();
  // A failed retry does not erase the useful capacity-denied state.
  expect((await getServerProvisioning(database.db, fixture.context, target.serverId))?.state).toBe(
    'start-denied',
  );
  await database.db
    .updateTable('operation_jobs')
    .set({ state: 'succeeded' })
    .where('id', '=', startId)
    .execute();
  await database.db
    .updateTable('server_operations')
    .set({ phase: 'complete', effect_state: 'confirmed' })
    .where('job_id', '=', startId)
    .execute();
  // Even when the server is offline again, the historical denial must not reappear.
  expect(await getServerProvisioning(database.db, fixture.context, target.serverId)).toBeNull();
  expect(
    (await getPlatformServer(database.db, fixture.context, target.serverId)).firstStart,
  ).toBeNull();
  expect(
    (await getPlatformJob(database.db, fixture.context, target.jobId)).provisioning?.state,
  ).toBe('start-denied');
});

it('deduplicates identity-bound installation receipts, wakes the queue, and never confirms installation', async () => {
  const target = await installing();
  const server = await database.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', target.serverId)
    .executeTakeFirstOrThrow();
  const feed = await database.db
    .selectFrom('provider_change_feeds')
    .select('instance_id')
    .where('enabled', '=', true)
    .executeTakeFirstOrThrow();
  if (!server.pterodactyl_id || !server.pterodactyl_uuid || !server.pterodactyl_identifier)
    throw new Error('Missing identity');
  const snapshot: ProviderChange = {
    schemaVersion: 1,
    eventId: randomUUID(),
    instanceId: feed.instance_id,
    type: 'snapshot',
    revision: 1,
    occurredAt: new Date().toISOString(),
    limits: { ...fixture.limits, threads: null },
    server: {
      providerId: server.pterodactyl_id,
      providerUuid: server.pterodactyl_uuid,
      identifier: server.pterodactyl_identifier,
      externalId: server.external_id,
      nodeId: fixture.providerNodeId,
    },
  };
  await linkProviderFeedServer(database.db, feed.instance_id, target.serverId, snapshot);
  const providerSecond = new Date(Math.floor(Date.now() / 1000) * 1000);
  await database.db
    .updateTable('server_operations')
    .set({ effect_started_at: new Date(providerSecond.getTime() + 100) })
    .where('job_id', '=', target.jobId)
    .execute();
  const event: ProviderInstallationEvent = {
    schemaVersion: 1,
    eventId: randomUUID(),
    instanceId: feed.instance_id,
    type: 'installation.updated',
    occurredAt: providerSecond.toISOString(),
    server: snapshot.server,
    installation: { state: 'installed', status: null },
  };
  await applyProviderInstallationEvent(database.db, event);
  const first = await database.db
    .selectFrom('job_outbox')
    .selectAll()
    .where('job_id', '=', target.jobId)
    .executeTakeFirstOrThrow();
  await applyProviderInstallationEvent(database.db, event);
  expect(
    await database.db
      .selectFrom('job_outbox')
      .selectAll()
      .where('job_id', '=', target.jobId)
      .executeTakeFirst(),
  ).toEqual(first);
  const operation = await database.db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', target.jobId)
    .executeTakeFirstOrThrow();
  expect(operation.plan.installConfirmed).toBeUndefined();
  expect(
    (
      await database.db
        .selectFrom('operation_jobs')
        .select('state')
        .where('id', '=', target.jobId)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe('queued');
  await expect(
    applyProviderInstallationEvent(database.db, {
      ...event,
      eventId: randomUUID(),
      server: { ...event.server, providerId: event.server.providerId + 1000 },
    }),
  ).rejects.toMatchObject({ code: 'provenance_mismatch' });
});

it('shares one installation collector, bounds replay and resumes history after shutdown', async () => {
  const target = await installing(),
    store = cache();
  let input: ConsoleRelayOptions | undefined;
  const close = vi.fn();
  const relayInstallation = vi.fn(async (_id: string, value: ConsoleRelayOptions) => {
    input = value;
    return {
      close,
      sendCommand: async () => {},
      requestLogs: async () => {},
      requestStats: async () => {},
    };
  });
  const prepare = vi.fn(async () => {}),
    wake = vi.fn(async () => {});
  const leased = new Map<string, string>();
  const lease = vi.fn(
    async (jobId: string, token: string, operation: 'claim' | 'renew' | 'release') => {
      if (operation === 'claim') {
        if (leased.has(jobId)) return false;
        leased.set(jobId, token);
        return true;
      }
      if (leased.get(jobId) !== token) return false;
      if (operation === 'release') leased.delete(jobId);
      return true;
    },
  );
  const options = {
    db: database.db,
    cache: store,
    adapter: async () => ({ relayInstallation }) as unknown as PterodactylAdapter,
    prepare,
    wake,
    lease,
    leaseKey: (jobId: string) => `lease:${jobId}`,
  };
  const collector = createInstallationCollector(options),
    replica = createInstallationCollector(options);
  try {
    collector.ensure(target.jobId, target.serverId);
    collector.ensure(target.jobId, target.serverId);
    await vi.waitFor(() => expect(relayInstallation).toHaveBeenCalledTimes(1));
    replica.ensure(target.jobId, target.serverId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(relayInstallation).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 1100; n++)
      input?.onEvent({ type: 'console', source: 'installation', data: `${n} ${'x'.repeat(512)}` });
    await vi.waitFor(() => expect(store.put).toHaveBeenCalled());
    await collector.close();
    const transcript = JSON.parse(store.values.get(installationLogKey(target.jobId)) ?? '{}');
    expect(transcript.available).toBe(true);
    expect(transcript.logs.length).toBeLessThanOrEqual(1000);
    expect(
      transcript.logs.reduce(
        (sum: number, row: { text: string }) => sum + Buffer.byteLength(row.text),
        0,
      ),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(transcript.logs.at(-1).text).toContain('1099 ');
    expect(close).toHaveBeenCalledOnce();
    replica.ensure(target.jobId, target.serverId);
    await vi.waitFor(() => expect(relayInstallation).toHaveBeenCalledTimes(2));
    input?.onEvent({ type: 'installation', phase: 'completed' });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(target.jobId));
    expect(
      (
        await database.db
          .selectFrom('operation_jobs')
          .select('state')
          .where('id', '=', target.jobId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('queued');
  } finally {
    await collector.close();
    await replica.close();
  }
});
