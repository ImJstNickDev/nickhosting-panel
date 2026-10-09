import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { createJobTransport, probeRedis } from '@nickhosting/jobs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as startWorker } from '../../../apps/worker/src/main.js';
import { getOwnerHealth, recordGatewayContact, recordWorkerHeartbeat } from './health.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
const prefix = `health_${randomUUID().replaceAll('-', '')}`;
const redisProbe = vi.fn(async () => 'healthy' as const);
const management = vi.fn(async () => ({
  adapter: {
    discoverCapabilities: async () => ({
      nodes: { available: true },
      nests: { available: true },
      servers: { available: true },
      users: { available: true },
      client: { available: true },
    }),
  },
}));
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  await f.db.deleteFrom('service_heartbeats').execute();
  management.mockClear();
  redisProbe.mockClear();
});

describe('Owner health from actual bounded evidence', () => {
  it('requires regular Owner authority before probes', async () => {
    await expect(
      getOwnerHealth(f.db, f.context, {}, { management, redisProbe }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      getOwnerHealth(f.db, { ...f.owner, sessionType: 'support' }, {}, { management, redisProbe }),
    ).rejects.toBeDefined();
    expect(management).not.toHaveBeenCalled();
    expect(redisProbe).not.toHaveBeenCalled();
  });

  it('shows missing configuration and observations honestly without probing providers', async () => {
    const result = await getOwnerHealth(f.db, f.owner, {}, { management, redisProbe });
    expect(result.worker.status).toBe('unconfigured');
    expect(result.gateway.controlPlane.status).toBe('disabled');
    expect(result.gateway.listenerReadiness.status).toBe('unknown');
    expect(result.provider.status).toBe('unconfigured');
    expect(result.services.sftp).toMatchObject({
      configured: false,
      connectivity: 'unverified',
      releaseGate: 18,
    });
    expect(management).not.toHaveBeenCalled();
  });

  it('separates current worker prefix progress, stale heartbeats and stopped instances', async () => {
    const instance = randomUUID();
    await recordWorkerHeartbeat(f.db, instance, 'unrelated_isolated_prefix', 'running');
    const options = { management, redisProbe };
    expect(
      (await getOwnerHealth(f.db, f.owner, { NH_JOB_PREFIX: prefix }, options)).worker.status,
    ).toBe('unknown');
    await recordWorkerHeartbeat(f.db, randomUUID(), prefix, 'running');
    expect(
      (await getOwnerHealth(f.db, f.owner, { NH_JOB_PREFIX: prefix }, options)).worker.status,
    ).toBe('healthy');
    await f.db
      .updateTable('service_heartbeats')
      .set({ observed_at: new Date(Date.now() - 60_000) })
      .execute();
    expect(
      (await getOwnerHealth(f.db, f.owner, { NH_JOB_PREFIX: prefix }, options)).worker.status,
    ).toBe('stale');
    await recordWorkerHeartbeat(f.db, randomUUID(), prefix, 'stopped');
    expect(
      (await getOwnerHealth(f.db, f.owner, { NH_JOB_PREFIX: prefix }, options)).worker.status,
    ).toBe('unavailable');
  });

  it('does not confuse authenticated Gateway contact with listener readiness', async () => {
    const gatewayId = randomUUID();
    const env = { NH_GATEWAY_ENABLED: 'true', NH_GATEWAY_ID: gatewayId };
    expect(
      (await getOwnerHealth(f.db, f.owner, env, { management, redisProbe })).gateway.controlPlane
        .status,
    ).toBe('unknown');
    await recordGatewayContact(f.db, gatewayId);
    const result = await getOwnerHealth(f.db, f.owner, env, { management, redisProbe });
    expect(result.gateway.controlPlane.status).toBe('healthy');
    expect(result.gateway.listenerReadiness.status).toBe('unknown');
    expect(result.gateway.routes).toEqual({ enabled: 0, leased: 0 });
  });

  it('never presents stale, mismatched or unobserved physical hosts as current', async () => {
    await f.db
      .updateTable('host_observations')
      .set({ observed_at: new Date(Date.now() - 60_000) })
      .where('host_id', '=', f.hostId)
      .execute();
    let host = (
      await getOwnerHealth(f.db, f.owner, {}, { management, redisProbe })
    ).hosts.items.find((entry) => entry.id === f.hostId);
    expect(host?.status).toBe('unknown'); // embedded measurement timestamp no longer matches
    await f.observe({}, new Date(Date.now() - 60_000));
    host = (await getOwnerHealth(f.db, f.owner, {}, { management, redisProbe })).hosts.items.find(
      (entry) => entry.id === f.hostId,
    );
    expect(host?.status).toBe('stale');
    await f.db.deleteFrom('host_observations').where('host_id', '=', f.hostId).execute();
    host = (await getOwnerHealth(f.db, f.owner, {}, { management, redisProbe })).hosts.items.find(
      (entry) => entry.id === f.hostId,
    );
    expect(host?.status).toBe('unknown');
  });

  it('reports sanitized read scopes without claiming provider write authority', async () => {
    const secret = 'private-fixture-value';
    const env = {
      NH_PTERODACTYL_BASE_URL: 'https://provider.example.test',
      NH_PTERODACTYL_APPLICATION_KEY: secret,
      NH_PTERODACTYL_CLIENT_KEY: secret,
    };
    const capabilities = {
      adapter: {
        discoverCapabilities: async () => ({
          nodes: { available: true },
          nests: { available: false, reason: secret },
          servers: { available: true },
          users: { available: false, reason: 'permission_denied' },
          client: { available: true },
        }),
      },
    };
    const result = await getOwnerHealth(f.db, f.owner, env, {
      management: async () => capabilities,
      redisProbe,
    });
    expect(result.provider.status).toBe('degraded');
    expect(result.provider.writeScopes).toBe('unverified');
    expect(result.provider.readScopes.find((scope) => scope.scope === 'users')).toMatchObject({
      available: false,
      reason: 'permission_denied',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('https://provider.example.test');
  });

  it('uses real isolated Redis PING and keeps errors sanitized', async () => {
    const redisUrl = process.env.NH_TEST_REDIS_URL;
    if (!redisUrl) throw new Error('Approved isolated Redis required');
    const parsed = new URL(redisUrl);
    if (
      ![process.env.NH_TEST_VERIFIED_REDIS_HOST, '127.0.0.1', 'localhost', '[::1]'].includes(
        parsed.hostname,
      )
    )
      throw new Error('Unapproved Redis');
    expect(await probeRedis(redisUrl)).toBe('healthy');
    parsed.password = 'wrong-isolated-fixture-password';
    expect(await probeRedis(parsed.toString())).toBe('unavailable');
    expect(await probeRedis(undefined)).toBe('unconfigured');
    expect(await probeRedis('https://not-a-redis.example')).toBe('unavailable');
  });

  it('persists a real worker polling heartbeat and stopped state on shutdown', async () => {
    const isolated = await createTestDatabase();
    const redisUrl = process.env.NH_TEST_REDIS_URL;
    if (!redisUrl) throw new Error('Approved isolated Redis required');
    const parsed = new URL(redisUrl);
    if (
      ![process.env.NH_TEST_VERIFIED_REDIS_HOST, '127.0.0.1', 'localhost', '[::1]'].includes(
        parsed.hostname,
      )
    )
      throw new Error('Unapproved Redis');
    const databaseUrl = new URL(process.env.NH_TEST_DATABASE_URL ?? '');
    databaseUrl.searchParams.set('options', `-c search_path=${isolated.schema}`);
    const workerPrefix = `health_worker_${randomUUID().replaceAll('-', '')}`;
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      worker = await startWorker({
        DATABASE_URL: databaseUrl.toString(),
        REDIS_URL: redisUrl,
        NH_JOB_PREFIX: workerPrefix,
      });
      await vi.waitFor(
        async () => {
          const row = await isolated.db
            .selectFrom('service_heartbeats')
            .selectAll()
            .where('service', '=', 'worker')
            .executeTakeFirst();
          expect(row?.state).toBe('running');
        },
        { timeout: 5000 },
      );
      await worker.close();
      expect(
        (
          await isolated.db
            .selectFrom('service_heartbeats')
            .selectAll()
            .where('service', '=', 'worker')
            .executeTakeFirst()
        )?.state,
      ).toBe('stopped');
    } finally {
      await worker?.close();
      const cleanup = createJobTransport({
        redisUrl,
        prefix: workerPrefix,
        logger: createLogger(() => {}),
      });
      try {
        await cleanup.queue.waitUntilReady();
        await cleanup.queue.obliterate({ force: true });
      } finally {
        await cleanup.close();
        await isolated.destroy();
      }
    }
    await delay(1);
  });
});
