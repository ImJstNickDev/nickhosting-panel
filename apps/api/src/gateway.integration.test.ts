import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger, DomainError, type LogRecord, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { GatewayRoute } from '@nickhosting/game-sdk';
import { safetyProviderServerSchema } from '@nickhosting/gateway-safety';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import {
  getGatewaySnapshot,
  getGatewayState,
  type ManagementRuntime,
  setGatewayPolicy,
  setGatewayRoute,
} from '@nickhosting/server-management';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp } from './app.js';

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
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let refreshHost: ReturnType<typeof vi.fn>;
let app: ReturnType<typeof createApp>,
  env: Record<string, string>,
  serverId: string,
  route: GatewayRoute;
const token = randomBytes(32).toString('base64url'),
  secret = randomBytes(32).toString('base64url');
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
const processStart = vi.fn<() => Promise<string | null>>(async () => null);
const logs: unknown[] = [];
const timingLogs: LogRecord[] = [];
let throwTimingSink = false;
let remote: Awaited<ReturnType<typeof f.adapter.getApplicationServer>>;
let routeInput: Parameters<typeof setGatewayRoute>[2];
const prefix = () => `/internal/gateway/${env.NH_GATEWAY_ID}`;
async function request(path: string, data?: unknown, headers: Record<string, string> = {}) {
  return app.request(`http://localhost:3999${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
const observation = (patch: Record<string, unknown> = {}) => ({
  routeId: route.id,
  routeRevision: route.revision,
  routes: [{ routeId: route.id, routeRevision: route.revision }],
  generation: route.generation,
  ...(route.wakeJobId ? { wakeJobId: route.wakeJobId } : {}),
  observedAt: new Date().toISOString(),
  ready: true,
  idle: true,
  playerCount: 0,
  activeSessions: 0,
  ...patch,
});
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  timingLogs.length = 0;
  throwTimingSink = false;
  f = await managementFixture(database.db, { interactive: true });
  refreshHost = vi.fn(() => f.observe());
  serverId = await f.server();
  const server = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  const claim = await f.db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  env = {
    NH_GATEWAY_ENABLED: 'true',
    NH_GATEWAY_ID: randomUUID(),
    NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
    NH_GATEWAY_CONTROL_TOKEN: token,
    NH_PTERODACTYL_APPLICATION_KEY: secret,
    NH_GATEWAY_NETWORK_POLICY: JSON.stringify({
      nodes: [{ nodeId: f.providerNodeId, nodeUuid: f.nodeId, networkMode: 'fixture-bridge' }],
      maximumObservationAgeMs: 5000,
    }),
  };
  await setGatewayPolicy(f.db, f.context, serverId, policy);
  routeInput = {
    serverId,
    allocationId: claim.id,
    publicAddress: f.backendAllocationPool.gatewayBindAddresses[0],
    publicPort: 26000,
    transport: 'tcp',
  };
  await setGatewayRoute(f.db, f.owner, routeInput, env);
  const first = (await getGatewaySnapshot(f.db, env)).routes[0];
  if (
    !first ||
    !server.pterodactyl_id ||
    !server.pterodactyl_uuid ||
    !server.pterodactyl_identifier ||
    server.provider_user_id === null
  )
    throw new Error('Incomplete isolated fixture');
  route = first;
  remote = {
    id: server.pterodactyl_id,
    uuid: server.pterodactyl_uuid,
    external_id: server.external_id,
    identifier: server.pterodactyl_identifier,
    name: secret,
    description: secret,
    suspended: false,
    limits: f.limits,
    feature_limits: { databases: 0, allocations: 1, backups: 1 },
    user: server.provider_user_id,
    node: f.providerNodeId,
    allocation: claim.pterodactyl_allocation_id,
    nest: 1,
    egg: 1,
    status: null,
    container: { startup_command: secret, image: secret, installed: true },
    relationships: {
      allocations: {
        object: 'list',
        data: [
          {
            attributes: {
              id: claim.pterodactyl_allocation_id,
              ip: claim.address,
              port: claim.port,
              assigned: true,
              alias: secret,
            },
          },
        ],
      },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  Object.assign(f.adapter, {
    listNodes: vi.fn(async () => [{ id: f.providerNodeId, uuid: f.nodeId, fqdn: secret }]),
    getApplicationServer: vi.fn(async () => remote),
    listAllocations: vi.fn(async () => [
      {
        id: claim.pterodactyl_allocation_id,
        ip: claim.address,
        port: claim.port,
        assigned: true,
        alias: secret,
      },
    ]),
  });
  processStart.mockReset().mockResolvedValue(null);
  app = createApp({
    database,
    codec,
    origins: ['http://localhost:3999'],
    env,
    log: (r) => logs.push(r),
    logger: createLogger((record) => {
      timingLogs.push(record);
      if (throwTimingSink) throw new Error('private-log-sink');
    }),
    identity: async () => {
      throw new DomainError('unauthenticated');
    },
    management: async () =>
      ({
        adapter: f.adapter,
        refreshObservations: refreshHost,
        lifecycle: { observeProcessStart: processStart },
      }) as unknown as ManagementRuntime,
  });
});
describe('M3 Core service authentication and managed control plane', () => {
  it.each<Record<string, string>>([
    { authorization: '' },
    { authorization: 'Bearer wrong' },
    { authorization: '', cookie: 'session=fake' },
    { 'x-nh-support-token': 'fake' },
  ])('rejects non-service authority %j', async (headers) => {
    expect((await request(`${prefix()}/snapshot`, undefined, headers)).status).toBe(401);
  });
  it('scopes the service identity to one configured Gateway and never grants browser authority', async () => {
    expect((await request(`/internal/gateway/${randomUUID()}/snapshot`)).status).toBe(401);
    expect((await request('/v1/owner/gateway/routes')).status).toBe(401);
    // The machine CSRF exception applies only to its narrow, separately authenticated path.
    expect((await request('/v1/owner/gateway/routes', {})).status).toBe(403);
  });
  it('returns durable snapshots/configuration without any provider or control secret', async () => {
    for (const path of ['snapshot', 'configuration']) {
      const response = await request(`${prefix()}/${path}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(secret);
      expect(text).not.toContain(token);
    }
  });
  it('negotiates terminal sleep evidence without breaking strict legacy snapshot clients', async () => {
    const operation = await f.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const completedAt = new Date(Date.now() - 1000);
    await f.db
      .updateTable('server_operations')
      .set({
        action: 'stop',
        phase: 'complete',
        effect_state: 'confirmed',
        plan: JSON.stringify({
          stopConfirmed: true,
          stopConfirmedAt: completedAt.toISOString(),
          gatewayAutomation: {
            kind: 'sleep',
            generation: route.generation,
            quiescenceUntil: new Date(Date.now() + 10000).toISOString(),
          },
        }),
      })
      .where('job_id', '=', operation.job_id)
      .execute();
    await f.db
      .updateTable('operation_jobs')
      .set({ state: 'succeeded', completed_at: completedAt })
      .where('id', '=', operation.job_id)
      .execute();
    await f.db
      .updateTable('gateway_server_states')
      .set({ state: 'sleeping', sleep_job_id: null })
      .where('server_id', '=', serverId)
      .execute();
    const legacy = await request(`${prefix()}/snapshot`);
    expect(legacy.status).toBe(200);
    const oldPayload = await legacy.json();
    expect(oldPayload.routes[0].completedSleep).toBeUndefined();
    expect(oldPayload.routes[0].presentation.variables).toBeUndefined();
    const modern = await request(`${prefix()}/snapshot`, undefined, {
      'X-NickHosting-Gateway-Features': 'completed-sleep-v1',
    });
    expect(modern.status).toBe(200);
    const newPayload = await modern.json();
    expect(newPayload.routes[0].completedSleep).toMatchObject({ jobId: operation.job_id });
    expect(newPayload.routes[0].presentation.variables).toBeUndefined();
    for (const features of [
      'presentation-variables-v1',
      'completed-sleep-v1, presentation-variables-v1,unknown-v1',
    ]) {
      const capable = await request(`${prefix()}/snapshot`, undefined, {
        'X-NickHosting-Gateway-Features': features,
      });
      expect(capable.status).toBe(200);
      const payload = await capable.json();
      expect(payload.routes[0].presentation.variables).toEqual(route.presentation?.variables);
      const { variables: _variables, ...presentation } = payload.routes[0].presentation;
      expect(presentation).toEqual(oldPayload.routes[0].presentation);
      expect(payload.routes[0].completedSleep !== undefined).toBe(
        features.includes('completed-sleep-v1'),
      );
    }
    expect(newPayload.revision).toBe(oldPayload.revision);
    expect(newPayload.routes[0].revision).toBe(oldPayload.routes[0].revision);
  });

  it('returns bounded provider cooldown only after Gateway authentication', async () => {
    vi.mocked(f.adapter.listNodes).mockRejectedValue(
      new PterodactylError('rate_limited', 'application', 'rejected', 429, 1700),
    );
    const response = await request(`${prefix()}/inventory`, { operation: 'nodes' });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toMatchObject({
      error: {
        code: 'integration_unavailable',
        messageKey: 'errors.integration_unavailable',
        details: { gatewayControlReason: 'provider_rate_limited', retryAfterMs: 1700 },
      },
    });
    const denied = await app.request(`${prefix()}/inventory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'nodes' }),
    });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain('provider_rate_limited');
  });
  it('narrows provider inventory and verifies managed provenance', async () => {
    for (const data of [
      { operation: 'nodes' },
      { operation: 'allocations', nodeId: f.providerNodeId },
      { operation: 'server', routeId: route.id },
    ]) {
      const response = await request(`${prefix()}/inventory`, data);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(secret);
      if (data.operation === 'server')
        expect(safetyProviderServerSchema.safeParse(JSON.parse(text)).success).toBe(true);
    }
    expect(
      (await request(`${prefix()}/inventory`, { operation: 'allocations', nodeId: 1 })).status,
    ).toBe(404);
    remote = { ...remote, external_id: randomUUID() };
    expect(
      (await request(`${prefix()}/inventory`, { operation: 'server', routeId: route.id })).status,
    ).toBe(409);
  });
  it('scopes allocations to configured nodes without duplicating fresh node discovery', async () => {
    const before = vi.mocked(f.adapter.listNodes).mock.calls.length;
    expect(
      (
        await request(`${prefix()}/inventory`, {
          operation: 'allocations',
          nodeId: f.providerNodeId,
        })
      ).status,
    ).toBe(200);
    expect(f.adapter.listNodes).toHaveBeenCalledTimes(before);
    expect(f.adapter.listAllocations).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(`${prefix()}/inventory`, {
          operation: 'allocations',
          nodeId: f.providerNodeId + 1,
        })
      ).status,
    ).toBe(404);
    expect(f.adapter.listAllocations).toHaveBeenCalledTimes(1);
    // Absence of an Owner policy never widens discovery to provider-wide nodes.
    delete env.NH_GATEWAY_NETWORK_POLICY;
    expect(
      (
        await request(`${prefix()}/inventory`, {
          operation: 'allocations',
          nodeId: f.providerNodeId,
        })
      ).status,
    ).toBe(404);
    expect(f.adapter.listAllocations).toHaveBeenCalledTimes(1);
  });
  it('rejects stale routes, foreign server selectors and unexpected credentials in requests', async () => {
    expect(
      (
        await request(`${prefix()}/context`, {
          routeId: route.id,
          routeRevision: route.revision + 1,
        })
      ).status,
    ).toBe(412);
    expect((await request(`${prefix()}/context`, { routeId: randomUUID() })).status).toBe(404);
    expect(
      (
        await request(`${prefix()}/inventory`, {
          operation: 'server',
          routeId: route.id,
          serverId: remote.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`${prefix()}/wake`, {
          routeId: route.id,
          routeRevision: route.revision,
          requestId: randomUUID(),
          applicationKey: secret,
        })
      ).status,
    ).toBe(400);
  });
  it('distinguishes an idle-state revision race from ownership or topology failures', async () => {
    // A normal idle observation changes sleepEligibleAt while the Gateway is
    // collecting inventory and reachability evidence for an earlier snapshot.
    await f.db
      .updateTable('gateway_server_states')
      .set({
        state: 'online',
        idle_since: new Date(),
        readiness_observed_at: new Date(),
        process_started_at: new Date().toISOString(),
      })
      .where('server_id', '=', serverId)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running', intent: 'auto_wake_enabled' })
      .where('id', '=', serverId)
      .execute();
    const fresh = (await getGatewaySnapshot(f.db, env)).routes[0];
    expect(fresh?.revision).toBeGreaterThan(route.revision);
    for (const action of ['context', 'proof-read']) {
      const response = await request(`${prefix()}/${action}`, {
        routeId: route.id,
        routeRevision: route.revision,
      });
      expect(response.status).toBe(412);
      expect(await response.json()).toMatchObject({
        error: { code: 'conflict', messageKey: 'errors.conflict', status: 412 },
      });
    }
    expect(
      (await request(`${prefix()}/context`, { routeId: route.id, routeRevision: fresh?.revision }))
        .status,
    ).toBe(200);
  });
  it('persists scoped reachability evidence and rejects tampering/replay', async () => {
    const proof = {
      version: 1 as const,
      routeId: route.id,
      serverId,
      allocationId: route.allocationId,
      namespaceId: 'net:[123]',
      dockerDaemonId: 'fixture',
      digest: 'a'.repeat(64),
      verifiedAt: Date.now(),
    };
    const body = { routeId: route.id, routeRevision: route.revision, proof };
    expect((await request(`${prefix()}/proof-write`, body)).status).toBe(204);
    expect(await (await request(`${prefix()}/proof-read`, { routeId: route.id })).json()).toEqual(
      proof,
    );
    for (const patch of [
      { serverId: randomUUID() },
      { allocationId: randomUUID() },
      { verifiedAt: Date.now() - 60000 },
      { verifiedAt: Date.now() + 60000 },
    ])
      expect(
        (await request(`${prefix()}/proof-write`, { ...body, proof: { ...proof, ...patch } }))
          .status,
      ).toBe(409);
  });
  it.each([false, true])(
    'correlates safe wake phases with the durable job even when logging fails=%s',
    async (throwSink) => {
      throwTimingSink = throwSink;
      const wakeRequestId = randomUUID();
      const response = await request(`${prefix()}/wake`, {
        routeId: route.id,
        routeRevision: route.revision,
        requestId: wakeRequestId,
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { operationId: string };
      expect(refreshHost).toHaveBeenCalledWith(database.db, serverId);
      const phases = timingLogs.filter((record) => record.event === 'gateway.wake_stage');
      expect(phases.map((record) => (record.data as Record<string, unknown>).stage)).toEqual([
        'route_validation',
        'management_configuration',
        'host_sampling',
        'admission_and_enqueue',
      ]);
      expect(timingLogs.at(-1)).toMatchObject({
        event: 'gateway.wake_completed',
        data: {
          jobId: result.operationId,
          wakeRequestId,
          serverId,
          routeId: route.id,
          mode: 'waking',
          outcome: 'succeeded',
        },
      });
      for (const record of timingLogs) {
        expect(record.data).toMatchObject({
          requestId: response.headers.get('x-request-id'),
          durationMs: expect.any(Number),
        });
        expect((record.data as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
      }
      expect(JSON.stringify(timingLogs)).not.toContain(token);
      expect(JSON.stringify(timingLogs)).not.toContain(secret);
      expect(JSON.stringify(timingLogs)).not.toContain('private-log-sink');
    },
  );
  it('uses real M2 admission for a burst wake and persists just one authorized operation', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(`${prefix()}/wake`, {
          routeId: route.id,
          routeRevision: route.revision,
          requestId: randomUUID(),
        }),
      ),
    );
    expect(responses.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect(responses.some((r) => r.status === 200)).toBe(true);
    expect(
      await f.db
        .selectFrom('server_operations')
        .selectAll()
        .where('server_id', '=', serverId)
        .where('action', '=', 'start')
        .execute(),
    ).toHaveLength(1);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
  });
  it('refuses omitted, extra, stale and client-supplied process evidence', async () => {
    expect((await request(`${prefix()}/observations`, observation({ routes: [] }))).status).toBe(
      400,
    );
    expect(
      (
        await request(
          `${prefix()}/observations`,
          observation({
            routes: [
              { routeId: route.id, routeRevision: route.revision },
              { routeId: randomUUID(), routeRevision: 1 },
            ],
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `${prefix()}/observations`,
          observation({ processStartedAt: new Date().toISOString() }),
        )
      ).status,
    ).toBe(400);
    await setGatewayRoute(f.db, f.owner, { ...(routeInput as object), transport: 'udp' }, env);
    expect((await request(`${prefix()}/observations`, observation())).status).toBe(409);
    expect(processStart).not.toHaveBeenCalled();
  });
  it('checks the complete route set again after a delayed provider observation', async () => {
    processStart.mockImplementationOnce(async () => {
      await setGatewayRoute(f.db, f.owner, { ...(routeInput as object), transport: 'udp' }, env);
      return null;
    });
    expect((await request(`${prefix()}/observations`, observation())).status).toBe(409);
  });
  it.each(['', 'readiness-receipt-v1', 'readiness-receipt-v1,presentation-variables-v1'])(
    'logs accepted readiness timing and negotiates receipt=%s',
    async (receipt) => {
      const startedAt = new Date(Date.now() - 1000).toISOString();
      await f.db
        .updateTable('managed_servers')
        .set({ runtime_state: 'running', intent: 'auto_wake_enabled' })
        .where('id', '=', serverId)
        .execute();
      await f.db
        .updateTable('gateway_server_states')
        .set({ state: 'waking', process_started_at: startedAt })
        .where('server_id', '=', serverId)
        .execute();
      processStart.mockResolvedValue(startedAt);
      route =
        (await getGatewaySnapshot(f.db, env)).routes[0] ??
        (() => {
          throw new Error('Missing fixture route');
        })();
      const accepted = await request(
        `${prefix()}/observations`,
        observation(),
        receipt ? { 'X-NickHosting-Gateway-Features': receipt } : {},
      );
      expect(accepted.status).toBe(receipt ? 200 : 204);
      if (receipt) {
        const payload = await accepted.json();
        expect(payload.routes[0].presentation.variables).toEqual(
          receipt.includes('presentation-variables-v1') ? route.presentation?.variables : undefined,
        );
        expect(payload).toMatchObject({
          gatewayId: env.NH_GATEWAY_ID,
          routes: [expect.objectContaining({ id: route.id, mode: 'online' })],
        });
      }
      expect(timingLogs).toHaveLength(1);
      expect(timingLogs[0]).toMatchObject({
        event: 'gateway.observation_state_changed',
        data: {
          from: 'waking',
          to: 'online',
          serverId,
          routeId: route.id,
          validationMs: expect.any(Number),
          processVerificationMs: expect.any(Number),
          observationCommitMs: expect.any(Number),
          managementConfigurationMs: expect.any(Number),
          completedAt: expect.any(String),
        },
      });
      route =
        (await getGatewaySnapshot(f.db, env)).routes[0] ??
        (() => {
          throw new Error('Missing fixture route');
        })();
      expect((await request(`${prefix()}/observations`, observation())).status).toBe(204);
      expect(timingLogs).toHaveLength(1);
    },
  );
  it('cannot mark a container playable without a corroborated running process', async () => {
    expect((await request(`${prefix()}/observations`, observation())).status).toBe(204);
    expect((await getGatewayState(f.db, serverId)).state).not.toBe('online');
    expect(processStart).toHaveBeenCalledWith(serverId, f.db);
  });
  it('fails closed when fresh resource observation is insufficient', async () => {
    const failed = createApp({
      logger: createLogger((record) => {
        timingLogs.push(record);
        throw new Error('private-sink-failure');
      }),
      database,
      codec,
      origins: [],
      env,
      identity: async () => {
        throw new DomainError('unauthenticated');
      },
      management: async () =>
        ({
          refreshObservations: async () => {
            throw new DomainError('integration_unavailable');
          },
        }) as unknown as ManagementRuntime,
    });
    const result = await failed.request(`http://localhost${prefix()}/wake`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        routeId: route.id,
        routeRevision: route.revision,
        requestId: randomUUID(),
      }),
    });
    expect(result.status).toBe(503);
    expect(timingLogs.at(-2)).toMatchObject({
      event: 'gateway.wake_stage',
      data: { stage: 'host_sampling', outcome: 'failed' },
    });
    expect(timingLogs.at(-1)).toMatchObject({
      event: 'gateway.wake_completed',
      data: { outcome: 'failed' },
    });
    expect(JSON.stringify(timingLogs)).not.toContain('private-sink-failure');
    expect(
      await f.db
        .selectFrom('server_operations')
        .selectAll()
        .where('server_id', '=', serverId)
        .where('action', '=', 'start')
        .execute(),
    ).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(token);
  });
});

it('rejects sleep fences outside issued authority or expired during independent process observation', async () => {
  expect(
    (
      await request(
        `${prefix()}/observations`,
        observation({ quiescenceUntil: new Date(Date.now() + 60000).toISOString() }),
      )
    ).status,
  ).toBe(409);
  processStart.mockImplementationOnce(async () => {
    await delay(80);
    return null;
  });
  expect(
    (
      await request(
        `${prefix()}/observations`,
        observation({ quiescenceUntil: new Date(Date.now() + 30).toISOString() }),
      )
    ).status,
  ).toBe(409);
  expect(
    await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('action', '=', 'stop')
      .execute(),
  ).toEqual([]);
});
