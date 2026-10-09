import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { GatewayRoute } from '@nickhosting/game-sdk';
import { safetyProviderServerSchema } from '@nickhosting/gateway-safety';
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
let app: ReturnType<typeof createApp>,
  env: Record<string, string>,
  serverId: string,
  route: GatewayRoute;
const token = randomBytes(32).toString('base64url'),
  secret = randomBytes(32).toString('base64url');
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
const processStart = vi.fn<() => Promise<string | null>>(async () => null);
const logs: unknown[] = [];
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
  f = await managementFixture(database.db, { interactive: true });
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
    !server.pterodactyl_identifier
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
    user: 1,
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
    identity: async () => {
      throw new DomainError('unauthenticated');
    },
    management: async () =>
      ({
        adapter: f.adapter,
        refreshObservations: () => f.observe(),
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
  it('rejects stale routes, foreign server selectors and unexpected credentials in requests', async () => {
    expect(
      (
        await request(`${prefix()}/context`, {
          routeId: route.id,
          routeRevision: route.revision + 1,
        })
      ).status,
    ).toBe(409);
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
  it('cannot mark a container playable without a corroborated running process', async () => {
    expect((await request(`${prefix()}/observations`, observation())).status).toBe(204);
    expect((await getGatewayState(f.db, serverId)).state).not.toBe('online');
    expect(processStart).toHaveBeenCalledWith(serverId, f.db);
  });
  it('fails closed when fresh resource observation is insufficient', async () => {
    const failed = createApp({
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
