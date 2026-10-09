import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createDatabase, type Database } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { commandDigest, enqueueCommand } from '@nickhosting/jobs';
import {
  type ApplicationServer,
  type Backup,
  type BuildUpdate,
  type PterodactylAdapter,
  PterodactylError,
  type Resources,
} from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type LifecycleOptions,
  processServerOperation,
  reconcileManagedServer,
} from './lifecycle.js';

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
) {
  const db = database.db;
  const ownerId = randomUUID(),
    hostId = randomUUID(),
    nodeId = randomUUID(),
    mappingId = randomUUID(),
    serverId = randomUUID(),
    jobId = randomUUID();
  const providerId = ++providerSequence;
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
        data: [{ attributes: { id: providerId, ip: '127.0.0.1', port: 25000, assigned: true } }],
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
  const adapter = {
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
    reinstall: vi.fn(async () => {}),
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
      address: '127.0.0.1',
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
    setState(value: Resources['current_state']) {
      state = value;
    },
    setExists(value: boolean) {
      exists = value;
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
  it('retains stopping reservations through the provider resource cache interval', async () => {
    const f = await fixture('stop');
    await f.prepareReservation();
    f.setState('running');
    expect(await f.run()).toBe('waiting');
    f.tick(5_000);
    expect(await f.run()).toBe('waiting');
    expect(await f.reservation()).toBeDefined();
    f.tick(17_000);
    expect(await f.run()).toBe('succeeded');
    expect(await f.reservation()).toBeUndefined();
    expect((await f.server()).intent).toBe('manually_stopped');
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
  it('refuses every mutation when a pinned identity or allocation changes', async () => {
    for (const mismatch of ['uuid', 'user', 'allocation', 'allocations'] as const) {
      const f = await fixture('delete');
      if (mismatch === 'uuid') f.remote.uuid = randomUUID();
      else if (mismatch === 'user') f.remote.user = 99;
      else if (mismatch === 'allocation') f.remote.allocation += 1;
      else f.remote.relationships = {};
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
  it('never repeats uncertain reinstall without an observed installation transition', async () => {
    const f = await fixture('reinstall');
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
    expect(await f.run()).toBe('succeeded');
    expect(f.adapter.reinstall).toHaveBeenCalledTimes(1);
  });
  it('confirms lost deletion response via pinned remote absence, releasing allocations atomically', async () => {
    const f = await fixture('delete');
    await f.prepareReservation();
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
    expect(f.adapter.power).not.toHaveBeenCalled();
    expect(await reconcileManagedServer(f.db, randomUUID(), f.options)).toBe('deferred');
    f.setState('offline');
    f.tick(5_000);
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect(await f.reservation()).toBeDefined();
    f.tick(22_000);
    await reconcileManagedServer(f.db, f.serverId, f.options);
    expect(await f.reservation()).toBeUndefined();
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
});
