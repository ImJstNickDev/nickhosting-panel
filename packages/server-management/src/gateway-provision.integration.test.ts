import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type {
  ApplicationServer,
  PterodactylAdapter,
  Resources,
} from '@nickhosting/pterodactyl-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockResources } from './admission.js';
import { type TrustedGameModule, trustedGameModules } from './game-modules.js';
import {
  getGatewayState,
  reportGatewayObservation,
  requestGatewayWake,
  setGatewayPolicy,
} from './gateway-orchestration.js';
import {
  activateProvisionGateway,
  planProvisionGateway,
  prepareProvisionGatewayStart,
} from './gateway-provision.js';
import { getGatewaySnapshot } from './gateway-registry.js';
import { type LifecycleOptions, processServerOperation } from './lifecycle.js';
import { createManagedServer } from './registry.js';
import { managementFixture } from './test-fixtures.js';

// Replace only the frozen registry container so isolated compiled fixture modules
// can be registered. Production has no API or config path for executable modules.
vi.mock('./game-modules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./game-modules.js')>();
  return { ...actual, trustedGameModules: { ...actual.trustedGameModules } };
});

let providerSequence = 9000;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let env: Record<string, string>;
let module: TrustedGameModule;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  env = {
    NH_GATEWAY_ENABLED: 'true',
    NH_GATEWAY_ID: randomUUID(),
    NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
  };
  module = {
    id: f.gameId,
    manifest: { ...f.manifest, capabilities: { ...f.manifest.capabilities, readiness: true } },
    provisionAsResourceOwner: false,
    gatewayPolicyBinding: async () => ({ protocolId: 'fixture', gameVersion: '1' }),
    assertProfileBinding: async () => {},
    authorizeOperation: async () => {},
    filterCatalog: async (_db, _ctx, entry) => entry,
  };
  const get = trustedGameModules.get;
  vi.spyOn(trustedGameModules, 'get').mockImplementation((id) =>
    id === f.gameId ? module : get(id),
  );
});
async function rows(serverId: string) {
  return f.db
    .selectFrom('gateway_routes')
    .selectAll()
    .where('server_id', '=', serverId)
    .orderBy('id')
    .execute();
}
async function installed(created: { serverId: string; jobId: string }) {
  await f.db
    .updateTable('managed_servers')
    .set({
      pterodactyl_id: ++providerSequence,
      pterodactyl_uuid: randomUUID(),
      pterodactyl_identifier: `fixture${providerSequence}`,
      installation_state: 'installed',
    })
    .where('id', '=', created.serverId)
    .execute();
  const op = await f.db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', created.jobId)
    .executeTakeFirstOrThrow();
  await f.db
    .updateTable('server_operations')
    .set({
      phase: 'installation',
      effect_state: 'confirmed',
      plan: JSON.stringify({ ...op.plan, installConfirmed: true }),
    })
    .where('job_id', '=', created.jobId)
    .execute();
}
async function activation(created: { serverId: string; jobId: string }) {
  await activateProvisionGateway(f.db, created.serverId, created.jobId, env);
}

