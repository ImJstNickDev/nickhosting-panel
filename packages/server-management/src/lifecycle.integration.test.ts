import { randomUUID } from 'node:crypto';
import { authSessionId, createLogger, DomainError, type LogRecord } from '@nickhosting/core';
import { createDatabase, type Database } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { commandDigest, enqueueCommand } from '@nickhosting/jobs';
import {
  type ApplicationServer,
  type Backup,
  type BackupActivity,
  type BuildUpdate,
  type GuardedDirectoryDelete,
  type PterodactylAdapter,
  PterodactylError,
  type Resources,
} from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackendAllocationPool } from './allocation-pool.js';
import { removeFilemanDirectory } from './fileman-directory.js';
import {
  type LifecycleOptions,
  processServerOperation,
  reconcileManagedServer,
  resolveUncertainOperation,
} from './lifecycle.js';
import { applyMinecraftWorldRemoval } from './minecraft-content.js';
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
    | 'configure'
    | 'minecraft-content',
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
        input: Parameters<PterodactylAdapter['stopWithConfirmation']>[2],
      ) => {
        if (!(await input.authorize()))
          throw new PterodactylError('permission_denied', 'client', 'rejected');
        await input.beforePower?.();
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
      provider_user_id: 1,
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
    backupPolicy: async () => ({ offline: 'none' }),
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
    tick(ms = ['backup', 'restore'].includes(action) ? 62_000 : 22_000) {
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
  it.each(['start', 'restart'] as const)(
    'performs one final full authorization for ordinary %s after local intent checks',
    async (action) => {
      const f = await fixture(action);
      if (action === 'restart') f.setState('running');
      const intent = vi.fn(async () => {}),
        effect = vi.fn(async () => {});
      f.options.authorizeIntent = intent;
      f.options.authorizeEffect = effect;
      expect(await f.run()).toBe('waiting');
      expect(intent).toHaveBeenCalledTimes(2);
      expect(effect).toHaveBeenCalledTimes(1);
      expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(action === 'start' ? 1 : 2);
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['restart'] as const)(
    'shares exactly the fresh post-preparation provider identity with final %s authorization',
    async (action) => {
      const f = await fixture(action);
      f.options.authorizeIntent = async () => {};
      f.options.checkpoint = async (point) => {
        if (point === 'prepared') {
          expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
          f.remote.container.image = 'fixture/changed:2';
        }
      };
      f.options.authorizeEffect = async (_jobId, _serverId, _db, context) => {
        expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
        expect((await context?.providerServer)?.container.image).toBe('fixture/changed:2');
        throw new DomainError('configuration_invalid');
      };
      expect(await f.run()).toBe('failed');
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect(await f.operation()).toMatchObject({
        effect_state: 'none',
        plan: { rejected: true, powerEffectPrepared: false },
      });
    },
  );
  it.each(['none', 'identity', 'authorization'] as const)(
    'overlaps final identity and authorization but awaits both proofs before power: rejection=%s',
    async (rejection) => {
      const f = await fixture('restart');
      f.options.authorizeIntent = async () => {};
      let identityStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        identityStarted = resolve;
      });
      let releaseIdentity!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseIdentity = resolve;
      });
      f.options.checkpoint = async (point) => {
        if (point !== 'prepared') return;
        f.adapter.getApplicationServer.mockImplementationOnce(async () => {
          identityStarted();
          await released;
          return rejection === 'identity' ? { ...f.remote, uuid: randomUUID() } : f.remote;
        });
      };
      f.options.authorizeEffect = async (_jobId, _serverId, _db, context) => {
        await started;
        expect(context?.providerServer).toBeInstanceOf(Promise);
        expect(f.adapter.power).not.toHaveBeenCalled();
        releaseIdentity();
        if (rejection === 'authorization') throw new DomainError('forbidden');
        // Generic consumers may ignore context. Lifecycle must still await identity.
      };
      expect(await f.run()).toBe(rejection === 'none' ? 'waiting' : 'failed');
      expect(f.adapter.power).toHaveBeenCalledTimes(rejection === 'none' ? 1 : 0);
      expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
      if (rejection !== 'none')
        expect(await f.operation()).toMatchObject({
          effect_state: 'none',
          plan: { rejected: true, powerEffectPrepared: false },
        });
    },
  );
  it('runs one final local guard after the shared slow proof, without nested full authorization', async () => {
    const f = await fixture('restart');
    let proofSettled = false;
    let finalGuards = 0;
    f.options.authorizeIntent = async () => {
      if (proofSettled) finalGuards++;
    };
    const authorizeEffect = vi.fn(async (_jobId, _serverId, _db, context) => {
      expect(context.deferFinalIntentCheck).toBe(true);
      await context.providerServer;
      proofSettled = true;
    });
    f.options.authorizeEffect = authorizeEffect;
    expect(await f.run()).toBe('waiting');
    expect(authorizeEffect).toHaveBeenCalledTimes(1);
    expect(finalGuards).toBe(1);
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    'rejects authority revoked during final identity after early authorization: local guard=%s',
    async (localGuard) => {
      const f = await fixture('restart');
      let revoked = false;
      let releaseIdentity!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseIdentity = resolve;
      });
      let prepared = false;
      f.options.checkpoint = async (point) => {
        if (point !== 'prepared') return;
        prepared = true;
        f.adapter.getApplicationServer.mockImplementationOnce(async () => {
          await released;
          revoked = true;
          return f.remote;
        });
      };
      const guard = async () => {
        if (revoked) throw new DomainError('forbidden');
      };
      if (localGuard) f.options.authorizeIntent = guard;
      f.options.authorizeEffect = async (_jobId, _serverId, _db, context) => {
        if (prepared && context?.providerServer instanceof Promise)
          expect(context.deferFinalIntentCheck).toBe(localGuard ? true : undefined);
        await guard();
        if (prepared) releaseIdentity();
        // Intentionally does not await the supplied provider promise.
      };
      expect(await f.run()).toBe('failed');
      expect(revoked).toBe(true);
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect(await f.operation()).toMatchObject({
        effect_state: 'none',
        plan: { rejected: true, rejectionCode: 'forbidden' },
      });
    },
  );
  it.each(['limits', 'suspended', 'installation'] as const)(
    'rejects %s drift after durable preparation against the same final snapshot',
    async (change) => {
      const f = await fixture('restart');
      f.options.authorizeIntent = async () => {};
      f.options.checkpoint = async (point) => {
        if (point !== 'prepared') return;
        if (change === 'limits') f.remote.limits.memory = 4096;
        if (change === 'suspended') f.remote.suspended = true;
        if (change === 'installation') f.remote.status = 'installing';
      };
      expect(await f.run()).toBe('failed');
      expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect(await f.operation()).toMatchObject({
        effect_state: 'none',
        plan: { rejected: true, powerEffectPrepared: false },
      });
    },
  );
  it('rejects provider identity drift after durable power preparation without uncertain effects', async () => {
    const f = await fixture('restart');
    f.options.authorizeIntent = async () => {};
    f.options.checkpoint = async (point) => {
      if (point === 'prepared') f.remote.uuid = randomUUID();
    };
    expect(await f.run()).toBe('failed');
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(await f.operation()).toMatchObject({
      effect_state: 'none',
      plan: { rejected: true, rejectionCode: 'provenance_mismatch' },
    });
  });
  it.each(['stop', 'restart'] as const)(
    'overlaps initial identity and resource reads for planned %s without publishing unverified telemetry',
    async (action) => {
      const f = await fixture(action);
      let startedResources!: () => void;
      const resourceRead = new Promise<void>((resolve) => {
        startedResources = resolve;
      });
      f.adapter.getApplicationServer.mockImplementationOnce(async () => {
        await resourceRead;
        return { ...f.remote, uuid: randomUUID() };
      });
      const original = f.adapter.getResources.getMockImplementation();
      f.adapter.getResources.mockImplementationOnce(async () => {
        startedResources();
        if (!original) throw new Error('Missing fixture resource reader');
        return original();
      });
      expect(await f.run()).toBe('failed');
      expect(f.adapter.getResources).toHaveBeenCalledTimes(1);
      expect((await f.server()).last_observed_at).toBeNull();
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
    },
  );
  it('sends clean Start with one limits read, no state preflight or runtime validation', async () => {
    const f = await fixture('start');
    f.remote.suspended = true;
    f.remote.status = 'installing';
    f.remote.container.image = 'fixture/provider-owned:2';
    const guard = vi.fn(async (_jobId, _serverId, _db, context) => {
      if (context) expect(context.startAdmissionValidated).toBe(true);
    });
    f.options.authorizeEffect = guard;
    f.options.authorizeIntent = async () => {};
    expect(await f.run()).toBe('waiting');
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
    expect(f.adapter.getResources).not.toHaveBeenCalled();
    expect(f.adapter.power).toHaveBeenCalledExactlyOnceWith(f.remote.identifier, 'start');
    expect((await f.operation()).plan.previousUptime).toBeNull();
    expect((await f.server()).last_observed_at).toBeNull();
    expect(guard).toHaveBeenCalledTimes(1);
  });
  it('sends clean Start using trusted feed limits without a provider limits read', async () => {
    const f = await fixture('start');
    f.options.cachedStartLimits = async () => f.remote.limits;
    expect(await f.run()).toBe('waiting');
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    expect(f.adapter.power).toHaveBeenCalledExactlyOnceWith(f.remote.identifier, 'start');
  });
  it('falls back to provider limits when the change feed is unavailable', async () => {
    const f = await fixture('start');
    f.options.cachedStartLimits = async () => null;
    expect(await f.run()).toBe('waiting');
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
  });
  it('rejects changed feed limits before reserving or sending Start', async () => {
    const f = await fixture('start');
    f.options.cachedStartLimits = async () => ({
      ...f.remote.limits,
      memory: f.remote.limits.memory + 1,
    });
    expect(await f.run()).toBe('failed');
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it.each(['id', 'identifier', 'uuid', 'node'] as const)(
    'rejects a limits snapshot for another power target: %s',
    async (key) => {
      const f = await fixture('start');
      if (key === 'id' || key === 'node') f.remote[key]++;
      else f.remote[key] = randomUUID();
      expect(await f.run()).toBe('failed');
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['memory', 'cpu', 'disk', 'swap', 'io'] as const)(
    'rejects clean Start when actual %s differs from reserved limits',
    async (key) => {
      const f = await fixture('start');
      f.remote.limits[key] += 1;
      expect(await f.run()).toBe('failed');
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect(f.adapter.getResources).not.toHaveBeenCalled();
    },
  );
  it('never replays clean Start after a crash at durable preparation', async () => {
    const f = await fixture('start');
    f.options.checkpoint = async (point) => {
      if (point === 'prepared') throw new Error('simulated worker exit');
    };
    expect(await f.run()).toBe('waiting');
    expect(await f.operation()).toMatchObject({ phase: 'power', effect_state: 'prepared' });
    f.options.checkpoint = undefined;
    f.tick();
    expect(await f.run()).toBe('waiting');
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(await f.reservation()).toBeDefined();
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
  });
  it('does not replay clean Start after a lost response and retains recovery identity checks', async () => {
    const f = await fixture('start');
    f.adapter.power.mockImplementationOnce(async () => {
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    expect((await f.operation()).effect_state).toBe('uncertain');
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
    f.remote.uuid = randomUUID();
    f.tick();
    await f.run();
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
  });
  it('overlaps start admission sampling with provider reads and reserves only after identity', async () => {
    const f = await fixture('start');
    const sampling = Promise.withResolvers<void>();
    let identityValidated = false;
    f.adapter.getApplicationServer.mockImplementationOnce(async () => {
      await sampling.promise;
      identityValidated = true;
      return f.remote;
    });
    const reserve = f.options.reserveStart;
    const commitAdmission = vi.fn(async () => {
      expect(identityValidated).toBe(true);
      await reserve?.(f.serverId, f.jobId, 'start', f.db);
    });
    f.options.prepareStartAdmission = async () => {
      sampling.resolve();
      return commitAdmission;
    };
    f.options.reserveStart = vi.fn(async () => {
      throw new Error('Prepared admission must replace sequential sampling');
    });
    expect(await f.run()).toBe('waiting');
    expect(commitAdmission).toHaveBeenCalledTimes(1);
    expect(f.options.reserveStart).not.toHaveBeenCalled();
    expect(f.adapter.power).toHaveBeenCalledOnce();
  });
  it.each(['provider', 'sampling', 'limits'] as const)(
    'settles start sampling and rejects before reservation or power on %s failure',
    async (failure) => {
      const f = await fixture('start');
      const identityStarted = Promise.withResolvers<void>();
      const samplingFinished = Promise.withResolvers<void>();
      const commitAdmission = vi.fn(async () => {});
      f.adapter.getApplicationServer.mockImplementationOnce(async () => {
        identityStarted.resolve();
        await samplingFinished.promise;
        if (failure === 'provider')
          throw new PterodactylError('unavailable', 'application', 'unknown');
        if (failure === 'limits')
          return { ...f.remote, limits: { ...f.remote.limits, memory: 9999 } };
        return f.remote;
      });
      f.options.prepareStartAdmission = async () => {
        await identityStarted.promise;
        samplingFinished.resolve();
        if (failure === 'sampling') throw new DomainError('configuration_invalid');
        return commitAdmission;
      };
      expect(await f.run()).toBe(failure === 'provider' ? 'waiting' : 'failed');
      expect(commitAdmission).not.toHaveBeenCalled();
      expect(f.adapter.power).not.toHaveBeenCalled();
    },
  );
  it('rejects ordinary power if full authority changes after preparation', async () => {
    const f = await fixture('start');
    f.options.authorizeIntent = async () => {};
    let prepared = false;
    f.options.checkpoint = async (point) => {
      if (point === 'prepared') prepared = true;
    };
    f.options.authorizeEffect = async () => {
      if (prepared) throw new DomainError('forbidden');
    };
    expect(await f.run()).toBe('failed');
    expect(prepared).toBe(true);
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(await f.operation()).toMatchObject({
      effect_state: 'none',
      plan: { rejected: true, powerEffectPrepared: false },
    });
  });
  it('uses local stop-console reauthorization and shares metadata while retaining a fresh final identity check', async () => {
    const f = await fixture('stop');
    f.setState('running');
    const intent = vi.fn(async () => {}),
      effect = vi.fn(async () => {});
    f.options.authorizeIntent = intent;
    f.options.authorizeEffect = effect;
    f.adapter.stopWithConfirmation.mockImplementationOnce(async (id, identifier, callbacks) => {
      expect(callbacks.verifiedServer).toMatchObject({ id, identifier, uuid: f.remote.uuid });
      const reads = f.adapter.getApplicationServer.mock.calls.length;
      for (let i = 0; i < 3; i++) expect(await callbacks.authorize()).toBe(true);
      expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(reads);
      await callbacks.beforePower?.();
      expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(reads + 1);
      f.setState('offline');
      await callbacks.onConfirmed();
      return { confirmed: true };
    });
    expect(await f.run()).toBe('waiting');
    expect(intent).toHaveBeenCalledTimes(5);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
  });
  it.each(['none', 'identity', 'host', 'revoked'] as const)(
    'overlaps stop identity/host proofs and rechecks local authority after both: %s',
    async (failure) => {
      const f = await fixture('stop');
      f.setState('running');
      const identityStarted = Promise.withResolvers<void>();
      const hostStarted = Promise.withResolvers<void>();
      const hostReleased = Promise.withResolvers<void>();
      let revoked = false;
      let preparing = false;
      let powerSent = false;
      f.options.authorizeIntent = async () => {
        if (revoked) throw new DomainError('forbidden');
      };
      f.options.verifyObservationHost = async () => {
        hostStarted.resolve();
        await identityStarted.promise;
        hostReleased.resolve();
        if (failure === 'host') throw new DomainError('configuration_invalid');
      };
      f.options.authorizeEffect = async (_jobId, _serverId, _db, context) => {
        if (!preparing) return;
        expect(context?.providerServer).toBeInstanceOf(Promise);
        expect(powerSent).toBe(false);
        // Deliberately ignore provider proof like an injected generic authorizer.
      };
      f.adapter.stopWithConfirmation.mockImplementationOnce(async (_id, _identifier, input) => {
        preparing = true;
        f.adapter.getApplicationServer.mockImplementationOnce(async () => {
          identityStarted.resolve();
          await hostStarted.promise;
          await hostReleased.promise;
          if (failure === 'revoked') revoked = true;
          return failure === 'identity' ? { ...f.remote, uuid: randomUUID() } : f.remote;
        });
        await input.beforePower?.();
        powerSent = true;
        f.setState('offline');
        await input.onConfirmed();
        return { confirmed: true };
      });
      expect(await f.run()).toBe(failure === 'none' ? 'waiting' : 'failed');
      expect(powerSent).toBe(failure === 'none');
      expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
      if (failure !== 'none') expect((await f.server()).runtime_state).toBe('running');
    },
  );
  it.each(['identity', 'permission'] as const)(
    'rejects stop when %s changes during console setup',
    async (change) => {
      const f = await fixture('stop');
      f.setState('running');
      f.options.authorizeIntent = async () => {};
      let setup = false;
      f.options.authorizeEffect = async () => {
        if (setup && change === 'permission') throw new DomainError('forbidden');
      };
      let sentPower = false;
      f.adapter.stopWithConfirmation.mockImplementationOnce(async (_id, _identifier, callbacks) => {
        setup = true;
        if (change === 'identity') f.remote.uuid = randomUUID();
        await callbacks.beforePower?.();
        sentPower = true;
        return { confirmed: false };
      });
      expect(await f.run()).toBe('failed');
      expect(setup).toBe(true);
      expect(sentPower).toBe(false);
      expect((await f.server()).runtime_state).toBe('running');
    },
  );
  it.each([false, true])(
    'records bounded operation timings without changing effects when the logger throws=%s',
    async (throws) => {
      const f = await fixture('start');
      const logs: LogRecord[] = [];
      f.options.logger = createLogger((record) => {
        logs.push(record);
        if (throws) throw new Error('isolated logging failure');
      });
      const results = await Promise.all(Array.from({ length: 3 }, () => f.run()));
      expect(results).toContain('waiting');
      f.tick();
      expect(await f.run()).toBe('succeeded');
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
      const stages = logs.filter((r) => r.event === 'servers.operation_stage');
      expect(stages.map((r) => (r.data as Record<string, unknown>).stage)).toEqual(
        expect.arrayContaining([
          'server_lock',
          'provider_identity',
          'provider_resources',
          'authorization',
          'provider_effect',
        ]),
      );
      for (const record of stages) {
        expect(record.data).toMatchObject({
          jobId: f.jobId,
          serverId: f.serverId,
          action: 'start',
          durationMs: expect.any(Number),
        });
        expect(Object.keys(record.data as object).sort()).toEqual([
          'action',
          'durationMs',
          'jobId',
          'outcome',
          'serverId',
          'stage',
        ]);
      }
      expect(
        logs.some(
          (r) =>
            r.event === 'servers.operation_deferred' &&
            (r.data as Record<string, unknown>).reason === 'server_lock_busy',
        ),
      ).toBe(true);
    },
  );
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
    expect(await processServerOperation(f.db, qualifiedStop.jobId, f.options)).toBe('succeeded');
    f.tick();
    expect(await processServerOperation(f.db, qualifiedStop.jobId, f.options)).toBe('duplicate');
    expect(await f.reservation()).toBeUndefined();
    const repeatedStop = await enqueue('stop');
    expect(await processServerOperation(f.db, repeatedStop.jobId, f.options)).toBe('succeeded');
    expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
    expect(f.options.confirmAlreadyStopped).toHaveBeenCalledTimes(3);
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
  it.each(['start', 'restart', 'provision'] as const)(
    'confirms %s from fresh process proof before the Panel resource cache expires',
    async (action) => {
      const f = await fixture(action, action === 'provision' ? { autoStart: true } : {});
      const baseline = new Date(f.now().getTime() - 100_000).toISOString();
      let proof: string | null = action === 'restart' ? baseline : null;
      f.options.observeProcessStart = async () => proof;
      expect(await f.run()).toBe('waiting');
      const effect = (await f.operation()).effect_started_at;
      if (!effect) throw new Error('missing durable power intent');
      expect((await f.operation()).phase).toBe(action === 'provision' ? 'initial_start' : 'power');
      proof = new Date(effect.getTime() + 500).toISOString();
      f.setState('offline'); // Panel still serves its pre-start resources cache.
      f.adapter.getResources.mockClear();
      f.tick(3000);
      expect(await f.run()).toBe('succeeded');
      expect((await f.reservation())?.state).toBe('running');
      expect(await f.server()).toMatchObject({
        runtime_state: 'running',
        readiness: 'unknown',
        active_operation_id: null,
      });
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
      expect(f.adapter.getResources).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['start', 'offline'],
    ['start', 'starting'],
    ['restart', 'offline'],
    ['restart', 'starting'],
    ['provision', 'offline'],
    ['provision', 'starting'],
  ] as const)(
    'preserves freshly confirmed %s through a cached %s reconciliation sample',
    async (action, cached) => {
      const f = await fixture(action, { autoStart: true });
      await f.db
        .updateTable('managed_servers')
        .set({ intent: 'auto_wake_enabled' })
        .where('id', '=', f.serverId)
        .execute();
      let epoch: string | null = null;
      f.options.observeProcessStart = vi.fn(async () => epoch);
      expect(await f.run()).toBe('waiting');
      const effect = (await f.operation()).effect_started_at;
      if (!effect) throw new Error('missing power effect');
      epoch = new Date(effect.getTime() + 500).toISOString();
      f.tick(3000);
      expect(await f.run()).toBe('succeeded');
      f.options.observeReconciliationProcessStart = vi.fn(async () => epoch);
      vi.mocked(f.options.observeProcessStart).mockClear();
      await f.db
        .updateTable('managed_servers')
        .set({ readiness: 'ready' })
        .where('id', '=', f.serverId)
        .execute();
      f.setState(cached);
      expect(await reconcileManagedServer(f.db, f.serverId, f.options)).toBe('observed');
      expect(await f.server()).toMatchObject({ runtime_state: 'running', readiness: 'ready' });
      expect(await f.reservation()).toMatchObject({ state: 'running' });
      expect(f.options.observeProcessStart).not.toHaveBeenCalled();
      expect(f.options.observeReconciliationProcessStart).toHaveBeenCalledTimes(1);
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    'null',
    'unavailable',
    'different_epoch',
    'malformed',
    'missing_receipt',
    'future_receipt',
    'pre_effect_receipt',
    'failed_job',
    'manual_stop',
    'missing_reservation',
    'external_stop',
    'identity_mismatch',
  ] as const)(
    'does not promote a cached offline reconciliation sample with %s',
    async (condition) => {
      const f = await fixture('start');
      await f.db
        .updateTable('managed_servers')
        .set({ intent: 'auto_wake_enabled' })
        .where('id', '=', f.serverId)
        .execute();
      let epoch: string | null = null;
      f.options.observeProcessStart = async () => epoch;
      expect(await f.run()).toBe('waiting');
      const effect = (await f.operation()).effect_started_at;
      if (!effect) throw new Error('missing power effect');
      epoch = new Date(effect.getTime() + 500).toISOString();
      f.tick(3000);
      expect(await f.run()).toBe('succeeded');
      f.options.observeReconciliationProcessStart = vi.fn(async () => {
        if (condition === 'null') return null;
        if (condition === 'unavailable') throw new Error('isolated unavailable observer');
        if (condition === 'different_epoch') return new Date(effect.getTime() + 1000).toISOString();
        if (condition === 'malformed') return 'invalid';
        if (condition === 'identity_mismatch') throw new DomainError('provenance_mismatch');
        return epoch;
      });
      if (['missing_receipt', 'future_receipt', 'pre_effect_receipt'].includes(condition)) {
        const plan = (await f.operation()).plan;
        await f.db
          .updateTable('server_operations')
          .set({
            plan: JSON.stringify({
              ...plan,
              startProcessStartedAt:
                condition === 'missing_receipt'
                  ? null
                  : condition === 'pre_effect_receipt'
                    ? effect.toISOString()
                    : new Date(f.now().getTime() + 1000).toISOString(),
            }),
          })
          .where('job_id', '=', f.jobId)
          .execute();
      }
      if (condition === 'failed_job')
        await f.db
          .updateTable('operation_jobs')
          .set({ state: 'failed' })
          .where('id', '=', f.jobId)
          .execute();
      if (condition === 'manual_stop')
        await f.db
          .updateTable('managed_servers')
          .set({ intent: 'manually_stopped' })
          .where('id', '=', f.serverId)
          .execute();
      if (condition === 'missing_reservation')
        await f.db
          .deleteFrom('resource_reservations')
          .where('server_id', '=', f.serverId)
          .execute();
      if (condition === 'external_stop')
        f.options.observeExternalStop = async () => ({
          containerId: 'a'.repeat(64),
          startedAt: epoch ?? '',
          finishedAt: new Date(effect.getTime() + 2000).toISOString(),
          activityId: 'owner-kill',
          activityAt: new Date(effect.getTime() + 1500).toISOString(),
          action: 'kill',
        });
      f.setState('offline');
      if (condition === 'identity_mismatch') {
        await expect(reconcileManagedServer(f.db, f.serverId, f.options)).rejects.toMatchObject({
          code: 'provenance_mismatch',
        });
      } else {
        expect(await reconcileManagedServer(f.db, f.serverId, f.options)).toBe('observed');
        expect((await f.server()).runtime_state).toBe('offline');
        if (condition === 'missing_reservation' || condition === 'external_stop')
          expect(await f.reservation()).toBeUndefined();
        else expect(await f.reservation()).toMatchObject({ state: 'uncertain' });
      }
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['null', 'unavailable', 'before_intent', 'equal_intent', 'future', 'malformed'] as const)(
    'does not complete start using cached running state when physical proof is %s',
    async (kind) => {
      const f = await fixture('start');
      f.options.observeProcessStart = async () => null;
      expect(await f.run()).toBe('waiting');
      const effect = (await f.operation()).effect_started_at;
      if (!effect) throw new Error('missing durable power intent');
      f.tick();
      f.setState('running');
      f.options.observeProcessStart = async () => {
        if (kind === 'null') return null;
        if (kind === 'unavailable') throw new Error('isolated unavailable observer');
        if (kind === 'malformed') return 'invalid';
        if (kind === 'equal_intent') return effect.toISOString();
        if (kind === 'before_intent') return new Date(effect.getTime() - 1).toISOString();
        return new Date(f.now().getTime() + 1).toISOString();
      };
      expect(await f.run()).toBe('waiting');
      expect((await f.operation()).plan.waitReason).toBe('start_terminal_unproven');
      expect((await f.reservation())?.state).toBe('starting');
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['start', 'restart'] as const)(
    'keeps %s process confirmation polls bounded instead of growing to ten seconds',
    async (action) => {
      const f = await fixture(action);
      f.options.observeProcessStart = async () => null;
      for (let attempt = 0; attempt < 6; attempt++) {
        expect(await f.run()).toBe('waiting');
        const job = await f.db
          .selectFrom('operation_jobs')
          .select('next_attempt_at')
          .where('id', '=', f.jobId)
          .executeTakeFirstOrThrow();
        const delay = job.next_attempt_at.getTime() - f.now().getTime();
        expect(delay).toBeGreaterThanOrEqual(2000);
        expect(delay).toBeLessThan(2500);
        f.tick(3000);
      }
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
      expect(await f.reservation()).toBeDefined();
    },
  );
  it('keeps the resource-cache safety window when no physical observer is available', async () => {
    const f = await fixture('start');
    expect(await f.run()).toBe('waiting');
    f.tick(3000);
    expect(await f.run()).toBe('waiting');
    expect((await f.operation()).plan.waitReason).toBe('resource_cache_expiry');
    f.tick();
    expect(await f.run()).toBe('succeeded');
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
  it.each(['replaced', 'deleted'] as const)(
    'does not request prompt delivery retries for an inactive %s operation',
    async (reason) => {
      const f = await fixture('start');
      await f.db
        .updateTable('managed_servers')
        .set(reason === 'deleted' ? { deleted_at: f.now() } : { active_operation_id: null })
        .where('id', '=', f.serverId)
        .execute();
      expect(await f.run()).toBe('inactive');
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect((await f.operation()).effect_started_at).toBeNull();
    },
  );
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
  it.each(['start', 'restart', 'provision'] as const)(
    'reconciles an interactive external stop after a proven %s epoch',
    async (action) => {
      const f = await fixture(action, { autoStart: true });
      expect(await f.run()).toBe('waiting');
      const effectAt = (await f.operation()).effect_started_at?.getTime() ?? 0;
      f.tick(3000);
      f.setState('offline');
      const receipt = {
        containerId: 'a'.repeat(64),
        startedAt: new Date(effectAt + 500).toISOString(),
        finishedAt: new Date(effectAt + 2500).toISOString(),
        activityId: 'owner-stop',
        activityAt: new Date(effectAt + 2000).toISOString(),
        action: 'kill' as const,
      };
      f.options.observeExternalStop = vi.fn(async () => receipt);
      expect(await f.run()).toBe('failed');
      expect(await f.reservation()).toBeUndefined();
      expect(await f.server()).toMatchObject({
        active_operation_id: null,
        intent: 'manually_stopped',
        runtime_state: 'offline',
      });
      expect((await f.operation()).plan.externalStopConfirmed).toEqual(receipt);
      expect((await f.operation()).plan.waitReason).toBeNull();
      f.setState('running'); // stale provider resource cache after terminal completion
      await reconcileManagedServer(f.db, f.serverId, f.options);
      expect(await f.reservation()).toBeUndefined();
      expect((await f.server()).runtime_state).toBe('offline');
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['missing', 'previous-epoch', 'pre-effect-stop'] as const)(
    'retains pending start capacity without a correlated terminal stop: %s',
    async (condition) => {
      const f = await fixture('start');
      f.adapter.power.mockImplementation(async () => {});
      expect(await f.run()).toBe('waiting');
      const at = (await f.operation()).effect_started_at?.getTime() ?? 0;
      f.tick();
      f.options.observeExternalStop = vi.fn(async () =>
        condition === 'missing'
          ? null
          : {
              containerId: 'a'.repeat(64),
              startedAt: new Date(
                at + (condition === 'previous-epoch' ? -1000 : 500),
              ).toISOString(),
              finishedAt: new Date(at + 2000).toISOString(),
              activityId: 'old-stop',
              activityAt: new Date(
                at + (condition === 'pre-effect-stop' ? -1000 : 1000),
              ).toISOString(),
              action: 'stop' as const,
            },
      );
      expect(await f.run()).toBe('waiting');
      expect(await f.reservation()).toBeDefined();
      expect(f.adapter.power).toHaveBeenCalledTimes(1);
    },
  );
  it('releases an already online reservation only for a corroborated interactive external stop', async () => {
    const f = await fixture('start');
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('succeeded');
    f.setState('offline');
    f.options.observeExternalStop = vi.fn(async () => {
      throw new DomainError('forbidden');
    });
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect((await f.server()).runtime_state).toBe('offline');
    expect(await f.reservation()).toMatchObject({ state: 'uncertain' });
    const at = f.now().getTime();
    f.options.observeExternalStop = vi.fn(async () => ({
      containerId: 'a'.repeat(64),
      startedAt: new Date(at - 10000).toISOString(),
      finishedAt: new Date(at - 500).toISOString(),
      activityId: 'external-stop',
      activityAt: new Date(at - 1000).toISOString(),
      action: 'stop' as const,
    }));
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect(await f.reservation()).toBeUndefined();
    expect(await f.server()).toMatchObject({
      intent: 'manually_stopped',
      runtime_state: 'offline',
      readiness: 'unknown',
    });
    f.setState('running');
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect(await f.reservation()).toBeUndefined();
    expect((await f.server()).runtime_state).toBe('offline');
    expect(f.adapter.power).toHaveBeenCalledTimes(1);
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
  it('completes an observed stop immediately despite cached running resources', async () => {
    const f = await fixture('stop');
    await f.prepareReservation();
    f.setState('running');
    f.options.verifyObservationHost = vi.fn(async () => {});
    f.options.confirmAlreadyStopped = vi.fn(async (_id, _db, context) => {
      expect(context?.providerServer).toBeInstanceOf(Promise);
      expect(context?.observerPreflight).toBeInstanceOf(Promise);
      expect((await context?.providerServer)?.uuid).toBe(f.remote.uuid);
      await context?.observerPreflight;
      return true;
    });
    f.adapter.stopWithConfirmation.mockImplementation(async (_id, _identifier, input) => {
      // Ordered provider/Docker confirmation arrived; the resources cache has not changed.
      await input.onConfirmed();
      return { confirmed: true };
    });
    expect(await f.run()).toBe('succeeded');
    expect(await f.reservation()).toBeUndefined();
    expect(await f.server()).toMatchObject({
      runtime_state: 'offline',
      readiness: 'unknown',
      active_operation_id: null,
      intent: 'manually_stopped',
    });
    expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it('does not recreate stopped capacity from a stale running reconciliation sample', async () => {
    const f = await fixture('stop');
    await f.prepareReservation();
    f.setState('running');
    f.options.confirmAlreadyStopped = vi.fn(async () => true);
    f.adapter.stopWithConfirmation.mockImplementation(async (_id, _identifier, input) => {
      await input.onConfirmed();
      return { confirmed: true };
    });
    expect(await f.run()).toBe('succeeded');
    f.tick(1000);
    expect(await reconcileManagedServer(f.db, f.serverId, f.options)).toBe('observed');
    expect(await f.server()).toMatchObject({ runtime_state: 'offline', readiness: 'unknown' });
    expect(await f.reservation()).toBeUndefined();
    expect(
      await f.db
        .selectFrom('server_events')
        .select('message_key')
        .where('server_id', '=', f.serverId)
        .where('message_key', '=', 'servers.reconciliation.external_start')
        .execute(),
    ).toEqual([]);
    // An actual new process must defeat even a recent stop receipt.
    f.options.confirmAlreadyStopped = vi.fn(async () => false);
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect(await f.server()).toMatchObject({ runtime_state: 'running' });
    expect(await f.reservation()).toBeDefined();
  });
  it('does not suppress a current observation using an expired stop receipt', async () => {
    const f = await fixture('stop');
    await f.prepareReservation();
    f.setState('running');
    f.options.confirmAlreadyStopped = vi.fn(async () => true);
    f.adapter.stopWithConfirmation.mockImplementation(async (_id, _identifier, input) => {
      await input.onConfirmed();
      return { confirmed: true };
    });
    expect(await f.run()).toBe('succeeded');
    f.tick();
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect(await f.reservation()).toBeDefined();
  });
  it.each(['running', 'unavailable', 'identity'] as const)(
    'retains stop capacity if the fresh confirmation is %s',
    async (failure) => {
      const f = await fixture('stop');
      await f.prepareReservation();
      f.setState('running');
      f.options.confirmAlreadyStopped = vi.fn(async () => {
        if (failure === 'unavailable') throw new Error('observer unavailable');
        return false;
      });
      const original = f.adapter.stopWithConfirmation.getMockImplementation();
      f.adapter.stopWithConfirmation.mockImplementation(async (...args) => {
        const result = await original?.(...args);
        if (failure === 'identity') f.remote.uuid = randomUUID();
        return result ?? { confirmed: false };
      });
      expect(await f.run()).toBe(failure === 'identity' ? 'failed' : 'waiting');
      expect(await f.reservation()).toBeDefined();
      expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
      expect(f.adapter.power).not.toHaveBeenCalled();
    },
  );
  it('recovers a confirmed stop before cache expiry without sending another stop', async () => {
    const f = await fixture('stop');
    await f.prepareReservation();
    f.setState('running');
    f.adapter.stopWithConfirmation.mockImplementation(async (_id, _identifier, input) => {
      await input.onConfirmed();
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    expect(await f.run()).toBe('waiting');
    f.options.confirmAlreadyStopped = vi.fn(async () => true);
    f.tick(3000);
    expect(await f.run()).toBe('succeeded');
    expect(await f.reservation()).toBeUndefined();
    expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
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
  const outputReceipt = {
    integrationId: 'fixture',
    combinationId: 'fixture-combination',
    mappingDigest: 'fixture-mapping',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    files: [{ path: 'server.jar', sha256: 'b'.repeat(64), size: 100 }],
  };
  it('recovers a missed first-install event from verified outputs without replay or automatic power', async () => {
    const f = await fixture('provision');
    f.adapter.confirmInstallation.mockResolvedValue({ confirmed: false });
    expect(await f.run()).toBe('waiting');
    expect(await f.installationReservation()).toBeDefined();
    f.tick();
    f.options.confirmInitialInstallationStopped = vi.fn(async () => true);
    f.options.verifyInitialInstallation = vi.fn(async () => outputReceipt);
    expect(await f.run()).toBe('succeeded');
    expect((await f.operation()).plan.installationProof).toMatchObject({
      method: 'required_outputs_verified',
      operationId: f.jobId,
      providerUuid: f.remote.uuid,
      ...outputReceipt,
    });
    expect(await f.installationReservation()).toBeUndefined();
    expect(f.options.confirmInitialInstallationStopped).toHaveBeenCalledTimes(2);
    expect(f.adapter.createServer).toHaveBeenCalledTimes(1);
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(f.adapter.reinstall).not.toHaveBeenCalled();
    expect(await f.run()).toBe('duplicate');
    expect(f.options.verifyInitialInstallation).toHaveBeenCalledTimes(1);
  });
  it('resumes after a crash following the durable output receipt without repeating creation or proof', async () => {
    const f = await fixture('provision');
    f.options.confirmInitialInstallationStopped = vi.fn(async () => true);
    f.options.verifyInitialInstallation = vi.fn(async () => outputReceipt);
    f.options.configureGameProvision = vi
      .fn()
      .mockRejectedValueOnce(new Error('crash'))
      .mockResolvedValue(true);
    expect(await f.run()).toBe('waiting');
    expect((await f.operation()).plan.installationProof).toMatchObject({
      method: 'required_outputs_verified',
    });
    expect(await f.installationReservation()).toBeUndefined();
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.options.verifyInitialInstallation).toHaveBeenCalledTimes(1);
    expect(f.adapter.createServer).toHaveBeenCalledTimes(1);
    expect(f.adapter.confirmInstallation).not.toHaveBeenCalled();
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it.each([
    'installer',
    'game',
    'identity',
    'outputs',
    'revocation',
    'status',
    'creation-time',
  ] as const)(
    'retains first-install admission when recovery fails %s verification',
    async (failure) => {
      const f = await fixture('provision');
      f.adapter.confirmInstallation.mockResolvedValue({ confirmed: false });
      expect(await f.run()).toBe('waiting');
      f.tick();
      f.options.confirmInitialInstallationStopped = vi.fn(async () => failure !== 'installer');
      f.options.verifyInitialInstallation = vi.fn(async () => {
        if (failure === 'outputs') throw new DomainError('conflict');
        if (failure === 'revocation')
          f.options.authorizeEffect = async () => {
            throw new DomainError('forbidden');
          };
        if (failure === 'status') f.remote.status = 'installing';
        return outputReceipt;
      });
      if (failure === 'game') f.setState('running');
      if (failure === 'identity') f.remote.uuid = randomUUID();
      if (failure === 'creation-time') f.remote.created_at = '2000-01-01T00:00:00Z';
      expect(await f.run()).toBe(
        ['identity', 'outputs', 'revocation'].includes(failure) ? 'failed' : 'waiting',
      );
      expect((await f.operation()).plan.installConfirmed).toBeUndefined();
      expect(await f.installationReservation()).toBeDefined();
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect(f.adapter.reinstall).not.toHaveBeenCalled();
    },
  );
  it.each(['reinstall', 'wipe'] as const)(
    'never substitutes initial output proof for %s completion',
    async (action) => {
      const f = await fixture(action);
      f.adapter.confirmInstallation.mockResolvedValue({ confirmed: false });
      f.adapter.reinstallWithConfirmation.mockResolvedValue({ confirmed: false });
      f.options.confirmInitialInstallationStopped = vi.fn(async () => true);
      f.options.verifyInitialInstallation = vi.fn(async () => outputReceipt);
      for (let attempt = 0; attempt < 4; attempt++) {
        await f.run();
        f.tick();
      }
      expect(f.options.verifyInitialInstallation).not.toHaveBeenCalled();
      expect((await f.operation()).plan.installConfirmed).toBeUndefined();
      expect(await f.installationReservation()).toBeDefined();
    },
  );
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

/** These gates model slow external I/O, never a production provider or clock sleep. */
function reconciliationGate<T>() {
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<T>();
  return { entered, result };
}

describe('unlocked reconciliation collection and atomic stale-result fencing', () => {
  async function idleFixture() {
    const f = await fixture('start');
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', f.serverId)
      .execute();
    return f;
  }
  async function history(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      server: await f.server(),
      reservation: await f.reservation(),
      installation: await f.installationReservation(),
      metrics: await f.db
        .selectFrom('server_metrics')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
      events: await f.db
        .selectFrom('server_events')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
    };
  }
  async function heldResources(f: Awaited<ReturnType<typeof fixture>>) {
    const sample = await f.adapter.getResources();
    const gate = reconciliationGate<Resources>();
    f.adapter.getResources.mockImplementationOnce(async () => {
      gate.entered.resolve();
      return gate.result.promise;
    });
    const observation = reconcileManagedServer(f.db, f.serverId, f.options);
    await gate.entered.promise;
    return { sample, gate, observation };
  }
  it('leaves the server operation lock free during provider collection and preserves freshness on failure', async () => {
    const f = await idleFixture();
    const before = await history(f);
    f.remote.status = 'install_failed';
    const held = await heldResources(f);
    await f.db.connection().execute(async (connection) => {
      const acquired = await sql<{
        acquired: boolean;
      }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:server:${f.serverId}`},0)) as acquired`.execute(
        connection,
      );
      expect(acquired.rows[0]?.acquired).toBe(true);
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:server:${f.serverId}`},0))`.execute(
        connection,
      );
    });
    expect(await history(f)).toEqual(before);
    const rejected = expect(held.observation).rejects.toThrow('fixture read failure');
    held.gate.result.reject(new Error('fixture read failure'));
    await rejected;
    expect(await history(f)).toEqual(before);
  });
  it('rejects a completed ABA lifecycle even when all server values and JS timestamps are unchanged', async () => {
    const f = await idleFixture();
    const before = await history(f);
    f.remote.status = 'install_failed';
    const held = await heldResources(f);
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: f.jobId })
      .where('id', '=', f.serverId)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', f.serverId)
      .execute();
    expect(await f.server()).toEqual(before.server);
    held.gate.result.resolve({ ...held.sample, current_state: 'running' });
    expect(await held.observation).toBe('deferred');
    expect(await history(f)).toEqual(before);
  });
  it('discards an older observation after a newer observation and readiness update', async () => {
    const f = await idleFixture();
    const held = await heldResources(f);
    f.setState('running');
    f.tick(1);
    expect(await reconcileManagedServer(f.db, f.serverId, f.options)).toBe('observed');
    await f.db
      .updateTable('managed_servers')
      .set({ readiness: 'ready' })
      .where('id', '=', f.serverId)
      .execute();
    const newer = await history(f);
    held.gate.result.resolve(held.sample);
    expect(await held.observation).toBe('deferred');
    expect(await history(f)).toEqual(newer);
  });
  it.each([
    'identity',
    'node',
    'host',
    'allocation',
    'deleted',
    'power_receipt',
    'reservation',
  ] as const)('discards every old effect after intervening %s changes', async (change) => {
    const f = await idleFixture();
    const held = await heldResources(f);
    if (change === 'identity')
      await f.db
        .updateTable('managed_servers')
        .set({ pterodactyl_uuid: randomUUID() })
        .where('id', '=', f.serverId)
        .execute();
    if (change === 'node')
      await f.db
        .updateTable('managed_nodes')
        .set({ pterodactyl_node_id: f.remote.node + 10000 })
        .where('id', '=', f.nodeId)
        .execute();
    if (change === 'host')
      await f.db
        .updateTable('physical_hosts')
        .set({ observer_id: 'replacement' })
        .where('id', '=', f.hostId)
        .execute();
    if (change === 'allocation')
      await f.db
        .updateTable('server_allocations')
        .set({ protocols: ['tcp', 'udp'] })
        .where('server_id', '=', f.serverId)
        .execute();
    if (change === 'deleted')
      await f.db
        .updateTable('managed_servers')
        .set({ deleted_at: f.now() })
        .where('id', '=', f.serverId)
        .execute();
    if (change === 'power_receipt')
      await f.db
        .updateTable('server_operations')
        .set({ plan: JSON.stringify({ startConfirmed: true }) })
        .where('job_id', '=', f.jobId)
        .execute();
    if (change === 'reservation') await f.prepareReservation();
    const changed = await history(f);
    held.gate.result.resolve({ ...held.sample, current_state: 'running' });
    expect(await held.observation).toBe('deferred');
    expect(await history(f)).toEqual(changed);
  });
  it('does not release a new reservation when a late external-stop receipt arrives', async () => {
    const f = await idleFixture();
    await f.prepareReservation();
    const gate = reconciliationGate<import('./lifecycle.js').ExternalStopReceipt | null>();
    f.options.observeExternalStop = async () => {
      gate.entered.resolve();
      return gate.result.promise;
    };
    const pending = reconcileManagedServer(f.db, f.serverId, f.options);
    await gate.entered.promise;
    await f.db
      .updateTable('resource_reservations')
      .set({ operation_id: randomUUID(), state: 'starting' })
      .where('server_id', '=', f.serverId)
      .execute();
    const newer = await history(f);
    gate.result.resolve({
      containerId: 'fixture',
      startedAt: new Date(f.now().getTime() - 10000).toISOString(),
      finishedAt: f.now().toISOString(),
      activityId: 'fixture',
      activityAt: f.now().toISOString(),
      action: 'kill',
    });
    expect(await pending).toBe('deferred');
    expect(await history(f)).toEqual(newer);
  });
  it('rolls back installation, observation, metrics and reservations together if atomic apply fails', async () => {
    const f = await idleFixture();
    const before = await history(f);
    f.remote.status = 'install_failed';
    f.setState('running');
    // Database CHECK failure during the final reservation insertion, after observation.
    await f.db
      .updateTable('managed_servers')
      .set({ limits: JSON.stringify({ ...f.remote.limits, cpu: -1 }) })
      .where('id', '=', f.serverId)
      .execute();
    const invalid = await history(f);
    await expect(reconcileManagedServer(f.db, f.serverId, f.options)).rejects.toBeDefined();
    expect(await history(f)).toEqual(invalid);
    expect((await f.server()).last_observed_at).toEqual(before.server.last_observed_at);
  });
});

describe('terminal failed installation reservation recovery', () => {
  async function failedInstallation(action: 'provision' | 'reinstall' = 'provision') {
    const f = await fixture('reinstall');
    await f.db
      .updateTable('managed_servers')
      .set({
        active_operation_id: null,
        installation_state: 'installing',
        runtime_state: 'offline',
        intent: 'manually_stopped',
      })
      .where('id', '=', f.serverId)
      .execute();
    await f.db
      .updateTable('server_operations')
      .set({
        action,
        phase: 'failed',
        effect_state: 'confirmed',
        plan: JSON.stringify({ installationEffectPrepared: true }),
      })
      .where('job_id', '=', f.jobId)
      .execute();
    await f.db
      .updateTable('operation_jobs')
      .set({
        state: 'failed',
        completed_at: f.now(),
        error_code: 'conflict',
      })
      .where('id', '=', f.jobId)
      .execute();
    await f.db
      .insertInto('installation_reservations')
      .values({
        server_id: f.serverId,
        physical_host_id: f.hostId,
        operation_id: f.jobId,
        memory_mib: 1178,
        cpu_percent: 100,
      })
      .execute();
    f.options.confirmInitialInstallationStopped = vi.fn(async () => true);
    f.options.verifyInitialInstallation = vi.fn();
    return f;
  }
  function retry(f: Awaited<ReturnType<typeof fixture>>) {
    return enqueueServerOperation(
      f.db,
      {
        actorUserId: f.ownerId,
        subjectUserId: f.ownerId,
        role: 'user',
        sessionType: 'regular',
        ownerElevation: false,
      },
      f.serverId,
      { action: 'reinstall', confirm: true, idempotencyKey: randomUUID() },
    );
  }
  it.each(['provision', 'reinstall'] as const)(
    'releases only the stopped failed %s reservation and allows an explicit reinstall',
    async (action) => {
      const f = await failedInstallation(action);
      await expect(retry(f)).rejects.toMatchObject({ code: 'operation_uncertain' });
      expect(await reconcileManagedServer(f.db, f.serverId, f.options)).toBe('observed');
      expect(await f.installationReservation()).toBeUndefined();
      expect(await f.server()).toMatchObject({
        installation_state: 'failed',
        active_operation_id: null,
      });
      expect((await f.operation()).phase).toBe('failed');
      expect(f.options.verifyInitialInstallation).not.toHaveBeenCalled();
      expect(f.adapter.reinstall).not.toHaveBeenCalled();
      expect(f.adapter.reinstallWithConfirmation).not.toHaveBeenCalled();
      expect(f.adapter.power).not.toHaveBeenCalled();
      const queued = await retry(f);
      expect((await f.server()).active_operation_id).toBe(queued.jobId);
      expect(f.adapter.reinstallWithConfirmation).not.toHaveBeenCalled();
    },
  );
  it.each(['install_failed', 'reinstall_failed'])(
    'recovers stopped %s even when the provider installed flag is false',
    async (status) => {
      const f = await failedInstallation();
      f.remote.status = status;
      f.remote.container.installed = false;
      await reconcileManagedServer(f.db, f.serverId, f.options);
      expect(await f.installationReservation()).toBeUndefined();
      expect((await f.server()).installation_state).toBe('failed');
    },
  );
  it.each([
    'provider-installing',
    'provider-pending',
    'server-running',
    'observer-false',
    'no-observer',
    'job-running',
    'operation-not-failed',
    'foreign-job',
    'job-queued',
    'active-operation',
    'confirmed-install',
  ] as const)('retains the reservation when %s', async (reason) => {
    const f = await failedInstallation();
    if (reason === 'provider-installing') f.remote.status = 'installing';
    if (reason === 'provider-pending') f.remote.container.installed = false;
    if (reason === 'server-running') f.setState('running');
    if (reason === 'observer-false')
      f.options.confirmInitialInstallationStopped = vi.fn(async () => false);
    if (reason === 'no-observer') f.options.confirmInitialInstallationStopped = undefined;
    if (reason === 'job-running')
      await f.db
        .updateTable('operation_jobs')
        .set({ state: 'running', completed_at: null })
        .where('id', '=', f.jobId)
        .execute();
    if (reason === 'operation-not-failed')
      await f.db
        .updateTable('server_operations')
        .set({ phase: 'installation' })
        .where('job_id', '=', f.jobId)
        .execute();
    if (reason === 'foreign-job') {
      const foreign = await failedInstallation();
      await f.db
        .updateTable('installation_reservations')
        .set({ operation_id: foreign.jobId })
        .where('server_id', '=', f.serverId)
        .execute();
    }
    if (reason === 'job-queued')
      await f.db
        .updateTable('operation_jobs')
        .set({ state: 'queued', completed_at: null })
        .where('id', '=', f.jobId)
        .execute();
    if (reason === 'active-operation')
      await f.db
        .updateTable('managed_servers')
        .set({ active_operation_id: f.jobId })
        .where('id', '=', f.serverId)
        .execute();
    if (reason === 'confirmed-install')
      await f.db
        .updateTable('server_operations')
        .set({ plan: JSON.stringify({ installConfirmed: true }) })
        .where('job_id', '=', f.jobId)
        .execute();
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect(await f.installationReservation()).toBeDefined();
    await expect(retry(f)).rejects.toMatchObject({
      code: reason === 'active-operation' ? 'conflict' : 'operation_uncertain',
    });
    expect(f.adapter.reinstallWithConfirmation).not.toHaveBeenCalled();
  });
  it.each(['integration_unavailable', 'configuration_invalid', 'provenance_mismatch'] as const)(
    'preserves and surfaces observer %s without releasing capacity',
    async (code) => {
      const f = await failedInstallation();
      f.options.confirmInitialInstallationStopped = vi.fn(async () => {
        throw new DomainError(code);
      });
      await expect(reconcileManagedServer(f.db, f.serverId, f.options)).rejects.toMatchObject({
        code,
      });
      expect(await f.installationReservation()).toBeDefined();
      await expect(retry(f)).rejects.toMatchObject({ code: 'operation_uncertain' });
    },
  );
  it.each(['provider-installing', 'server-running'] as const)(
    'retains capacity when %s changes during observer proof',
    async (change) => {
      const f = await failedInstallation();
      f.options.confirmInitialInstallationStopped = vi.fn(async () => {
        if (change === 'provider-installing') f.remote.status = 'installing';
        else f.setState('running');
        return true;
      });
      await reconcileManagedServer(f.db, f.serverId, f.options);
      expect(await f.installationReservation()).toBeDefined();
    },
  );
  it.each(['active-operation', 'operation-aba', 'job', 'reservation'] as const)(
    'defers stale recovery when %s changes during proof',
    async (change) => {
      const f = await failedInstallation();
      const gate = reconciliationGate<boolean>();
      // The failed reservation owner need not be the latest power operation.
      // Its revision must independently fence recovery.
      if (change === 'job') {
        const newer = await fixture('stop');
        await f.db
          .updateTable('server_operations')
          .set({
            server_id: f.serverId,
            updated_at: new Date(f.now().getTime() + 1000),
          })
          .where('job_id', '=', newer.jobId)
          .execute();
      }
      f.options.confirmInitialInstallationStopped = vi.fn(async () => {
        gate.entered.resolve();
        return gate.result.promise;
      });
      const result = reconcileManagedServer(f.db, f.serverId, f.options);
      await gate.entered.promise;
      if (change === 'active-operation' || change === 'operation-aba') {
        await f.db
          .updateTable('managed_servers')
          .set({ active_operation_id: f.jobId })
          .where('id', '=', f.serverId)
          .execute();
        if (change === 'operation-aba')
          await f.db
            .updateTable('managed_servers')
            .set({ active_operation_id: null })
            .where('id', '=', f.serverId)
            .execute();
      } else if (change === 'job') {
        await f.db
          .updateTable('operation_jobs')
          .set({ error_code: 'forbidden' })
          .where('id', '=', f.jobId)
          .execute();
      } else {
        await f.db
          .updateTable('installation_reservations')
          .set({ memory_mib: 2000 })
          .where('server_id', '=', f.serverId)
          .execute();
      }
      gate.result.resolve(true);
      expect(await result).toBe('deferred');
      expect(await f.installationReservation()).toBeDefined();
      expect((await f.server()).installation_state).toBe('installing');
    },
  );
  it('does not call the installer observer for ordinary servers without an orphan', async () => {
    const f = await fixture('start');
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null, installation_state: 'installed' })
      .where('id', '=', f.serverId)
      .execute();
    f.options.confirmInitialInstallationStopped = vi.fn(async () => true);
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect(f.options.confirmInitialInstallationStopped).not.toHaveBeenCalled();
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
    expect(f.adapter.getResources).toHaveBeenCalledTimes(1);
  });
  it('marks a newly failed incomplete installation failed without releasing unproven capacity', async () => {
    const f = await fixture('provision');
    f.options.confirmInitialInstallationStopped = vi.fn(async () => true);
    f.options.verifyInitialInstallation = vi.fn(async () => {
      throw new DomainError('conflict');
    });
    expect(await f.run()).toBe('failed');
    expect(await f.server()).toMatchObject({
      installation_state: 'failed',
      active_operation_id: null,
    });
    expect(await f.installationReservation()).toBeDefined();
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(f.adapter.reinstallWithConfirmation).not.toHaveBeenCalled();
  });
  it('preserves confirmed installation when a later provisioning step fails', async () => {
    const f = await fixture('provision', { autoStart: true });
    f.options.configureGameProvision = vi.fn(async () => {
      throw new DomainError('forbidden');
    });
    expect(await f.run()).toBe('failed');
    expect((await f.operation()).plan.installConfirmed).toBe(true);
    expect((await f.server()).installation_state).toBe('installed');
    expect(await f.installationReservation()).toBeUndefined();
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it('retains capacity when the final provider recheck is unavailable', async () => {
    const f = await failedInstallation();
    f.options.confirmInitialInstallationStopped = vi.fn(async () => {
      f.adapter.getApplicationServer.mockRejectedValueOnce(
        new PterodactylError('unavailable', 'application', 'unknown'),
      );
      return true;
    });
    await expect(reconcileManagedServer(f.db, f.serverId, f.options)).rejects.toBeInstanceOf(
      PterodactylError,
    );
    expect(await f.installationReservation()).toBeDefined();
    expect((await f.server()).installation_state).toBe('installing');
  });
});

describe('event-driven backup lifecycle', () => {
  it('passes backup options and completes from durable event without provider polling', async () => {
    const f = await fixture('backup', {
      backupOptions: {
        name: 'Before update',
        ignored: '*.log\ncache/**',
        isLocked: true,
        mode: 'live',
      },
    });
    f.options.backupEventsEnabled = async () => true;
    let completion: Awaited<ReturnType<NonNullable<LifecycleOptions['readBackupCompletion']>>> =
      null;
    f.options.readBackupCompletion = async () => completion;
    expect(await f.run()).toBe('waiting');
    expect(f.adapter.createBackup).toHaveBeenCalledWith(f.remote.identifier, {
      name: `nickhosting-operation-${f.jobId}`,
      ignored: '*.log\ncache/**',
      is_locked: true,
    });
    expect(f.adapter.getBackup).not.toHaveBeenCalled();
    const job = await f.db
      .selectFrom('operation_jobs')
      .select('next_attempt_at')
      .where('id', '=', f.jobId)
      .executeTakeFirstOrThrow();
    expect(job.next_attempt_at.getTime() - f.now().getTime()).toBeGreaterThanOrEqual(60_000);
    const id = String((await f.operation()).plan.backupId);
    expect(
      await f.db
        .selectFrom('backup_labels')
        .select('name')
        .where('backup_id', '=', id)
        .executeTakeFirst(),
    ).toEqual({ name: 'Before update' });
    completion = {
      eventId: randomUUID(),
      occurredAt: f.now().toISOString(),
      backup: {
        uuid: id,
        isSuccessful: true,
        checksum: 'sha256:fixture',
        completedAt: f.now().toISOString(),
      },
    };
    await f.db
      .updateTable('operation_jobs')
      .set({ next_attempt_at: f.now() })
      .where('id', '=', f.jobId)
      .execute();
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.getBackup).not.toHaveBeenCalled();
  });

  it('temporarily stops, cleans up and resumes only after admission', async () => {
    const f = await fixture('backup');
    f.setState('running');
    f.options.backupPolicy = async () => ({ offline: 'required' });
    f.options.confirmAlreadyStopped = async () =>
      (await f.adapter.getResources()).current_state === 'offline';
    f.options.observeProcessStart = async () =>
      (await f.adapter.getResources()).current_state === 'running'
        ? new Date(f.now().getTime() - 1_000).toISOString()
        : null;
    f.options.prepareBackup = vi.fn(async () => {});
    f.options.cleanupBackup = vi.fn(async () => {});
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'auto_wake_enabled' })
      .where('id', '=', f.serverId)
      .execute();
    expect(await f.run()).toBe('waiting');
    expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
    expect(f.options.prepareBackup).toHaveBeenCalledTimes(1);
    f.tick();
    expect(await f.run()).toBe('waiting');
    expect(f.options.reserveStart).toHaveBeenCalledTimes(1);
    expect(f.adapter.power).toHaveBeenCalledWith(f.remote.identifier, 'start');
    const started = new Date(f.now().getTime() + 1).toISOString();
    f.options.observeProcessStart = async () => started;
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(f.options.cleanupBackup).toHaveBeenCalledTimes(1);
    expect((await f.operation()).plan).toMatchObject({
      backupComplete: true,
      backupResumeOutcome: 'succeeded',
    });
  });

  it('suppresses automatic resume after a manual stop or explicit pause and preserves backup success on admission failure', async () => {
    for (const reason of ['manual-stop', 'pause', 'admission']) {
      const f = await fixture('backup');
      f.setState('running');
      f.options.backupPolicy = async () => ({ offline: 'required' });
      f.options.confirmAlreadyStopped = async () =>
        (await f.adapter.getResources()).current_state === 'offline';
      f.options.observeProcessStart = async () =>
        (await f.adapter.getResources()).current_state === 'running'
          ? new Date(f.now().getTime() - 1_000).toISOString()
          : null;
      await f.db
        .updateTable('managed_servers')
        .set({ intent: 'auto_wake_enabled' })
        .where('id', '=', f.serverId)
        .execute();
      expect(await f.run()).toBe('waiting');
      if (reason !== 'admission')
        await f.db
          .updateTable('managed_servers')
          .set(
            reason === 'pause' ? { automatic_starts_paused: true } : { intent: 'manually_stopped' },
          )
          .where('id', '=', f.serverId)
          .execute();
      else
        f.options.reserveStart = async () => {
          throw new DomainError('resources_unavailable');
        };
      f.tick();
      expect(await f.run()).toBe('succeeded');
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect((await f.operation()).plan).toMatchObject({
        backupComplete: true,
        backupResumeOutcome: reason === 'admission' ? 'failed' : 'suppressed',
      });
    }
  });

  it('rejects a required-offline live override before stopping or creating a backup', async () => {
    const f = await fixture('backup', { backupOptions: { mode: 'live' } });
    f.options.backupPolicy = async () => ({ offline: 'required' });
    expect(await f.run()).toBe('failed');
    expect(f.adapter.createBackup).not.toHaveBeenCalled();
    expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
  });
});

describe('backup recovery and restore safety', () => {
  it('cleans up a durably rejected backup after worker recovery', async () => {
    const f = await fixture('backup', {
      backupMode: 'live',
      backupPreparationStarted: true,
      backupPrepared: true,
      rejected: true,
      rejectionCode: 'integration_unavailable',
    });
    f.options.cleanupBackup = vi.fn(async () => {});
    expect(await f.run()).toBe('failed');
    expect(f.options.cleanupBackup).toHaveBeenCalledTimes(1);
    expect(f.adapter.createBackup).not.toHaveBeenCalled();
  });
  it('keeps successful snapshot outcome when rejected resume is recovered', async () => {
    const f = await fixture('backup', {
      backupComplete: true,
      rejected: true,
      rejectionCode: 'resources_unavailable',
    });
    await f.db
      .updateTable('server_operations')
      .set({ phase: 'backup_resume', effect_state: 'none' })
      .where('job_id', '=', f.jobId)
      .execute();
    expect(await f.run()).toBe('succeeded');
    expect((await f.operation()).plan).toMatchObject({
      backupComplete: true,
      backupResumeOutcome: 'failed',
      backupResumeError: 'resources_unavailable',
    });
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it('creates optional safety backup without replacing the requested restore target', async () => {
    const id = randomUUID();
    const f = await fixture('restore', { restoreBackupId: id, backupBefore: true, truncate: true });
    f.backups.push({
      uuid: id,
      name: 'original',
      is_successful: true,
      is_locked: false,
      ignored_files: [],
      checksum: 'sha256:original',
      bytes: 100,
      created_at: f.now().toISOString(),
      completed_at: f.now().toISOString(),
    });
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    f.tick();
    expect(await f.run()).toBe('waiting');
    expect(f.adapter.restoreBackup).toHaveBeenCalledWith(f.remote.identifier, id, true);
    expect((await f.operation()).plan.backupId).not.toBe(id);
    expect((await f.operation()).plan.restoreBackupId).toBe(id);
  });
});

it('retention deletes only successful same-schedule backups and preserves provider protection', async () => {
  const scheduleId = randomUUID();
  const f = await fixture('backup', {
    scheduleAutomation: { scheduleId, retention: { enabled: true, keepLast: 1 } },
  });
  const template = await f.db
    .selectFrom('operation_jobs')
    .selectAll()
    .where('id', '=', f.jobId)
    .executeTakeFirstOrThrow();
  const eligible: string[] = [];
  for (const [isLocked, sameSchedule] of [
    [false, true],
    [true, true],
    [false, false],
  ] as const) {
    const backupId = randomUUID(),
      oldJob = randomUUID();
    f.backups.push({
      uuid: backupId,
      name: `old-${oldJob}`,
      is_successful: true,
      is_locked: isLocked,
      ignored_files: [],
      checksum: 'sha256:fixture',
      bytes: 100,
      created_at: f.now().toISOString(),
      completed_at: f.now().toISOString(),
    });
    await f.db
      .insertInto('operation_jobs')
      .values({
        ...template,
        command: JSON.stringify(template.command),
        policy_snapshot: JSON.stringify(template.policy_snapshot),
        id: oldJob,
        idempotency_key: oldJob,
        state: 'succeeded',
        completed_at: f.now(),
      })
      .execute();
    await f.db
      .insertInto('server_operations')
      .values({
        job_id: oldJob,
        server_id: f.serverId,
        action: 'backup',
        phase: 'complete',
        plan: JSON.stringify({
          backupComplete: true,
          backupId,
          scheduleAutomation: { scheduleId: sameSchedule ? scheduleId : randomUUID() },
        }),
        effect_started_at: null,
        lease_until: null,
        lease_token: null,
      })
      .execute();
    if (!isLocked && sameSchedule) eligible.push(backupId);
  }
  const deleteBackup = vi.fn(async () => {});
  f.options.adapter = { ...f.options.adapter, deleteBackup };
  expect(await f.run()).toBe('waiting');
  f.tick();
  expect(await f.run()).toBe('succeeded');
  expect(deleteBackup.mock.calls).toEqual(eligible.map((id) => [f.remote.identifier, id]));
  expect((await f.operation()).plan.backupRetentionComplete).toBe(true);
});

it('stops a physically running server even when Panel still caches offline after start', async () => {
  const f = await fixture('backup');
  f.setState('offline');
  f.options.backupPolicy = async () => ({ offline: 'required' });
  let physicallyRunning = true;
  f.options.confirmAlreadyStopped = async () => !physicallyRunning;
  f.options.observeProcessStart = async () =>
    physicallyRunning ? new Date(f.now().getTime() - 1_000).toISOString() : null;
  f.adapter.stopWithConfirmation.mockImplementationOnce(async (_id, _identifier, options) => {
    await options.beforePower?.();
    physicallyRunning = false;
    await options.onConfirmed();
    return { confirmed: true };
  });
  expect(await f.run()).toBe('waiting');
  expect(f.adapter.stopWithConfirmation).toHaveBeenCalledTimes(1);
  expect(f.adapter.createBackup).toHaveBeenCalledTimes(1);
  expect((await f.operation()).plan.backupWasRunning).toBe(true);
});

it('allows only compensating cleanup after creator authorization is withdrawn', async () => {
  const f = await fixture('backup', { backupOptions: { mode: 'live' } });
  f.options.prepareBackup = vi.fn(async () => {});
  f.options.cleanupBackup = vi.fn(async (context) => {
    await context.authorize();
  });
  expect(await f.run()).toBe('waiting');
  f.options.authorizeEffect = async () => {
    throw new DomainError('forbidden');
  };
  f.tick();
  expect(await f.run()).toBe('succeeded');
  expect(f.options.cleanupBackup).toHaveBeenCalledTimes(1);
  expect(f.adapter.power).not.toHaveBeenCalled();
});

it('terminates a recovered rejected resume even when the backup itself also failed', async () => {
  const f = await fixture('backup', {
    backupFailed: true,
    rejected: true,
    rejectionCode: 'forbidden',
  });
  await f.db
    .updateTable('server_operations')
    .set({ phase: 'backup_resume', effect_state: 'none' })
    .where('job_id', '=', f.jobId)
    .execute();
  expect(await f.run()).toBe('failed');
  expect((await f.operation()).plan).toMatchObject({
    backupResumeOutcome: 'failed',
    backupResumeError: 'forbidden',
  });
  expect(f.adapter.power).not.toHaveBeenCalled();
});

it('consumes an exact restore terminal event without polling activity after the effect', async () => {
  const id = randomUUID();
  const f = await fixture('restore', { restoreBackupId: id, truncate: true });
  f.options.settleMs = 0;
  f.options.backupEventsEnabled = async () => true;
  let completion: Awaited<ReturnType<NonNullable<LifecycleOptions['readBackupCompletion']>>> = null;
  f.options.readBackupCompletion = async () => completion;
  f.backups.push({
    uuid: id,
    name: 'original',
    is_successful: true,
    is_locked: false,
    ignored_files: [],
    checksum: 'sha256:original',
    bytes: 100,
    created_at: f.now().toISOString(),
    completed_at: f.now().toISOString(),
  });
  f.adapter.restoreBackup.mockImplementation(async () => {
    completion = {
      eventId: randomUUID(),
      occurredAt: f.now().toISOString(),
      backup: {
        uuid: id,
        isSuccessful: true,
        checksum: 'sha256:original',
        completedAt: f.now().toISOString(),
      },
    };
  });
  expect(await f.run()).toBe('waiting');
  f.tick();
  expect(await f.run()).toBe('waiting');
  const pending = await f.db
    .selectFrom('operation_jobs')
    .select('next_attempt_at')
    .where('id', '=', f.jobId)
    .executeTakeFirstOrThrow();
  expect(pending.next_attempt_at).toEqual(f.now());
  expect(await f.run()).toBe('succeeded');
  expect(f.adapter.listBackupActivity).toHaveBeenCalledTimes(1);
});

it('retains resumed compute after a rejected backup create without inheriting its rejection', async () => {
  const f = await fixture('backup');
  f.setState('running');
  await f.db
    .updateTable('managed_servers')
    .set({ intent: 'auto_wake_enabled' })
    .where('id', '=', f.serverId)
    .execute();
  f.options.backupPolicy = async () => ({ offline: 'required' });
  f.options.confirmAlreadyStopped = async () =>
    (await f.adapter.getResources()).current_state === 'offline';
  f.options.observeProcessStart = async () =>
    (await f.adapter.getResources()).current_state === 'running'
      ? new Date(f.now().getTime() - 1_000).toISOString()
      : null;
  f.adapter.createBackup.mockRejectedValue(
    new PterodactylError('invalid_request', 'client', 'rejected'),
  );
  expect(await f.run()).toBe('waiting');
  expect((await f.operation()).plan).toMatchObject({
    backupFailed: true,
    rejected: false,
    backupResumeOutcome: 'pending',
  });
  f.tick();
  expect(await f.run()).toBe('failed');
  expect((await f.operation()).plan.backupResumeOutcome).toBe('succeeded');
  expect(f.adapter.power).toHaveBeenCalledTimes(1);
  expect(
    await f.db
      .selectFrom('resource_reservations')
      .select('state')
      .where('server_id', '=', f.serverId)
      .executeTakeFirst(),
  ).toEqual({ state: 'running' });
});

describe('Minecraft world selection without telemetry settling', () => {
  const plan = () => ({
    minecraftContent: {
      combinationId: randomUUID(),
      command: { kind: 'world-select', world: 'selected_world' },
      world: { existing: true, dataVersion: 3955 },
      backupBefore: false,
    },
  });
  const metadataPlan = (kind: 'world-select' | 'properties' | 'player') =>
    kind === 'world-select'
      ? plan()
      : {
          minecraftContent: {
            combinationId: randomUUID(),
            backupBefore: false,
            command:
              kind === 'properties'
                ? { kind, changes: { motd: 'fixture' } }
                : { kind, list: 'operators', action: 'add', name: 'Player' },
          },
        };
  async function resourceBlockedWorker(jobId: string) {
    const worker = createDatabase(process.env.NH_TEST_DATABASE_URL ?? '', {
      options: `-c search_path=${database.schema} -c lock_timeout=200ms`,
      application_name: `isolated-selection-${jobId}`,
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    const blocker = await database.pool.connect();
    const attempts: Promise<unknown>[] = [];
    const block = async () => {
      const held = await blocker.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock(hashtextextended(current_schema() || ':resources',0)) as acquired",
      );
      expect(held.rows[0]?.acquired).toBe(true);
    };
    try {
      await block();
    } catch (error) {
      blocker.release();
      await worker.db.destroy();
      throw error;
    }
    return {
      run(options: LifecycleOptions) {
        const operation = processServerOperation(worker.db, jobId, options);
        attempts.push(operation);
        void operation.catch(() => {});
        return operation;
      },
      async close() {
        try {
          await blocker.query(
            "select pg_advisory_unlock(hashtextextended(current_schema() || ':resources',0))",
          );
        } finally {
          blocker.release();
          // An assertion must not leave the operation or borrowed connection alive.
          await Promise.allSettled(attempts);
          await worker.db.destroy();
        }
      },
    };
  }
  it.each([
    ['world-select', false],
    ['world-select', true],
    ['properties', false],
    ['properties', true],
    ['player', false],
    ['player', true],
  ] as const)(
    'finishes %s with the global resource lock held and no reservation DELETE, rejected=%s',
    async (kind, rejected) => {
      const prepared = plan();
      const f = await fixture(
        'minecraft-content',
        kind === 'world-select'
          ? prepared
          : {
              minecraftContent: {
                combinationId: randomUUID(),
                backupBefore: false,
                command:
                  kind === 'properties'
                    ? { kind, changes: { motd: 'fixture' } }
                    : { kind, list: 'operators', action: 'add', name: 'Player' },
              },
            },
      );
      const write = vi.fn(async () => {});
      f.options.confirmAlreadyStopped = async () => true;
      await f.options.reserveInstallation?.(f.serverId, f.jobId, f.db);
      const reservation = await f.installationReservation();
      const blocked = await resourceBlockedWorker(f.jobId);
      f.options.processGameContent = async (context) => {
        if (!rejected) await context.effect('minecraft.text.fixture', write);
        if (rejected) throw new DomainError('conflict');
        return true;
      };
      try {
        // Statement-level protection also detects the otherwise empty generic DELETE.
        // Only this isolated worker is guarded; other fixture sessions are unaffected.
        await database.pool.query(`
          CREATE FUNCTION reject_selection_reservation_delete() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF current_setting('application_name', true) = 'isolated-selection-${f.jobId}' THEN
              RAISE EXCEPTION 'selection must not delete installation reservations';
            END IF;
            RETURN NULL;
          END $$;
          CREATE TRIGGER selection_reservation_delete BEFORE DELETE ON installation_reservations
            FOR EACH STATEMENT EXECUTE FUNCTION reject_selection_reservation_delete();
        `);
        expect(await blocked.run(f.options)).toBe(rejected ? 'failed' : 'succeeded');
        expect(write).toHaveBeenCalledTimes(rejected ? 0 : 1);
        expect(f.adapter.getResources).not.toHaveBeenCalled();
        expect(await f.installationReservation()).toEqual(reservation);
        expect((await f.server()).active_operation_id).toBeNull();
        expect(await f.operation()).toMatchObject({
          phase: rejected ? 'failed' : 'complete',
          lease_token: null,
          lease_until: null,
        });
        expect(
          await f.db
            .selectFrom('operation_jobs')
            .select(['state', 'error_code', 'completed_at'])
            .where('id', '=', f.jobId)
            .executeTakeFirstOrThrow(),
        ).toEqual({
          state: rejected ? 'failed' : 'succeeded',
          error_code: rejected ? 'conflict' : null,
          completed_at: f.now(),
        });
        expect(
          await f.db
            .selectFrom('job_steps')
            .select('step')
            .where('job_id', '=', f.jobId)
            .where('step', '=', `server.minecraft-content.${rejected ? 'failed' : 'complete'}`)
            .execute(),
        ).toHaveLength(1);
        expect(
          await f.db
            .selectFrom('job_outbox')
            .select('job_id')
            .where('job_id', '=', f.jobId)
            .execute(),
        ).toEqual([]);
      } finally {
        await blocked.close();
        await database.pool.query(`
          DROP TRIGGER IF EXISTS selection_reservation_delete ON installation_reservations;
          DROP FUNCTION IF EXISTS reject_selection_reservation_delete();
        `);
      }
    },
  );
  it.each([
    ['properties', 'offline'],
    ['properties', 'running'],
    ['properties', 'revoked'],
    ['properties', 'unavailable'],
    ['player', 'offline'],
    ['player', 'running'],
    ['player', 'revoked'],
    ['player', 'unavailable'],
  ] as const)(
    'dispatches %s only after one fresh process proof and final authority (%s)',
    async (kind, state) => {
      const f = await fixture('minecraft-content', {
        minecraftContent: {
          combinationId: randomUUID(),
          backupBefore: false,
          command:
            kind === 'properties'
              ? { kind, changes: { motd: 'fixture' } }
              : { kind, list: 'operators', action: 'add', name: 'Player' },
        },
      });
      const write = vi.fn(async () => {});
      let revoked = false;
      const order: string[] = [];
      f.options.authorizeIntent = vi.fn(async () => {});
      f.options.authorizeEffect = vi.fn(async () => {
        order.push('authorization');
        if (revoked) throw new DomainError('forbidden');
      });
      f.options.confirmAlreadyStopped = vi.fn(async (_server, _db, proof) => {
        order.push('physical');
        expect(await proof?.providerServer).toMatchObject({
          uuid: (await f.server()).pterodactyl_uuid,
        });
        revoked = state === 'revoked';
        if (state === 'unavailable') throw new DomainError('integration_unavailable');
        return state !== 'running';
      });
      f.options.processGameContent = async (context) => {
        expect(context.effectVerifiesStopped).toBe(true);
        await context.authorize();
        await context.effect('minecraft.text.fixture', write);
        return true;
      };
      expect(await f.run()).toBe(state === 'offline' ? 'succeeded' : 'failed');
      expect(f.options.confirmAlreadyStopped).toHaveBeenCalledTimes(1);
      expect(f.adapter.getResources).not.toHaveBeenCalled();
      expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(state === 'offline' ? 1 : 0);
      if (state === 'offline' || state === 'revoked')
        expect(order.slice(-2)).toEqual(['physical', 'authorization']);
      expect((await f.server()).active_operation_id).toBeNull();
    },
  );

  it('retains the global lock when a confirmed stop finishes and releases reservations', async () => {
    const f = await fixture('stop', { stopConfirmed: true });
    await f.prepareReservation();
    await f.options.reserveInstallation?.(f.serverId, f.jobId, f.db);
    await f.db
      .updateTable('server_operations')
      .set({ phase: 'power', effect_state: 'confirmed', effect_started_at: f.now() })
      .where('job_id', '=', f.jobId)
      .execute();
    f.options.confirmAlreadyStopped = vi.fn(async () => true);
    const compute = await f.reservation();
    const installation = await f.installationReservation();
    const blocked = await resourceBlockedWorker(f.jobId);
    try {
      // PostgreSQL bounds the lock wait; no elapsed-time assertion is needed.
      expect(await blocked.run(f.options)).toBe('waiting');
      expect(f.options.confirmAlreadyStopped).toHaveBeenCalledOnce();
      expect(await f.reservation()).toEqual(compute);
      expect(await f.installationReservation()).toEqual(installation);
      expect((await f.server()).active_operation_id).toBe(f.jobId);
      expect((await f.operation()).phase).toBe('power');
      expect(
        await f.db
          .selectFrom('operation_jobs')
          .select('completed_at')
          .where('id', '=', f.jobId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ completed_at: null });
    } finally {
      await blocked.close();
    }
    f.tick();
    expect(await f.run()).toBe('succeeded');
    expect(await f.reservation()).toBeUndefined();
    expect(await f.installationReservation()).toBeUndefined();
    expect((await f.server()).active_operation_id).toBeNull();
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(f.adapter.stopWithConfirmation).not.toHaveBeenCalled();
  });
  it('orders selection completion behind user locks before taking the server row', async () => {
    const f = await fixture('minecraft-content', plan());
    const ready = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const write = vi.fn(async () => {});
    f.options.confirmAlreadyStopped = async () => true;
    f.options.processGameContent = async (context) => {
      await context.effect('minecraft.text.fixture', write);
      // Earlier journal events also reference users. Hold the user only after
      // those commits, so the observed wait belongs to terminal completion.
      ready.resolve();
      await finish.promise;
      return true;
    };
    const blocker = await database.pool.connect();
    const applicationName = `isolated-selection-order-${f.jobId}`;
    const worker = createDatabase(process.env.NH_TEST_DATABASE_URL ?? '', {
      options: `-c search_path=${database.schema} -c lock_timeout=3000ms`,
      application_name: applicationName,
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    let selecting: ReturnType<typeof processServerOperation> | undefined;
    try {
      selecting = processServerOperation(worker.db, f.jobId, f.options);
      await Promise.race([
        ready.promise,
        selecting.then(() => {
          throw new Error('Selection ended before the completion barrier');
        }),
      ]);
      await blocker.query("BEGIN; SET LOCAL lock_timeout = '200ms'");
      // Match reconciliation's resource -> user -> server order in this schema.
      await blocker.query(
        "select pg_advisory_xact_lock(hashtextextended(current_schema() || ':resources',0))",
      );
      await blocker.query('select id from "user" where id = $1 for update', [f.ownerId]);
      const identity = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid');
      finish.resolve();
      await vi.waitFor(async () => {
        const waiting = await database.pool.query<{ blocked: boolean }>(
          `select exists (
            select 1 from pg_stat_activity
            where application_name = $1 and $2::int = any(pg_blocking_pids(pid))
          ) as blocked`,
          [applicationName, identity.rows[0]?.pid],
        );
        expect(waiting.rows[0]?.blocked).toBe(true);
      });
      expect((await f.server()).active_operation_id).toBe(f.jobId);
      expect(
        await f.db
          .selectFrom('operation_jobs')
          .select(['state', 'completed_at'])
          .where('id', '=', f.jobId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'running', completed_at: null });
      // A finish that took the server first would now fail with lock_timeout.
      const server = await blocker.query<{ id: string }>(
        'select id from managed_servers where id = $1 for update',
        [f.serverId],
      );
      expect(server.rows[0]?.id).toBe(f.serverId);
      await blocker.query('COMMIT');
      expect(await selecting).toBe('succeeded');
      expect(write).toHaveBeenCalledOnce();
      expect((await f.server()).active_operation_id).toBeNull();
      expect((await f.operation()).phase).toBe('complete');
    } finally {
      finish.resolve();
      try {
        await blocker.query('ROLLBACK');
      } finally {
        blocker.release();
        await selecting?.catch(() => {});
        await worker.db.destroy();
      }
    }
  });
  it.each([
    ['debug', false],
    ['debug', true],
    ['info', false],
  ] as const)('summarizes world-selection timing only at %s, failed=%s', async (level, fail) => {
    const f = await fixture('minecraft-content', plan());
    const records: LogRecord[] = [];
    f.options.logger = createLogger((record) => records.push(record), { level });
    f.options.authorizeIntent = async () => {};
    f.options.confirmAlreadyStopped = async () => true;
    f.options.processGameContent = async (context) => {
      expect(Boolean(context.timing)).toBe(level === 'debug');
      if (fail) throw new DomainError('conflict', 409, { privatePath: '/private/world' });
      await context.effect('minecraft.text.fixture', async () => {});
      return true;
    };
    expect(await f.run()).toBe(fail ? 'failed' : 'succeeded');
    const summaries = records.filter((record) => record.event === 'servers.world_selection_timing');
    expect(summaries).toHaveLength(level === 'debug' ? 1 : 0);
    if (level !== 'debug') return;
    const summary = summaries[0]?.data as {
      jobId: string;
      serverId: string;
      totalMs: number;
      spanGroups: { name: string }[][];
    };
    expect(summary).toMatchObject({ jobId: f.jobId, serverId: f.serverId });
    expect(summary.totalMs).toBeGreaterThanOrEqual(0);
    const names = summary.spanGroups.flat().map((span) => span.name);
    expect(names).toContain('lock.wait');
    expect(names).toContain('finish.transaction');
    expect(names).toContain('lease.release');
    if (!fail) expect(names).toContain('provider_effect');
    expect(JSON.stringify(summary)).not.toContain('/private/world');
    expect(JSON.stringify(summary)).not.toContain('minecraft.text.fixture');
  });
  it('keeps debug timing scoped to world selection and ignores a broken summary sink', async () => {
    const ordinary = await fixture('stop');
    const records: LogRecord[] = [];
    ordinary.options.logger = createLogger((record) => records.push(record), { level: 'debug' });
    ordinary.options.confirmAlreadyStopped = async () => true;
    await ordinary.run();
    expect(records.some((record) => record.event === 'servers.world_selection_timing')).toBe(false);
    const selected = await fixture('minecraft-content', plan());
    selected.options.logger = createLogger(
      (record) => {
        if (record.event === 'servers.world_selection_timing') throw new Error('sink unavailable');
      },
      { level: 'debug' },
    );
    selected.options.confirmAlreadyStopped = async () => true;
    selected.options.processGameContent = async () => true;
    expect(await selected.run()).toBe('succeeded');
  });
  it('selects in one delivery with shared identity, local read authorization and fresh physical stop proof', async () => {
    const f = await fixture('minecraft-content', plan());
    const write = vi.fn(async () => {});
    f.options.authorizeIntent = vi.fn(async () => {});
    f.options.authorizeEffect = vi.fn(async () => {});
    f.options.confirmAlreadyStopped = vi.fn(async (_server, _db, proof) => {
      expect(await proof?.providerServer).toMatchObject({ uuid: f.remote.uuid });
      return true;
    });
    f.options.processGameContent = async (context) => {
      for (let index = 0; index < 5; index++) await context.authorize();
      await context.effect('minecraft.text.fixture', write);
      return true;
    };
    expect(await f.run()).toBe('succeeded');
    expect(write).toHaveBeenCalledOnce();
    expect(f.adapter.getApplicationServer).toHaveBeenCalledOnce();
    expect(f.adapter.getResources).not.toHaveBeenCalled();
    expect(f.options.confirmAlreadyStopped).toHaveBeenCalledOnce();
    expect(f.options.authorizeEffect).not.toHaveBeenCalled();
    expect(f.options.authorizeIntent).toHaveBeenCalledTimes(6);
    expect((await f.operation()).plan.offlineSince).toBeUndefined();
  });
  it('rechecks revoked authority after an authorized selection read, before any write', async () => {
    const f = await fixture('minecraft-content', plan());
    let revoked = false;
    const write = vi.fn(async () => {});
    f.options.authorizeIntent = vi.fn(async () => {
      if (revoked) throw new DomainError('forbidden');
    });
    f.options.confirmAlreadyStopped = async () => true;
    f.options.processGameContent = async (context) => {
      await context.authorize();
      revoked = true;
      await context.effect('minecraft.text.fixture', write);
      return true;
    };
    expect(await f.run()).toBe('failed');
    expect(f.options.authorizeIntent).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    expect((await f.operation()).effect_state).toBe('none');
  });
  it.each(['world-select', 'properties', 'player'] as const)(
    'rolls back %s journal failures without inventing an uncertain external write',
    async (kind) => {
      const f = await fixture('minecraft-content', metadataPlan(kind));
      const write = vi.fn(async () => {});
      f.options.confirmAlreadyStopped = async () => true;
      f.options.processGameContent = async (context) => {
        await context.effect('minecraft.text.fixture', write);
        return true;
      };
      await database.pool.query(`
      CREATE FUNCTION fail_selection_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.message_key = 'servers.operation.effect_prepared' AND NEW.job_id = '${f.jobId}' THEN
          RAISE EXCEPTION 'isolated journal insertion failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER selection_journal_failure BEFORE INSERT ON server_events
        FOR EACH ROW EXECUTE FUNCTION fail_selection_journal();
    `);
      try {
        await f.run();
        expect(write).not.toHaveBeenCalled();
        const operation = await f.operation();
        expect(operation.effect_state).toBe('none');
        expect(operation.plan.waitReason).toBe('provider_unavailable');
        expect(operation.plan.effectAttempts).toBeUndefined();
      } finally {
        await database.pool.query(
          'DROP TRIGGER selection_journal_failure ON server_events; DROP FUNCTION fail_selection_journal();',
        );
      }
    },
  );
  it('checks host and process once after durable intent with one resource transaction', async () => {
    const f = await fixture('minecraft-content', plan());
    const order: string[] = [];
    const records: LogRecord[] = [];
    f.options.logger = createLogger((record) => records.push(record), { level: 'debug' });
    f.options.verifyObservationHost = vi.fn(async () => {});
    f.options.checkpoint = async (phase) => {
      if (phase === 'prepared') order.push('prepared');
    };
    f.options.confirmAlreadyStopped = vi.fn(async (_server, _db, proof) => {
      expect(proof?.observerPreflight).toBeUndefined();
      expect(await proof?.providerServer).toMatchObject({ uuid: f.remote.uuid });
      order.push('physical');
      return true;
    });
    f.options.processGameContent = async (context) => {
      order.push('read');
      await context.effect('minecraft.text.fixture', async () => {
        order.push('write');
      });
      return true;
    };
    expect(await f.run()).toBe('succeeded');
    expect(order).toEqual(['read', 'prepared', 'physical', 'write']);
    expect(f.options.verifyObservationHost).not.toHaveBeenCalled();
    expect(f.options.confirmAlreadyStopped).toHaveBeenCalledOnce();
    const summary = records.find((record) => record.event === 'servers.world_selection_timing')
      ?.data as { stages: Record<string, { count: number }> };
    expect(summary.stages['effect.resourceLock']).toBeUndefined();
    expect(summary.stages['stop.final']?.count).toBe(1);
    expect(summary.stages['stop.initial']).toBeUndefined();
  });
  it.each(
    (['world-select', 'properties', 'player'] as const).flatMap((action) =>
      (
        [
          ['upload', 'read'],
          ['installation', 'read'],
          ['compute', 'read'],
          ['upload', 'prepared'],
          ['installation', 'prepared'],
          ['compute', 'prepared'],
        ] as const
      ).map(([kind, phase]) => ({ action, kind, phase })),
    ),
  )(
    'refuses $action when a $kind reservation appears at $phase',
    async ({ action, kind, phase }) => {
      const f = await fixture('minecraft-content', metadataPlan(action));
      const other = kind === 'installation' ? await fixture('minecraft-content') : undefined;
      const write = vi.fn(async () => {});
      const reserve = async () => {
        if (kind === 'upload') await pendingUploadFixture(f.db, f.serverId);
        else if (kind === 'compute') await f.prepareReservation();
        else
          await f.db
            .insertInto('installation_reservations')
            .values({
              server_id: f.serverId,
              physical_host_id: f.hostId,
              operation_id: other?.jobId ?? f.jobId,
              memory_mib: 1178,
              cpu_percent: 100,
            })
            .execute();
      };
      f.options.confirmAlreadyStopped = vi.fn(async () => true);
      f.options.checkpoint = async (checkpoint) => {
        if (phase === 'prepared' && checkpoint === 'prepared') await reserve();
      };
      f.options.processGameContent = async (context) => {
        if (phase === 'read') await reserve();
        await context.effect('minecraft.text.fixture', write);
        return true;
      };
      expect(await f.run()).toBe('failed');
      expect(write).not.toHaveBeenCalled();
      expect((await f.operation()).effect_state).toBe('none');
      expect((await f.server()).active_operation_id).toBeNull();
      expect(f.options.confirmAlreadyStopped).not.toHaveBeenCalled();
    },
  );
  it.each(['running', 'missing observer'] as const)(
    'does not trust cached offline state when %s',
    async (state) => {
      const f = await fixture('minecraft-content', plan());
      await f.db
        .updateTable('managed_servers')
        .set({ runtime_state: 'offline' })
        .where('id', '=', f.serverId)
        .execute();
      if (state === 'running') f.options.confirmAlreadyStopped = vi.fn(async () => false);
      const write = vi.fn(async () => {});
      f.options.processGameContent = vi.fn(async (context) => {
        await context.effect('minecraft.text.fixture', write);
        return true;
      });
      expect(await f.run()).toBe('failed');
      expect(f.options.processGameContent).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect((await f.server()).active_operation_id).toBeNull();
      expect(f.adapter.getResources).not.toHaveBeenCalled();
    },
  );
  it('does not select while a compute reservation remains', async () => {
    const f = await fixture('minecraft-content', plan());
    await f.prepareReservation();
    f.options.confirmAlreadyStopped = vi.fn(async () => true);
    const write = vi.fn(async () => {});
    f.options.processGameContent = vi.fn(async (context) => {
      await context.effect('minecraft.text.fixture', write);
      return true;
    });
    expect(await f.run()).toBe('failed');
    expect(f.options.processGameContent).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(f.options.confirmAlreadyStopped).not.toHaveBeenCalled();
  });
  it.each(['absent directory', 'deleted during read'] as const)(
    'releases a stale selection without writes when its target is %s',
    async (missing) => {
      const f = await fixture('minecraft-content', plan());
      const write = vi.fn(async () => {});
      f.options.confirmAlreadyStopped = vi.fn(async () => true);
      f.options.processGameContent = async (context) => {
        if (missing === 'absent directory') {
          const files = await context.adapter.listFiles(
            context.server.pterodactyl_identifier ?? '',
          );
          if (!files.some((file) => file.name === 'selected_world'))
            throw new DomainError('not_found');
        } else throw new PterodactylError('not_found', 'client', 'rejected', 404);
        await context.effect('minecraft.text.fixture', write);
        return true;
      };
      expect(await f.run()).toBe('failed');
      expect(write).not.toHaveBeenCalled();
      expect((await f.server()).active_operation_id).toBeNull();
      expect((await f.operation()).effect_state).toBe('none');
      expect(
        await f.db
          .selectFrom('operation_jobs')
          .select(['state', 'error_code'])
          .where('id', '=', f.jobId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'failed', error_code: 'not_found' });
    },
  );
  it.each(['process restarted', 'permission revoked', 'provider replaced'] as const)(
    'refuses world selection when %s after preparation',
    async (change) => {
      const f = await fixture('minecraft-content', plan());
      let changed = false;
      const write = vi.fn(async () => {});
      f.options.confirmAlreadyStopped = vi.fn(
        async () => change !== 'process restarted' || !changed,
      );
      f.options.authorizeIntent = async () => {
        if (change === 'permission revoked' && changed) throw new DomainError('forbidden');
      };
      f.options.checkpoint = async (phase) => {
        if (phase !== 'prepared') return;
        changed = true;
        if (change === 'provider replaced') {
          f.tick(60_000);
          f.remote.uuid = randomUUID();
        }
      };
      f.options.processGameContent = async (context) => {
        await context.effect('minecraft.text.fixture', write);
        return true;
      };
      expect(await f.run()).toBe('failed');
      expect(write).not.toHaveBeenCalled();
      expect((await f.operation()).effect_state).toBe('none');
    },
  );
});

describe('additive Minecraft world imports', () => {
  const plan = () => ({
    minecraftContent: {
      combinationId: randomUUID(),
      command: { kind: 'world-import', archiveRef: randomUUID(), targetWorld: 'new_world' },
      world: { existing: false, dataVersion: 3955 },
      backupBefore: false,
      deletePaths: [],
    },
  });
  it('runs the content effect while online without releasing compute or changing power', async () => {
    const f = await fixture('minecraft-content', plan());
    f.options.supportsManagedFileOperations = vi.fn(async () => true);
    f.setState('running');
    await f.db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running' })
      .where('id', '=', f.serverId)
      .execute();
    await f.options.reserveStart?.(f.serverId, f.jobId, 'start', f.db);
    await f.db
      .updateTable('resource_reservations')
      .set({ state: 'running' })
      .where('server_id', '=', f.serverId)
      .execute();
    const write = vi.fn(async () => {});
    f.options.processGameContent = vi.fn(async (context) => {
      await context.effect('minecraft.import.fixture', write);
      return true;
    });
    expect(await f.run()).toBe('succeeded');
    expect(write).toHaveBeenCalledOnce();
    expect((await f.server()).runtime_state).toBe('running');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('state')
        .where('server_id', '=', f.serverId)
        .executeTakeFirst(),
    ).toEqual({ state: 'running' });
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(f.adapter.getApplicationServer).toHaveBeenCalledOnce();
    expect(f.options.supportsManagedFileOperations).not.toHaveBeenCalled();
  });
  it('refreshes the delivery identity when world preparation takes a minute', async () => {
    const f = await fixture('minecraft-content', plan());
    const write = vi.fn(async () => {});
    f.options.processGameContent = async (context) => {
      f.tick(60_000);
      await context.effect('minecraft.import.fixture', write);
      return true;
    };
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
  });
  it('rejects an expired proof that changes after durable preparation without dispatching', async () => {
    const f = await fixture('minecraft-content', plan());
    const write = vi.fn(async () => {});
    f.options.checkpoint = async (phase) => {
      if (phase !== 'prepared') return;
      f.tick(60_000);
      f.remote.uuid = randomUUID();
    };
    f.options.processGameContent = async (context) => {
      await context.effect('minecraft.import.fixture', write);
      return true;
    };
    expect(await f.run()).toBe('failed');
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    expect((await f.operation()).effect_state).toBe('none');
  });
  it.each(['revocation', 'uuid', 'mapping', 'allocation'] as const)(
    'rejects local %s changes after durable preparation while reusing remote identity',
    async (change) => {
      const f = await fixture('minecraft-content', plan());
      const write = vi.fn(async () => {});
      let revoked = false;
      f.options.authorizeIntent = async () => {
        if (revoked) throw new DomainError('forbidden');
      };
      f.options.checkpoint = async (phase) => {
        if (phase !== 'prepared') return;
        if (change === 'revocation') revoked = true;
        else if (change === 'uuid')
          await f.db
            .updateTable('managed_servers')
            .set({ pterodactyl_uuid: randomUUID() })
            .where('id', '=', f.serverId)
            .execute();
        else if (change === 'allocation')
          await f.db.deleteFrom('server_allocations').where('server_id', '=', f.serverId).execute();
        else {
          const previous = await f.db
            .selectFrom('runtime_egg_mappings')
            .selectAll()
            .where('id', '=', (await f.server()).mapping_id)
            .executeTakeFirstOrThrow();
          const replacement = randomUUID();
          await f.db
            .insertInto('runtime_egg_mappings')
            .values({
              ...previous,
              id: replacement,
              runtime_id: 'replacement-fixture',
              environment: JSON.stringify(previous.environment),
              port_roles: JSON.stringify(previous.port_roles),
              feature_limits: JSON.stringify(previous.feature_limits),
            })
            .execute();
          await f.db
            .updateTable('managed_servers')
            .set({ mapping_id: replacement })
            .where('id', '=', f.serverId)
            .execute();
        }
      };
      f.options.processGameContent = async (context) => {
        await context.effect('minecraft.import.fixture', write);
        return true;
      };
      expect(await f.run()).toBe('failed');
      expect(f.adapter.getApplicationServer).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect((await f.operation()).effect_state).toBe('none');
    },
  );
  it('takes a new identity proof on another delivery even inside the reuse window', async () => {
    const f = await fixture('minecraft-content', plan());
    const write = vi.fn(async () => {});
    f.options.processGameContent = vi
      .fn<NonNullable<LifecycleOptions['processGameContent']>>()
      .mockResolvedValueOnce(false)
      .mockImplementation(async (context) => {
        await context.effect('minecraft.import.fixture', write);
        return true;
      });
    expect(await f.run()).toBe('waiting');
    f.tick(5_000);
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
  });
  it('imports an inactive folder during a power transition without reading process telemetry', async () => {
    const f = await fixture('minecraft-content', plan());
    f.setState('starting');
    f.options.processGameContent = vi.fn(async () => true);
    expect(await f.run()).toBe('succeeded');
    expect(f.options.processGameContent).toHaveBeenCalledOnce();
    expect(f.adapter.getResources).not.toHaveBeenCalled();
    expect(f.adapter.power).not.toHaveBeenCalled();
  });
  it('keeps existing-world replacement behind quiescence even with a running reservation', async () => {
    const prepared = plan();
    prepared.minecraftContent.world.existing = true;
    const f = await fixture('minecraft-content', prepared);
    f.setState('running');
    await f.options.reserveStart?.(f.serverId, f.jobId, 'start', f.db);
    f.options.processGameContent = vi.fn(async () => true);
    await f.run();
    expect(f.options.processGameContent).not.toHaveBeenCalled();
  });
});

describe('inactive Minecraft world removal', () => {
  const plan = (backupBefore = false) => ({
    minecraftContent: {
      combinationId: randomUUID(),
      command: { kind: 'world-remove', world: 'unused_world', confirm: true, backupBefore },
      world: { existing: true },
      backupBefore,
    },
  });
  function guardedBridge(f: Awaited<ReturnType<typeof fixture>>) {
    const identity = {
      providerId: f.remote.id,
      providerUuid: f.remote.uuid,
      identifier: f.remote.identifier,
      externalId: f.remote.external_id as string,
      nodeId: f.remote.node,
    };
    const snapshot = {
      identity,
      target: { path: 'unused_world', observation: 'a'.repeat(64) },
      guard: { path: 'server.properties', sha256: 'b'.repeat(64), contents: 'level-name=world\n' },
    };
    const adapter = Object.assign(f.adapter, {
      getFileOperationCapabilities: vi.fn(async () => ({
        inspection: true,
        guardedDelete: true,
        archiveCommit: true,
      })),
      inspectFileOperation: vi.fn(async () => structuredClone(snapshot)),
      guardedDeleteDirectory: vi.fn(
        async (_identifier: string, request: GuardedDirectoryDelete) => ({
          operationId: request.operationId,
          state: 'confirmed' as const,
          identity: request.identity,
          target: request.target,
        }),
      ),
    });
    f.options.supportsManagedFileOperations = vi.fn(async () => true);
    f.options.fileman = (context) => ({
      removeDirectory: (input) => removeFilemanDirectory(context, input),
      uploadStaged: vi.fn(),
    });
    f.options.processGameContent = (context) =>
      applyMinecraftWorldRemoval(context, 'unused_world', { backupBefore: false });
    return { snapshot, adapter };
  }

  it.each(['running', 'offline'] as const)(
    'confirms guarded removal while %s without an Application identity request',
    async (state) => {
      const f = await fixture('minecraft-content', plan());
      const bridge = guardedBridge(f);
      f.setState(state);
      await f.db
        .updateTable('managed_servers')
        .set({ runtime_state: state })
        .where('id', '=', f.serverId)
        .execute();
      expect(await f.run()).toBe('succeeded');
      expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
      expect(f.adapter.getResources).not.toHaveBeenCalled();
      expect(f.adapter.listFiles).not.toHaveBeenCalled();
      expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect(bridge.adapter.inspectFileOperation).toHaveBeenCalledExactlyOnceWith(
        f.remote.identifier,
        {
          target: 'unused_world',
          guardFile: 'server.properties',
        },
      );
      expect(bridge.adapter.guardedDeleteDirectory).toHaveBeenCalledOnce();
      expect((await f.operation()).effect_state).toBe('confirmed');
      expect((await f.server()).runtime_state).toBe(state);
    },
  );

  it('keeps Application identity verification when the guarded capability is unavailable', async () => {
    const f = await fixture('minecraft-content', plan());
    f.options.supportsManagedFileOperations = vi.fn(async () => false);
    f.options.processGameContent = async (context) => {
      await context.effect('minecraft.remove.fixture', () =>
        context.adapter.deleteFiles(f.remote.identifier, '', ['unused_world']),
      );
      return true;
    };
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.getApplicationServer).toHaveBeenCalledOnce();
    expect(f.adapter.deleteFiles).toHaveBeenCalledOnce();
  });

  function legacyBridgeFallback(
    f: Awaited<ReturnType<typeof fixture>>,
    fallback: 'missing Fileman' | 'expired capability',
  ) {
    const bridge = guardedBridge(f);
    if (fallback === 'missing Fileman') f.options.fileman = undefined;
    else
      bridge.adapter.getFileOperationCapabilities.mockRejectedValue(
        new PterodactylError('not_found', 'client', 'rejected', 404),
      );
    f.adapter.listFiles.mockImplementation(async () =>
      ['server.properties', 'unused_world'].map((name) => ({
        name,
        mode: name === 'server.properties' ? '-rw' : 'drw',
        size: 17,
        is_file: name === 'server.properties',
        is_symlink: false,
        mimetype: 'text/plain',
        created_at: f.now().toISOString(),
        modified_at: f.now().toISOString(),
      })),
    );
    Object.assign(f.adapter, {
      readFileForEditor: vi.fn(async () => Buffer.from('level-name=world\n')),
      prefetchDownloads: vi.fn(async () => {}),
    });
    return bridge;
  }

  it.each(['missing Fileman', 'expired capability'] as const)(
    'verifies Application identity before a legacy effect after %s',
    async (fallback) => {
      const f = await fixture('minecraft-content', plan());
      const bridge = legacyBridgeFallback(f, fallback);
      expect(await f.run()).toBe('succeeded');
      expect(f.options.supportsManagedFileOperations).toHaveBeenCalledOnce();
      expect(f.adapter.getApplicationServer).toHaveBeenCalledOnce();
      expect(f.adapter.deleteFiles).toHaveBeenCalledExactlyOnceWith(f.remote.identifier, '', [
        'unused_world',
      ]);
      expect(bridge.adapter.inspectFileOperation).not.toHaveBeenCalled();
      expect(bridge.adapter.guardedDeleteDirectory).not.toHaveBeenCalled();
      expect((await f.operation()).effect_state).toBe('confirmed');
    },
  );

  it.each(['missing Fileman', 'expired capability'] as const)(
    'rejects a foreign provider before a legacy effect after %s',
    async (fallback) => {
      const f = await fixture('minecraft-content', plan());
      const bridge = legacyBridgeFallback(f, fallback);
      f.remote.uuid = randomUUID();
      expect(await f.run()).toBe('failed');
      expect(f.adapter.getApplicationServer).toHaveBeenCalledOnce();
      expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
      expect(bridge.adapter.guardedDeleteDirectory).not.toHaveBeenCalled();
      expect((await f.operation()).effect_state).toBe('none');
    },
  );

  it('refreshes legacy fallback identity after durable preparation when its proof expires', async () => {
    const f = await fixture('minecraft-content', plan());
    const bridge = legacyBridgeFallback(f, 'missing Fileman');
    f.options.checkpoint = async (phase) => {
      if (phase !== 'prepared') return;
      f.tick(60_000);
      f.remote.uuid = randomUUID();
    };
    expect(await f.run()).toBe('failed');
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(2);
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
    expect(bridge.adapter.guardedDeleteDirectory).not.toHaveBeenCalled();
    expect((await f.operation()).effect_state).toBe('none');
  });

  it.each(['uuid', 'identifier', 'externalId', 'providerUser', 'mapping', 'revocation'] as const)(
    'blocks guarded dispatch when local %s changes after durable preparation',
    async (change) => {
      const f = await fixture('minecraft-content', plan());
      const bridge = guardedBridge(f);
      let revoked = false;
      f.options.authorizeIntent = async () => {
        if (revoked) throw new DomainError('forbidden');
      };
      f.options.checkpoint = async (phase) => {
        if (phase !== 'prepared') return;
        if (change === 'revocation') {
          revoked = true;
          return;
        }
        if (change === 'mapping') {
          const previous = await f.db
            .selectFrom('runtime_egg_mappings')
            .selectAll()
            .where('id', '=', (await f.server()).mapping_id)
            .executeTakeFirstOrThrow();
          const replacement = randomUUID();
          await f.db
            .insertInto('runtime_egg_mappings')
            .values({
              ...previous,
              id: replacement,
              runtime_id: 'guarded-replacement',
              environment: JSON.stringify(previous.environment),
              port_roles: JSON.stringify(previous.port_roles),
              feature_limits: JSON.stringify(previous.feature_limits),
            })
            .execute();
          await f.db
            .updateTable('managed_servers')
            .set({ mapping_id: replacement })
            .where('id', '=', f.serverId)
            .execute();
          return;
        }
        const patch =
          change === 'uuid'
            ? { pterodactyl_uuid: randomUUID() }
            : change === 'identifier'
              ? { pterodactyl_identifier: 'changed' }
              : change === 'externalId'
                ? { external_id: `nh:${randomUUID()}` }
                : { provider_user_id: 999999 };
        await f.db.updateTable('managed_servers').set(patch).where('id', '=', f.serverId).execute();
      };
      expect(await f.run()).toBe('failed');
      expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
      expect(bridge.adapter.inspectFileOperation).toHaveBeenCalledOnce();
      expect(bridge.adapter.guardedDeleteDirectory).not.toHaveBeenCalled();
      expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
      expect((await f.operation()).effect_state).toBe('none');
    },
  );

  it('rejects a foreign inspection before a guarded effect without an Application lookup', async () => {
    const f = await fixture('minecraft-content', plan());
    const bridge = guardedBridge(f);
    bridge.snapshot.identity.providerUuid = randomUUID();
    expect(await f.run()).toBe('failed');
    expect(bridge.adapter.guardedDeleteDirectory).not.toHaveBeenCalled();
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    expect((await f.operation()).effect_state).toBe('none');
  });

  it('rejects an inspected active world before a guarded effect', async () => {
    const f = await fixture('minecraft-content', plan());
    const bridge = guardedBridge(f);
    bridge.snapshot.guard.contents = 'level-name=unused_world\n';
    expect(await f.run()).toBe('failed');
    expect(bridge.adapter.guardedDeleteDirectory).not.toHaveBeenCalled();
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    expect((await f.operation()).effect_state).toBe('none');
  });

  it.each(['running', 'offline'] as const)(
    'deletes in one delivery while %s without telemetry, offline settling or duplicate identity reads',
    async (state) => {
      const f = await fixture('minecraft-content', plan());
      f.setState(state);
      await f.db
        .updateTable('managed_servers')
        .set({ runtime_state: state })
        .where('id', '=', f.serverId)
        .execute();
      if (state === 'running') {
        await f.prepareReservation();
        await f.db
          .updateTable('resource_reservations')
          .set({ state: 'running' })
          .where('server_id', '=', f.serverId)
          .execute();
      }
      f.options.confirmAlreadyStopped = vi.fn(async () => false);
      f.options.authorizeIntent = vi.fn(async () => {});
      f.options.processGameContent = async (context) => {
        await context.authorize();
        await context.effect('minecraft.remove.fixture', () =>
          context.adapter.deleteFiles(context.server.pterodactyl_identifier ?? '', '', [
            'unused_world',
          ]),
        );
        return true;
      };
      expect(await f.run()).toBe('succeeded');
      expect(f.adapter.getApplicationServer).toHaveBeenCalledOnce();
      expect(f.adapter.getResources).not.toHaveBeenCalled();
      expect(f.options.confirmAlreadyStopped).not.toHaveBeenCalled();
      expect(f.adapter.deleteFiles).toHaveBeenCalledOnce();
      expect(f.adapter.power).not.toHaveBeenCalled();
      expect((await f.server()).runtime_state).toBe(state);
      expect((await f.operation()).effect_state).toBe('confirmed');
      expect((await f.operation()).plan.offlineSince).toBeUndefined();
      if (state === 'running') expect((await f.reservation())?.state).toBe('running');
    },
  );
  it('keeps requested backup and replacement workflows behind offline confirmation', async () => {
    const f = await fixture('minecraft-content', plan(true));
    f.options.supportsManagedFileOperations = vi.fn(async () => true);
    f.setState('running');
    f.options.processGameContent = vi.fn(async () => true);
    expect(await f.run()).toBe('waiting');
    expect(f.options.processGameContent).not.toHaveBeenCalled();
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
    expect(f.options.supportsManagedFileOperations).not.toHaveBeenCalled();
  });
  it('rejects a foreign provider identity before reading or removing a world', async () => {
    const f = await fixture('minecraft-content', plan());
    f.remote.uuid = randomUUID();
    f.options.processGameContent = vi.fn(async () => true);
    await f.run();
    expect(f.options.processGameContent).not.toHaveBeenCalled();
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
  });
  it('rechecks revocation after durable preparation without marking an undispatched delete uncertain', async () => {
    const f = await fixture('minecraft-content', plan());
    let revoked = false;
    f.options.checkpoint = async (phase) => {
      if (phase === 'prepared') revoked = true;
    };
    f.options.authorizeIntent = async () => {
      if (revoked) throw new DomainError('forbidden');
    };
    f.options.processGameContent = async (context) => {
      await context.effect('minecraft.remove.fixture', () =>
        context.adapter.deleteFiles(context.server.pterodactyl_identifier ?? '', '', [
          'unused_world',
        ]),
      );
      return true;
    };
    expect(await f.run()).toBe('failed');
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
    expect((await f.operation()).effect_state).toBe('none');
  });
});
