import { randomUUID } from 'node:crypto';
import { authSessionId, DomainError } from '@nickhosting/core';
import { createDatabase, type Database } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { commandDigest, enqueueCommand } from '@nickhosting/jobs';
import {
  type ApplicationServer,
  type Backup,
  type BackupActivity,
  type BuildUpdate,
  type PterodactylAdapter,
  PterodactylError,
  type Resources,
} from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackendAllocationPool } from './allocation-pool.js';
import {
  type LifecycleOptions,
  processServerOperation,
  reconcileManagedServer,
  resolveUncertainOperation,
} from './lifecycle.js';
import { enqueueServerOperation } from './registry.js';
import { pendingUploadFixture } from './test-fixtures.js';

let providerSequence = 0;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

async function fixture(
  action:
    | 'provision'
    | 'start'
    | 'stop'
    | 'restart'
    | 'reinstall'
    | 'wipe'
    | 'delete'
    | 'backup'
    | 'restore'
    | 'configure',
  plan: Record<string, unknown> = {},
  binding?: {
    address: string;
    backendAddress: string;
    loopbackRemap: BackendAllocationPool['loopbackRemap'];
  },
) {
  const db = database.db;
  const ownerId = randomUUID(),
    hostId = randomUUID(),
    nodeId = randomUUID(),
    mappingId = randomUUID(),
    serverId = randomUUID(),
    jobId = randomUUID();
  const providerId = ++providerSequence;
  const allocationAddress = binding?.address ?? '10.0.0.2';
  const backendAddress = binding?.backendAddress ?? allocationAddress;
  let clock = new Date();
  await sql`insert into "user"(id,name,email,role) values(${ownerId},'fixture',${`${ownerId}@example.com`},'user')`.execute(
    db,
  );
  await db
    .insertInto('game_integrations')
    .values({ id: mappingId, version: '1', manifest: {} })
    .execute();
  await db
    .insertInto('physical_hosts')
    .values({
      id: hostId,
      name: 'isolated',
      memory_limit_mib: 2048,
      cpu_limit_percent: 200,
      storage_pool_mib: '10000',
      memory_headroom_mib: 256,
      cpu_headroom_percent: 20,
      disk_headroom_mib: '100',
      local_disk_path: 'fixture',
      observer_id: 'fixture',
    })
    .execute();
  await db
    .insertInto('managed_nodes')
    .values({
      id: nodeId,
      physical_host_id: hostId,
      pterodactyl_node_id: providerId,
      provision_user_id: 1,
      backend_allocation_pool: JSON.stringify({
        allocations: [
          { allocationId: providerId, address: allocationAddress, backendAddress, port: 25000 },
        ],
        ...(binding ? { loopbackRemap: binding.loopbackRemap } : {}),
        gatewayBindAddresses: ['203.0.113.2'],
      }),
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
      docker_image: 'fixture/image:1',
      startup: 'fixture',
      environment: '{}',
      port_roles: JSON.stringify([{ role: 'game', protocols: ['tcp'], primary: true }]),
      feature_limits: JSON.stringify({ databases: 0, allocations: 1, backups: 1 }),
    })
    .execute();
  const remote: ApplicationServer = {
    id: providerId,
    external_id: `nh:${serverId}`,
    uuid: randomUUID(),
    identifier: serverId.slice(0, 8),
    name: 'fixture',
    description: '',
    suspended: false,
    limits: { memory: 128, cpu: 10, disk: 64, swap: 0, io: 500 },
    feature_limits: { databases: 0, allocations: 1, backups: 1 },
    user: 1,
    node: providerId,
    allocation: providerId,
    nest: 1,
    egg: 1,
    status: null,
    container: { startup_command: 'fixture', image: 'fixture/image:1', installed: true },
    relationships: {
      allocations: {
        object: 'list',
        data: [
          { attributes: { id: providerId, ip: allocationAddress, port: 25000, assigned: true } },
        ],
      },
    },
    created_at: clock.toISOString(),
    updated_at: clock.toISOString(),
  };
  let exists = action !== 'provision';
  let state: Resources['current_state'] = 'offline';
  let uptime = 100_000;
  let files = ['world', 'settings.cfg'];
  const backups: Backup[] = [];
  const activities: BackupActivity[] = [];
  const adapter = {
    getNode: vi.fn(async () => ({ id: providerId })),
    listAllocations: vi.fn(async () => [
      { id: providerId, ip: allocationAddress, port: 25000, assigned: exists },
    ]),
    getApplicationServer: vi.fn(async () => {
      if (!exists) throw new PterodactylError('not_found', 'application', 'rejected', 404);
      return structuredClone(remote);
    }),
    findServerByExternalId: vi.fn(async () => (exists ? structuredClone(remote) : null)),
    createServer: vi.fn(async () => {
      exists = true;
      return structuredClone(remote);
    }),
    getResources: vi.fn(
      async (): Promise<Resources> => ({
        current_state: state,
        is_suspended: false,
        resources: {
          memory_bytes: state === 'running' ? 64 * 1048576 : 0,
          cpu_absolute: state === 'running' ? 5 : 0,
          disk_bytes: 1024,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
          uptime,
        },
      }),
    ),
    power: vi.fn(async (_identifier: string, signal: string) => {
      state = signal === 'stop' ? 'offline' : 'running';
      if (signal === 'restart') uptime = 1;
    }),
    stopWithConfirmation: vi.fn(
      async (
        _applicationId: number,
        _identifier: string,
        input: { authorize: () => Promise<boolean>; onConfirmed: () => Promise<void> },
      ) => {
        if (!(await input.authorize()))
          throw new PterodactylError('permission_denied', 'client', 'rejected');
        state = 'offline';
        await input.onConfirmed();
        return { confirmed: true };
      },
    ),
    confirmInstallation: vi.fn(
      async (
        _applicationId: number,
        _identifier: string,
        input: { authorize: () => Promise<boolean>; onConfirmed: () => Promise<void> },
      ) => {
        if (!(await input.authorize())) return { confirmed: false };
        await input.onConfirmed();
        return { confirmed: true };
      },
    ),
    reinstallWithConfirmation: vi.fn(
      async (
        _applicationId: number,
        identifier: string,
        input: { authorize: () => Promise<boolean>; onConfirmed: () => Promise<void> },
      ) => {
        if (!(await input.authorize()))
          throw new PterodactylError('permission_denied', 'client', 'rejected');
        await adapter.reinstall(identifier);
        await input.onConfirmed();
        return { confirmed: true };
      },
    ),
    reinstall: vi.fn(async (_identifier: string) => {}),
    deleteServer: vi.fn(async () => {
      exists = false;
    }),
    listFiles: vi.fn(async () =>
      files.map((name) => ({
        name,
        mode: '-rw',
        size: 1,
        is_file: true,
        is_symlink: false,
        mimetype: 'text/plain',
        created_at: clock.toISOString(),
        modified_at: clock.toISOString(),
      })),
    ),
    deleteFiles: vi.fn(async (_identifier: string, _root: string, names: string[]) => {
      files = files.filter((name) => !names.includes(name));
    }),
    createBackup: vi.fn(async (_identifier: string, input: { name: string }) => {
      const value: Backup = {
        uuid: randomUUID(),
        name: input.name,
        is_successful: true,
        is_locked: false,
        ignored_files: [],
        checksum: 'sha256:fixture',
        bytes: 100,
        created_at: clock.toISOString(),
        completed_at: clock.toISOString(),
      };
      backups.push(value);
      return value;
    }),
    listBackups: vi.fn(async () => backups),
    listBackupActivity: vi.fn(async () => activities),
    getBackup: vi.fn(async (_identifier: string, id: string) => {
      const value = backups.find((b) => b.uuid === id);
      if (!value) throw new PterodactylError('not_found', 'client', 'rejected');
      return value;
    }),
    restoreBackup: vi.fn(async () => {}),
    updateBuild: vi.fn(async (_id: number, build: BuildUpdate) => {
      remote.limits = {
        memory: build.memory,
        cpu: build.cpu,
        disk: build.disk,
        swap: build.swap,
        io: build.io,
      };
      return remote;
    }),
  };
  const command = {
    type: 'server.operation',
    version: 1,
    payload: { serverId, operationId: jobId },
  } as const;
  await db
    .insertInto('operation_jobs')
    .values({
      id: jobId,
      actor_id: ownerId,
      subject_id: ownerId,
      resource_owner_id: ownerId,
      support_session_id: null,
      idempotency_key: jobId,
      command_hash: commandDigest({ command, subjectId: ownerId, resourceOwnerId: ownerId }),
      command: JSON.stringify(command),
      policy_snapshot: '{}',
      max_attempts: 3,
      error_code: null,
      completed_at: null,
      next_attempt_at: clock,
    })
    .execute();
  await db
    .insertInto('managed_servers')
    .values({
      id: serverId,
      owner_id: ownerId,
      project_id: null,
      mapping_id: mappingId,
      node_id: nodeId,
      name: 'fixture',
      external_id: remote.external_id ?? '',
      pterodactyl_id: exists ? remote.id : null,
      pterodactyl_uuid: exists ? remote.uuid : null,
      pterodactyl_identifier: exists ? remote.identifier : null,
      limits: JSON.stringify(remote.limits),
      active_operation_id: jobId,
      last_observed_at: null,
      deleted_at: null,
    })
    .execute();
  await db
    .insertInto('server_allocations')
    .values({
      id: randomUUID(),
      server_id: serverId,
      node_id: nodeId,
      pterodactyl_allocation_id: providerId,
      address: allocationAddress,
      backend_address: backendAddress,
      port: 25000,
      role: 'game',
      protocols: ['tcp'],
      is_primary: true,
    })
    .execute();
  const provision = {
    name: 'fixture',
    externalId: remote.external_id,
    userId: 1,
    eggId: 1,
    dockerImage: 'fixture/image:1',
    startup: 'fixture',
    environment: {},
    limits: remote.limits,
    featureLimits: remote.feature_limits,
    allocation: { default: providerId },
  };
  await db
    .insertInto('server_operations')
    .values({
      job_id: jobId,
      server_id: serverId,
      action,
      plan: JSON.stringify({ ...(action === 'provision' ? { provision } : {}), ...plan }),
      effect_started_at: null,
      lease_until: null,
      lease_token: null,
    })
    .execute();
  await db.insertInto('job_outbox').values({ job_id: jobId, last_dispatched_at: null }).execute();
  const reserveStart = vi.fn(
    async (
      _serverId?: string,
      _jobId?: string,
      _action?: string,
      connection: Kysely<Database> = db,
    ) => {
      await connection
        .insertInto('resource_reservations')
        .values({
          server_id: serverId,
          owner_id: ownerId,
          physical_host_id: hostId,
          memory_mib: 128,
          physical_memory_mib: 148,
          cpu_percent: 10,
          operation_id: jobId,
          state: action === 'restart' ? 'restarting' : 'starting',
          updated_at: clock,
        })
        .onConflict((c) => c.column('server_id').doNothing())
        .execute();
    },
  );
  const options: LifecycleOptions = {
    adapter: adapter as unknown as PterodactylAdapter,
    authorizeEffect: async () => {},
    now: () => clock,
    reserveStart,
    reserveInstallation: async (_serverId, _jobId, connection) => {
      await connection
        .insertInto('installation_reservations')
        .values({
          server_id: serverId,
          physical_host_id: hostId,
          operation_id: jobId,
          memory_mib: 1178,
          cpu_percent: 100,
        })
        .onConflict((c) => c.column('server_id').doNothing())
        .execute();
    },
  };
  return {
    db,
    jobId,
    serverId,
    ownerId,
    hostId,
    nodeId,
    remote,
    adapter,
    options,
    backups,
    activities,
    now: () => clock,
    setState(value: Resources['current_state']) {
      state = value;
    },
    setExists(value: boolean) {
      exists = value;
    },
    setFiles(value: string[]) {
      files = value;
    },
    setUptime(value: number) {
      uptime = value;
    },
    tick(ms = 22_000) {
      clock = new Date(clock.getTime() + ms);
    },
    run() {
      return processServerOperation(db, jobId, options);
    },
    async operation() {
      return db
        .selectFrom('server_operations')
        .selectAll()
        .where('job_id', '=', jobId)
        .executeTakeFirstOrThrow();
    },
    async server() {
      return db
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();
    },
    async installationReservation() {
      return db
        .selectFrom('installation_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .executeTakeFirst();
    },
    async reservation() {
      return db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .executeTakeFirst();
    },
    async prepareReservation() {
      await reserveStart();
    },
  };
}

describe('durable provider lifecycle with real PostgreSQL', () => {
  const loopbackBinding = {
    address: '127.0.0.1',
    backendAddress: '10.0.0.254',
    loopbackRemap: {
      wingsVersion: '1.11.13' as const,
      networkMode: 'isolated-fixture-bridge',
      networkDriver: 'bridge' as const,
      gatewayMode: 'nat' as const,
      interfaceAddress: '10.0.0.254',
      ispn: false as const,
      verifiedEggs: [{ nestId: 1, eggId: 1, forceOutgoingIp: false as const }],
    },
  };
  it('provisions a declared loopback allocation while preserving separate provider and backend identities', async () => {
    const f = await fixture('provision', {}, loopbackBinding);
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.createServer).toHaveBeenCalledOnce();
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(
      await f.db
        .selectFrom('server_allocations')
        .select(['address', 'backend_address'])
        .where('server_id', '=', f.serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ address: '127.0.0.1', backend_address: '10.0.0.254' });
    expect(f.remote.relationships?.allocations?.data[0]?.attributes.ip).toBe('127.0.0.1');
  });
  it('rejects a loopback provision if its egg no longer has explicit verified network evidence', async () => {
    const f = await fixture(
      'provision',
      {},
      {
        ...loopbackBinding,
        loopbackRemap: {
          ...loopbackBinding.loopbackRemap,
          verifiedEggs: [{ nestId: 1, eggId: 2, forceOutgoingIp: false }],
        },
      },
    );
    expect(await f.run()).toBe('failed');
    expect(f.adapter.createServer).not.toHaveBeenCalled();
    expect(await f.installationReservation()).toBeUndefined();
  });
  it('does not substitute the backend address for the provider identity before mutations', async () => {
    const f = await fixture('delete', {}, loopbackBinding);
    const allocation = f.remote.relationships?.allocations?.data[0]?.attributes;
    if (!allocation) throw new Error('Missing fixture allocation');
    allocation.ip = loopbackBinding.backendAddress;
    expect(await f.run()).toBe('failed');
    expect(f.adapter.deleteServer).not.toHaveBeenCalled();
  });
  it('retains an ambiguous upload and refuses a queued provider effect after worker recovery', async () => {
    const f = await fixture('backup');
    const claimId = await pendingUploadFixture(f.db, f.serverId);
    expect(await f.run()).toBe('waiting');
    expect(f.adapter.createBackup).not.toHaveBeenCalled();
    expect((await f.operation()).effect_state).toBe('none');
    expect(
      await f.db
        .selectFrom('upload_ingestion_claims')
        .select('id')
        .where('id', '=', claimId)
        .executeTakeFirst(),
    ).toEqual({ id: claimId });
  });
  it.each(['unconfigured', 'environment-disabled', 'assigned', 'address-drift', 'foreign-plan'])(
    'rejects %s backend allocations before installer admission or provider creation',
    async (change) => {
      const f = await fixture('provision');
      if (change === 'unconfigured')
        await f.db
          .updateTable('managed_nodes')
          .set({ backend_allocation_pool: null })
          .where('id', '=', f.nodeId)
          .execute();
      else if (change === 'environment-disabled')
        f.options.env = { NH_BACKEND_ALLOCATION_POOLS: JSON.stringify({ [f.nodeId]: null }) };
      else if (change === 'assigned')
        f.adapter.listAllocations.mockResolvedValue([
          { id: f.remote.allocation, ip: '10.0.0.2', port: 25000, assigned: true },
        ]);
      else if (change === 'address-drift')
        f.adapter.listAllocations.mockResolvedValue([
          { id: f.remote.allocation, ip: '203.0.113.2', port: 25000, assigned: false },
        ]);
      else {
        const operation = await f.operation();
        await f.db
          .updateTable('server_operations')
          .set({
            plan: JSON.stringify({
              ...operation.plan,
              provision: {
                ...(operation.plan.provision as Record<string, unknown>),
                allocation: { default: f.remote.allocation + 100000 },
              },
            }),
          })
          .where('job_id', '=', f.jobId)
          .execute();
      }
      expect(await f.run()).toBe('failed');
      expect(f.adapter.createServer).not.toHaveBeenCalled();
      expect(await f.installationReservation()).toBeUndefined();
      expect((await f.operation()).effect_started_at).toBeNull();
    },
  );
  it('provisions stopped servers without compute reservation and snapshots intent before the effect', async () => {
    const f = await fixture('provision');
    f.options.checkpoint = async (point) => {
      if (point === 'prepared')
        expect(await f.operation()).toMatchObject({ phase: 'provision', effect_state: 'prepared' });
    };
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.createServer).toHaveBeenCalledTimes(1);
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(await f.reservation()).toBeUndefined();
    expect(await f.installationReservation()).toBeUndefined();
    expect(await f.server()).toMatchObject({
      pterodactyl_uuid: f.remote.uuid,
      runtime_state: 'offline',
      installation_state: 'installed',
      active_operation_id: null,
    });
  });
  it('recovers crash after remote creation without duplicate provisioning', async () => {
    const f = await fixture('provision');
    f.options.checkpoint = async (point) => {
      if (point === 'remote_succeeded') throw new Error('simulated process crash');
    };
    expect(await f.run()).toBe('waiting');
    expect(await f.operation()).toMatchObject({ phase: 'provision', effect_state: 'prepared' });
    expect((await f.server()).pterodactyl_id).toBeNull();
    // A newly disabled pool blocks new creates, not recovery of our confirmed identity.
    await f.db
      .updateTable('managed_nodes')
      .set({ backend_allocation_pool: null })
      .where('id', '=', f.nodeId)
      .execute();
    delete f.options.checkpoint;
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.createServer).toHaveBeenCalledTimes(1);
  });
  it('never repeats an uncertain create or adopts a pre-existing external identity', async () => {
    const uncertain = await fixture('provision');
    uncertain.adapter.createServer.mockImplementation(async () => {
      throw new PterodactylError('unavailable', 'application', 'unknown');
    });
    expect(await uncertain.run()).toBe('waiting');
    uncertain.tick();
    expect(await uncertain.run()).toBe('waiting');
    expect(uncertain.adapter.createServer).toHaveBeenCalledTimes(1);
    const existing = await fixture('provision');
    existing.setExists(true);
    expect(await existing.run()).toBe('failed');
    expect(existing.adapter.createServer).not.toHaveBeenCalled();
  });
  it('keeps a created server offline when optional initial admission is denied', async () => {
    const f = await fixture('provision', { autoStart: true });
    f.options.reserveStart = async () => {
      throw new DomainError('resources_unavailable');
    };
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect((await f.server()).runtime_state).toBe('offline');
    const event = await f.db
      .selectFrom('server_events')
      .select('message_key')
      .where('server_id', '=', f.serverId)
      .execute();
    expect(event.map((e) => e.message_key)).toContain('servers.operation.initial_start_denied');
  });
  it('admits initial start only after installation and confirms running separately', async () => {
    const f = await fixture('provision', { autoStart: true });
    expect(await f.run()).toBe('waiting');
    expect(await f.reservation()).toBeDefined();
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
    expect((await f.server()).readiness).toBe('loading');
  });
  it('serializes duplicate deliveries around an external power call', async () => {
    const f = await fixture('start');
    const results = await Promise.all(Array.from({ length: 10 }, () => f.run()));
    expect(results).toContain('waiting');
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect((await f.reservation())?.state).toBe('running');
  });
  it('recovers timeout after a remote start succeeded without another start', async () => {
    const f = await fixture('start');
    f.adapter.power.mockImplementation(async () => {
      f.setState('running');
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
  });
  it('retains stopping reservations when cached offline does not prove terminal stop', async () => {
    const f = await fixture('stop');
    f.adapter.stopWithConfirmation.mockImplementation(async () => {
      f.setState('offline');
      return { confirmed: false };
    });
    await f.prepareReservation();
    f.setState('running');
    expect(await f.run()).toBe('waiting');
    f.tick(5_000);
    expect(await f.run()).toBe('waiting');
    expect(await f.reservation()).toBeDefined();
    f.tick(17_000);
    expect(await f.run()).toBe('waiting');
    expect(await f.reservation()).toBeDefined();
    expect((await f.operation()).plan.waitReason).toBe('stop_terminal_unproven');
    expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
  });
  it('completes a proven offline stop without power and leaves start, repeated stop and delete usable', async () => {
    const f = await fixture('provision');
    expect(await f.run()).toBe('succeeded');
    const context = {
      actorUserId: f.ownerId,
      subjectUserId: f.ownerId,
      role: 'user' as const,
      sessionType: 'regular' as const,
      ownerElevation: false,
    };
    const enqueue = async (action: 'start' | 'stop' | 'delete') =>
      enqueueServerOperation(f.db, context, f.serverId, {
        action,
        idempotencyKey: randomUUID(),
        ...(action === 'delete' ? { confirm: true } : {}),
      });
    f.options.confirmAlreadyStopped = vi.fn(async () => true);
    const stopped = await enqueue('stop');
    f.tick(1000);
    expect(await processServerOperation(f.db, stopped.jobId, f.options)).toBe('succeeded');
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
    expect(await f.reservation()).toBeUndefined();
    expect((await f.server()).active_operation_id).toBeNull();
    expect(
      await f.db
        .selectFrom('server_operations')
        .selectAll()
        .where('job_id', '=', stopped.jobId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ phase: 'complete', effect_started_at: null, plan: { stopNoOp: true } });
    const at = new Date();
    await f.db
      .insertInto('host_observations')
      .values({
        host_id: f.hostId,
        observer_id: 'fixture',
        observed_at: at,
        snapshot: JSON.stringify({
          totalMemoryMiB: 2048,
          availableMemoryMiB: 2048,
          cpuCapacityPercent: 200,
          cpuBusyPercent: 0,
          availableDiskMiB: 10000,
          managed: {},
          observedAt: at.toISOString(),
        }),
      })
      .execute();
    const started = await enqueue('start');
    expect(await processServerOperation(f.db, started.jobId, f.options)).toBe('waiting');
    f.tick();
    expect(await processServerOperation(f.db, started.jobId, f.options)).toBe('succeeded');
    const qualifiedStop = await enqueue('stop');
    expect(await processServerOperation(f.db, qualifiedStop.jobId, f.options)).toBe('waiting');
    f.tick();
    expect(await processServerOperation(f.db, qualifiedStop.jobId, f.options)).toBe('succeeded');
    expect(await f.reservation()).toBeUndefined();
    const repeatedStop = await enqueue('stop');
    expect(await processServerOperation(f.db, repeatedStop.jobId, f.options)).toBe('succeeded');
    expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
    expect(f.options.confirmAlreadyStopped).toHaveBeenCalledTimes(2);
    const deleted = await enqueue('delete');
    expect(await processServerOperation(f.db, deleted.jobId, f.options)).toBe('waiting');
    f.tick();
    expect(await processServerOperation(f.db, deleted.jobId, f.options)).toBe('waiting');
    f.tick();
    expect(await processServerOperation(f.db, deleted.jobId, f.options)).toBe('succeeded');
    expect((await f.server()).deleted_at).not.toBeNull();
    expect(f.adapter.deleteServer).toHaveBeenCalledTimes(1);
  });
  it.each(['false', 'throws'] as const)(
    'does not complete an offline stop when physical confirmation %s',
    async (proof) => {
      const f = await fixture('stop');
      f.options.confirmAlreadyStopped = async () => {
        if (proof === 'throws') throw new Error('isolated observer unavailable');
        return false;
      };
      expect(await f.run()).toBe('waiting');
      expect(await f.operation()).toMatchObject({
        phase: 'planned',
        effect_started_at: null,
        plan: { waitReason: 'already_stopped_unproven' },
      });
      expect((await f.server()).active_operation_id).toBe(f.jobId);
      expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
      expect(f.adapter.power).not.toHaveBeenCalled();
    },
  );
  it('never bypasses strict stop evidence for a held uncertain reservation', async () => {
    const f = await fixture('stop');
    await f.prepareReservation();
    await f.db
      .updateTable('resource_reservations')
      .set({ state: 'uncertain' })
      .where('server_id', '=', f.serverId)
      .execute();
    f.options.confirmAlreadyStopped = vi.fn(async () => true);
    f.adapter.stopWithConfirmation.mockResolvedValue({ confirmed: false });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    expect((await f.reservation())?.state).toBe('uncertain');
    expect((await f.operation()).plan.stopNoOp).not.toBe(true);
    expect(f.options.confirmAlreadyStopped).not.toHaveBeenCalled();
    expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
  });
  it.each(['compute', 'installer'] as const)(
    'rechecks a %s reservation created during offline proof in the locked finish transaction',
    async (kind) => {
      const f = await fixture('stop');
      f.options.confirmAlreadyStopped = async () => {
        if (kind === 'compute') await f.prepareReservation();
        else await f.options.reserveInstallation?.(f.serverId, f.jobId, f.db);
        return true;
      };
      expect(await f.run()).toBe('waiting');
      expect(await f.operation()).toMatchObject({
        phase: 'planned',
        effect_started_at: null,
        plan: { waitReason: 'already_stopped_reservation_changed' },
      });
      expect((await f.operation()).plan.stopNoOp).not.toBe(true);
      expect((await f.server()).active_operation_id).toBe(f.jobId);
      expect(
        kind === 'compute' ? await f.reservation() : await f.installationReservation(),
      ).toBeDefined();
      expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
    },
  );
  it('rechecks current job authorization before completing an offline no-op stop', async () => {
    const f = await fixture('stop');
    f.options.confirmAlreadyStopped = async () => true;
    f.options.authorizeEffect = async () => {
      throw new DomainError('forbidden');
    };
    expect(await f.run()).toBe('failed');
    expect((await f.operation()).plan.stopNoOp).not.toBe(true);
    expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it('retains restart reservation during transient offline and never reissues unknown restart', async () => {
    const f = await fixture('restart');
    f.setState('running');
    f.adapter.power.mockImplementation(async () => {
      f.setState('offline');
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    expect(await f.reservation()).toBeDefined();
    f.setState('running');
    f.setUptime(1);
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
  });
  it('does not misreport an uncertain restart from unchanged running telemetry', async () => {
    const f = await fixture('restart');
    f.setState('running');
    f.adapter.power.mockImplementation(async () => {
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    expect((await f.operation()).plan.waitReason).toBe('restart_outcome_unknown');
    expect(await f.reservation()).toBeDefined();
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
  });
  it('confirms a fast restart from a new physical process despite missing the cached uptime reset', async () => {
    const f = await fixture('restart');
    const baseline = new Date(f.now().getTime() - 100_000).toISOString();
    const observer = vi.fn<NonNullable<LifecycleOptions['observeProcessStart']>>(
      async () => baseline,
    );
    f.options.observeProcessStart = observer;
    f.setState('running');
    f.setUptime(5_000);
    f.adapter.power.mockImplementation(async () => {
      expect((await f.operation()).plan.previousProcessStartedAt).toBe(baseline);
      f.setUptime(25_000);
    });
    expect(await f.run()).toBe('waiting');
    const effect = (await f.operation()).effect_started_at;
    if (!effect) throw new Error('missing durable restart intent');
    const startedAt = new Date(effect.getTime() + 1500).toISOString().replace('Z', '123456Z');
    observer.mockResolvedValue(startedAt);
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(await f.operation()).toMatchObject({
      phase: 'complete',
      plan: {
        previousProcessStartedAt: baseline,
        restartConfirmed: true,
        restartConfirmedAt: f.now().toISOString(),
        restartProcessStartedAt: startedAt,
      },
    });
    expect((await f.reservation())?.state).toBe('running');
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls[0]?.[0]).toBe(f.serverId);
  });
  it('allows restart from a verified offline baseline and records its null process start', async () => {
    const f = await fixture('restart');
    const observer = vi.fn<NonNullable<LifecycleOptions['observeProcessStart']>>(async () => null);
    f.options.observeProcessStart = observer;
    expect(await f.run()).toBe('waiting');
    expect((await f.operation()).plan.previousProcessStartedAt).toBeNull();
    const startedAt = new Date(f.now().getTime() + 1000).toISOString();
    observer.mockResolvedValue(startedAt);
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect((await f.operation()).plan.restartProcessStartedAt).toBe(startedAt);
    expect((await f.reservation())?.state).toBe('running');
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
  });
  it('recovers a persisted uncertain restart in a new worker connection without replaying power', async () => {
    const f = await fixture('restart');
    const baseline = new Date(f.now().getTime() - 100_000).toISOString();
    f.options.observeProcessStart = async () => baseline;
    f.options.checkpoint = async (point) => {
      if (point === 'remote_succeeded') throw new Error('simulated worker exit');
    };
    f.setState('running');
    expect(await f.run()).toBe('waiting');
    expect(await f.operation()).toMatchObject({ phase: 'power', effect_state: 'prepared' });
    const startedAt = new Date(f.now().getTime() + 1000).toISOString();
    f.setUptime(200_000);
    f.tick();
    const restartedWorker = createDatabase(process.env.NH_TEST_DATABASE_URL ?? '', {
      options: `-c search_path=${database.schema}`,
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    try {
      const recoveredOptions: LifecycleOptions = {
        adapter: f.options.adapter,
        authorizeEffect: async () => {},
        now: f.now,
        observeProcessStart: async () => startedAt,
      };
      expect(await processServerOperation(restartedWorker.db, f.jobId, recoveredOptions)).toBe(
        'succeeded',
      );
      expect((await f.operation()).plan.restartProcessStartedAt).toBe(startedAt);
      expect((await f.reservation())?.state).toBe('running');
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
    } finally {
      await restartedWorker.db.destroy();
    }
  });
  it('recovers a historical restart without a physical baseline using strictly newer physical proof', async () => {
    const f = await fixture('restart');
    f.setState('running');
    expect(await f.run()).toBe('waiting');
    expect((await f.operation()).plan).not.toHaveProperty('previousProcessStartedAt');
    const startedAt = new Date(f.now().getTime() + 1000).toISOString();
    f.options.observeProcessStart = async () => startedAt;
    f.setUptime(200_000);
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect((await f.operation()).plan.restartConfirmed).toBe(true);
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
  });
  it.each(['unavailable', 'malformed', 'future', 'zero'] as const)(
    'does not issue restart power when the physical baseline is %s',
    async (kind) => {
      const f = await fixture('restart');
      f.setState('running');
      f.options.observeProcessStart = async () => {
        if (kind === 'unavailable') throw new Error('isolated observer unavailable');
        if (kind === 'malformed') return 'not a timestamp';
        if (kind === 'zero') return '0001-01-01T00:00:00Z';
        return new Date(f.now().getTime() + 1).toISOString();
      };
      expect(await f.run()).toBe('waiting');
      expect(await f.operation()).toMatchObject({
        phase: 'planned',
        plan: { waitReason: 'restart_baseline_unavailable' },
      });
      expect(await f.reservation()).toBeDefined();
      expect(f.adapter.power).not.toHaveBeenCalled();
    },
  );
  it.each([
    'null',
    'unavailable',
    'malformed',
    'invalid_date',
    'zero',
    'epoch',
    'future',
    'future_nanosecond',
    'unchanged',
    'equal_intent',
    'before_intent',
  ] as const)(
    'retains restart reservation for %s physical proof even when telemetry reports an uptime reset',
    async (kind) => {
      const f = await fixture('restart');
      const baseline = new Date(f.now().getTime() - 100_000).toISOString();
      f.setState('running');
      f.options.observeProcessStart = async () => baseline;
      expect(await f.run()).toBe('waiting');
      const effect = (await f.operation()).effect_started_at;
      if (!effect) throw new Error('missing durable restart intent');
      f.tick();
      f.options.observeProcessStart = async () => {
        switch (kind) {
          case 'null':
            return null;
          case 'unavailable':
            throw new Error('isolated observer unavailable');
          case 'malformed':
            return 'not a timestamp';
          case 'invalid_date':
            return '2026-02-30T00:00:00Z';
          case 'zero':
            return '0001-01-01T00:00:00Z';
          case 'epoch':
            return '1970-01-01T00:00:00Z';
          case 'future':
            return new Date(f.now().getTime() + 1).toISOString();
          case 'future_nanosecond':
            return f.now().toISOString().replace('Z', '000001Z');
          case 'unchanged':
            return baseline;
          case 'equal_intent':
            return effect.toISOString();
          case 'before_intent':
            return new Date(effect.getTime() - 1).toISOString();
        }
      };
      expect(await f.run()).toBe('waiting');
      expect((await f.operation()).plan.waitReason).toBe('restart_terminal_unproven');
      expect((await f.operation()).plan.restartConfirmed).not.toBe(true);
      expect((await f.reservation())?.state).toBe('restarting');
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
    },
  );
  it('compares physical evidence at nanosecond precision beyond the durable intent boundary', async () => {
    const f = await fixture('restart');
    const baseline = new Date(f.now().getTime() - 100_000).toISOString();
    f.setState('running');
    f.options.observeProcessStart = async () => baseline;
    expect(await f.run()).toBe('waiting');
    const effect = (await f.operation()).effect_started_at;
    if (!effect) throw new Error('missing durable restart intent');
    const startedAt = effect.toISOString().replace('Z', '000001Z');
    f.options.observeProcessStart = async () => startedAt;
    f.setUptime(200_000);
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect((await f.operation()).plan.restartProcessStartedAt).toBe(startedAt);
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
  });
  it('refuses every mutation when a pinned identity or allocation changes', async () => {
    for (const mismatch of [
      'uuid',
      'user',
      'allocation',
      'allocations',
      'address',
      'port',
      'assignment',
    ] as const) {
      const f = await fixture('delete');
      if (mismatch === 'uuid') f.remote.uuid = randomUUID();
      else if (mismatch === 'user') f.remote.user = 99;
      else if (mismatch === 'allocation') f.remote.allocation += 1;
      else if (mismatch === 'allocations') f.remote.relationships = {};
      else {
        const allocation = f.remote.relationships?.allocations?.data[0]?.attributes;
        if (!allocation) throw new Error('Missing fixture allocation');
        if (mismatch === 'address') allocation.ip = '10.0.0.99';
        else if (mismatch === 'port') allocation.port++;
        else allocation.assigned = false;
      }
      expect(await f.run()).toBe('failed');
      expect(f.adapter.deleteServer).not.toHaveBeenCalled();
      expect(
        (
          await f.db
            .selectFrom('operation_jobs')
            .select('error_code')
            .where('id', '=', f.jobId)
            .executeTakeFirstOrThrow()
        ).error_code,
      ).toBe('provenance_mismatch');
    }
  });
  it('gates wipe on successful verified backup and does not delete data after backup failure', async () => {
    const f = await fixture('wipe', { backupBefore: true });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    const backup = f.backups[0];
    if (!backup) throw new Error('missing backup');
    backup.is_successful = false;
    f.tick();
    expect(await f.run()).toBe('failed');
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
    expect(f.adapter.reinstall).not.toHaveBeenCalled();
  });
  it('wipes only recorded root entries, confirms removal, and reinstalls once', async () => {
    const f = await fixture('wipe');
    for (let i = 0; i < 8; i++) {
      const result = await f.run();
      if (result === 'succeeded') break;
      f.tick();
    }
    expect((await f.operation()).phase).toBe('complete');
    expect(f.adapter.deleteFiles).toHaveBeenCalledWith(f.remote.identifier, '', [
      'world',
      'settings.cfg',
    ]);
    expect(f.adapter.reinstall).toHaveBeenCalledTimes(1);
  });
  it('never repeats uncertain reinstall and requires authenticated terminal proof', async () => {
    const f = await fixture('reinstall');
    f.adapter.confirmInstallation.mockResolvedValue({ confirmed: false });
    f.adapter.reinstall.mockImplementation(async () => {
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.remote.status = 'installing';
    f.remote.container.installed = false;
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.remote.status = null;
    f.remote.container.installed = true;
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.adapter.confirmInstallation.mockImplementationOnce(async (_id, _identifier, input) => {
      await input.onConfirmed();
      return { confirmed: true };
    });
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.reinstall).toHaveBeenCalledTimes(1);
  });
  it('confirms lost deletion response via pinned remote absence, releasing allocations atomically', async () => {
    const f = await fixture('delete');
    f.adapter.deleteServer.mockImplementation(async () => {
      f.setExists(false);
      throw new PterodactylError('unavailable', 'application', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect((await f.server()).deleted_at).toBeInstanceOf(Date);
    expect(await f.reservation()).toBeUndefined();
    expect(
      await f.db
        .selectFrom('server_allocations')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
    ).toHaveLength(0);
    expect(f.adapter.deleteServer).toHaveBeenCalledTimes(1);
  });
  it('reconciles applied build changes after a timeout without duplicate effects', async () => {
    const f = await fixture('configure', {
      build: {
        memory: 256,
        cpu: 10,
        disk: 64,
        swap: 0,
        io: 500,
        allocation: providerSequence + 1,
        feature_limits: { databases: 0, allocations: 1, backups: 1 },
      },
    });
    f.adapter.updateBuild.mockImplementation(async (_id, build) => {
      f.remote.limits.memory = build.memory;
      throw new PterodactylError('unavailable', 'application', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect((await f.server()).limits.memory).toBe(256);
    expect(f.adapter.updateBuild).toHaveBeenCalledTimes(1);
  });
  it('reconciles only registered servers and conservatively accounts external starts', async () => {
    const f = await fixture('start');
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', f.serverId)
      .execute();
    f.setState('running');
    expect(await reconcileManagedServer(f.db, f.serverId, f.options)).toBe('observed');
    expect(await f.reservation()).toBeDefined();
    expect(await f.reservation()).toMatchObject({ memory_mib: 128, physical_memory_mib: 148 });
    await reconcileManagedServer(f.db, f.serverId, {
      ...f.options,
      env: { NH_NODE_MEMORY_OVERHEAD_PERCENT: '200' },
    });
    expect((await f.reservation())?.physical_memory_mib).toBe(256);
    await reconcileManagedServer(f.db, f.serverId, {
      ...f.options,
      env: { NH_NODE_MEMORY_OVERHEAD_PERCENT: '100' },
    });
    expect((await f.reservation())?.physical_memory_mib).toBe(256);
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(await reconcileManagedServer(f.db, randomUUID(), f.options)).toBe('deferred');
    f.setState('offline');
    f.tick(5_000);
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect(await f.reservation()).toBeDefined();
    f.tick(22_000);
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect((await f.reservation())?.state).toBe('uncertain');
  });
  it('raises retained installer physical memory during reconciliation without reducing old maxima', async () => {
    const f = await fixture('reinstall');
    await f.options.reserveInstallation?.(f.serverId, f.jobId, f.db);
    expect(
      (
        await f.db
          .selectFrom('installation_reservations')
          .selectAll()
          .where('server_id', '=', f.serverId)
          .executeTakeFirstOrThrow()
      ).memory_mib,
    ).toBe(1178);
    await reconcileManagedServer(f.db, f.serverId, {
      ...f.options,
      env: { NH_NODE_MEMORY_OVERHEAD_PERCENT: '200' },
    });
    expect(
      (
        await f.db
          .selectFrom('installation_reservations')
          .selectAll()
          .where('server_id', '=', f.serverId)
          .executeTakeFirstOrThrow()
      ).memory_mib,
    ).toBe(2048);
    await reconcileManagedServer(f.db, f.serverId, {
      ...f.options,
      env: { NH_NODE_MEMORY_OVERHEAD_PERCENT: '100' },
    });
    expect(
      (
        await f.db
          .selectFrom('installation_reservations')
          .selectAll()
          .where('server_id', '=', f.serverId)
          .executeTakeFirstOrThrow()
      ).memory_mib,
    ).toBe(2048);
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it('rejects direct generic enqueue of a server operation before it can bypass admission', async () => {
    const f = await fixture('start');
    await expect(
      enqueueCommand(f.db, {
        context: {
          actorUserId: f.ownerId,
          subjectUserId: f.ownerId,
          role: 'owner',
          sessionType: 'regular',
          ownerElevation: false,
        },
        resourceOwnerId: f.ownerId,
        idempotencyKey: randomUUID(),
        command: {
          type: 'server.operation',
          version: 1,
          payload: { serverId: f.serverId, operationId: randomUUID() },
        },
      }),
    ).rejects.toThrow('forbidden');
  });
  it('does not starve a two-connection pool while processing distinct servers concurrently', async () => {
    const fixtures = await Promise.all(Array.from({ length: 4 }, () => fixture('start')));
    const narrow = createDatabase(process.env.NH_TEST_DATABASE_URL ?? '', {
      options: `-c search_path=${database.schema}`,
      max: 2,
      connectionTimeoutMillis: 1000,
    });
    try {
      const result = await Promise.all(
        fixtures.map((f) => processServerOperation(narrow.db, f.jobId, f.options)),
      );
      expect(result).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
      for (const f of fixtures) expect(f.adapter.power).toHaveBeenCalledTimes(1);
    } finally {
      await narrow.db.destroy();
    }
  });
  it('rejects resource drift before admitting a start', async () => {
    const f = await fixture('start');
    f.remote.limits.memory = 4096;
    expect(await f.run()).toBe('failed');
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(await f.reservation()).toBeUndefined();
  });
  it('recovers a lost backup response by durable operation name without another backup', async () => {
    const f = await fixture('backup');
    const original = f.adapter.createBackup.getMockImplementation();
    f.adapter.createBackup.mockImplementation(async (...args) => {
      if (!original) throw new Error('missing implementation');
      await original(...args);
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.createBackup).toHaveBeenCalledTimes(1);
  });
  it('never repeats an uncertain restore and requires a restoration transition', async () => {
    const id = randomUUID();
    const f = await fixture('restore', { backupId: id, truncate: true });
    f.backups.push({
      uuid: id,
      name: 'fixture',
      is_successful: true,
      is_locked: false,
      ignored_files: [],
      checksum: 'sha256:fixture',
      bytes: 100,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    f.adapter.restoreBackup.mockImplementation(async () => {
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.remote.status = 'restoring_backup';
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.remote.status = null;
    f.activities.push({
      id: '1'.repeat(40),
      event: 'server:backup.restore-complete',
      timestamp: f.options.now?.().toISOString() ?? '',
      properties: { name: 'fixture' },
    });
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.restoreBackup).toHaveBeenCalledTimes(1);
  });
  it('blocks deletion until external access revocation has succeeded', async () => {
    const f = await fixture('delete');
    f.options.beforeDelete = async () => {
      throw new DomainError('integration_unavailable');
    };
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    expect(f.adapter.deleteServer).not.toHaveBeenCalled();
    f.options.beforeDelete = async () => {};
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.deleteServer).toHaveBeenCalledTimes(1);
  });
  it('rechecks authorization before every new external effect but still reconciles started effects', async () => {
    const denied = await fixture('delete');
    denied.options.authorizeEffect = async () => {
      throw new DomainError('forbidden');
    };
    expect(await denied.run()).toBe('waiting');
    denied.tick();
    expect(await denied.run()).toBe('failed');
    expect(denied.adapter.deleteServer).not.toHaveBeenCalled();
    const started = await fixture('start');
    expect(await started.run()).toBe('waiting');
    started.options.authorizeEffect = async () => {
      throw new DomainError('forbidden');
    };
    started.tick();
    expect(await started.run()).toBe('succeeded');
    expect(started.adapter.power).toHaveBeenCalledTimes(1);
  });
  it('does not call restore complete when Panel merely clears restoration status', async () => {
    const id = randomUUID();
    const f = await fixture('restore', { backupId: id, truncate: true });
    f.backups.push({
      uuid: id,
      name: 'unique-restore',
      is_successful: true,
      is_locked: false,
      ignored_files: [],
      checksum: 'sha256:fixture',
      bytes: 100,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    expect((await f.operation()).plan.waitReason).toBe('restore_evidence_pending');
    f.activities.push({
      id: '2'.repeat(40),
      event: 'server.backup.restore-failed',
      timestamp: f.options.now?.().toISOString() ?? '',
      properties: { name: 'unique-restore' },
    });
    f.tick();
    expect(await f.run()).toBe('failed');
    expect(f.adapter.restoreBackup).toHaveBeenCalledTimes(1);
  });
  it('rejects ambiguous backup names and excludes baseline or unrelated restoration events', async () => {
    const id = randomUUID();
    const f = await fixture('restore', { backupId: id, truncate: true });
    const backup = {
      uuid: id,
      name: 'same-name',
      is_successful: true,
      is_locked: false,
      ignored_files: [],
      checksum: 'sha256:fixture',
      bytes: 100,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    f.backups.push(backup, { ...backup, uuid: randomUUID() });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('failed');
    expect(f.adapter.restoreBackup).not.toHaveBeenCalled();
    const next = await fixture('restore', { backupId: id, truncate: true });
    next.backups.push(backup);
    next.activities.push({
      id: '3'.repeat(40),
      event: 'server:backup.restore-complete',
      timestamp: next.options.now?.().toISOString() ?? '',
      properties: { name: 'same-name' },
    });
    expect(await next.run()).toBe('waiting');
    next.tick();
    expect(await next.run()).toBe('waiting');
    next.tick();
    next.activities.push({
      id: '4'.repeat(40),
      event: 'server:backup.restore-complete',
      timestamp: next.options.now?.().toISOString() ?? '',
      properties: { name: 'other-backup' },
    });
    expect(await next.run()).toBe('waiting');
    expect(next.adapter.restoreBackup).toHaveBeenCalledTimes(1);
  });
  it('quarantines Owner resolution and audits failed-only acknowledgment without releasing capacity', async () => {
    const f = await fixture('configure', {
      build: {
        memory: 256,
        cpu: 10,
        disk: 64,
        swap: 0,
        io: 500,
        allocation: providerSequence + 1,
        feature_limits: { databases: 0, allocations: 1, backups: 1 },
      },
    });
    f.adapter.updateBuild.mockImplementation(async () => {
      throw new PterodactylError('unavailable', 'application', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    await f.prepareReservation();
    const context = {
      actorUserId: f.ownerId,
      subjectUserId: f.ownerId,
      role: 'owner',
      sessionType: 'regular',
      ownerElevation: false,
    } as const;
    const input = {
      jobId: f.jobId,
      confirm: true,
      reason: 'Inspected and acknowledged uncertain remote outcome',
    };
    await expect(
      resolveUncertainOperation(f.db, f.options.adapter, context, f.serverId, input),
    ).rejects.toThrow('conflict');
    await f.db
      .updateTable('server_operations')
      .set({ effect_started_at: new Date(Date.now() - 121000) })
      .where('job_id', '=', f.jobId)
      .execute();
    f.setState('running');
    await expect(
      resolveUncertainOperation(f.db, f.options.adapter, context, f.serverId, input),
    ).rejects.toThrow('conflict');
    f.setState('offline');
    expect(
      await resolveUncertainOperation(f.db, f.options.adapter, context, f.serverId, input),
    ).toBe('resolved');
    expect((await f.operation()).phase).toBe('owner_resolved_failed');
    expect(await f.reservation()).toBeDefined();
    expect((await f.server()).active_operation_id).toBeNull();
    expect(
      await f.db
        .selectFrom('audit_events')
        .select('id')
        .where('action', '=', 'server.operation.owner_resolution')
        .where('actor_user_id', '=', f.ownerId)
        .execute(),
    ).toHaveLength(1);
    expect(f.adapter.updateBuild).toHaveBeenCalledTimes(1);
  });
  it.each(['revoked', 'expired', 'demoted'] as const)(
    'rejects Owner resolution when the bound session is %s during provider proof',
    async (change) => {
      const f = await fixture('configure', {
        build: {
          memory: 256,
          cpu: 10,
          disk: 64,
          swap: 0,
          io: 500,
          allocation: providerSequence + 1,
          feature_limits: { databases: 0, allocations: 1, backups: 1 },
        },
      });
      f.adapter.updateBuild.mockImplementation(async () => {
        throw new PterodactylError('unavailable', 'application', 'unknown');
      });
      expect(await f.run()).toBe('waiting');
      f.tick();
      expect(await f.run()).toBe('waiting');
      await f.prepareReservation();
      await f.db
        .updateTable('server_operations')
        .set({ effect_started_at: new Date(Date.now() - 121_000) })
        .where('job_id', '=', f.jobId)
        .execute();
      await f.db.updateTable('user').set({ role: 'owner' }).where('id', '=', f.ownerId).execute();
      const sessionId = randomUUID();
      await f.db
        .insertInto('session')
        .values({
          id: sessionId,
          token: randomUUID(),
          userId: f.ownerId,
          expiresAt: new Date(Date.now() + 60_000),
        })
        .execute();
      const before = {
        operation: await f.operation(),
        reservation: await f.reservation(),
        server: await f.server(),
      };
      const resources = await f.adapter.getResources();
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      f.adapter.getResources.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return resources;
      });
      const pending = resolveUncertainOperation(
        f.db,
        f.options.adapter,
        {
          actorUserId: f.ownerId,
          subjectUserId: f.ownerId,
          role: 'owner',
          sessionType: 'regular',
          ownerElevation: false,
          [authSessionId]: sessionId,
        },
        f.serverId,
        { jobId: f.jobId, confirm: true, reason: 'Isolated current Owner authorization test' },
      ).then(
        (result) => result,
        (error: unknown) => error,
      );
      try {
        await entered.promise;
        if (change === 'revoked')
          await f.db.deleteFrom('session').where('id', '=', sessionId).execute();
        else if (change === 'expired')
          await f.db
            .updateTable('session')
            .set({ expiresAt: new Date(0) })
            .where('id', '=', sessionId)
            .execute();
        else
          await f.db
            .updateTable('user')
            .set({ role: 'user' })
            .where('id', '=', f.ownerId)
            .execute();
      } finally {
        release.resolve();
      }
      const outcome = await pending;
      await f.db.updateTable('user').set({ role: 'user' }).where('id', '=', f.ownerId).execute();
      expect(outcome).toMatchObject({
        code: change === 'demoted' ? 'forbidden' : 'unauthenticated',
      });
      expect(await f.operation()).toEqual(before.operation);
      expect(await f.reservation()).toEqual(before.reservation);
      expect(await f.server()).toEqual(before.server);
      expect(
        await f.db
          .selectFrom('audit_events')
          .select('id')
          .where('action', '=', 'server.operation.owner_resolution')
          .where('actor_user_id', '=', f.ownerId)
          .execute(),
      ).toHaveLength(0);
      expect(f.adapter.updateBuild).toHaveBeenCalledTimes(1);
    },
  );
  it('tracks retries per effect so a multi-batch wipe cannot exhaust the job retry constraint', async () => {
    const f = await fixture('wipe');
    f.setFiles(Array.from({ length: 3500 }, (_, index) => `fixture-${index}`));
    let result = 'waiting';
    for (let attempt = 0; attempt < 20 && result === 'waiting'; attempt++) {
      result = await f.run();
      f.tick();
    }
    expect(result).toBe('succeeded');
    expect(f.adapter.deleteFiles).toHaveBeenCalledTimes(4);
    expect(f.adapter.reinstall).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.db
          .selectFrom('operation_jobs')
          .select('attempts')
          .where('id', '=', f.jobId)
          .executeTakeFirstOrThrow()
      ).attempts,
    ).toBe(1);
  });
  it('bounds safe absolute configuration retries while retaining uncertain state for review', async () => {
    const f = await fixture('configure', {
      build: {
        memory: 256,
        cpu: 10,
        disk: 64,
        swap: 0,
        io: 500,
        allocation: providerSequence + 1,
        feature_limits: { databases: 0, allocations: 1, backups: 1 },
      },
    });
    f.adapter.updateBuild.mockImplementation(async () => {
      throw new PterodactylError('unavailable', 'application', 'unknown');
    });
    for (let attempt = 0; attempt < 7; attempt++) {
      expect(await f.run()).toBe('waiting');
      f.tick();
    }
    expect(f.adapter.updateBuild).toHaveBeenCalledTimes(3);
    expect(
      (
        await f.db
          .selectFrom('operation_jobs')
          .select('attempts')
          .where('id', '=', f.jobId)
          .executeTakeFirstOrThrow()
      ).attempts,
    ).toBe(3);
    expect((await f.server()).active_operation_id).toBe(f.jobId);
  });
  it('restores previously confirmed limits after a definitively rejected build change', async () => {
    const f = await fixture('configure', {
      previousLimits: { memory: 128, cpu: 10, disk: 64, swap: 0, io: 500 },
      build: {
        memory: 256,
        cpu: 10,
        disk: 128,
        swap: 0,
        io: 500,
        allocation: providerSequence + 1,
        feature_limits: { databases: 0, allocations: 1, backups: 1 },
      },
    });
    await f.db
      .updateTable('managed_servers')
      .set({ limits: JSON.stringify({ memory: 256, cpu: 10, disk: 128, swap: 0, io: 500 }) })
      .where('id', '=', f.serverId)
      .execute();
    f.adapter.updateBuild.mockImplementation(async () => {
      throw new PterodactylError('invalid_request', 'application', 'rejected', 422);
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('failed');
    expect((await f.server()).limits).toMatchObject({ memory: 128, disk: 64 });
    expect(f.adapter.updateBuild).toHaveBeenCalledTimes(1);
  });
  it('retains accepted start reservations through a long offline preboot and does not replay power', async () => {
    for (const action of ['start', 'provision'] as const) {
      const f = await fixture(action, { autoStart: true });
      f.adapter.power.mockImplementation(async () => {});
      expect(await f.run()).toBe('waiting');
      f.tick(130000);
      expect(await f.run()).toBe('waiting');
      expect(await f.reservation()).toBeDefined();
      expect((await f.server()).active_operation_id).toBe(f.jobId);
      f.setState('running');
      f.tick();
      expect(await f.run()).toBe('succeeded');
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects stop and installation proof when observations belong to another physical host', async () => {
    const stop = await fixture('stop');
    stop.setState('running');
    await stop.prepareReservation();
    stop.options.verifyObservationHost = vi.fn(async (serverId, connection) => {
      expect(serverId).toBe(stop.serverId);
      expect(
        await connection
          .selectFrom('managed_servers')
          .select('id')
          .where('id', '=', serverId)
          .executeTakeFirst(),
      ).toBeDefined();
      throw new DomainError('configuration_invalid');
    });
    expect(await stop.run()).toBe('failed');
    expect(stop.options.verifyObservationHost).toHaveBeenCalledTimes(1);
    expect((await stop.operation()).plan.stopConfirmed).toBeUndefined();
    expect((await stop.server()).runtime_state).toBe('running');
    expect(await stop.reservation()).toBeDefined();
    expect(stop.adapter.power).not.toHaveBeenCalled();

    const install = await fixture('provision');
    install.options.verifyObservationHost = vi.fn(async () => {
      throw new DomainError('configuration_invalid');
    });
    expect(await install.run()).toBe('waiting');
    expect(install.options.verifyObservationHost).toHaveBeenCalledTimes(1);
    expect((await install.operation()).plan.installConfirmed).toBeUndefined();
    expect((await install.server()).installation_state).toBe('installing');
    expect(await install.installationReservation()).toBeDefined();
    expect(install.adapter.power).not.toHaveBeenCalled();
    expect(install.adapter.reinstall).not.toHaveBeenCalled();
  });
  it('releases stop reservations only after persisted terminal proof and cache settlement', async () => {
    const f = await fixture('stop');
    await f.prepareReservation();
    f.setState('running');
    expect(await f.run()).toBe('waiting');
    expect((await f.operation()).plan.stopConfirmed).toBe(true);
    f.tick(5000);
    expect(await f.run()).toBe('waiting');
    expect(await f.reservation()).toBeDefined();
    f.tick(17000);
    expect(await f.run()).toBe('succeeded');
    expect(await f.reservation()).toBeUndefined();
    expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it('recovers persisted stop proof after worker loss before the provider helper returned', async () => {
    const f = await fixture('stop');
    await f.prepareReservation();
    f.setState('running');
    f.adapter.stopWithConfirmation.mockImplementation(async (_id, _identifier, input) => {
      f.setState('offline');
      await input.onConfirmed();
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    expect((await f.operation()).plan.stopConfirmed).toBe(true);
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(await f.reservation()).toBeUndefined();
    expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
  });
  it('does not accept a claimed helper success without its persisted stop evidence callback', async () => {
    const f = await fixture('stop');
    await f.prepareReservation();
    f.adapter.stopWithConfirmation.mockImplementation(async () => {
      f.setState('offline');
      return { confirmed: true };
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    expect(await f.reservation()).toBeDefined();
  });
  it('blocks offline destructive effects while any uncertain compute reservation remains', async () => {
    for (const action of ['configure', 'reinstall', 'wipe', 'restore', 'delete'] as const) {
      const f = await fixture(action);
      await f.prepareReservation();
      expect(await f.run()).toBe('waiting');
      f.tick();
      expect(await f.run()).toBe('waiting');
      expect(f.adapter.updateBuild).not.toHaveBeenCalled();
      expect(f.adapter.reinstall).not.toHaveBeenCalled();
      expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
      expect(f.adapter.restoreBackup).not.toHaveBeenCalled();
      expect(f.adapter.deleteServer).not.toHaveBeenCalled();
      expect(await f.reservation()).toBeDefined();
    }
  });
  it('releases only a newly created reservation when no start could have been sent', async () => {
    const f = await fixture('start', { reservationCreated: true });
    await f.prepareReservation();
    f.options.authorizeEffect = async () => {
      throw new DomainError('forbidden');
    };
    expect(await f.run()).toBe('failed');
    expect(await f.reservation()).toBeUndefined();
    expect(f.adapter.power).not.toHaveBeenCalled();
    const rejected = await fixture('start', { reservationCreated: true });
    rejected.adapter.power.mockImplementation(async () => {
      throw new PterodactylError('permission_denied', 'client', 'rejected');
    });
    expect(await rejected.run()).toBe('failed');
    expect(await rejected.reservation()).toBeUndefined();
    const previous = await fixture('restart', { reservationCreated: false });
    await previous.prepareReservation();
    previous.options.authorizeEffect = async () => {
      throw new DomainError('forbidden');
    };
    expect(await previous.run()).toBe('failed');
    expect(await previous.reservation()).toBeDefined();
  });
  it('restores durable installation state after denied or definitively rejected reinstall', async () => {
    for (const preEffectDenied of [false, true]) {
      const f = await fixture('reinstall');
      await f.db
        .updateTable('managed_servers')
        .set({ installation_state: 'installed' })
        .where('id', '=', f.serverId)
        .execute();
      if (preEffectDenied)
        f.options.authorizeEffect = async () => {
          throw new DomainError('forbidden');
        };
      f.adapter.reinstallWithConfirmation.mockImplementation(async () => {
        throw new PterodactylError('permission_denied', 'client', 'rejected');
      });
      expect(await f.run()).toBe('waiting');
      f.tick();
      expect(await f.run()).toBe('failed');
      expect((await f.server()).installation_state).toBe('installed');
      expect((await f.operation()).plan.previousInstallationState).toBe('installed');
      expect(await f.installationReservation()).toBeUndefined();
      expect(f.adapter.reinstallWithConfirmation).toHaveBeenCalledTimes(preEffectDenied ? 0 : 1);
    }
  });
  it('deletes a never-created local registry record only using durable no-effect evidence and provider absence', async () => {
    for (const foreignRemoteAppears of [false, true]) {
      const f = await fixture('provision');
      f.options.authorizeEffect = async () => {
        throw new DomainError('forbidden');
      };
      expect(await f.run()).toBe('failed');
      expect((await f.operation()).plan.noExternalEffect).toBe(true);
      expect(f.adapter.createServer).not.toHaveBeenCalled();
      f.options.authorizeEffect = async () => {};
      const deletion = await enqueueServerOperation(
        f.db,
        {
          actorUserId: f.ownerId,
          subjectUserId: f.ownerId,
          role: 'user',
          sessionType: 'regular',
          ownerElevation: false,
        },
        f.serverId,
        { action: 'delete', confirm: true, idempotencyKey: randomUUID() },
      );
      f.setExists(foreignRemoteAppears);
      f.tick();
      const result = await processServerOperation(f.db, deletion.jobId, f.options);
      expect(result).toBe(foreignRemoteAppears ? 'failed' : 'succeeded');
      expect(!!(await f.server()).deleted_at).toBe(!foreignRemoteAppears);
      expect(f.adapter.deleteServer).not.toHaveBeenCalled();
    }
  });
  it('reserves installer capacity before create and releases only definitive rejection or proof', async () => {
    const denied = await fixture('provision');
    denied.adapter.createServer.mockImplementation(async () => {
      expect(await denied.installationReservation()).toBeDefined();
      throw new PterodactylError('permission_denied', 'application', 'rejected');
    });
    expect(await denied.run()).toBe('failed');
    expect(await denied.installationReservation()).toBeUndefined();
    const unknown = await fixture('provision');
    unknown.adapter.createServer.mockImplementation(async () => {
      expect(await unknown.installationReservation()).toBeDefined();
      throw new PterodactylError('unavailable', 'application', 'unknown');
    });
    expect(await unknown.run()).toBe('waiting');
    expect(await unknown.installationReservation()).toBeDefined();
    const noPower = await fixture('provision');
    noPower.options.authorizeEffect = async () => {
      throw new DomainError('forbidden');
    };
    expect(await noPower.run()).toBe('failed');
    expect(await noPower.installationReservation()).toBeUndefined();
    expect(noPower.adapter.createServer).not.toHaveBeenCalled();
  });
  it('does not infer installation completion after a daemon reset clears Panel status', async () => {
    for (const action of ['provision', 'reinstall', 'wipe'] as const) {
      const f = await fixture(action, { autoStart: true });
      f.adapter.confirmInstallation.mockResolvedValue({ confirmed: false });
      f.adapter.reinstallWithConfirmation.mockResolvedValue({ confirmed: false });
      for (let attempt = 0; attempt < 7; attempt++) {
        expect(await f.run()).toBe('waiting');
        f.tick();
      }
      expect((await f.server()).installation_state).toBe('installing');
      expect(await f.installationReservation()).toBeDefined();
      expect(f.adapter.power).not.toHaveBeenCalled();
      await reconcileManagedServer(f.db, f.serverId, f.options);
      expect((await f.server()).installation_state).toBe('installing');
    }
  });
  it('records reinstall_failed as a terminal failure instead of installed', async () => {
    const f = await fixture('reinstall');
    f.adapter.reinstallWithConfirmation.mockImplementation(async () => {
      f.remote.status = 'reinstall_failed';
      return { confirmed: false };
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('failed');
    expect((await f.server()).installation_state).toBe('failed');
  });
  it('preserves initial reservation provenance through crash and later admission denial', async () => {
    const f = await fixture('provision', { autoStart: true });
    const reserve = f.options.reserveStart;
    if (!reserve) throw new Error('fixture reserve callback missing');
    f.options.reserveStart = async (...args) => {
      await reserve(...args);
      throw new Error('simulated crash after reservation commit');
    };
    expect(await f.run()).toBe('waiting');
    expect(await f.reservation()).toBeDefined();
    expect((await f.operation()).plan.reservationCreated).toBe(true);
    f.options.reserveStart = async () => {
      throw new DomainError('resources_unavailable');
    };
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect((await f.operation()).plan.reservationCreated).toBe(true);
    expect(await f.reservation()).toBeUndefined();
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it('clears a new initial-start reservation when authorization is revoked after installation', async () => {
    const f = await fixture('provision', { autoStart: true });
    let calls = 0;
    f.options.authorizeEffect = async () => {
      calls++;
      if (calls > 1) throw new DomainError('forbidden');
    };
    expect(await f.run()).toBe('failed');
    expect(f.adapter.createServer).toHaveBeenCalledTimes(1);
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(await f.reservation()).toBeUndefined();
    expect((await f.server()).pterodactyl_id).toBe(f.remote.id);
  });
});