describe('automatic provision Gateway routes', () => {
  it('reserves stable same-number TCP/UDP multiport routes once and activates atomically', async () => {
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({
        port_roles: JSON.stringify([
          { role: 'game', protocols: ['tcp', 'udp'], primary: true },
          { role: 'query', protocols: ['udp'], primary: false },
        ]),
      })
      .where('id', '=', f.mappingId)
      .execute();
    const input = f.input();
    const created = await createManagedServer(f.db, f.adapter, f.context, input, env);
    const reserved = await rows(created.serverId);
    expect(reserved).toHaveLength(3);
    expect(reserved.every((route) => !route.enabled)).toBe(true);
    expect(reserved.map((route) => route.public_port).sort()).toEqual([20000, 20000, 20001]);
    expect((await getGatewaySnapshot(f.db, env)).routes).toEqual([]);
    expect(await createManagedServer(f.db, f.adapter, f.context, input, env)).toEqual(created);
    expect(await rows(created.serverId)).toEqual(reserved);
    await installed(created);
    await activation(created);
    const first = await rows(created.serverId);
    expect(first.every((route) => route.enabled)).toBe(true);
    const state = await getGatewayState(f.db, created.serverId, { env });
    expect(state).toMatchObject({ enabled: false, state: 'manually_stopped' });
    await activation(created);
    expect(await rows(created.serverId)).toEqual(first);
    const policy = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', created.serverId)
      .executeTakeFirstOrThrow();
    expect(policy).toMatchObject({
      idle_timeout_inherited: true,
      owner_idle_timeout_seconds: null,
      owner_idle_timeout_user_access: null,
    });
    expect((await getGatewaySnapshot(f.db, env)).routes).toHaveLength(3);
  });
  it('does not re-enable a previously activated route on crash recovery', async () => {
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input(), env);
    await installed(created);
    await activation(created);
    await f.db
      .updateTable('gateway_routes')
      .set({ enabled: false })
      .where('server_id', '=', created.serverId)
      .execute();
    await activation(created);
    expect((await rows(created.serverId)).every((route) => !route.enabled)).toBe(true);
  });
  it.each(['disabled', 'ambiguous', 'wrong-host'] as const)(
    'rejects %s setup before persisting a server or provider effects',
    async (kind) => {
      if (kind === 'ambiguous')
        await f.db
          .updateTable('managed_nodes')
          .set({
            backend_allocation_pool: JSON.stringify({
              ...f.backendAllocationPool,
              gatewayBindAddresses: ['192.0.2.10', '192.0.2.11'],
            }),
          })
          .where('id', '=', f.nodeId)
          .execute();
      await expect(
        createManagedServer(f.db, f.adapter, f.context, f.input(), {
          ...env,
          ...(kind === 'disabled' ? { NH_GATEWAY_ENABLED: 'false' } : {}),
          ...(kind === 'wrong-host' ? { NH_GATEWAY_PHYSICAL_HOST_ID: randomUUID() } : {}),
        }),
      ).rejects.toBeInstanceOf(DomainError);
      expect(
        await f.db
          .selectFrom('managed_servers')
          .select('id')
          .where('owner_id', '=', f.context.subjectUserId)
          .execute(),
      ).toEqual([]);
    },
  );
  it('fails atomically on collision and retains reserved endpoints when configuration changes', async () => {
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input(), env);
    await installed(created);
    await f.db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          ...f.backendAllocationPool,
          gatewayBindAddresses: ['192.0.2.11'],
        }),
      })
      .where('id', '=', f.nodeId)
      .execute();
    await expect(activation(created)).rejects.toThrow('allocation_unavailable');
    expect(
      (await rows(created.serverId)).every(
        (route) => !route.enabled && route.public_address === '192.0.2.10',
      ),
    ).toBe(true);
    await f.db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          ...f.backendAllocationPool,
          allocations: [
            ...f.backendAllocationPool.allocations,
            {
              allocationId: 999999,
              address: '192.0.2.10',
              port: 20000,
              delivery: 'direct',
              directEndpoint: { hostname: 'direct.example.test', port: 20000 },
            },
          ],
        }),
      })
      .where('id', '=', f.nodeId)
      .execute();
    await expect(activation(created)).rejects.toThrow('allocation_unavailable');
    expect((await rows(created.serverId)).every((route) => !route.enabled)).toBe(true);
    await f.db
      .updateTable('managed_nodes')
      .set({ backend_allocation_pool: JSON.stringify(f.backendAllocationPool) })
      .where('id', '=', f.nodeId)
      .execute();
    await activation(created);
    expect((await rows(created.serverId)).every((route) => route.enabled)).toBe(true);
  });
  it('rejects missing or retargeted route identity rather than silently rebuilding it', async () => {
    const created = await createManagedServer(f.db, f.adapter, f.context, f.input(), env);
    await installed(created);
    const route = (await rows(created.serverId))[0];
    if (!route) throw new Error('fixture route absent');
    await f.db.deleteFrom('gateway_routes').where('id', '=', route.id).execute();
    await expect(activation(created)).rejects.toThrow('conflict');
    expect((await rows(created.serverId)).every((route) => !route.enabled)).toBe(true);
  });
  it('leaves direct mode untouched even if Gateway configuration is absent', async () => {
    // Existing direct fixtures do not require any protocol/route registration.
    vi.restoreAllMocks();
    const serverId = await f.server();
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'direct' })
      .where('id', '=', serverId)
      .execute();
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect(
      await f.db.transaction().execute(async (tx) => {
        await lockResources(tx);
        return planProvisionGateway(tx, server, f.gameId);
      }),
    ).toBeUndefined();
    expect(await rows(serverId)).toEqual([]);
  });
  it('does not override explicit manual policy changed during provisioning', async () => {
    const created = await createManagedServer(
      f.db,
      f.adapter,
      f.context,
      f.input({ autoStart: true }),
      env,
    );
    await installed(created);
    await activation(created);
    await setGatewayPolicy(
      f.db,
      f.owner,
      created.serverId,
      {
        enabled: false,
        protocolId: 'fixture',
        gameVersion: '1',
        readinessTimeoutSeconds: 601,
        readinessMaxAgeSeconds: 30,
        estimateMaxAgeSeconds: 604800,
        wakeRetrySeconds: 10,
        mode: 'manually_stopped',
      },
      { env },
    );
    await expect(
      prepareProvisionGatewayStart(f.db, created.serverId, created.jobId, new Date()),
    ).rejects.toThrow('conflict');
    expect(await getGatewayState(f.db, created.serverId, { env })).toMatchObject({
      state: 'manually_stopped',
      enabled: false,
    });
  });
});

