import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { commandDigest } from '@nickhosting/jobs';
import type {
  ApplicationServer,
  PterodactylAdapter,
  Resources,
} from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
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
import {
  type LifecycleOptions,
  processServerOperation,
  reconcileManagedServer,
} from './lifecycle.js';
import { createManagedServer } from './registry.js';
import { getAutomationConsent, setAutomationConsent } from './schedules.js';
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
    expect(state).toMatchObject({ enabled: true, state: 'manually_stopped' });
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
    user: server.provider_user_id ?? 1,
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
    advance: (ms = 30_000) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
    processStart: () => processStart,
    remote,
    setState(value: Resources['current_state']) {
      state = value;
    },
  };
}

describe('provision worker automatic routing and launch recovery', () => {
  it('provisions offline with inherited automation while manual-stop intent suppresses wake', async () => {
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
    ).toMatchObject({ enabled: true, state: 'manually_stopped', wakeJobId: null });
  });
  it('confirms initial launch and readiness after a lost reply with inherited automation', async () => {
    const run = await lifecycleFixture(true);
    run.options.checkpoint = async (point) => {
      if (point === 'remote_succeeded') throw new Error('isolated crash after provider start');
    };
    expect(await processServerOperation(f.db, run.jobId, run.options)).toBe('waiting');
    expect(run.power).toHaveBeenCalledTimes(1);
    const state = await getGatewayState(f.db, run.serverId, { env, now: run.now });
    expect(state).toMatchObject({ enabled: true, state: 'waking', wakeJobId: run.jobId });
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
    expect(observed).toMatchObject({ enabled: true, state: 'online' });
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
  it('revokes the initial automatic start after durable preparation without disabling the Gateway', async () => {
    const run = await lifecycleFixture(true);
    run.options.checkpoint = async (point) => {
      if (point !== 'prepared') return;
      const consent = await getAutomationConsent(f.db, f.owner, run.serverId);
      await setAutomationConsent(
        f.db,
        f.owner,
        run.serverId,
        {
          allowed: false,
          expectedAllowed: consent.allowed,
          expectedIntent: consent.expectedIntent,
        },
        env,
      );
    };
    expect(await processServerOperation(f.db, run.jobId, run.options)).toBe('failed');
    expect(run.power).not.toHaveBeenCalled();
    expect((await getAutomationConsent(f.db, f.owner, run.serverId)).allowed).toBe(false);
    expect((await getGatewayState(f.db, run.serverId, { env })).enabled).toBe(true);
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

/** Durable histories model completed user actions; reconciliation sends no effects. */
async function failedProvisionReinstalled() {
  const run = await lifecycleFixture(false);
  const failedAt = new Date(run.now().getTime() - 3000);
  await f.db
    .updateTable('server_operations')
    .set({ phase: 'failed', updated_at: failedAt })
    .where('job_id', '=', run.jobId)
    .execute();
  await f.db
    .updateTable('operation_jobs')
    .set({
      state: 'failed',
      created_at: new Date(failedAt.getTime() - 1000),
      completed_at: failedAt,
    })
    .where('id', '=', run.jobId)
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ active_operation_id: null })
    .where('id', '=', run.serverId)
    .execute();
  async function completed(
    action: 'reinstall' | 'start' | 'restart' | 'stop',
    offset: number,
    plan: Record<string, unknown> = {},
    succeeded = true,
  ) {
    const jobId = randomUUID();
    const createdAt = new Date(failedAt.getTime() + offset);
    const completedAt = new Date(createdAt.getTime() + 2);
    const command = {
      type: 'server.operation',
      version: 1,
      payload: { serverId: run.serverId, operationId: jobId },
    } as const;
    const owner = f.context.subjectUserId;
    await f.db
      .insertInto('operation_jobs')
      .values({
        id: jobId,
        actor_id: owner,
        subject_id: owner,
        resource_owner_id: owner,
        support_session_id: null,
        idempotency_key: jobId,
        command_hash: commandDigest({ command, subjectId: owner, resourceOwnerId: owner }),
        command: JSON.stringify(command),
        policy_snapshot: '{}',
        max_attempts: 3,
        error_code: null,
        state: succeeded ? 'succeeded' : 'failed',
        created_at: createdAt,
        updated_at: completedAt,
        completed_at: completedAt,
        next_attempt_at: createdAt,
      })
      .execute();
    await f.db
      .insertInto('server_operations')
      .values({
        job_id: jobId,
        server_id: run.serverId,
        action,
        phase: succeeded ? 'complete' : 'failed',
        effect_state: 'confirmed',
        effect_started_at: createdAt,
        lease_token: null,
        lease_until: null,
        plan: JSON.stringify(plan),
        updated_at: completedAt,
      })
      .execute();
    return jobId;
  }
  const reinstallJobId = await completed('reinstall', 1000, { installConfirmed: true });
  async function start(action: 'start' | 'restart' = 'start', extra: Record<string, unknown> = {}) {
    const processStartedAt = new Date(failedAt.getTime() + 2001).toISOString();
    const confirmedAt = new Date(failedAt.getTime() + 2002).toISOString();
    const prefix = action === 'restart' ? 'restart' : 'start';
    const jobId = await completed(action, 2000, {
      [`${prefix}Confirmed`]: true,
      [`${prefix}ProcessStartedAt`]: processStartedAt,
      [`${prefix}ConfirmedAt`]: confirmedAt,
      ...extra,
    });
    run.setState('running');
    return { jobId, processStartedAt };
  }
  return { ...run, failedAt, reinstallJobId, completed, start };
}

describe('Gateway recovery after failed provision and successful reinstall', () => {
  it.each(['owner-edit', 'active-operation'] as const)(
    'preserves concurrent %s during provider observation',
    async (change) => {
      const run = await failedProvisionReinstalled();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const resources = run.options.adapter.getResources.bind(run.options.adapter);
      vi.spyOn(run.options.adapter, 'getResources').mockImplementationOnce(async (identifier) => {
        entered.resolve();
        await release.promise;
        return resources(identifier);
      });
      const pending = reconcileManagedServer(f.db, run.serverId, run.options);
      await entered.promise;
      if (change === 'owner-edit')
        await sql`update gateway_routes set updated_at = created_at + interval '1 microsecond' where server_id = ${run.serverId}`.execute(
          f.db,
        );
      else
        await f.db
          .updateTable('managed_servers')
          .set({ active_operation_id: run.reinstallJobId })
          .where('id', '=', run.serverId)
          .execute();
      const before = await rows(run.serverId);
      release.resolve();
      expect(await pending).toBe(change === 'owner-edit' ? 'observed' : 'deferred');
      expect(await rows(run.serverId)).toEqual(before);
      expect(
        await f.db
          .selectFrom('gateway_server_states')
          .select('server_id')
          .where('server_id', '=', run.serverId)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(run.power).not.toHaveBeenCalled();
    },
  );
  it('activates the original untouched routes offline without replaying original autoStart', async () => {
    const run = await failedProvisionReinstalled();
    const original = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', run.jobId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('server_operations')
      .set({ plan: JSON.stringify({ ...original.plan, autoStart: true }) })
      .where('job_id', '=', run.jobId)
      .execute();
    expect(await reconcileManagedServer(f.db, run.serverId, run.options)).toBe('observed');
    expect((await rows(run.serverId)).every((route) => route.enabled)).toBe(true);
    expect(await getGatewayState(f.db, run.serverId, { env })).toMatchObject({
      state: 'manually_stopped',
      enabled: true,
      wakeJobId: null,
    });
    const recovered = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', run.jobId)
      .executeTakeFirstOrThrow();
    expect(recovered).toMatchObject({
      phase: 'failed',
      updated_at: original.updated_at,
      plan: { gatewayRoutesActivated: true, gatewayRecoveredAfterReinstall: run.reinstallJobId },
    });
    expect(run.power).not.toHaveBeenCalled();
  });
  it.each(['start', 'restart'] as const)(
    'recovers a running explicit %s through fresh readiness with inherited automation',
    async (action) => {
      const run = await failedProvisionReinstalled();
      const started = await run.start(action);
      expect(await reconcileManagedServer(f.db, run.serverId, run.options)).toBe('observed');
      const state = await getGatewayState(f.db, run.serverId, { env, now: run.now });
      expect(state).toMatchObject({ state: 'waking', enabled: true, wakeJobId: started.jobId });
      expect(
        await f.db
          .selectFrom('managed_servers')
          .select('intent')
          .where('id', '=', run.serverId)
          .executeTakeFirst(),
      ).toMatchObject({ intent: 'auto_wake_enabled' });
      expect((await rows(run.serverId)).every((route) => route.enabled)).toBe(true);
      const ready = await reportGatewayObservation(
        f.db,
        run.serverId,
        {
          generation: state.generation,
          wakeJobId: started.jobId,
          observedAt: run.now().toISOString(),
          processStartedAt: started.processStartedAt,
          ready: true,
          idle: false,
          playerCount: 1,
          activeSessions: 1,
        },
        { env, now: run.now },
      );
      expect(ready).toMatchObject({ state: 'online', enabled: true });
      const policy = await f.db
        .selectFrom('gateway_server_states')
        .selectAll()
        .where('server_id', '=', run.serverId)
        .executeTakeFirstOrThrow();
      expect(policy).toMatchObject({
        idle_timeout_inherited: true,
        owner_idle_timeout_seconds: null,
        owner_idle_timeout_user_access: null,
      });
      // A stale Panel offline cache still resolves against the latest actual start,
      // not the failed provision whose bookkeeping was updated by recovery.
      run.setState('offline');
      run.options.observeReconciliationProcessStart = async () => started.processStartedAt;
      run.advance();
      await reconcileManagedServer(f.db, run.serverId, run.options);
      expect(
        await f.db
          .selectFrom('managed_servers')
          .select('runtime_state')
          .where('id', '=', run.serverId)
          .executeTakeFirst(),
      ).toMatchObject({ runtime_state: 'running' });
      expect(run.power).not.toHaveBeenCalled();
    },
  );
  it.each([
    'owner-disabled',
    'published',
    'missing',
    'extra',
    'existing-policy',
    'no-reinstall',
    'unconfirmed-reinstall',
    'active-operation',
    'provider-installing',
    'direct',
  ] as const)('preserves reservations and policies when %s', async (reason) => {
    const run = await failedProvisionReinstalled();
    const route = (await rows(run.serverId))[0];
    if (!route) throw new Error('missing fixture route');
    if (reason === 'owner-disabled')
      await sql`update gateway_routes set updated_at = created_at + interval '1 microsecond' where id = ${route.id}`.execute(
        f.db,
      );
    if (reason === 'published')
      await f.db
        .updateTable('gateway_routes')
        .set({ payload_hash: 'old', revision: '2' })
        .where('id', '=', route.id)
        .execute();
    if (reason === 'missing')
      await f.db.deleteFrom('gateway_routes').where('id', '=', route.id).execute();
    if (reason === 'extra') {
      const operation = await f.db
        .selectFrom('server_operations')
        .select('plan')
        .where('job_id', '=', run.jobId)
        .executeTakeFirstOrThrow();
      const plan = operation.plan.gatewayProvision as { routes: unknown[] };
      await f.db
        .updateTable('server_operations')
        .set({
          plan: JSON.stringify({
            ...operation.plan,
            gatewayProvision: { ...plan, routes: plan.routes.slice(0, 1) },
          }),
        })
        .where('job_id', '=', run.jobId)
        .execute();
    }
    if (reason === 'existing-policy') {
      await f.db
        .updateTable('managed_servers')
        .set({ active_operation_id: run.jobId })
        .where('id', '=', run.serverId)
        .execute();
      await activateProvisionGateway(f.db, run.serverId, run.jobId, env);
      await f.db
        .updateTable('managed_servers')
        .set({ active_operation_id: null })
        .where('id', '=', run.serverId)
        .execute();
      await f.db
        .updateTable('gateway_routes')
        .set({ enabled: false })
        .where('server_id', '=', run.serverId)
        .execute();
    }
    if (reason === 'no-reinstall')
      await f.db
        .updateTable('operation_jobs')
        .set({ state: 'failed' })
        .where('id', '=', run.reinstallJobId)
        .execute();
    if (reason === 'unconfirmed-reinstall')
      await f.db
        .updateTable('server_operations')
        .set({ plan: '{}' })
        .where('job_id', '=', run.reinstallJobId)
        .execute();
    if (reason === 'active-operation')
      await f.db
        .updateTable('managed_servers')
        .set({ active_operation_id: run.reinstallJobId })
        .where('id', '=', run.serverId)
        .execute();
    if (reason === 'provider-installing') run.remote.status = 'installing';
    if (reason === 'direct')
      await f.db
        .updateTable('managed_servers')
        .set({ connection_mode: 'direct' })
        .where('id', '=', run.serverId)
        .execute();
    const before = await rows(run.serverId);
    const policy = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', run.serverId)
      .executeTakeFirst();
    await reconcileManagedServer(f.db, run.serverId, run.options);
    expect(await rows(run.serverId)).toEqual(before);
    expect(
      await f.db
        .selectFrom('gateway_server_states')
        .selectAll()
        .where('server_id', '=', run.serverId)
        .executeTakeFirst(),
    ).toEqual(policy);
    expect(run.power).not.toHaveBeenCalled();
  });
  it.each([
    'maintenance',
    'later-stop',
    'later-failed-stop',
    'automation',
    'invalid-receipt',
  ] as const)('does not infer a new launch intent when %s', async (reason) => {
    const run = await failedProvisionReinstalled();
    await run.start(
      'start',
      reason === 'automation'
        ? { gatewayAutomation: {} }
        : reason === 'invalid-receipt'
          ? { startConfirmedAt: 'invalid' }
          : {},
    );
    if (reason === 'maintenance')
      await f.db
        .updateTable('managed_servers')
        .set({ intent: 'maintenance' })
        .where('id', '=', run.serverId)
        .execute();
    if (reason === 'later-stop' || reason === 'later-failed-stop')
      await run.completed('stop', 2500, {}, reason === 'later-stop');
    await reconcileManagedServer(f.db, run.serverId, run.options);
    expect(await getGatewayState(f.db, run.serverId, { env, now: run.now })).toMatchObject({
      state: reason === 'maintenance' ? 'maintenance' : 'manually_stopped',
      enabled: true,
      wakeJobId: null,
    });
    expect(run.power).not.toHaveBeenCalled();
  });
});

async function legacyGeneratedAutomation() {
  const run = await failedProvisionReinstalled();
  const started = await run.start();
  await reconcileManagedServer(f.db, run.serverId, run.options);
  await f.db
    .updateTable('gateway_server_states')
    .set({ enabled: false })
    .where('server_id', '=', run.serverId)
    .execute();
  const operation = await f.db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', run.jobId)
    .executeTakeFirstOrThrow();
  const { gatewayAutomationInitialized: _oldMarker, ...plan } = operation.plan;
  await f.db
    .updateTable('server_operations')
    .set({ plan: JSON.stringify(plan) })
    .where('job_id', '=', run.jobId)
    .execute();
  const state = await getGatewayState(f.db, run.serverId, { env, now: run.now });
  async function report(playerCount: number | null = 0, quiescence = false) {
    return reportGatewayObservation(
      f.db,
      run.serverId,
      {
        generation: state.generation,
        wakeJobId: started.jobId,
        observedAt: run.now().toISOString(),
        processStartedAt: started.processStartedAt,
        ready: true,
        idle: playerCount === 0,
        playerCount: playerCount ?? undefined,
        activeSessions: 0,
        ...(quiescence
          ? { quiescenceUntil: new Date(run.now().getTime() + 15000).toISOString() }
          : {}),
      },
      { env, now: run.now },
    );
  }
  return { ...run, started, report };
}

describe('generated Gateway policies inherit automation without overriding explicit policy', () => {
  it.each(['60', '-1'])(
    'repairs the legacy default with timeout %s and preserves fresh idle evidence',
    async (timeout) => {
      env.NH_DEFAULT_IDLE_TIMEOUT_SECONDS = timeout;
      const run = await legacyGeneratedAutomation();
      await run.report();
      for (let n = 0; n < 3; n++) {
        run.advance(20_000);
        await run.report();
      }
      const before = await f.db
        .selectFrom('gateway_server_states')
        .selectAll()
        .where('server_id', '=', run.serverId)
        .executeTakeFirstOrThrow();
      expect(before.enabled).toBe(false);
      await reconcileManagedServer(f.db, run.serverId, run.options);
      const after = await f.db
        .selectFrom('gateway_server_states')
        .selectAll()
        .where('server_id', '=', run.serverId)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({ ...before, enabled: true });
      run.advance(1);
      const reported = await run.report(0, true);
      if (timeout === '-1') {
        expect(reported).toMatchObject({ enabled: true, state: 'online', sleepJobId: null });
      } else {
        expect(reported.sleepJobId).not.toBeNull();
        expect(
          await f.db
            .selectFrom('server_operations')
            .select(['action', 'plan'])
            .where('job_id', '=', reported.sleepJobId ?? '')
            .executeTakeFirst(),
        ).toMatchObject({ action: 'stop', plan: { gatewayAutomation: { kind: 'sleep' } } });
      }
      expect(run.power).not.toHaveBeenCalled();
    },
  );
  it('unknown player counts never authorize automatic sleep after enabling the inherited policy', async () => {
    env.NH_DEFAULT_IDLE_TIMEOUT_SECONDS = '60';
    const run = await legacyGeneratedAutomation();
    await reconcileManagedServer(f.db, run.serverId, run.options);
    for (let n = 0; n < 5; n++) {
      run.advance(20_000);
      expect(await run.report(null, true)).toMatchObject({ enabled: true, sleepJobId: null });
    }
    expect(run.power).not.toHaveBeenCalled();
  });
  it('preserves an explicit no-op disable even when the generated generation is unchanged', async () => {
    const run = await legacyGeneratedAutomation();
    const before = await getGatewayState(f.db, run.serverId, { env, now: run.now });
    await setGatewayPolicy(
      f.db,
      f.owner,
      run.serverId,
      {
        enabled: false,
        protocolId: 'fixture',
        gameVersion: '1',
        mode: 'auto',
        readinessTimeoutSeconds: 600,
        readinessMaxAgeSeconds: 30,
        estimateMaxAgeSeconds: 604800,
        wakeRetrySeconds: 10,
      },
      { env, now: run.now },
    );
    expect((await getGatewayState(f.db, run.serverId, { env, now: run.now })).generation).toBe(
      before.generation,
    );
    await reconcileManagedServer(f.db, run.serverId, run.options);
    expect(await getGatewayState(f.db, run.serverId, { env, now: run.now })).toMatchObject({
      enabled: false,
      generation: before.generation,
    });
  });
  it.each(['manual-stop', 'maintenance', 'rotated-generation'] as const)(
    'repairs only the generated flag while preserving %s',
    async (change) => {
      const run = await legacyGeneratedAutomation();
      const generation = randomUUID();
      await f.db
        .updateTable('gateway_server_states')
        .set({ generation })
        .where('server_id', '=', run.serverId)
        .execute();
      const intent =
        change === 'maintenance'
          ? 'maintenance'
          : change === 'manual-stop'
            ? 'manually_stopped'
            : 'auto_wake_enabled';
      await f.db
        .updateTable('managed_servers')
        .set({ intent })
        .where('id', '=', run.serverId)
        .execute();
      await reconcileManagedServer(f.db, run.serverId, run.options);
      expect(
        await f.db
          .selectFrom('gateway_server_states')
          .select(['generation', 'enabled'])
          .where('server_id', '=', run.serverId)
          .executeTakeFirst(),
      ).toEqual({ generation, enabled: true });
      expect(
        await f.db
          .selectFrom('managed_servers')
          .select('intent')
          .where('id', '=', run.serverId)
          .executeTakeFirst(),
      ).toEqual({ intent });
      if (change !== 'rotated-generation')
        expect(
          await requestGatewayWake(
            f.db,
            run.serverId,
            { generation, intent: 'join' },
            { env, now: run.now },
          ),
        ).toMatchObject({ wakeJobId: run.started.jobId, state: intent });
      expect(run.power).not.toHaveBeenCalled();
    },
  );
  it.each(['override', 'modified-policy', 'missing-provenance', 'unsupported-binding'] as const)(
    'declines automatic policy repair for %s',
    async (change) => {
      const run = await legacyGeneratedAutomation();
      if (change === 'override')
        await f.db
          .updateTable('gateway_server_states')
          .set({ owner_idle_timeout_seconds: -1 })
          .where('server_id', '=', run.serverId)
          .execute();
      if (change === 'modified-policy')
        await f.db
          .updateTable('gateway_server_states')
          .set({ readiness_timeout_seconds: 601 })
          .where('server_id', '=', run.serverId)
          .execute();
      if (change === 'missing-provenance')
        await f.db
          .updateTable('server_operations')
          .set({ plan: '{}' })
          .where('job_id', '=', run.jobId)
          .execute();
      if (change === 'unsupported-binding') module.gatewayPolicyBinding = async () => null;
      if (change === 'unsupported-binding')
        await expect(reconcileManagedServer(f.db, run.serverId, run.options)).rejects.toThrow(
          'integration_unavailable',
        );
      else await reconcileManagedServer(f.db, run.serverId, run.options);
      expect((await getGatewayState(f.db, run.serverId, { env, now: run.now })).enabled).toBe(
        false,
      );
    },
  );
});
