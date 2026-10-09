import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { createJobTransport, dispatchOutbox, startJobWorker } from '@nickhosting/jobs';
import {
  type ApplicationServer,
  type ProvisionPlan,
  type PterodactylAdapter,
  PterodactylError,
} from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
  createLifecycleProcessor,
  type LifecycleOptions,
  processServerOperation,
} from './lifecycle.js';
import { createManagedServer } from './registry.js';
import { managementFixture } from './test-fixtures.js';

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Isolated lifecycle job did not finish');
    await delay(25);
  }
}
async function fixture() {
  const isolated = await createTestDatabase();
  try {
    const f = await managementFixture(isolated.db);
    const queued = await createManagedServer(f.db, f.adapter, f.context, f.input());
    let remote: ApplicationServer | null = null;
    const createServer = vi.fn(async (plan: ProvisionPlan) => {
      const at = new Date().toISOString();
      remote = {
        id: 1,
        uuid: randomUUID(),
        identifier: 'fixture1',
        external_id: plan.externalId,
        name: plan.name,
        description: '',
        suspended: false,
        limits: plan.limits,
        feature_limits: plan.featureLimits,
        user: plan.userId,
        node: f.providerNodeId,
        allocation: plan.allocation.default,
        nest: 1,
        egg: plan.eggId,
        status: null,
        container: { startup_command: plan.startup, image: plan.dockerImage, installed: 1 },
        created_at: at,
        updated_at: at,
        relationships: {
          allocations: {
            object: 'list',
            data: [
              {
                attributes: {
                  id: plan.allocation.default,
                  ip: '127.0.0.1',
                  port: 20000,
                  assigned: true,
                },
              },
            ],
          },
        },
      };
      return remote;
    });
    const adapter = {
      ...f.adapter,
      createServer,
      confirmInstallation: async (
        _id: number,
        _identifier: string,
        input: { onConfirmed: () => Promise<void> },
      ) => {
        await input.onConfirmed();
        return { confirmed: true };
      },
      findServerByExternalId: async () => remote,
      getApplicationServer: async () => {
        if (!remote) throw new PterodactylError('not_found', 'application', 'rejected');
        return remote;
      },
      getResources: async () => ({
        current_state: 'offline',
        is_suspended: false,
        resources: {
          memory_bytes: 0,
          cpu_absolute: 0,
          disk_bytes: 0,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
        },
      }),
    } as unknown as PterodactylAdapter;
    const options: LifecycleOptions = {
      adapter,
      authorizeEffect: async () => {},
      reserveInstallation: async (serverId, jobId, connection) => {
        await connection
          .insertInto('installation_reservations')
          .values({
            server_id: serverId,
            operation_id: jobId,
            physical_host_id: f.hostId,
            memory_mib: 1178,
            cpu_percent: 100,
          })
          .onConflict((c) => c.column('server_id').doNothing())
          .execute();
      },
    };
    const redisUrl = process.env.NH_TEST_REDIS_URL;
    if (!redisUrl) throw new Error('Isolated Redis URL required');
    if (
      !['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_REDIS_HOST].includes(
        new URL(redisUrl).hostname,
      )
    )
      throw new Error('Only verified isolated Redis permitted');
    const transport = {
      redisUrl,
      prefix: `nh_lifecycle_${randomUUID().replaceAll('-', '')}`,
      logger: createLogger(() => {}),
    };
    const state = async () =>
      (
        await f.db
          .selectFrom('operation_jobs')
          .select('state')
          .where('id', '=', queued.jobId)
          .executeTakeFirstOrThrow()
      ).state;
    return { isolated, ...f, ...queued, options, transport, createServer, state };
  } catch (error) {
    await isolated.destroy();
    throw error;
  }
}
async function cleanQueue(options: Parameters<typeof createJobTransport>[0]) {
  const transport = createJobTransport(options);
  try {
    await transport.queue.waitUntilReady();
    await transport.queue.obliterate({ force: true });
  } finally {
    await transport.close();
  }
}