async function lifecycleFixture(autoStart: boolean) {
  const created = await createManagedServer(
    f.db,
    f.adapter,
    f.context,
    f.input({ autoStart }),
    env,
  );
  await installed(created);
  const server = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', created.serverId)
    .executeTakeFirstOrThrow();
  const claims = await f.db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', created.serverId)
    .execute();
  let clock = new Date(Date.now() + 100);
  let state: Resources['current_state'] = 'offline';
  let processStart = '';
  const remote: ApplicationServer = {
    id: server.pterodactyl_id ?? 0,
    uuid: server.pterodactyl_uuid ?? '',
    identifier: server.pterodactyl_identifier ?? '',
    external_id: server.external_id,
    name: server.name,
    description: '',
    suspended: false,
    limits: server.limits,
    feature_limits: { databases: 0, allocations: 3, backups: 1 },
    user: 1,
    node: f.providerNodeId,
    allocation: claims.find((claim) => claim.is_primary)?.pterodactyl_allocation_id ?? 0,
    nest: 1,
    egg: 1,
    status: null,
    container: { startup_command: 'fixture', image: 'fixture/image:1', installed: true },
    relationships: {
      allocations: {
        object: 'list',
        data: claims.map((claim) => ({
          attributes: {
            id: claim.pterodactyl_allocation_id,
            ip: claim.address,
            port: claim.port,
            assigned: true,
          },
        })),
      },
    },
    created_at: clock.toISOString(),
    updated_at: clock.toISOString(),
  };
  const power = vi.fn(async () => {
    clock = new Date(clock.getTime() + 1);
    processStart = clock.toISOString();
    state = 'running';
  });
  const adapter = {
    ...f.adapter,
    findServerByExternalId: async () => remote,
    getApplicationServer: async () => remote,
    getResources: async (): Promise<Resources> => ({
      current_state: state,
      is_suspended: false,
      resources: {
        memory_bytes: 128,
        cpu_absolute: 1,
        disk_bytes: 1,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
        uptime: 100,
      },
    }),
    power,
  } as unknown as PterodactylAdapter;
  const options: LifecycleOptions = {
    adapter,
    env,
    now: () => clock,
    settleMs: 1,
    authorizeEffect: async () => {},
    configureGameProvision: async () => true,
    reserveStart: async () => {
      await f.db
        .insertInto('resource_reservations')
        .values({
          server_id: created.serverId,
          owner_id: server.owner_id,
          physical_host_id: f.hostId,
          operation_id: created.jobId,
          memory_mib: server.limits.memory,
          physical_memory_mib: server.limits.memory,
          cpu_percent: server.limits.cpu,
          state: 'starting',
        })
        .onConflict((c) => c.column('server_id').doNothing())
        .execute();
    },
  };
  return {
    ...created,
    options,
    power,
    advance: () => {
      clock = new Date(clock.getTime() + 30_000);
    },
    now: () => clock,
    processStart: () => processStart,
  };
}

