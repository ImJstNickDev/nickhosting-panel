import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger, DomainError, type LogRecord, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { GatewayRoute } from '@nickhosting/game-sdk';
import { safetyProviderServerSchema } from '@nickhosting/gateway-safety';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import {
  ensureSatisfactoryTlsIdentity,
  getGatewaySnapshot,
  getGatewayState,
  type ManagementRuntime,
  setGatewayPolicy,
  setGatewayRoute,
} from '@nickhosting/server-management';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SatisfactoryApi } from '../../../games/satisfactory/src/api.js';
import {
  createNativeAuthenticationToken,
  decodeNativePlayerIdentity,
} from '../../../games/satisfactory/src/native-auth.js';
import * as consoleLifecycle from '../../../packages/server-management/src/gateway-orchestration.js';
import * as satisfactoryApi from '../../../packages/server-management/src/satisfactory-api.js';
import * as nativeCredentials from '../../../packages/server-management/src/satisfactory-native-credentials.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp } from './app.js';
import {
  observeSatisfactorySessions,
  persistSatisfactoryOfflineSnapshots,
} from './gateway-satisfactory-offline.js';

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
    getApplicationServers: vi.fn(async () => [remote]),
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
        lifecycle: {
          observeProcessStart: processStart,
          confirmInitialInstallationStopped: async () => true,
        },
      }) as unknown as ManagementRuntime,
  });
});
describe('M3 Core service authentication and managed control plane', () => {
  async function satisfactoryRoute(transport: 'tcp' | 'udp' = 'tcp') {
    await f.db
      .insertInto('game_integrations')
      .values({ id: 'satisfactory', version: '1.0.0', manifest: {} })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ game_id: 'satisfactory', runtime_id: 'dedicated' })
      .where('id', '=', f.mappingId)
      .execute();
    await f.db
      .updateTable('gateway_server_states')
      .set({ protocol_id: 'satisfactory' })
      .where('server_id', '=', serverId)
      .execute();
    await f.db
      .updateTable('server_allocations')
      .set({ protocols: ['tcp', 'udp'] })
      .where('id', '=', route.allocationId)
      .execute();
    await f.db
      .updateTable('gateway_routes')
      .set({ transport })
      .where('id', '=', route.id)
      .execute();
    const selected = (await getGatewaySnapshot(f.db, env)).routes.find(
      (entry) => entry.id === route.id,
    );
    if (!selected) throw new Error('Missing Satisfactory fixture route');
    route = selected;
    return { routeId: route.id, routeRevision: route.revision };
  }
  const satisfactoryState = () => ({
    state: 3,
    netCL: 123456,
    flags: '0',
    substates: [{ id: 0, version: 1 }],
    name: 'Factory',
    observedAt: new Date().toISOString(),
  });
  describe('authenticated Satisfactory console commands', () => {
    afterEach(() => vi.restoreAllMocks());
    const credentials = {
      build: 513885,
      serverName: 'Private factory',
      serverSecret: 'A1'.repeat(256),
      adminPassword: { hash: 'B2'.repeat(64), salt: 'C3'.repeat(32) },
    };
    const playerId = '060102030405060708';
    const player = decodeNativePlayerIdentity(playerId);
    if (!player) throw new Error('fixture');
    const admin = createNativeAuthenticationToken(credentials, 'Administrator', player);
    async function setup(mode: 'sleeping' | 'online' = 'sleeping') {
      await satisfactoryRoute();
      await f.db
        .updateTable('gateway_server_states')
        .set({
          state: mode,
          auto_wake_override: true,
          process_started_at: mode === 'online' ? new Date().toISOString() : null,
          readiness_observed_at: mode === 'online' ? new Date() : null,
        })
        .where('server_id', '=', serverId)
        .execute();
      await f.db
        .updateTable('managed_servers')
        .set({
          intent: mode === 'online' ? 'auto_wake_enabled' : 'sleeping',
          runtime_state: mode === 'online' ? 'running' : 'offline',
          automatic_starts_paused: false,
        })
        .where('id', '=', serverId)
        .execute();
      const selected = (await getGatewaySnapshot(f.db, env)).routes.find(
        (entry) => entry.id === route.id,
      );
      if (!selected) throw new Error('fixture');
      route = selected;
      const stopped = vi
        .spyOn(nativeCredentials, 'readStoppedSatisfactoryCredentials')
        .mockResolvedValue({
          credentials,
          generation: route.generation,
          digest: 'D4'.repeat(32),
          providerUuid: remote.uuid,
          port: route.backend.port,
        });
      const verify = vi.fn(async () => undefined);
      const live = vi
        .spyOn(satisfactoryApi, 'resolveSatisfactoryApi')
        .mockResolvedValue(new SatisfactoryApi({ request: verify }));
      const input = (command: string, authorization = `Bearer ${admin}`) => ({
        routeId: route.id,
        routeRevision: route.revision,
        request: { operation: 'RunCommand', data: { Command: command }, authorization, playerId },
      });
      const call = async (command: string) => {
        const response = await request(`${prefix()}/console-command`, input(command));
        expect(response.status).toBe(200);
        return response.json();
      };
      return { input, call, stopped, live, verify };
    }
    it('serves the complete read-only command tree while sleeping, including exact mods text, without waking or exposing credentials', async () => {
      const { call, live } = await setup();
      const wake = vi.spyOn(consoleLifecycle, 'requestGatewayWake');
      for (const command of [
        'nickhosting',
        'nickhosting help stop',
        'nickhosting status',
        'nickhosting info',
        'nickhosting version',
        'nickhosting idle',
        'nickhosting mods',
      ]) {
        const body = await call(command);
        expect(body).toMatchObject({
          status: 200,
          body: { data: { commandResult: expect.any(String), returnValue: true } },
        });
        expect(JSON.stringify(body)).not.toContain(credentials.serverSecret);
        expect(JSON.stringify(body)).not.toContain(admin);
        if (command === 'nickhosting mods')
          expect(body.body.data.commandResult).toBe('Coming Soon :)');
      }
      expect((await call('quit')).body.data.returnValue).toBe(false);
      expect((await call('nickhosting stop')).body.data.returnValue).toBe(true);
      expect((await call('nickhosting restart')).body.data.returnValue).toBe(false);
      expect(wake).not.toHaveBeenCalled();
      expect(live).not.toHaveBeenCalled();
    });
    it('rejects forged, client, application and other-player credentials before returning even help or mods', async () => {
      const { input, live } = await setup();
      for (const authorization of [
        '',
        `Bearer ${createNativeAuthenticationToken(credentials, 'Client', player)}`,
        `Bearer ${admin.slice(0, -2)}00`,
        `Bearer ${Buffer.from(JSON.stringify({ pl: 'APIToken' })).toString('base64')}.${'AA'.repeat(64)}`,
      ]) {
        const response = await request(
          `${prefix()}/console-command`,
          input('nickhosting mods', authorization),
        );
        expect(await response.json()).toMatchObject({ status: 401 });
      }
      const other = input('nickhosting help');
      other.request.playerId = '060102030405060709';
      expect(await (await request(`${prefix()}/console-command`, other)).json()).toMatchObject({
        status: 401,
      });
      expect(live).not.toHaveBeenCalled();
    });
    it('authenticates online with original Administrator token/player and rejects success-shaped non-204 verification', async () => {
      const { call, live, stopped, verify } = await setup('online');
      expect((await call('nickhosting mods')).body.data.commandResult).toBe('Coming Soon :)');
      expect(live).toHaveBeenCalledWith(expect.anything(), codec, serverId, admin, playerId);
      expect(verify).toHaveBeenCalledWith(
        {
          function: 'VerifyAuthenticationToken',
          data: { AuthenticationToken: admin.split('.')[1], PrivilegeLevel: 'Administrator' },
        },
        expect.any(AbortSignal),
      );
      expect(stopped).not.toHaveBeenCalled();
      verify.mockResolvedValueOnce({ data: {} } as never);
      expect(await call('nickhosting mods')).toMatchObject({ status: 401 });
      verify.mockRejectedValueOnce(new DomainError('unauthenticated'));
      expect(await call('nickhosting mods')).toMatchObject({ status: 401 });
    });
    it.each(['sleeping', 'online'] as const)(
      'accepts genuine native anonymous Administrator in %s without inventing a player',
      async (mode) => {
        const { input, live } = await setup(mode);
        const anonymous = decodeNativePlayerIdentity();
        if (!anonymous) throw new Error('fixture');
        const nativeToken = createNativeAuthenticationToken(
          credentials,
          'Administrator',
          anonymous,
        );
        const value = input('nickhosting mods', `Bearer ${nativeToken}`);
        const response = await request(`${prefix()}/console-command`, {
          ...value,
          request: { ...value.request, playerId: undefined },
        });
        expect(await response.json()).toMatchObject({
          status: 200,
          body: { data: { commandResult: 'Coming Soon :)', returnValue: true } },
        });
        if (mode === 'online')
          expect(live).toHaveBeenCalledWith(
            expect.anything(),
            codec,
            serverId,
            nativeToken,
            'INVALID',
          );
      },
    );
    it('checks service identity, transport and revision before native credential access', async () => {
      const { input, stopped } = await setup();
      const value = input('nickhosting status');
      expect(
        (await request(`${prefix()}/console-command`, value, { authorization: '' })).status,
      ).toBe(401);
      expect(
        (
          await request(`${prefix()}/console-command`, {
            ...value,
            routeRevision: route.revision + 1,
          })
        ).status,
      ).toBe(412);
      await f.db
        .updateTable('gateway_routes')
        .set({ transport: 'udp' })
        .where('id', '=', route.id)
        .execute();
      const changed = (await getGatewaySnapshot(f.db, env)).routes.find(
        (entry) => entry.id === route.id,
      );
      if (!changed) throw new Error('fixture');
      expect(
        (
          await request(`${prefix()}/console-command`, {
            ...value,
            routeRevision: changed.revision,
          })
        ).status,
      ).toBe(403);
      expect(stopped).not.toHaveBeenCalled();
    });
    it('revalidates generation after native authentication before allowing an action', async () => {
      const { input, verify } = await setup('online');
      const action = vi.spyOn(consoleLifecycle, 'requestGatewayConsoleAction');
      verify.mockImplementationOnce(async () => {
        await f.db
          .updateTable('gateway_server_states')
          .set({ generation: randomUUID() })
          .where('server_id', '=', serverId)
          .execute();
        return undefined;
      });
      const response = await request(`${prefix()}/console-command`, input('nickhosting stop'));
      expect([409, 412]).toContain(response.status);
      expect(action).not.toHaveBeenCalled();
    });
    it('never requests forced sleep without a configured save credential', async () => {
      const { call } = await setup('online');
      const action = vi.spyOn(consoleLifecycle, 'requestGatewayConsoleAction');
      vi.spyOn(satisfactoryApi, 'satisfactoryApiConfigured').mockResolvedValue(false);
      expect((await call('nickhosting stop')).body.data.returnValue).toBe(false);
      expect(action).not.toHaveBeenCalled();
    });
    it.each(['stop', 'restart'] as const)(
      'sends %s through Core and returns only its accepted transition proof',
      async (command) => {
        const { call } = await setup('online');
        vi.spyOn(satisfactoryApi, 'satisfactoryApiConfigured').mockResolvedValue(true);
        const before = await getGatewayState(f.db, serverId, { env });
        const generation = command === 'restart' ? randomUUID() : before.generation;
        const action = vi.spyOn(consoleLifecycle, 'requestGatewayConsoleAction').mockResolvedValue({
          ...before,
          generation,
          state: command === 'stop' ? 'blocked' : 'waking',
          sleepJobId: command === 'stop' ? randomUUID() : null,
          wakeJobId: command === 'restart' ? randomUUID() : null,
        });
        const result = await call(`nickhosting ${command}`);
        expect(result).toMatchObject({
          status: 200,
          body: { data: { returnValue: true } },
          transition: {
            action: command === 'stop' ? 'sleep' : 'restart',
            previousGeneration: before.generation,
            generation,
          },
        });
        expect(action).toHaveBeenCalledWith(
          expect.anything(),
          serverId,
          {
            generation: before.generation,
            action: command === 'stop' ? 'sleep' : 'restart',
            playerId,
          },
          expect.objectContaining({ env, validateObservation: expect.any(Function) }),
        );
      },
    );
    it('uses existing wake admission for start and returns no accepted proof when blocked', async () => {
      const { call } = await setup();
      const before = await getGatewayState(f.db, serverId, { env });
      const wake = vi
        .spyOn(consoleLifecycle, 'requestGatewayWake')
        .mockResolvedValue({ ...before, state: 'waking', wakeJobId: randomUUID() });
      expect(await call('nickhosting start')).toMatchObject({
        transition: {
          action: 'start',
          previousGeneration: before.generation,
          generation: before.generation,
        },
      });
      expect(wake).toHaveBeenCalledWith(
        expect.anything(),
        serverId,
        { generation: before.generation, intent: 'join' },
        expect.objectContaining({ validateObservation: expect.any(Function) }),
      );
      wake.mockResolvedValueOnce({ ...before, state: 'blocked', wakeJobId: null });
      expect(await call('nickhosting start')).toMatchObject({
        body: { data: { returnValue: false } },
      });
    });
  });
  describe('native stopped Satisfactory API', () => {
    afterEach(() => vi.restoreAllMocks());
    const credentials = {
      build: 513885,
      serverName: 'Synthetic protected server',
      serverSecret: 'A1'.repeat(256),
      adminPassword: { hash: 'B2'.repeat(64), salt: 'C3'.repeat(32) },
    };
    const playerId = '060102030405060708';
    const login = {
      operation: 'PasswordlessLogin',
      playerId,
      data: { MinimumPrivilegeLevel: 'Client' },
    };
    async function setup(transport: 'tcp' | 'udp' = 'tcp') {
      await satisfactoryRoute(transport);
      await f.db
        .updateTable('gateway_server_states')
        .set({ state: 'sleeping', auto_wake_override: true })
        .where('server_id', '=', serverId)
        .execute();
      await f.db
        .updateTable('managed_servers')
        .set({ intent: 'sleeping', runtime_state: 'offline', automatic_starts_paused: false })
        .where('id', '=', serverId)
        .execute();
      const selected = (await getGatewaySnapshot(f.db, env)).routes.find(
        (entry) => entry.id === route.id,
      );
      if (!selected) throw new Error('Missing offline route');
      route = selected;
      const authority = {
        credentials,
        digest: 'D4'.repeat(32),
        generation: route.generation,
        providerUuid: remote.uuid,
        port: route.backend.port,
      };
      const spy = vi
        .spyOn(nativeCredentials, 'readStoppedSatisfactoryCredentials')
        .mockResolvedValue(authority);
      return {
        spy,
        authority,
        input: { routeId: route.id, routeRevision: route.revision, request: login },
      };
    }
    it('rejects another game integration before invoking the native credential service', async () => {
      const spy = vi.spyOn(nativeCredentials, 'readStoppedSatisfactoryCredentials');
      expect(
        (
          await request(`${prefix()}/offline-api`, {
            routeId: route.id,
            routeRevision: route.revision,
            request: login,
          })
        ).status,
      ).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    });
    it('requires authenticated Gateway access and returns only a native token envelope, never credentials', async () => {
      const { input, spy } = await setup();
      const rejectedHeaders: Record<string, string>[] = [
        { authorization: '' },
        { authorization: 'Bearer wrong' },
        { 'x-nh-support-token': 'support' },
      ];
      for (const headers of rejectedHeaders) {
        expect((await request(`${prefix()}/offline-api`, input, headers)).status).toBe(401);
      }
      expect((await request(`/internal/gateway/${randomUUID()}/offline-api`, input)).status).toBe(
        401,
      );
      expect(spy).not.toHaveBeenCalled();
      const response = await request(`${prefix()}/offline-api`, input);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const serialized = await response.text();
      const player = decodeNativePlayerIdentity(playerId);
      if (!player) throw new Error('fixture');
      expect(JSON.parse(serialized)).toEqual({
        status: 200,
        body: {
          data: {
            authenticationToken: createNativeAuthenticationToken(credentials, 'Client', player),
          },
        },
      });
      for (const value of [
        credentials.serverSecret,
        credentials.adminPassword.hash,
        credentials.adminPassword.salt,
        'Synthetic protected server',
        'providerUuid',
        'digest',
      ])
        expect(serialized).not.toContain(value);
      expect(spy).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        serverId,
        expect.objectContaining({ adapter: f.adapter, confirmStopped: expect.any(Function) }),
      );
    });
    it('rejects stale revision and wrong transport/role before reading native credentials', async () => {
      const { input, spy } = await setup('udp');
      expect((await request(`${prefix()}/offline-api`, input)).status).toBe(403);
      expect(
        (await request(`${prefix()}/offline-api`, { ...input, routeRevision: route.revision + 1 }))
          .status,
      ).toBe(412);
      expect(spy).not.toHaveBeenCalled();
      await f.db
        .updateTable('gateway_routes')
        .set({ transport: 'tcp' })
        .where('id', '=', route.id)
        .execute();
      await f.db
        .updateTable('server_allocations')
        .set({ role: 'reliable' })
        .where('id', '=', route.allocationId)
        .execute();
      const selected = (await getGatewaySnapshot(f.db, env)).routes.find(
        (entry) => entry.id === route.id,
      );
      if (!selected) throw new Error('fixture');
      expect(
        (await request(`${prefix()}/offline-api`, { ...input, routeRevision: selected.revision }))
          .status,
      ).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    });
    it.each(['manually_stopped', 'maintenance', 'online', 'waking'] as const)(
      'rejects native auth in %s mode',
      async (mode) => {
        const { input, spy } = await setup();
        await f.db
          .updateTable('gateway_server_states')
          .set({ state: mode })
          .where('server_id', '=', serverId)
          .execute();
        const selected = (await getGatewaySnapshot(f.db, env)).routes.find(
          (entry) => entry.id === route.id,
        );
        if (!selected) throw new Error('fixture');
        expect(
          (await request(`${prefix()}/offline-api`, { ...input, routeRevision: selected.revision }))
            .status,
        ).toBe(503);
        expect(spy).not.toHaveBeenCalled();
      },
    );
    it('rejects disabled wake, unavailable authority and mismatched generation', async () => {
      const { input, spy, authority } = await setup();
      spy.mockResolvedValueOnce(undefined);
      expect((await request(`${prefix()}/offline-api`, input)).status).toBe(503);
      spy.mockResolvedValueOnce({ ...authority, generation: `${authority.generation}0` });
      expect((await request(`${prefix()}/offline-api`, input)).status).toBe(503);
      await f.db
        .updateTable('gateway_server_states')
        .set({ auto_wake_override: false })
        .where('server_id', '=', serverId)
        .execute();
      const selected = (await getGatewaySnapshot(f.db, env)).routes.find(
        (entry) => entry.id === route.id,
      );
      if (!selected) throw new Error('fixture');
      spy.mockClear();
      expect(
        (await request(`${prefix()}/offline-api`, { ...input, routeRevision: selected.revision }))
          .status,
      ).toBe(503);
      expect(spy).not.toHaveBeenCalled();
    });
    it('reads encrypted native observations only after cryptographic auth, without borrowing old cache authorization', async () => {
      const { input } = await setup();
      const state = {
        activeSessionName: 'Observed factory',
        numConnectedPlayers: 4,
        playerLimit: 4,
        techTier: 3,
        activeSchematic: '',
        gamePhase: 'Phase 2',
        isGameRunning: true,
        totalGameDuration: 99,
        isGamePaused: false,
        averageTickRate: 60,
        autoLoadSessionName: 'Observed factory',
      };
      await persistSatisfactoryOfflineSnapshots(f.db, codec, serverId, [
        {
          key: '1'.repeat(64),
          tokenKey: '2'.repeat(64),
          expiresAt: Date.now() - 3600000,
          responses: {
            QueryServerState: JSON.stringify({
              data: { serverGameState: state },
              authenticationToken: 'must-not-persist',
            }),
          },
        },
      ]);
      const secret = await f.db
        .selectFrom('encrypted_secrets')
        .select('envelope')
        .where('name', '=', `gateway.satisfactory.observations.${serverId}`)
        .executeTakeFirstOrThrow();
      expect(JSON.stringify(secret.envelope)).not.toContain('Observed factory');
      expect(
        codec.decrypt(secret.envelope, `gateway.satisfactory.observations.${serverId}`),
      ).not.toContain('must-not-persist');
      const player = decodeNativePlayerIdentity(playerId);
      if (!player) throw new Error('fixture');
      const authorization = `Bearer ${createNativeAuthenticationToken(credentials, 'Client', player)}`;
      const query = {
        ...input,
        request: { operation: 'QueryServerState', playerId, authorization },
      };
      const response = await request(`${prefix()}/offline-api`, query);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 200,
        body: {
          data: {
            serverGameState: {
              ...state,
              numConnectedPlayers: 0,
              averageTickRate: 0,
              isGamePaused: true,
              activeSessionName: expect.stringContaining('Observed factory'),
            },
          },
        },
      });
      expect(
        await (
          await request(`${prefix()}/offline-api`, {
            ...query,
            request: { ...query.request, authorization: 'Bearer invalid' },
          })
        ).json(),
      ).toEqual({ status: 401, body: { errorCode: 'invalid_token' } });
      expect(
        await (
          await request(`${prefix()}/offline-api`, {
            ...query,
            request: { ...query.request, playerId: '060102030405060709' },
          })
        ).json(),
      ).toEqual({ status: 401, body: { errorCode: 'invalid_token' } });
    });
    it('captures native save metadata online and serves it offline only to a verified administrator', async () => {
      const { input } = await setup();
      const native = { sessions: [], currentSessionIndex: -1 };
      const sessions = vi.fn(async () => native);
      const advancedSettings = vi.fn(async () => ({
        creativeModeEnabled: false,
        advancedGameSettings: {},
      }));
      const options = vi.fn(async () => ({ serverOptions: {}, pendingServerOptions: {} }));
      const api = { sessions, advancedSettings, options } as unknown as SatisfactoryApi;
      const revalidate = vi.fn(async () => undefined);
      await observeSatisfactorySessions(f.db, codec, route, api, revalidate);
      expect(sessions).not.toHaveBeenCalled();
      await observeSatisfactorySessions(f.db, codec, { ...route, mode: 'online' }, api, revalidate);
      await observeSatisfactorySessions(f.db, codec, { ...route, mode: 'online' }, api, revalidate);
      expect(sessions).toHaveBeenCalledTimes(1);
      expect(advancedSettings).toHaveBeenCalledTimes(1);
      expect(options).toHaveBeenCalledTimes(1);
      expect(revalidate).toHaveBeenCalledTimes(1);
      const player = decodeNativePlayerIdentity(playerId);
      if (!player) throw new Error('fixture');
      const client = `Bearer ${createNativeAuthenticationToken(credentials, 'Client', player)}`;
      expect(
        await (
          await request(`${prefix()}/offline-api`, {
            ...input,
            request: {
              operation: 'GetAdvancedGameSettings',
              playerId,
              authorization: client,
            },
          })
        ).json(),
      ).toEqual({
        status: 200,
        body: { data: { creativeModeEnabled: false, advancedGameSettings: {} } },
      });
      for (const privilege of ['Client', 'Administrator'] as const) {
        const response = await request(`${prefix()}/offline-api`, {
          ...input,
          request: {
            operation: 'EnumerateSessions',
            playerId,
            authorization: `Bearer ${createNativeAuthenticationToken(credentials, privilege, player)}`,
          },
        });
        expect(await response.json()).toEqual(
          privilege === 'Administrator'
            ? { status: 200, body: { data: native } }
            : { status: 403, body: { errorCode: 'insufficient_scope' } },
        );
      }
    });
    it('keeps genuine metadata when one native read fails while persisting successful observations', async () => {
      await setup();
      const options = { serverOptions: { Existing: 'yes' }, pendingServerOptions: {} };
      const advanced = { creativeModeEnabled: false, advancedGameSettings: {} };
      await persistSatisfactoryOfflineSnapshots(
        f.db,
        codec,
        serverId,
        [],
        [
          { operation: 'GetServerOptions', body: { data: options } },
          { operation: 'GetAdvancedGameSettings', body: { data: advanced } },
        ],
      );
      const api = {
        sessions: async () => ({ sessions: [], currentSessionIndex: -1 }),
        options: async () => {
          throw new Error('private-error');
        },
        advancedSettings: async () => ({ malformed: 'must-not-persist' }),
      } as unknown as SatisfactoryApi;
      await observeSatisfactorySessions(
        f.db,
        codec,
        { ...route, mode: 'online' },
        api,
        async () => undefined,
      );
      const name = `gateway.satisfactory.observations.${serverId}`;
      const row = await f.db
        .selectFrom('encrypted_secrets')
        .select('envelope')
        .where('name', '=', name)
        .executeTakeFirstOrThrow();
      const value = JSON.parse(codec.decrypt(row.envelope, name));
      expect(value.GetServerOptions.body).toEqual({ data: options });
      expect(value.GetAdvancedGameSettings.body).toEqual({ data: advanced });
      expect(value.EnumerateSessions.body).toEqual({
        data: { sessions: [], currentSessionIndex: -1 },
      });
      expect(JSON.stringify(value)).not.toMatch(/private-error|must-not-persist/);
    });
    it('never persists enumeration after route revalidation fails', async () => {
      await setup();
      const api = {
        sessions: vi.fn(async () => ({ sessions: [], currentSessionIndex: -1 })),
      } as unknown as SatisfactoryApi;
      await observeSatisfactorySessions(
        f.db,
        codec,
        { ...route, mode: 'online' },
        api,
        async () => {
          throw new Error('revoked');
        },
      );
      expect(
        await f.db
          .selectFrom('encrypted_secrets')
          .select('name')
          .where('name', '=', `gateway.satisfactory.observations.${serverId}`)
          .executeTakeFirst(),
      ).toBeUndefined();
    });
    it('rechecks route authority after native reads instead of returning a token for a changed route', async () => {
      const { input, spy, authority } = await setup();
      spy.mockImplementationOnce(async () => {
        await f.db
          .updateTable('gateway_server_states')
          .set({ auto_wake_override: false })
          .where('server_id', '=', serverId)
          .execute();
        return authority;
      });
      const response = await request(`${prefix()}/offline-api`, input);
      expect(response.status).toBe(412);
      expect(await response.text()).not.toContain('authenticationToken');
    });
  });
  it.each([
    'tls-identity',
    'protocol-state',
    'private-state-read',
    'private-state-write',
    'application-observation',
    'protocol-state-read',
  ])('rejects browser and wrong-Gateway access to %s', async (endpoint) => {
    const input = {
      routeId: route.id,
      routeRevision: route.revision,
      ...(endpoint === 'protocol-state' ? { state: satisfactoryState() } : {}),
    };
    expect((await request(`${prefix()}/${endpoint}`, input, { authorization: '' })).status).toBe(
      401,
    );
    expect(
      (await request(`${prefix()}/${endpoint}`, input, { 'x-nh-support-token': 'support' })).status,
    ).toBe(401);
    expect((await request(`/internal/gateway/${randomUUID()}/${endpoint}`, input)).status).toBe(
      401,
    );
  });
  it('returns only the route-bound TLS identity, rejects stale revisions and hides keys from snapshots', async () => {
    const input = await satisfactoryRoute();
    const identity = await ensureSatisfactoryTlsIdentity(f.db, codec, serverId);
    const response = await request(`${prefix()}/tls-identity`, input);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(identity);
    expect(
      (await request(`${prefix()}/tls-identity`, { ...input, routeRevision: route.revision + 1 }))
        .status,
    ).toBe(412);
    expect(
      (await request(`${prefix()}/tls-identity`, { ...input, serverId: randomUUID() })).status,
    ).toBe(400);
    const snapshot = await request(`${prefix()}/snapshot`);
    expect(await snapshot.text()).not.toContain('PRIVATE KEY');
  });
  it.each([
    'tls-identity',
    'protocol-state',
    'private-state-read',
    'private-state-write',
    'application-observation',
    'protocol-state-read',
  ])('rejects wrong protocol handlers for %s', async (endpoint) => {
    const response = await request(`${prefix()}/${endpoint}`, {
      routeId: route.id,
      routeRevision: route.revision,
      ...(endpoint === 'protocol-state' ? { state: satisfactoryState() } : {}),
    });
    expect(response.status).toBe(403);
  });
  it('rejects TLS identity retrieval for UDP routes and other Gateway namespaces', async () => {
    const input = await satisfactoryRoute('udp');
    expect((await request(`${prefix()}/tls-identity`, input)).status).toBe(403);
    await f.db
      .updateTable('gateway_routes')
      .set({ gateway_id: randomUUID() })
      .where('id', '=', route.id)
      .execute();
    expect((await request(`${prefix()}/tls-identity`, input)).status).toBe(404);
  });
  it('rejects Reliable Messaging routes and missing persisted TLS identities', async () => {
    const input = await satisfactoryRoute();
    expect((await request(`${prefix()}/tls-identity`, input)).status).toBe(503);
    await f.db
      .updateTable('server_allocations')
      .set({ role: 'reliable' })
      .where('id', '=', route.allocationId)
      .execute();
    const selected = (await getGatewaySnapshot(f.db, env)).routes.find(
      (entry) => entry.id === route.id,
    );
    if (!selected) throw new Error('Missing reliable fixture route');
    expect(
      (
        await request(`${prefix()}/tls-identity`, {
          routeId: selected.id,
          routeRevision: selected.revision,
        })
      ).status,
    ).toBe(403);
  });
  it('persists private protocol state encrypted, never in routing snapshots', async () => {
    const input = await satisfactoryRoute();
    const state = [
      {
        key: 'f'.repeat(64),
        expiresAt: Date.now() + 60000,
        responses: { QueryServerState: '{"data":{"privateSession":"factory-secret"}}' },
      },
    ];
    expect((await request(`${prefix()}/private-state-write`, { ...input, state })).status).toBe(
      204,
    );
    const response = await request(`${prefix()}/private-state-read`, input);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(state);
    const stored = await f.db
      .selectFrom('encrypted_secrets')
      .select('envelope')
      .where('name', '=', `gateway.satisfactory.cache.${serverId}`)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.envelope)).not.toContain('factory-secret');
    expect(await (await request(`${prefix()}/snapshot`)).text()).not.toContain('factory-secret');
    expect(
      (
        await request(`${prefix()}/private-state-read`, {
          ...input,
          routeRevision: input.routeRevision + 1,
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await request(`${prefix()}/private-state-write`, {
          ...input,
          state,
          serverId: randomUUID(),
        })
      ).status,
    ).toBe(400);
  });
  it('accepts a large private snapshot only after Gateway authentication', async () => {
    const input = await satisfactoryRoute();
    const state = [
      {
        key: 'f'.repeat(64),
        tokenKey: 'a'.repeat(64),
        expiresAt: Date.now() + 60000,
        responses: {
          EnumerateSessions: JSON.stringify({
            data: { sessions: [], currentSessionIndex: -1, padding: 'x'.repeat(128 * 1024) },
          }),
        },
      },
    ];
    expect(
      (
        await request(
          `${prefix()}/private-state-write`,
          { ...input, state },
          { authorization: 'Bearer invalid' },
        )
      ).status,
    ).toBe(401);
    expect((await request(`${prefix()}/private-state-write`, { ...input, state })).status).toBe(
      204,
    );
    expect(await (await request(`${prefix()}/private-state-read`, input)).json()).toEqual(state);
  });
  it('observes only authenticated live player state without exposing private session data', async () => {
    const input = await satisfactoryRoute('udp');
    expect((await request(`${prefix()}/application-observation`, input)).status).toBe(503);
    let players = 3;
    let gameRunning = true;
    let enumerationAvailable = true;
    const resolver = vi.spyOn(satisfactoryApi, 'resolveSatisfactoryApi').mockResolvedValue(
      new SatisfactoryApi({
        async request(body, signal) {
          if (body.function === 'EnumerateSessions') {
            if (!enumerationAvailable) throw new Error('Enumeration unavailable');
            return { data: { sessions: [], currentSessionIndex: -1 } };
          }
          expect(body.function).toBe('QueryServerState');
          expect(signal).toBeInstanceOf(AbortSignal);
          return {
            data: {
              serverGameState: {
                activeSessionName: 'Private session',
                numConnectedPlayers: players,
                playerLimit: 4,
                techTier: 1,
                activeSchematic: '',
                gamePhase: '',
                isGameRunning: gameRunning,
                totalGameDuration: 100,
                isGamePaused: false,
                averageTickRate: 30,
                autoLoadSessionName: '',
              },
            },
          };
        },
      }),
    );
    try {
      const response = await request(`${prefix()}/application-observation`, input);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ ready: true, idle: false, playerCount: 3 });
      expect(resolver).toHaveBeenCalledWith(expect.anything(), codec, serverId);
      players = 0;
      expect(await (await request(`${prefix()}/application-observation`, input)).json()).toEqual({
        ready: true,
        idle: true,
        playerCount: 0,
      });
      gameRunning = false;
      for (const available of [true, false]) {
        enumerationAvailable = available;
        const setup = await request(`${prefix()}/application-observation`, input);
        expect(setup.status).toBe(200);
        expect(await setup.json()).toEqual({ ready: true, idle: false, playerCount: 0 });
      }
      gameRunning = true;
      expect(await (await request(`${prefix()}/application-observation`, input)).json()).toEqual({
        ready: true,
        idle: true,
        playerCount: 0,
      });
      expect(
        (
          await request(`${prefix()}/application-observation`, {
            ...input,
            routeRevision: input.routeRevision + 1,
          })
        ).status,
      ).toBe(412);
      expect(
        (await request(`${prefix()}/application-observation`, { ...input, serverId: randomUUID() }))
          .status,
      ).toBe(400);
    } finally {
      resolver.mockRestore();
    }
    const tcp = await satisfactoryRoute('tcp');
    expect((await request(`${prefix()}/application-observation`, tcp)).status).toBe(403);
  });
  it('does not fabricate missing protocol state and rejects reads through TCP', async () => {
    const input = await satisfactoryRoute('udp');
    expect(await (await request(`${prefix()}/protocol-state-read`, input)).json()).toEqual({
      state: null,
    });
    const tcp = await satisfactoryRoute('tcp');
    expect((await request(`${prefix()}/protocol-state-read`, tcp)).status).toBe(403);
  });
  it('persists UDP state outside route authority and hydrates only the matching game route', async () => {
    const input = await satisfactoryRoute('udp');
    const state = satisfactoryState();
    expect((await request(`${prefix()}/protocol-state`, { ...input, state })).status).toBe(204);
    const selected = (await getGatewaySnapshot(f.db, env)).routes.find(
      (entry) => entry.id === route.id,
    );
    if (!selected) throw new Error('Missing Satisfactory fixture route');
    route = selected;
    const revision = route.revision;
    expect(route.protocol?.satisfactory).toBeUndefined();
    expect(revision).toBe(input.routeRevision);
    const cached = await request(`${prefix()}/protocol-state-read`, input);
    expect(cached.status).toBe(200);
    expect(cached.headers.get('cache-control')).toBe('no-store');
    expect(await cached.json()).toEqual({ state });
    expect(
      (await request(`${prefix()}/protocol-state-read`, { ...input, routeRevision: revision + 1 }))
        .status,
    ).toBe(412);
    expect(
      (await request(`${prefix()}/protocol-state-read`, { ...input, serverId: randomUUID() }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(`${prefix()}/protocol-state`, {
          routeId: route.id,
          routeRevision: revision,
          state: {
            ...state,
            name: 'Changed factory',
            netCL: 513885,
            substates: [{ id: 0, version: 7 }],
            observedAt: new Date(Date.now() + 1000).toISOString(),
          },
        })
      ).status,
    ).toBe(204);
    expect(
      (await getGatewaySnapshot(f.db, env)).routes.find((entry) => entry.id === route.id)?.revision,
    ).toBe(revision);
    expect(
      (
        await request(`${prefix()}/protocol-state`, {
          routeId: route.id,
          routeRevision: revision,
          state: { ...state, observedAt: new Date(Date.now() - 60000).toISOString() },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`${prefix()}/protocol-state`, {
          routeId: route.id,
          routeRevision: revision + 1,
          state,
        })
      ).status,
    ).toBe(412);
  });

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
  it('fetches multiple managed routes for the same server once and strips private provider metadata', async () => {
    await setGatewayRoute(f.db, f.owner, { ...(routeInput as object), transport: 'udp' }, env);
    const routes = (await getGatewaySnapshot(f.db, env)).routes;
    expect(routes).toHaveLength(2);
    const response = await request(`${prefix()}/inventory`, {
      operation: 'servers',
      routeIds: routes.map((route) => route.id),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(secret);
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(1);
    expect(safetyProviderServerSchema.safeParse(parsed[0]).success).toBe(true);
    expect(f.adapter.getApplicationServers).toHaveBeenCalledExactlyOnceWith([remote.uuid]);
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
  });

  it('batches distinct managed servers while verifying every returned identity', async () => {
    vi.mocked(f.adapter.listAllocations).mockResolvedValue(f.inventory);
    const otherId = await f.server();
    const other = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', otherId)
      .executeTakeFirstOrThrow();
    const claim = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', otherId)
      .executeTakeFirstOrThrow();
    if (
      !other.pterodactyl_id ||
      !other.pterodactyl_uuid ||
      !other.pterodactyl_identifier ||
      !other.provider_user_id
    )
      throw new Error('Missing second fixture provider identity');
    await setGatewayPolicy(f.db, f.context, otherId, policy);
    await setGatewayRoute(
      f.db,
      f.owner,
      { ...(routeInput as object), serverId: otherId, allocationId: claim.id, publicPort: 26001 },
      env,
    );
    const otherRemote = {
      ...remote,
      id: other.pterodactyl_id,
      uuid: other.pterodactyl_uuid,
      identifier: other.pterodactyl_identifier,
      external_id: other.external_id,
      user: other.provider_user_id,
      allocation: claim.pterodactyl_allocation_id,
      relationships: {
        allocations: {
          object: 'list' as const,
          data: [
            {
              attributes: {
                id: claim.pterodactyl_allocation_id,
                ip: claim.address,
                port: claim.port,
                assigned: true,
              },
            },
          ],
        },
      },
    };
    vi.mocked(f.adapter.getApplicationServers).mockResolvedValue([otherRemote, remote]);
    const routes = (await getGatewaySnapshot(f.db, env)).routes;
    const data = { operation: 'servers', routeIds: routes.map((route) => route.id) };
    const response = await request(`${prefix()}/inventory`, data);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(2);
    expect(f.adapter.getApplicationServers).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining([remote.uuid, otherRemote.uuid]),
    );
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    vi.mocked(f.adapter.getApplicationServers).mockResolvedValue([
      remote,
      { ...otherRemote, external_id: 'foreign' },
    ]);
    expect((await request(`${prefix()}/inventory`, data)).status).toBe(409);
  });

  it.each(['missing', 'foreign', 'duplicate', 'identity', 'allocations'] as const)(
    'rejects %s members from batched provider inventory without individual retries',
    async (failure) => {
      if (failure === 'missing') vi.mocked(f.adapter.getApplicationServers).mockResolvedValue([]);
      if (failure === 'foreign')
        vi.mocked(f.adapter.getApplicationServers).mockResolvedValue([
          remote,
          { ...remote, uuid: randomUUID(), id: remote.id + 1 },
        ]);
      if (failure === 'duplicate')
        vi.mocked(f.adapter.getApplicationServers).mockResolvedValue([remote, remote]);
      if (failure === 'identity') remote = { ...remote, user: remote.user + 1 };
      if (failure === 'allocations') remote = { ...remote, relationships: undefined };
      const response = await request(`${prefix()}/inventory`, {
        operation: 'servers',
        routeIds: [route.id],
      });
      expect(response.status).toBe(409);
      expect(f.adapter.getApplicationServers).toHaveBeenCalledOnce();
      expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain(secret);
    },
  );

  it.each(['foreign', 'disabled'] as const)(
    'rejects a %s route before requesting batched provider inventory',
    async (failure) => {
      if (failure === 'disabled')
        await f.db
          .updateTable('gateway_routes')
          .set({ enabled: false })
          .where('id', '=', route.id)
          .execute();
      const response = await request(`${prefix()}/inventory`, {
        operation: 'servers',
        routeIds: [failure === 'foreign' ? randomUUID() : route.id],
      });
      expect(response.status).toBe(412);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'conflict',
          messageKey: 'errors.conflict',
          details: { gatewayControlReason: 'snapshot_membership_changed' },
        },
      });
      expect(f.adapter.getApplicationServers).not.toHaveBeenCalled();
      expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    },
  );

  it('requires current managed provider context before requesting batched inventory', async () => {
    await f.db
      .updateTable('managed_servers')
      .set({ provider_user_id: null })
      .where('id', '=', serverId)
      .execute();
    const response = await request(`${prefix()}/inventory`, {
      operation: 'servers',
      routeIds: [route.id],
    });
    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({
      error: { details: { gatewayControlReason: 'snapshot_membership_changed' } },
    });
    expect(f.adapter.getApplicationServers).not.toHaveBeenCalled();
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
  });

  it('does not classify a context provenance failure as retryable membership drift', async () => {
    const management = await import('@nickhosting/server-management');
    const context = vi
      .spyOn(management, 'gatewaySafetyContext')
      .mockRejectedValueOnce(new DomainError('provenance_mismatch'));
    try {
      const response = await request(`${prefix()}/inventory`, {
        operation: 'servers',
        routeIds: [route.id],
      });
      expect(response.status).toBe(409);
      const body = await response.text();
      expect(body).toContain('provenance_mismatch');
      expect(body).not.toContain('snapshot_membership_changed');
      expect(f.adapter.getApplicationServers).not.toHaveBeenCalled();
    } finally {
      context.mockRestore();
    }
  });

  it('requires service authentication and unique bounded route selectors for batched inventory', async () => {
    const inputs = [
      { operation: 'servers', routeIds: [] },
      { operation: 'servers', routeIds: [route.id, route.id] },
      { operation: 'servers', routeIds: Array.from({ length: 1001 }, () => randomUUID()) },
      { operation: 'servers', routeIds: [route.id], applicationKey: secret },
      { operation: 'servers', routeIds: [remote.id] },
    ];
    for (const data of inputs)
      expect((await request(`${prefix()}/inventory`, data)).status).toBe(400);
    expect(
      (
        await request(
          `${prefix()}/inventory`,
          { operation: 'servers', routeIds: [route.id] },
          { authorization: '' },
        )
      ).status,
    ).toBe(401);
    expect(f.adapter.getApplicationServers).not.toHaveBeenCalled();
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
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
