import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { createJobTransport, dispatchOutbox, startJobWorker } from '@nickhosting/jobs';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { describe, expect, it, vi } from 'vitest';
import { reserveStart } from './admission.js';
import {
  getGatewayState,
  reportGatewayObservation,
  requestGatewayWake,
  setGatewayPolicy,
} from './gateway-orchestration.js';
import {
  createLifecycleProcessor,
  type LifecycleOptions,
  processServerOperation,
} from './lifecycle.js';
import { authorizeQueuedEffect } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 12000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Isolated gateway wake did not recover');
    await delay(25);
  }
}
async function fixture() {
  const isolated = await createTestDatabase();
  try {
    const f = await managementFixture(isolated.db, { interactive: true });
    const serverId = await f.server();
    const state = await setGatewayPolicy(f.db, f.context, serverId, {
      enabled: true,
      protocolId: 'isolated-fixture',
      gameVersion: '1',
      idleTimeoutSeconds: null,
      readinessTimeoutSeconds: 60,
      readinessMaxAgeSeconds: 15,
      estimateMaxAgeSeconds: 86400,
      wakeRetrySeconds: 10,
    });
    const queued = await requestGatewayWake(f.db, serverId, {
      generation: state.generation,
      intent: 'join',
    });
    if (!queued.wakeJobId) throw new Error('Expected admitted wake');
    const jobId = queued.wakeJobId;
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    const allocations = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    let currentState = 'offline',
      processStartedAt: string | null = null;
    const power = vi.fn(async () => {
      await delay(2);
      processStartedAt = new Date().toISOString();
      currentState = 'running';
    });
    const adapter = {
      getApplicationServer: async () => ({
        id: server.pterodactyl_id,
        uuid: server.pterodactyl_uuid,
        identifier: server.pterodactyl_identifier,
        external_id: server.external_id,
        node: f.providerNodeId,
        user: 1,
        limits: server.limits,
        status: null,
        suspended: false,
        container: { installed: true },
        allocation: allocations.find((row) => row.is_primary)?.pterodactyl_allocation_id,
        relationships: {
          allocations: {
            data: allocations.map((row) => ({
              attributes: {
                id: row.pterodactyl_allocation_id,
                ip: row.address,
                port: row.port,
                assigned: true,
              },
            })),
          },
        },
      }),
      getResources: async () => ({
        current_state: currentState,
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
    const lifecycle: LifecycleOptions = {
      adapter,
      settleMs: 0,
      authorizeEffect: async (id, target, db) => {
        await authorizeQueuedEffect(db, id, target);
      },
      reserveStart: (target, id, action, db) => reserveStart(db, target, id, action),
      observeProcessStart: async () => processStartedAt,
    };
    const redisUrl = process.env.NH_TEST_REDIS_URL;
    if (
      !redisUrl ||
      !['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_REDIS_HOST].includes(
        new URL(redisUrl).hostname,
      )
    )
      throw new Error('Only verified isolated Redis is permitted');
    const transport = {
      redisUrl,
      prefix: `nh_gateway_${randomUUID().replaceAll('-', '')}`,
      logger: createLogger(() => {}),
    };
    const job = async () =>
      f.db
        .selectFrom('operation_jobs')
        .selectAll()
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow();
    return {
      ...f,
      isolated,
      serverId,
      state,
      jobId,
      lifecycle,
      power,
      transport,
      job,
      async ready() {
        return reportGatewayObservation(f.db, serverId, {
          generation: state.generation,
          wakeJobId: jobId,
          observedAt: new Date().toISOString(),
          processStartedAt,
          ready: true,
          activeSessions: 0,
        });
      },
    };
  } catch (error) {
    await isolated.destroy();
    throw error;
  }
}
async function cleanup(options: Parameters<typeof createJobTransport>[0]) {
  const transport = createJobTransport(options);
  try {
    await transport.queue.waitUntilReady();
    await transport.queue.obliterate({ force: true });
  } finally {
    await transport.close();
  }
}

describe('M3 durable wake recovery through real isolated Redis delivery', () => {
  it('retains one admitted wake during client disconnection and resumes through fresh delivery', async () => {
    const f = await fixture(),
      unavailable = createJobTransport(f.transport);
    let worker: Awaited<ReturnType<typeof startJobWorker>> | undefined;
    try {
      await unavailable.queue.waitUntilReady();
      // Close only this test-owned Redis client. No service restart or host
      // networking change is needed to exercise a real failed publication.
      await unavailable.queue.disconnect();
      await expect(
        dispatchOutbox(f.db, unavailable.queue, { recoveryIntervalMs: 100 }),
      ).rejects.toThrow();
      const burst = await Promise.all(
        Array.from({ length: 20 }, () =>
          requestGatewayWake(f.db, f.serverId, {
            generation: f.state.generation,
            intent: 'join',
          }),
        ),
      );
      expect(new Set(burst.map((state) => state.wakeJobId))).toEqual(new Set([f.jobId]));
      expect((await f.job()).state).toBe('queued');
      expect(
        await f.db.selectFrom('job_outbox').selectAll().where('job_id', '=', f.jobId).execute(),
      ).toHaveLength(1);
      expect(
        await f.db
          .selectFrom('resource_reservations')
          .selectAll()
          .where('server_id', '=', f.serverId)
          .execute(),
      ).toHaveLength(1);
      expect(f.power).not.toHaveBeenCalled();
      worker = await startJobWorker({
        db: f.db,
        ...f.transport,
        processor: createLifecycleProcessor(f.db, f.lifecycle),
        pollIntervalMs: 50,
        recoveryIntervalMs: 100,
      });
      await eventually(async () => (await f.job()).state === 'succeeded');
      expect((await getGatewayState(f.db, f.serverId)).state).toBe('waking');
      expect((await f.ready()).state).toBe('online');
      await worker.queue.add('duplicate', { jobId: f.jobId });
      await eventually(
        async () =>
          !!worker &&
          (await worker.queue.getActiveCount()) === 0 &&
          (await worker.queue.getWaitingCount()) === 0,
      );
      expect(f.power).toHaveBeenCalledTimes(1);
      expect(
        await f.db.selectFrom('job_outbox').selectAll().where('job_id', '=', f.jobId).execute(),
      ).toHaveLength(0);
      expect(
        await f.db
          .selectFrom('gateway_startup_samples')
          .selectAll()
          .where('server_id', '=', f.serverId)
          .execute(),
      ).toHaveLength(1);
    } finally {
      await worker?.close();
      await unavailable.close();
      await cleanup(f.transport);
      await f.isolated.destroy();
    }
  });
  it('rebuilds lost Redis delivery and recovers worker loss after one successful remote power effect', async () => {
    const f = await fixture(),
      transport = createJobTransport(f.transport);
    let worker: Awaited<ReturnType<typeof startJobWorker>> | undefined;
    try {
      await transport.queue.waitUntilReady();
      expect(await dispatchOutbox(f.db, transport.queue, { recoveryIntervalMs: 100 })).toBe(1);
      // This queue has a unique UUID prefix and no worker. Erasure simulates
      // nonauthoritative delivery loss without touching any other Redis keys.
      await transport.queue.obliterate({ force: true });
      expect(
        await processServerOperation(f.db, f.jobId, {
          ...f.lifecycle,
          checkpoint: async (point) => {
            if (point === 'remote_succeeded') throw new Error('isolated worker loss');
          },
        }),
      ).toBe('waiting');
      expect(f.power).toHaveBeenCalledTimes(1);
      expect((await getGatewayState(f.db, f.serverId)).state).toBe('waking');
      worker = await startJobWorker({
        db: f.db,
        ...f.transport,
        processor: createLifecycleProcessor(f.db, f.lifecycle),
        pollIntervalMs: 50,
        recoveryIntervalMs: 100,
      });
      await eventually(async () => (await f.job()).state === 'succeeded');
      expect((await f.ready()).state).toBe('online');
      expect(f.power).toHaveBeenCalledTimes(1);
      expect(
        await f.db
          .selectFrom('server_operations')
          .selectAll()
          .where('server_id', '=', f.serverId)
          .where('action', '=', 'start')
          .execute(),
      ).toHaveLength(1);
      expect(
        await f.db
          .selectFrom('resource_reservations')
          .selectAll()
          .where('server_id', '=', f.serverId)
          .execute(),
      ).toHaveLength(1);
    } finally {
      await worker?.close();
      await transport.close();
      await cleanup(f.transport);
      await f.isolated.destroy();
    }
  });
});