describe('provision worker automatic routing and launch recovery', () => {
  it('provisions offline with routes, then preserves disabled wake and manual-stop suppression', async () => {
    const run = await lifecycleFixture(false);
    expect(await processServerOperation(f.db, run.jobId, run.options)).toBe('succeeded');
    expect(run.power).not.toHaveBeenCalled();
    expect((await rows(run.serverId)).every((route) => route.enabled)).toBe(true);
    const state = await getGatewayState(f.db, run.serverId, { env });
    expect(
      await requestGatewayWake(
        f.db,
        run.serverId,
        { generation: state.generation, intent: 'join' },
        { env },
      ),
    ).toMatchObject({ enabled: false, state: 'manually_stopped', wakeJobId: null });
  });
  it('confirms initial launch and actual readiness after a lost reply without granting automatic wake', async () => {
    const run = await lifecycleFixture(true);
    run.options.checkpoint = async (point) => {
      if (point === 'remote_succeeded') throw new Error('isolated crash after provider start');
    };
    expect(await processServerOperation(f.db, run.jobId, run.options)).toBe('waiting');
    expect(run.power).toHaveBeenCalledTimes(1);
    const state = await getGatewayState(f.db, run.serverId, { env, now: run.now });
    expect(state).toMatchObject({ enabled: false, state: 'waking', wakeJobId: run.jobId });
    run.options.checkpoint = undefined;
    run.advance();
    // Gateway settings may be changed while the provider start is being confirmed.
    // Confirmation never replays power or loses the actual compute reservation.
    run.options.env = { ...env, NH_GATEWAY_ENABLED: 'false' };
    expect(await processServerOperation(f.db, run.jobId, run.options)).toBe('succeeded');
    expect(run.power).toHaveBeenCalledTimes(1);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('state')
        .where('server_id', '=', run.serverId)
        .executeTakeFirst(),
    ).toMatchObject({ state: 'running' });
    const observed = await reportGatewayObservation(
      f.db,
      run.serverId,
      {
        generation: state.generation,
        wakeJobId: run.jobId,
        observedAt: run.now().toISOString(),
        processStartedAt: run.processStart(),
        ready: true,
        idle: false,
        playerCount: 1,
        activeSessions: 1,
      },
      { env, now: run.now },
    );
    expect(observed).toMatchObject({ enabled: false, state: 'online' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(run.now());
    try {
      expect(
        (await getGatewaySnapshot(f.db, env)).routes.every((route) => route.mode === 'online'),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('rechecks manual-stop suppression after the durable initial-start intent and before power', async () => {
    const run = await lifecycleFixture(true);
    run.options.checkpoint = async (point) => {
      if (point !== 'prepared') return;
      await setGatewayPolicy(
        f.db,
        f.owner,
        run.serverId,
        {
          enabled: false,
          protocolId: 'fixture',
          gameVersion: '1',
          readinessTimeoutSeconds: 600,
          readinessMaxAgeSeconds: 30,
          estimateMaxAgeSeconds: 604800,
          wakeRetrySeconds: 10,
          mode: 'manually_stopped',
        },
        { env },
      );
    };
    expect(await processServerOperation(f.db, run.jobId, run.options)).toBe('failed');
    expect(run.power).not.toHaveBeenCalled();
    expect(await getGatewayState(f.db, run.serverId, { env })).toMatchObject({
      state: 'manually_stopped',
      enabled: false,
    });
  });
  it('does not mark provisioning successful when routing activation fails', async () => {
    const run = await lifecycleFixture(false);
    run.options.env = { ...env, NH_GATEWAY_PHYSICAL_HOST_ID: randomUUID() };
    expect(await processServerOperation(f.db, run.jobId, run.options)).toBe('failed');
    expect((await rows(run.serverId)).every((route) => !route.enabled)).toBe(true);
    expect(
      await f.db
        .selectFrom('managed_servers')
        .select(['installation_state', 'pterodactyl_uuid'])
        .where('id', '=', run.serverId)
        .executeTakeFirst(),
    ).toMatchObject({ installation_state: 'installed', pterodactyl_uuid: expect.any(String) });
    expect(run.power).not.toHaveBeenCalled();
  });
});