describe('PostgreSQL lifecycle recovery through isolated Redis delivery', () => {
  it('delivers a real provision command and absorbs duplicate deliveries', async () => {
    const f = await fixture();
    let runtime: Awaited<ReturnType<typeof startJobWorker>> | undefined;
    try {
      runtime = await startJobWorker({
        db: f.db,
        ...f.transport,
        processor: createLifecycleProcessor(f.db, f.options),
        pollIntervalMs: 50,
        recoveryIntervalMs: 100,
      });
      await eventually(async () => (await f.state()) === 'succeeded');
      await runtime.queue.add('duplicate', { jobId: f.jobId });
      await eventually(
        async () =>
          !!runtime &&
          (await runtime.queue.getActiveCount()) === 0 &&
          (await runtime.queue.getWaitingCount()) === 0,
      );
      expect(f.createServer).toHaveBeenCalledTimes(1);
      expect(
        await f.db.selectFrom('job_steps').select('step').where('job_id', '=', f.jobId).execute(),
      ).toEqual([{ step: 'server.provision.complete' }]);
    } finally {
      await runtime?.close();
      await cleanQueue(f.transport);
      await f.isolated.destroy();
    }
  });
  it('rebuilds lost Redis delivery from the PostgreSQL outbox without duplicate provisioning', async () => {
    const f = await fixture();
    const transport = createJobTransport(f.transport);
    let runtime: Awaited<ReturnType<typeof startJobWorker>> | undefined;
    try {
      await transport.queue.waitUntilReady();
      expect(await dispatchOutbox(f.db, transport.queue, { recoveryIntervalMs: 100 })).toBe(1);
      await transport.queue.obliterate({ force: true });
      expect(await f.state()).toBe('queued');
      runtime = await startJobWorker({
        db: f.db,
        ...f.transport,
        processor: createLifecycleProcessor(f.db, f.options),
        pollIntervalMs: 50,
        recoveryIntervalMs: 100,
      });
      await eventually(async () => (await f.state()) === 'succeeded');
      expect(f.createServer).toHaveBeenCalledTimes(1);
    } finally {
      await runtime?.close();
      await transport.close();
      await cleanQueue(f.transport);
      await f.isolated.destroy();
    }
  });
  it('recovers a prepared external effect after worker loss using a fresh processor', async () => {
    const f = await fixture();
    let runtime: Awaited<ReturnType<typeof startJobWorker>> | undefined;
    try {
      const crashed = {
        ...f.options,
        checkpoint: async (point: string) => {
          if (point === 'remote_succeeded')
            throw new Error('simulated worker loss after provider committed');
        },
      };
      expect(await processServerOperation(f.db, f.jobId, crashed)).toBe('waiting');
      expect(
        (
          await f.db
            .selectFrom('managed_servers')
            .select('pterodactyl_id')
            .where('id', '=', f.serverId)
            .executeTakeFirstOrThrow()
        ).pterodactyl_id,
      ).toBeNull();
      await f.db
        .updateTable('operation_jobs')
        .set({ next_attempt_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', f.jobId)
        .execute();
      await f.db
        .updateTable('job_outbox')
        .set({ next_dispatch_at: sql<Date>`clock_timestamp()` })
        .where('job_id', '=', f.jobId)
        .execute();
      runtime = await startJobWorker({
        db: f.db,
        ...f.transport,
        processor: createLifecycleProcessor(f.db, f.options),
        pollIntervalMs: 50,
        recoveryIntervalMs: 100,
      });
      await eventually(async () => (await f.state()) === 'succeeded');
      expect(f.createServer).toHaveBeenCalledTimes(1);
      expect(
        (
          await f.db
            .selectFrom('managed_servers')
            .select('pterodactyl_uuid')
            .where('id', '=', f.serverId)
            .executeTakeFirstOrThrow()
        ).pterodactyl_uuid,
      ).toBeTruthy();
    } finally {
      await runtime?.close();
      await cleanQueue(f.transport);
      await f.isolated.destroy();
    }
  });
});
