import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { authSessionId } from '@nickhosting/core';
import {
  createDatabase,
  listenForGatewayChanges,
  listenForJobOutbox,
  notifyGatewayChange,
  notifyJobOutbox,
  updateSettings,
} from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import type {
  ApplicationServer,
  PterodactylAdapter,
  Resources,
} from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reserveStart } from './admission.js';
import { trustedGameModules } from './game-modules.js';
import {
  type GatewayObservation,
  type GatewayOrchestrationOptions,
  type GatewayPolicy,
  getGatewayState,
  reconcileGatewayState,
  reportGatewayObservation,
  reportGatewayProviderRunning,
  requestGatewayWake,
  setGatewayPolicy,
} from './gateway-orchestration.js';
import { getGatewaySnapshot, requireGatewayRoute, setGatewayRoute } from './gateway-registry.js';
import {
  type LifecycleOptions,
  processServerOperation,
  reconcileManagedServer,
} from './lifecycle.js';
import { getPlatformSleepPolicy } from './platform-queries.js';
import { enqueueServerOperation } from './registry.js';
import { authorizeQueuedEffect } from './runtime.js';
import { getGameSleepPolicy, resolveIdleTimeout, setGameSleepPolicy } from './sleep-policy.js';
import { managementFixture, pendingUploadFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
let clock: Date;
const options = { now: () => clock };
const policy: GatewayPolicy = {
  enabled: true,
  protocolId: 'isolated-fixture',
  gameVersion: '1',
  idleTimeoutSeconds: 10,
  readinessTimeoutSeconds: 60,
  readinessMaxAgeSeconds: 15,
  estimateMaxAgeSeconds: 86400,
  wakeRetrySeconds: 10,
  mode: 'auto',
};
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  serverId = await f.server();
  clock = new Date(Date.now() + 100);
});
afterAll(async () => {
  await database?.destroy();
});
const advance = (milliseconds: number) => {
  clock = new Date(clock.getTime() + milliseconds);
};
async function configure(patch: Partial<GatewayPolicy> = {}) {
  return setGatewayPolicy(f.db, f.context, serverId, { ...policy, ...patch }, options);
}
async function wake() {
  const state = await getGatewayState(f.db, serverId, options);
  return requestGatewayWake(
    f.db,
    serverId,
    { generation: state.generation, intent: 'join' },
    options,
  );
}
async function row() {
  return f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
}
async function lifecycleFixture() {
  const server = await row();
  if (server.provider_user_id === null) throw new Error('Missing fixture provider account');
  const allocations = await f.db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .execute();
  let runtime: Resources['current_state'] = 'offline';
  let processStart: string | null = null;
  const remote: ApplicationServer = {
    id: server.pterodactyl_id ?? 0,
    uuid: server.pterodactyl_uuid ?? '',
    external_id: server.external_id,
    identifier: server.pterodactyl_identifier ?? '',
    name: 'fixture',
    description: '',
    suspended: false,
    limits: server.limits,
    feature_limits: { databases: 0, allocations: 3, backups: 1 },
    user: server.provider_user_id,
    node: f.providerNodeId,
    allocation: allocations.find((a) => a.is_primary)?.pterodactyl_allocation_id ?? 0,
    nest: 1,
    egg: 1,
    status: null,
    container: { startup_command: 'fixture', image: 'fixture/image:1', installed: true },
    relationships: {
      allocations: {
        object: 'list',
        data: allocations.map((allocation) => ({
          attributes: {
            id: allocation.pterodactyl_allocation_id,
            ip: allocation.address,
            port: allocation.port,
            assigned: true,
          },
        })),
      },
    },
    created_at: clock.toISOString(),
    updated_at: clock.toISOString(),
  };
  const power = vi.fn(async () => {
    advance(1);
    processStart = clock.toISOString();
    runtime = 'running';
  });
  const stop = vi.fn(
    async (
      _id: number,
      _identifier: string,
      callbacks: {
        authorize: () => Promise<boolean>;
        beforePower?: () => Promise<void>;
        onConfirmed: () => Promise<void>;
      },
    ) => {
      if (!(await callbacks.authorize())) throw new Error('stop refused');
      await callbacks.beforePower?.();
      runtime = 'offline';
      processStart = null;
      await callbacks.onConfirmed();
      return { confirmed: true };
    },
  );
  const adapter = {
    getApplicationServer: vi.fn(async () => structuredClone(remote)),
    getResources: vi.fn(
      async (): Promise<Resources> => ({
        current_state: runtime,
        is_suspended: false,
        resources: {
          memory_bytes: 0,
          cpu_absolute: 0,
          disk_bytes: 0,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
          uptime: runtime === 'running' ? 10 : 0,
        },
      }),
    ),
    power,
    stopWithConfirmation: stop,
  } as unknown as PterodactylAdapter;
  const lifecycle: LifecycleOptions = {
    adapter,
    now: () => clock,
    settleMs: 0,
    authorizeEffect: async (jobId, id, db) => {
      await authorizeQueuedEffect(db, jobId, id);
    },
    reserveStart: (id, jobId, action, db) => reserveStart(db, id, jobId, action),
    observeProcessStart: async () => processStart,
    confirmAlreadyStopped: async () => runtime === 'offline',
  };
  const process = async (jobId: string) => {
    await f.db
      .updateTable('operation_jobs')
      .set({ next_attempt_at: new Date(0) })
      .where('id', '=', jobId)
      .execute();
    return processServerOperation(f.db, jobId, lifecycle);
  };
  return { lifecycle, process, power, stop, processStartedAt: () => processStart };
}
async function started() {
  await configure();
  const fixture = await lifecycleFixture();
  const state = await wake();
  expect(state.state).toBe('waking');
  expect(await fixture.process(state.wakeJobId ?? '')).toBe('waiting');
  advance(1000);
  expect(await fixture.process(state.wakeJobId ?? '')).toBe('succeeded');
  return { ...fixture, state };
}
async function report(
  fixture: Awaited<ReturnType<typeof started>>,
  patch: Partial<GatewayObservation> = {},
  extra: Partial<GatewayOrchestrationOptions> = {},
) {
  return reportGatewayObservation(
    f.db,
    serverId,
    {
      generation: fixture.state.generation,
      wakeJobId: fixture.state.wakeJobId,
      observedAt: clock.toISOString(),
      processStartedAt: fixture.processStartedAt(),
      ready: true,
      activeSessions: 0,
      idle: true,
      playerCount: 0,
      quiescenceUntil: new Date(clock.getTime() + 15000).toISOString(),
      ...patch,
    },
    { ...options, ...extra },
  );
}

describe('durable Gateway sleep/wake using M2 admission and lifecycle', () => {
  it('migrates legacy positive and NULL timeouts to independent Owner authority without enabling sleep', async () => {
    await configure();
    const migration20 = await readFile(
      new URL('../../database/migrations/020_sleep_policy_inheritance.sql', import.meta.url),
      'utf8',
    );
    const migration21 = await readFile(
      new URL('../../database/migrations/021_sleep_policy_owner_controls.sql', import.meta.url),
      'utf8',
    );
    await expect(
      f.db.transaction().execute(async (tx) => {
        await sql`alter table gateway_server_states drop column owner_idle_timeout_seconds, drop column owner_idle_timeout_user_access, drop column idle_timeout_inherited`.execute(
          tx,
        );
        await sql.raw(migration20).execute(tx);
        expect(
          (
            await tx
              .selectFrom('gateway_server_states')
              .selectAll()
              .where('server_id', '=', serverId)
              .executeTakeFirstOrThrow()
          ).idle_timeout_inherited,
        ).toBe(false);
        // Exercise both historical representations within this rolled-back fixture transaction.
        await sql.raw(migration21).execute(tx);
        expect(
          await tx
            .selectFrom('gateway_server_states')
            .selectAll()
            .where('server_id', '=', serverId)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({
          owner_idle_timeout_seconds: 10,
          idle_timeout_seconds: null,
          idle_timeout_inherited: true,
        });
        await sql`alter table gateway_server_states drop column owner_idle_timeout_seconds, drop column owner_idle_timeout_user_access`.execute(
          tx,
        );
        await tx
          .updateTable('gateway_server_states')
          .set({ idle_timeout_seconds: null, idle_timeout_inherited: false })
          .where('server_id', '=', serverId)
          .execute();
        await sql.raw(migration21).execute(tx);
        expect(
          await tx
            .selectFrom('gateway_server_states')
            .selectAll()
            .where('server_id', '=', serverId)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({
          owner_idle_timeout_seconds: -1,
          idle_timeout_seconds: null,
          idle_timeout_inherited: true,
        });
        throw new Error('rollback isolated migration fixture');
      }),
    ).rejects.toThrow('rollback isolated migration fixture');
  });

  it('enforces hidden and shorten-only access against direct API policy changes and clamps old preferences', async () => {
    await updateSettings(f.db, f.owner, {
      defaultIdleTimeoutSeconds: 60,
      idleTimeoutUserAccess: 'hidden',
    });
    await setGatewayPolicy(
      f.db,
      f.owner,
      serverId,
      { ...policy, idleTimeoutSeconds: null, idleTimeoutInherited: true },
      options,
    );
    expect((await getPlatformSleepPolicy(f.db, f.context, serverId)).idleTimeout).toBeNull();
    expect((await getPlatformSleepPolicy(f.db, f.context, serverId)).policy).not.toHaveProperty(
      'idleTimeoutSeconds',
    );
    await expect(configure({ idleTimeoutSeconds: 10 })).rejects.toThrow('forbidden');
    await expect(
      configure({ idleTimeoutSeconds: null, idleTimeoutInherited: true, enabled: false }),
    ).rejects.toThrow('forbidden');
    await updateSettings(f.db, f.owner, { idleTimeoutUserAccess: 'shorten-only' });
    await expect(configure({ idleTimeoutSeconds: 61 })).rejects.toThrow('forbidden');
    await expect(
      configure({ idleTimeoutSeconds: null, idleTimeoutInherited: false }),
    ).rejects.toThrow('forbidden');
    await configure({ idleTimeoutSeconds: 30 });
    expect((await getPlatformSleepPolicy(f.db, f.context, serverId)).idleTimeout).toMatchObject({
      overrideSeconds: 30,
      effectiveSeconds: 30,
      source: 'server',
      ownerBaselineSeconds: 60,
    });
    await updateSettings(f.db, f.owner, { defaultIdleTimeoutSeconds: 15 });
    expect((await getPlatformSleepPolicy(f.db, f.context, serverId)).idleTimeout).toMatchObject({
      overrideSeconds: 30,
      effectiveSeconds: 15,
      source: 'default',
    });
    await updateSettings(f.db, f.owner, { idleTimeoutUserAccess: 'hidden' });
    expect((await getPlatformSleepPolicy(f.db, f.owner, serverId)).idleTimeout).toMatchObject({
      overrideSeconds: null,
      effectiveSeconds: 15,
    });
    await expect(configure({ idleTimeoutUserAccess: 'editable' })).rejects.toThrow('forbidden');
  });
  it('keeps separate Owner server authority and respects game/runtime access precedence', async () => {
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    await updateSettings(f.db, f.owner, {
      defaultIdleTimeoutSeconds: 900,
      idleTimeoutUserAccess: 'hidden',
      gameIdleTimeouts: {
        [mapping.game_id]: {
          gameTimeoutSeconds: 600,
          userAccess: 'editable',
          runtimeTimeouts: { fixture: 300 },
          runtimeUserAccess: { fixture: 'shorten-only' },
        },
      },
    });
    await setGatewayPolicy(
      f.db,
      f.owner,
      serverId,
      { ...policy, idleTimeoutSeconds: 120, idleTimeoutUserAccess: 'editable' },
      options,
    );
    await configure({ idleTimeoutSeconds: null, idleTimeoutInherited: false });
    expect((await getPlatformSleepPolicy(f.db, f.context, serverId)).idleTimeout).toMatchObject({
      effectiveSeconds: -1,
      ownerBaselineSeconds: 120,
      overrideSeconds: -1,
    });
    const ownerView = await getPlatformSleepPolicy(f.db, f.owner, serverId);
    expect(ownerView.idleTimeout).toMatchObject({
      overrideSeconds: 120,
      inheritedSeconds: 300,
      inheritedUserAccess: 'shorten-only',
      ownerUserAccessOverride: 'editable',
    });
    await setGatewayPolicy(
      f.db,
      f.owner,
      serverId,
      {
        ...policy,
        idleTimeoutSeconds: null,
        idleTimeoutInherited: true,
        idleTimeoutUserAccess: null,
      },
      options,
    );
    expect((await getPlatformSleepPolicy(f.db, f.context, serverId)).idleTimeout).toMatchObject({
      effectiveSeconds: 300,
      userAccess: 'shorten-only',
      ownerBaselineSeconds: 300,
    });
  });
  it('cannot extend idle time through repeated hidden or shorten-only no-op policy writes', async () => {
    const fixture = await started();
    await updateSettings(f.db, f.owner, {
      defaultIdleTimeoutSeconds: 60,
      idleTimeoutUserAccess: 'shorten-only',
    });
    await report(fixture);
    const before = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    await configure({ idleTimeoutSeconds: 10 });
    const after = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect(after.idle_since).toEqual(before.idle_since);
    expect(after.generation).toBe(before.generation);
    expect(after.state).toBe('online');
  });
  it('specialized game policy updates reset inherited idle evidence, preserve wake identity and honor environment locks', async () => {
    await configure({
      enabled: false,
      mode: 'manually_stopped',
      idleTimeoutInherited: true,
      idleTimeoutSeconds: null,
    });
    const manifest = trustedGameModules.get('minecraft')?.manifest;
    if (!manifest) throw new Error('Missing trusted Minecraft module');
    await f.db
      .insertInto('game_integrations')
      .values({ id: manifest.id, version: manifest.version, manifest })
      .onConflict((c) => c.column('id').doNothing())
      .execute();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ game_id: 'minecraft', runtime_id: 'vanilla' })
      .where('id', '=', f.mappingId)
      .execute();
    const before = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('gateway_server_states')
      .set({ idle_since: clock })
      .where('server_id', '=', serverId)
      .execute();
    await setGameSleepPolicy(f.db, f.owner, 'minecraft', {
      gameTimeoutSeconds: 60,
      runtimeTimeouts: { vanilla: 30 },
      userAccess: 'shorten-only',
      runtimeUserAccess: {},
    });
    const after = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect(after.idle_since).toBeNull();
    expect(after.generation).toBe(before.generation);
    const env = { NH_GAME_IDLE_TIMEOUTS: '{}' };
    expect(await getGameSleepPolicy(f.db, f.owner, 'minecraft', env)).toMatchObject({
      locked: true,
    });
    await expect(
      setGameSleepPolicy(
        f.db,
        f.owner,
        'minecraft',
        { gameTimeoutSeconds: 60, runtimeTimeouts: {} },
        env,
      ),
    ).rejects.toThrow('conflict');
    await expect(
      setGameSleepPolicy(f.db, { ...f.owner, sessionType: 'support' }, 'minecraft', {
        gameTimeoutSeconds: 60,
        runtimeTimeouts: {},
      }),
    ).rejects.toThrow();
  });

  it('inherits game then runtime defaults, supports server overrides and preserves legacy disabled sleep', async () => {
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    await updateSettings(f.db, f.owner, {
      gameIdleTimeouts: {
        [mapping.game_id]: { gameTimeoutSeconds: 120, runtimeTimeouts: { fixture: 60 } },
      },
    });
    expect(await resolveIdleTimeout(f.db, serverId, null)).toMatchObject({
      effectiveSeconds: 60,
      source: 'runtime',
      overrideSeconds: null,
    });
    expect(
      await resolveIdleTimeout(f.db, serverId, {
        idle_timeout_seconds: 15,
        idle_timeout_inherited: false,
      }),
    ).toMatchObject({ effectiveSeconds: 15, source: 'server' });
    expect(
      await resolveIdleTimeout(f.db, serverId, {
        idle_timeout_seconds: null,
        idle_timeout_inherited: false,
      }),
    ).toMatchObject({ effectiveSeconds: -1, source: 'server' });
    expect(
      await resolveIdleTimeout(f.db, serverId, null, {
        NH_GAME_IDLE_TIMEOUTS: JSON.stringify({
          [mapping.game_id]: { gameTimeoutSeconds: 180, runtimeTimeouts: {} },
        }),
      }),
    ).toMatchObject({ effectiveSeconds: 180, source: 'game' });
    await configure({ idleTimeoutSeconds: null, idleTimeoutInherited: true });
    const state = await getGatewayState(f.db, serverId);
    expect((await wake()).state).toBe('waking');
    expect(state.enabled).toBe(true);
  });
  it('honors environment-disabled sleep on duplicate observations and before the final worker power handoff', async () => {
    const fixture = await started();
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    await updateSettings(f.db, f.owner, {
      gameIdleTimeouts: { [mapping.game_id]: { gameTimeoutSeconds: 10, runtimeTimeouts: {} } },
    });
    await f.db
      .updateTable('gateway_server_states')
      .set({ idle_timeout_inherited: true })
      .where('server_id', '=', serverId)
      .execute();
    await report(fixture);
    const env = {
      NH_GAME_IDLE_TIMEOUTS: JSON.stringify({
        [mapping.game_id]: { gameTimeoutSeconds: -1, runtimeTimeouts: {} },
      }),
    };
    expect(await report(fixture, {}, { env })).toMatchObject({ sleepEligibleAt: null });
    advance(10000);
    const pending = await report(fixture);
    fixture.lifecycle.env = env;
    let externalPower = false;
    fixture.stop.mockImplementationOnce(async (_id, _identifier, callbacks) => {
      await callbacks.beforePower?.();
      externalPower = true;
      return { confirmed: false };
    });
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('failed');
    expect(externalPower).toBe(false);
    expect((await row()).runtime_state).toBe('running');
  });
  it('confirms an already sent sleep after inherited sleep is disabled without repeating remote power', async () => {
    const fixture = await started();
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    await updateSettings(f.db, f.owner, {
      gameIdleTimeouts: { [mapping.game_id]: { gameTimeoutSeconds: 10, runtimeTimeouts: {} } },
    });
    await f.db
      .updateTable('gateway_server_states')
      .set({ idle_timeout_inherited: true })
      .where('server_id', '=', serverId)
      .execute();
    await report(fixture);
    advance(10000);
    const pending = await report(fixture);
    fixture.lifecycle.checkpoint = async (point) => {
      if (point === 'remote_succeeded') throw new Error('isolated lost acknowledgement');
    };
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('waiting');
    await updateSettings(f.db, f.owner, {
      gameIdleTimeouts: { [mapping.game_id]: { gameTimeoutSeconds: -1, runtimeTimeouts: {} } },
    });
    advance(15001);
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('succeeded');
    expect(fixture.stop).toHaveBeenCalledTimes(1);
  });
  it('does not accumulate hidden idle time while sleep is disabled by the environment', async () => {
    const fixture = await started();
    await f.db
      .updateTable('gateway_server_states')
      .set({ idle_timeout_inherited: true })
      .where('server_id', '=', serverId)
      .execute();
    const env = { NH_DEFAULT_IDLE_TIMEOUT_SECONDS: '-1' };
    await report(fixture, {}, { env });
    advance(10000);
    await report(fixture, {}, { env });
    expect(
      (
        await f.db
          .selectFrom('gateway_server_states')
          .select('idle_since')
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).idle_since,
    ).toBeNull();
    advance(1);
    expect(
      await report(fixture, {}, { env: { NH_DEFAULT_IDLE_TIMEOUT_SECONDS: '10' } }),
    ).toMatchObject({
      state: 'online',
      sleepJobId: null,
      sleepEligibleAt: new Date(clock.getTime() + 10000).toISOString(),
    });
  });
  it('disabling inherited sleep does not disable intentional wake', async () => {
    await configure({ idleTimeoutSeconds: null, idleTimeoutInherited: true });
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    await updateSettings(f.db, f.owner, {
      gameIdleTimeouts: { [mapping.game_id]: { gameTimeoutSeconds: -1, runtimeTimeouts: {} } },
    });
    expect((await wake()).state).toBe('waking');
  });
  it.each([-1, 120])(
    'fences a queued idle stop after inherited timeout changes to %s, retaining RAM and recovering readiness',
    async (timeout) => {
      const fixture = await started();
      const mapping = await f.db
        .selectFrom('runtime_egg_mappings')
        .select('game_id')
        .where('id', '=', f.mappingId)
        .executeTakeFirstOrThrow();
      await updateSettings(f.db, f.owner, {
        gameIdleTimeouts: { [mapping.game_id]: { gameTimeoutSeconds: 10, runtimeTimeouts: {} } },
      });
      await f.db
        .updateTable('gateway_server_states')
        .set({ idle_timeout_inherited: true })
        .where('server_id', '=', serverId)
        .execute();
      await report(fixture);
      advance(10000);
      const pending = await report(fixture);
      expect(pending.sleepJobId).not.toBeNull();
      await updateSettings(f.db, f.owner, {
        gameIdleTimeouts: {
          [mapping.game_id]: { gameTimeoutSeconds: timeout, runtimeTimeouts: {} },
        },
      });
      expect(await fixture.process(pending.sleepJobId ?? '')).toBe('failed');
      expect(fixture.stop).not.toHaveBeenCalled();
      expect((await row()).runtime_state).toBe('running');
      expect((await row()).active_operation_id).toBeNull();
      expect(
        await f.db
          .selectFrom('resource_reservations')
          .select('server_id')
          .where('server_id', '=', serverId)
          .execute(),
      ).toHaveLength(1);
      await reconcileGatewayState(f.db, serverId, options);
      advance(1);
      expect(await report(fixture)).toMatchObject({ state: 'online' });
    },
  );

  it('rejects an already queued Gateway wake if the server is direct, without releasing its reservation', async () => {
    await configure();
    const state = await wake();
    expect(state.wakeJobId).toBeTruthy();
    const jobId = state.wakeJobId ?? '';
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).resolves.toMatchObject({
      subjectUserId: f.context.subjectUserId,
    });
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'direct' })
      .where('id', '=', serverId)
      .execute();
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).rejects.toThrow('forbidden');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst(),
    ).toBeDefined();
  });
  it.each([
    ['resources', 'logout'],
    ['resources', 'demotion'],
    ['request', 'logout'],
    ['request', 'demotion'],
  ])('revalidates manual-stop consent after the %s lock and %s', async (lock, reason) => {
    const initial = await configure(),
      key = randomUUID();
    const blocker = await database.pool.connect();
    let result: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid;
      if (lock === 'resources')
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':resources',0))",
        );
      else
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':request:' || $1 || ':' || $2,0))",
          [f.owner.actorUserId, key],
        );
      result = enqueueServerOperation(f.db, f.owner, serverId, {
        action: 'stop',
        idempotencyKey: key,
      }).then(
        () => ({ success: true }),
        (error: unknown) => error,
      );
      await vi.waitFor(async () => {
        const waiting = await database.pool.query<{ count: string }>(
          'SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [pid],
        );
        expect(Number(waiting.rows[0]?.count)).toBe(1);
      });
      if (reason === 'logout')
        await f.db
          .deleteFrom('session')
          .where('id', '=', f.owner[authSessionId] ?? '')
          .execute();
      else
        await f.db
          .updateTable('user')
          .set({ role: 'user' })
          .where('id', '=', f.owner.actorUserId)
          .execute();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    try {
      expect(await result).toMatchObject({
        code: reason === 'logout' ? 'unauthenticated' : 'forbidden',
      });
      expect(await getGatewayState(f.db, serverId, options)).toMatchObject({
        generation: initial.generation,
        state: 'sleeping',
      });
      expect((await row()).intent).toBe('sleeping');
      expect((await row()).active_operation_id).toBeNull();
      const audit = await f.db
        .selectFrom('audit_events')
        .selectAll()
        .where('action', '=', 'gateway.consent.revoked')
        .execute();
      expect(audit.filter((event) => event.metadata.serverId === serverId)).toHaveLength(0);
    } finally {
      if (reason === 'demotion')
        await f.db
          .updateTable('user')
          .set({ role: 'owner' })
          .where('id', '=', f.owner.actorUserId)
          .execute();
    }
  });
  it('rejects unbound interactive consent changes when a Gateway policy exists', async () => {
    const initial = await configure();
    const unbound = { ...f.context };
    delete unbound[authSessionId];
    for (const action of ['stop', 'start'] as const)
      await expect(
        enqueueServerOperation(f.db, unbound, serverId, { action, idempotencyKey: randomUUID() }),
      ).rejects.toThrow('unauthenticated');
    expect(await getGatewayState(f.db, serverId, options)).toMatchObject({
      generation: initial.generation,
      state: 'sleeping',
    });
  });
  it.each(['logout', 'demotion'])(
    'revalidates interactive authority after waiting for the resource lock: %s',
    async (reason) => {
      const initial = await configure();
      const blocker = await database.pool.connect();
      let result: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid;
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':resources',0))",
        );
        result = setGatewayPolicy(
          f.db,
          f.owner,
          serverId,
          { ...policy, enabled: false },
          options,
        ).then(
          () => ({ success: true }),
          (error: unknown) => error,
        );
        await vi.waitFor(async () => {
          const waiting = await database.pool.query<{ count: string }>(
            'SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
            [pid],
          );
          expect(Number(waiting.rows[0]?.count)).toBe(1);
        });
        if (reason === 'logout')
          await f.db
            .deleteFrom('session')
            .where('id', '=', f.owner[authSessionId] ?? '')
            .execute();
        else
          await f.db
            .updateTable('user')
            .set({ role: 'user' })
            .where('id', '=', f.owner.actorUserId)
            .execute();
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      try {
        expect(await result).toMatchObject({
          code: reason === 'logout' ? 'unauthenticated' : 'forbidden',
        });
        expect(await getGatewayState(f.db, serverId, options)).toMatchObject({
          generation: initial.generation,
          enabled: true,
          state: 'sleeping',
        });
      } finally {
        if (reason === 'demotion')
          await f.db
            .updateTable('user')
            .set({ role: 'owner' })
            .where('id', '=', f.owner.actorUserId)
            .execute();
      }
    },
  );
  it('40 concurrent intentional joins create exactly one reservation, operation and outbox entry', async () => {
    const state = await configure();
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        requestGatewayWake(
          f.db,
          serverId,
          {
            generation: state.generation,
            intent: 'join',
          },
          options,
        ),
      ),
    );
    expect(new Set(results.map((result) => result.wakeJobId)).size).toBe(1);
    expect(results.every((result) => result.state === 'waking')).toBe(true);
    const operations = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('action', '=', 'start')
      .execute();
    expect(operations).toHaveLength(1);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await f.db
        .selectFrom('job_outbox')
        .selectAll()
        .where('job_id', '=', results[0]?.wakeJobId ?? '')
        .execute(),
    ).toHaveLength(1);
  });
  it('passive status probes never wake or reserve compute', async () => {
    const state = await configure();
    for (let i = 0; i < 10; i++)
      expect(
        (
          await requestGatewayWake(
            f.db,
            serverId,
            {
              generation: state.generation,
              intent: 'status',
            },
            options,
          )
        ).state,
      ).toBe('sleeping');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
  });
  it.each([{ availableMemoryMiB: 1 }, { cpuBusyPercent: 800 }])(
    'immediately refuses insufficient physical resources with no waiting job: %j',
    async (resources) => {
      await configure();
      await f.observe(resources);
      const denied = await wake();
      expect(denied).toMatchObject({
        state: 'blocked',
        errorCode: 'resources_unavailable',
        wakeJobId: null,
      });
      expect(
        await f.db
          .selectFrom('resource_reservations')
          .selectAll()
          .where('server_id', '=', serverId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await f.db
          .selectFrom('server_operations')
          .selectAll()
          .where('server_id', '=', serverId)
          .where('action', '=', 'start')
          .execute(),
      ).toHaveLength(0);
      await f.observe();
      expect((await reconcileGatewayState(f.db, serverId, options)).state).toBe('blocked');
      expect((await wake()).state).toBe('blocked');
      advance(11000);
      expect((await wake()).state).toBe('waking');
    },
  );
  it('uncertain uploads roll admission back but preserve a blocked diagnostic', async () => {
    await configure();
    await pendingUploadFixture(f.db, serverId);
    expect(await wake()).toMatchObject({
      state: 'blocked',
      errorCode: 'operation_uncertain',
      wakeJobId: null,
    });
    expect((await row()).active_operation_id).toBeNull();
  });
  it('manual-stop suppression wins even when stop enqueue conflicts with an existing wake', async () => {
    await configure();
    const fixture = await lifecycleFixture();
    const pending = await wake();
    await expect(
      enqueueServerOperation(f.db, f.context, serverId, {
        action: 'stop',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('conflict');
    expect((await getGatewayState(f.db, serverId, options)).state).toBe('manually_stopped');
    const audit = await f.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'gateway.consent.revoked')
      .execute();
    expect(audit.filter((event) => event.metadata.serverId === serverId)).toEqual([
      expect.objectContaining({
        actor_user_id: f.context.actorUserId,
        subject_user_id: f.context.subjectUserId,
        metadata: expect.objectContaining({ reason: 'manual_stop', serverId }),
      }),
    ]);
    expect(await fixture.process(pending.wakeJobId ?? '')).toBe('failed');
    expect(fixture.power).not.toHaveBeenCalled();
    expect((await wake()).state).toBe('manually_stopped');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
  });
  it('manual stop and a burst of joins never leave an authorized queued auto-start', async () => {
    const state = await configure();
    await Promise.allSettled([
      ...Array.from({ length: 20 }, () =>
        requestGatewayWake(
          f.db,
          serverId,
          { generation: state.generation, intent: 'join' },
          options,
        ),
      ),
      enqueueServerOperation(f.db, f.context, serverId, {
        action: 'stop',
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect((await row()).intent).toBe('manually_stopped');
    const pending = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('action', '=', 'start')
      .execute();
    for (const operation of pending)
      await expect(authorizeQueuedEffect(f.db, operation.job_id, serverId)).rejects.toThrow(
        'forbidden',
      );
  });
  it('maintenance and disabled policy suppress joins and revoke old generations', async () => {
    const initial = await configure();
    const maintained = await configure({ mode: 'maintenance' });
    expect(maintained.state).toBe('maintenance');
    expect((await wake()).wakeJobId).toBeNull();
    await expect(
      requestGatewayWake(
        f.db,
        serverId,
        { generation: initial.generation, intent: 'join' },
        options,
      ),
    ).rejects.toThrow('conflict');
    expect((await configure({ enabled: false })).state).toBe('manually_stopped');
    expect((await wake()).wakeJobId).toBeNull();
  });
  it('disabling automation revokes a queued wake before its first remote effect', async () => {
    await configure();
    const fixture = await lifecycleFixture();
    const pending = await wake();
    await configure({ enabled: false });
    expect(await fixture.process(pending.wakeJobId ?? '')).toBe('failed');
    expect(fixture.power).not.toHaveBeenCalled();
    expect((await getGatewayState(f.db, serverId, options)).state).toBe('manually_stopped');
  });
  it('rechecks a manual-stop revocation after preparing intent and before sending power', async () => {
    await configure();
    const fixture = await lifecycleFixture();
    const pending = await wake();
    fixture.lifecycle.checkpoint = async (point) => {
      if (point !== 'prepared') return;
      await expect(
        enqueueServerOperation(f.db, f.context, serverId, {
          action: 'stop',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow('conflict');
    };
    expect(await fixture.process(pending.wakeJobId ?? '')).toBe('failed');
    expect(fixture.power).not.toHaveBeenCalled();
    expect((await row()).intent).toBe('manually_stopped');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
  });
  it('replaying an old manual stop does not revoke a later explicit rearm', async () => {
    const fixture = await started();
    const input = { action: 'stop', idempotencyKey: randomUUID() };
    const stopped = await enqueueServerOperation(f.db, f.context, serverId, input);
    expect(await fixture.process(stopped.jobId)).toBe('succeeded');
    advance(1000);
    expect(await fixture.process(stopped.jobId)).toBe('duplicate');
    const rearmed = await configure();
    expect(rearmed.state).toBe('sleeping');
    expect(await enqueueServerOperation(f.db, f.context, serverId, input)).toEqual(stopped);
    expect(await getGatewayState(f.db, serverId, options)).toMatchObject({
      generation: rearmed.generation,
      state: 'sleeping',
    });
  });
  it('an explicit manual start clears manual suppression without granting disabled auto-wake', async () => {
    await configure({ enabled: false });
    const manual = await enqueueServerOperation(f.db, f.context, serverId, {
      action: 'start',
      idempotencyKey: randomUUID(),
    });
    expect(await getGatewayState(f.db, serverId, options)).toMatchObject({
      state: 'waking',
      enabled: false,
      wakeJobId: manual.jobId,
    });
    expect(await wake()).toMatchObject({ enabled: false, wakeJobId: manual.jobId });
  });
  it('an ordinary power start does not clear an explicit maintenance policy', async () => {
    await configure({ mode: 'maintenance' });
    await enqueueServerOperation(f.db, f.context, serverId, {
      action: 'start',
      idempotencyKey: randomUUID(),
    });
    expect((await row()).intent).toBe('maintenance');
    expect((await getGatewayState(f.db, serverId, options)).state).toBe('maintenance');
  });
  it('unrelated servers and unauthorized users cannot acquire an automation policy', async () => {
    await expect(getGatewayState(f.db, randomUUID(), options)).rejects.toThrow('not_found');
    const other = await managementFixture(f.db, { interactive: true });
    await expect(setGatewayPolicy(f.db, other.context, serverId, policy, options)).rejects.toThrow(
      'forbidden',
    );
    expect(
      await f.db
        .selectFrom('gateway_server_states')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
  });
  it('trusted provider running reuses the admitted successful start without inventing idle evidence', async () => {
    const fixture = await started();
    const server = await row();
    const input = {
      generation: fixture.state.generation,
      wakeJobId: fixture.state.wakeJobId as string,
      observedAt: clock.toISOString(),
      providerIdentity: {
        pterodactyl_id: server.pterodactyl_id,
        pterodactyl_uuid: server.pterodactyl_uuid,
        provider_user_id: server.provider_user_id,
        external_id: server.external_id,
        node_id: server.node_id,
      },
    };
    const result = await reportGatewayProviderRunning(f.db, serverId, input, options);
    expect(result.state).toBe('online');
    expect(result.sleepEligibleAt).toBeNull();
    expect(result.processStartedAt).toBe(fixture.processStartedAt());
    await expect(
      reportGatewayProviderRunning(f.db, serverId, { ...input, generation: randomUUID() }, options),
    ).rejects.toThrow('conflict');
    await expect(
      reportGatewayProviderRunning(
        f.db,
        serverId,
        {
          ...input,
          providerIdentity: { ...input.providerIdentity, provider_user_id: -1 },
        },
        options,
      ),
    ).rejects.toThrow('conflict');
  });
  it('provider running commits with real route revalidation inside its existing transaction', async () => {
    clock = new Date(Date.now() - 2000);
    const fixture = await started();
    const server = await row();
    const env = {
      NH_GATEWAY_ENABLED: 'true',
      NH_GATEWAY_ID: randomUUID(),
      NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
    };
    const allocation = await f.db
      .selectFrom('server_allocations')
      .select('id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const route = await setGatewayRoute(
      f.db,
      f.owner,
      {
        serverId,
        allocationId: allocation.id,
        publicAddress: f.backendAllocationPool.gatewayBindAddresses[0],
        publicPort: 26000,
        transport: 'tcp',
      },
      env,
    );
    const selected = await requireGatewayRoute(f.db, route.id, undefined, env);
    expect(selected.mode).toBe('waking');
    const result = await reportGatewayProviderRunning(
      f.db,
      serverId,
      {
        generation: fixture.state.generation,
        wakeJobId: fixture.state.wakeJobId as string,
        observedAt: clock.toISOString(),
        providerIdentity: {
          pterodactyl_id: server.pterodactyl_id,
          pterodactyl_uuid: server.pterodactyl_uuid,
          provider_user_id: server.provider_user_id,
          external_id: server.external_id,
          node_id: server.node_id,
        },
      },
      {
        ...options,
        env,
        validateObservation: async (tx) => {
          // Match the startup SSE handler, including the real registry callback.
          expect(tx.isTransaction).toBe(true);
          const current = await requireGatewayRoute(tx, selected.id, selected.revision, env);
          expect(current).toMatchObject({
            mode: 'waking',
            generation: fixture.state.generation,
            wakeJobId: fixture.state.wakeJobId,
          });
        },
      },
    );
    expect(result.state).toBe('online');
    expect(result.sleepEligibleAt).toBeNull();
    expect((await getGatewaySnapshot(f.db, env)).routes).toEqual([
      expect.objectContaining({ id: selected.id, mode: 'online' }),
    ]);
  });
  it.each(['pending', 'unconfirmed', 'missing-reservation', 'changed-epoch', 'provider-stopped'])(
    'provider running cannot bypass %s durable start proof',
    async (failure) => {
      const fixture = await started();
      const server = await row();
      if (failure === 'pending')
        await f.db
          .updateTable('operation_jobs')
          .set({ state: 'queued', completed_at: null })
          .where('id', '=', fixture.state.wakeJobId as string)
          .execute();
      if (failure === 'unconfirmed')
        await f.db
          .updateTable('server_operations')
          .set({ effect_state: 'prepared' })
          .where('job_id', '=', fixture.state.wakeJobId as string)
          .execute();
      if (failure === 'missing-reservation')
        await f.db.deleteFrom('resource_reservations').where('server_id', '=', serverId).execute();
      const operation = await f.db
        .selectFrom('server_operations')
        .select('plan')
        .where('job_id', '=', fixture.state.wakeJobId as string)
        .executeTakeFirstOrThrow();
      await expect(
        reportGatewayProviderRunning(
          f.db,
          serverId,
          {
            generation: fixture.state.generation,
            wakeJobId: fixture.state.wakeJobId as string,
            observedAt: clock.toISOString(),
            providerIdentity: {
              pterodactyl_id: server.pterodactyl_id,
              pterodactyl_uuid: server.pterodactyl_uuid,
              provider_user_id: server.provider_user_id,
              external_id: server.external_id,
              node_id: server.node_id,
            },
          },
          {
            ...options,
            validateLiveReadiness: () => {
              if (failure === 'provider-stopped') throw new Error('operation_uncertain');
            },
            validateObservation: async (tx) => {
              if (failure === 'changed-epoch')
                await tx
                  .updateTable('server_operations')
                  .set({
                    plan: JSON.stringify({
                      ...operation.plan,
                      startProcessStartedAt: new Date().toISOString(),
                    }),
                  })
                  .where('job_id', '=', fixture.state.wakeJobId as string)
                  .execute();
            },
          },
        ),
      ).rejects.toThrow('operation_uncertain');
      expect((await getGatewayState(f.db, serverId, options)).state).not.toBe('online');
    },
  );
  it('container running is insufficient; correlated game readiness records the real duration once', async () => {
    const fixture = await started();
    expect((await row()).runtime_state).toBe('running');
    expect((await getGatewayState(f.db, serverId, options)).state).toBe('waking');
    expect((await report(fixture, { ready: false })).state).toBe('waking');
    advance(1000);
    expect((await report(fixture)).state).toBe('online');
    await report(fixture);
    const samples = await f.db
      .selectFrom('gateway_startup_samples')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.duration_ms).toBe(2000);
    expect((await getGatewayState(f.db, serverId, options)).startupEstimate).toBeNull();
    await reconcileManagedServer(f.db, serverId, fixture.lifecycle);
    expect((await row()).readiness).toBe('ready');
  });
  it('rejects old generations, stale/future observations and unrelated wake job IDs', async () => {
    const fixture = await started();
    for (const patch of [{ generation: randomUUID() }, { wakeJobId: randomUUID() }])
      await expect(report(fixture, patch)).rejects.toThrow('conflict');
    for (const observedAt of [
      new Date(clock.getTime() + 1).toISOString(),
      new Date(clock.getTime() - 16000).toISOString(),
    ])
      await expect(report(fixture, { observedAt })).rejects.toThrow('validation_failed');
    await expect(
      report(fixture, { processStartedAt: new Date(clock.getTime() - 10000).toISOString() }),
    ).rejects.toThrow('operation_uncertain');
  });
  it('does not reuse readiness for a different process after a crash', async () => {
    const fixture = await started();
    await report(fixture);
    advance(1000);
    expect(await report(fixture, { processStartedAt: clock.toISOString() })).toMatchObject({
      state: 'blocked',
      errorCode: 'operation_uncertain',
    });
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
  });
  it('does not truncate process identity into a false after-effect timestamp', async () => {
    const fixture = await started();
    const operation = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', fixture.state.wakeJobId ?? '')
      .executeTakeFirstOrThrow();
    const effect = operation.effect_started_at?.toISOString() ?? '';
    await expect(report(fixture, { processStartedAt: effect })).rejects.toThrow(
      'operation_uncertain',
    );
    const nanosBefore = new Date((operation.effect_started_at?.getTime() ?? 0) - 1)
      .toISOString()
      .replace('Z', '999999Z');
    await expect(report(fixture, { processStartedAt: nanosBefore })).rejects.toThrow(
      'operation_uncertain',
    );
    await expect(
      report(fixture, { processStartedAt: effect.replace('Z', '000001Z') }),
    ).resolves.toMatchObject({ state: 'online' });
  });
  it('stale readiness and startup timeout fail closed without releasing committed resources', async () => {
    const fixture = await started();
    await report(fixture);
    advance(16000);
    expect((await getGatewayState(f.db, serverId, options)).state).toBe('blocked');
    await reconcileGatewayState(f.db, serverId, options);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
    expect((await wake()).state).toBe('blocked');
  });
  it('recovers an already-ready process after a long control-plane outage without another start', async () => {
    const fixture = await started();
    await report(fixture);
    advance(120000);
    expect((await reconcileGatewayState(f.db, serverId, options)).state).toBe('blocked');
    expect((await report(fixture)).state).toBe('online');
    expect(fixture.power).toHaveBeenCalledTimes(1);
    expect(
      await f.db
        .selectFrom('server_operations')
        .selectAll()
        .where('server_id', '=', serverId)
        .where('action', '=', 'start')
        .execute(),
    ).toHaveLength(1);
  });
  it('a worker outage never causes a second wake or a timer-based waiting queue', async () => {
    await configure();
    const pending = await wake();
    advance(61000);
    expect((await reconcileGatewayState(f.db, serverId, options)).state).toBe('blocked');
    advance(11000);
    expect((await wake()).wakeJobId).toBe(pending.wakeJobId);
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
  it('idle sleep uses the existing durable stop and waits for proven terminal release', async () => {
    const fixture = await started();
    await report(fixture);
    advance(10000);
    const sleeping = await report(fixture);
    expect(sleeping.state).toBe('blocked');
    expect(sleeping.sleepJobId).not.toBeNull();
    expect((await row()).intent).toBe('sleeping');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
    expect(await fixture.process(sleeping.sleepJobId ?? '')).toBe('succeeded');
    advance(1000);
    expect(await fixture.process(sleeping.sleepJobId ?? '')).toBe('duplicate');
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect((await row()).intent).toBe('sleeping');
    expect((await reconcileGatewayState(f.db, serverId, options)).state).toBe('sleeping');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
    expect((await wake()).state).toBe('waking');
  });
  it('commits the sleeping snapshot and notifies immediately when the confirmed stop finishes, without a reconciliation tick', async () => {
    clock = new Date(Date.now() - 11000);
    const fixture = await started();
    const env = {
      NH_GATEWAY_ENABLED: 'true',
      NH_GATEWAY_ID: randomUUID(),
      NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
    };
    const allocation = await f.db
      .selectFrom('server_allocations')
      .select('id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const route = await setGatewayRoute(
      f.db,
      f.owner,
      {
        serverId,
        allocationId: allocation.id,
        publicAddress: f.backendAllocationPool.gatewayBindAddresses[0],
        publicPort: 26000,
        transport: 'tcp',
      },
      env,
    );
    await report(fixture);
    advance(10000);
    const quiescenceUntil = new Date(Date.now() + 15000).toISOString();
    const pending = await report(fixture, { quiescenceUntil });
    expect(pending.sleepJobId).not.toBeNull();
    fixture.lifecycle.now = () => new Date();
    fixture.lifecycle.env = env;
    const changed = vi.fn();
    const subscription = await listenForGatewayChanges(database.pool, changed, vi.fn());
    try {
      expect(await fixture.process(pending.sleepJobId ?? '')).toBe('succeeded');
      // Direct row and snapshot reads: neither invokes the periodic reconciler.
      expect(
        await f.db
          .selectFrom('gateway_server_states')
          .select(['state', 'sleep_job_id'])
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'sleeping', sleep_job_id: null });
      const snapshot = await getGatewaySnapshot(f.db, env);
      expect(snapshot.routes.find((item) => item.id === route.id)).toMatchObject({
        mode: 'sleeping',
        completedSleep: {
          jobId: pending.sleepJobId,
          generation: pending.generation,
          quiescenceUntil,
        },
      });
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(fixture.stop).toHaveBeenCalledOnce();
    } finally {
      subscription.close();
    }
  });
  it('delivers only committed schema-scoped Gateway hints, independently from job notifications', async () => {
    const changed = vi.fn(),
      jobChanged = vi.fn();
    const subscription = await listenForGatewayChanges(database.pool, changed, vi.fn());
    const jobs = await listenForJobOutbox(database.pool, jobChanged, vi.fn());
    const other = await createTestDatabase();
    try {
      await expect(
        f.db.transaction().execute(async (tx) => {
          await notifyGatewayChange(tx);
          throw new Error('rollback notification fixture');
        }),
      ).rejects.toThrow('rollback notification fixture');
      await notifyGatewayChange(other.db);
      await notifyJobOutbox(f.db);
      // Receipt of the later commit on this schema provides an ordering barrier.
      await vi.waitFor(() => expect(jobChanged).toHaveBeenCalledOnce());
      expect(changed).not.toHaveBeenCalled();
      await notifyGatewayChange(f.db);
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(jobChanged).toHaveBeenCalledOnce();
    } finally {
      subscription.close();
      jobs.close();
      await other.destroy();
    }
  });
  it('retains affirmative idle proof when a fresh observation races the prepared sleep handoff', async () => {
    const fixture = await started();
    await report(fixture);
    advance(10000);
    const pending = await report(fixture);
    fixture.lifecycle.checkpoint = async (point) => {
      if (point !== 'prepared') return;
      advance(1);
      expect(await report(fixture, { quiescenceUntil: undefined })).toMatchObject({
        state: 'blocked',
        sleepJobId: pending.sleepJobId,
      });
    };
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('succeeded');
    expect(fixture.stop).toHaveBeenCalledTimes(1);
  });
  it.each([
    { playerCount: undefined },
    { playerCount: 1 },
    { activeSessions: 1 },
    { idle: false },
    { ready: false },
    { processStartedAt: null },
    { processStartedAt: '2026-01-01T00:00:00.000Z' },
  ])('revokes a prepared sleep on ambiguous or changed observation %j', async (patch) => {
    const fixture = await started();
    await report(fixture);
    advance(10000);
    const pending = await report(fixture);
    fixture.lifecycle.checkpoint = async (point) => {
      if (point !== 'prepared') return;
      advance(1);
      await report(fixture, { ...patch, quiescenceUntil: undefined });
    };
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('failed');
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(
      (
        await f.db
          .selectFrom('gateway_server_states')
          .select('idle_since')
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).idle_since,
    ).toBeNull();
  });
  it.each(['gap', 'disabled-policy', 'terminal-job', 'terminal-operation'])(
    'does not retain prepared sleep proof after %s',
    async (condition) => {
      const fixture = await started();
      await report(fixture);
      advance(10000);
      const pending = await report(fixture);
      let observationChecked = false;
      fixture.lifecycle.checkpoint = async (point) => {
        if (point !== 'prepared') return;
        advance(condition === 'gap' ? 15001 : 1);
        if (condition === 'disabled-policy')
          await f.db
            .updateTable('gateway_server_states')
            .set({ enabled: false })
            .where('server_id', '=', serverId)
            .execute();
        if (condition === 'terminal-job')
          await f.db
            .updateTable('operation_jobs')
            .set({ state: 'failed', completed_at: clock })
            .where('id', '=', pending.sleepJobId ?? '')
            .execute();
        if (condition === 'terminal-operation')
          await f.db
            .updateTable('server_operations')
            .set({ phase: 'failed' })
            .where('job_id', '=', pending.sleepJobId ?? '')
            .execute();
        await report(fixture, { quiescenceUntil: undefined });
        expect(
          (
            await f.db
              .selectFrom('gateway_server_states')
              .select('idle_since')
              .where('server_id', '=', serverId)
              .executeTakeFirstOrThrow()
          ).idle_since,
        ).toBeNull();
        observationChecked = true;
      };
      expect(await fixture.process(pending.sleepJobId ?? '')).toBe('failed');
      expect(observationChecked).toBe(true);
      expect(fixture.stop).not.toHaveBeenCalled();
    },
  );
  async function rejectedSleep() {
    const fixture = await started();
    await report(fixture);
    advance(10000);
    const pending = await report(fixture);
    fixture.lifecycle.checkpoint = async (point) => {
      if (point !== 'prepared') return;
      advance(1);
      await report(fixture, { playerCount: undefined, quiescenceUntil: undefined });
    };
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('failed');
    expect(fixture.stop).not.toHaveBeenCalled();
    const operation = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', pending.sleepJobId ?? '')
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({
      effect_state: 'none',
      phase: 'failed',
      plan: {
        rejected: true,
        powerEffectPrepared: false,
        acknowledged: false,
        effectAttempts: { power: 1 },
      },
    });
    expect(operation.effect_started_at).not.toBeNull();
    return { fixture, pending, operation };
  }
  it('retires only a rejected pre-handoff sleep journal and establishes a new idle interval', async () => {
    const { fixture, pending, operation } = await rejectedSleep();
    const reservations = await f.db
      .selectFrom('resource_reservations')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    expect(await reconcileGatewayState(f.db, serverId, options)).toMatchObject({
      state: 'blocked',
      sleepJobId: null,
    });
    advance(1);
    const online = await report(fixture, { quiescenceUntil: undefined });
    expect(online).toMatchObject({ state: 'online', sleepJobId: null });
    expect(online.sleepEligibleAt).toBe(new Date(clock.getTime() + 10000).toISOString());
    for (let i = 0; i < 2; i++) {
      advance(1);
      expect((await reconcileGatewayState(f.db, serverId, options)).state).toBe('online');
      expect((await report(fixture, { quiescenceUntil: undefined })).state).toBe('online');
    }
    expect(
      await f.db
        .selectFrom('server_operations')
        .selectAll()
        .where('job_id', '=', pending.sleepJobId ?? '')
        .executeTakeFirstOrThrow(),
    ).toEqual(operation);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toEqual(reservations);
    expect(
      await f.db
        .selectFrom('server_operations')
        .select('job_id')
        .where('server_id', '=', serverId)
        .where('action', '=', 'stop')
        .execute(),
    ).toHaveLength(1);
  });
  it.each([
    'prepared',
    'uncertain',
    'confirmed',
    'power-prepared',
    'unproven-none',
    'handoff',
    'acknowledged',
    'stop-confirmed',
    'stop-confirmed-at',
    'generation',
    'other-active-job',
  ])('keeps an unresolved %s sleep blocked despite repeated positive probes', async (condition) => {
    const { fixture, pending, operation } = await rejectedSleep();
    if (['prepared', 'uncertain', 'confirmed'].includes(condition)) {
      await f.db
        .updateTable('server_operations')
        .set({ effect_state: condition as 'prepared' | 'uncertain' | 'confirmed' })
        .where('job_id', '=', operation.job_id)
        .execute();
    } else if (condition === 'other-active-job') {
      await f.db
        .updateTable('managed_servers')
        .set({ active_operation_id: fixture.state.wakeJobId })
        .where('id', '=', serverId)
        .execute();
    } else {
      const plan = { ...operation.plan };
      if (condition === 'power-prepared') plan.powerEffectPrepared = true;
      if (condition === 'unproven-none') delete plan.rejected;
      if (condition === 'handoff') plan.gatewaySleepHandoffAt = clock.toISOString();
      if (condition === 'acknowledged') plan.acknowledged = true;
      if (condition === 'stop-confirmed') plan.stopConfirmed = true;
      if (condition === 'stop-confirmed-at') plan.stopConfirmedAt = clock.toISOString();
      if (condition === 'generation')
        plan.gatewayAutomation = {
          ...(plan.gatewayAutomation as object),
          generation: randomUUID(),
        };
      await f.db
        .updateTable('server_operations')
        .set({ plan: JSON.stringify(plan) })
        .where('job_id', '=', operation.job_id)
        .execute();
    }
    for (let i = 0; i < 2; i++) {
      advance(1);
      expect(await report(fixture, { quiescenceUntil: undefined })).toMatchObject({
        state: 'blocked',
        sleepJobId: pending.sleepJobId,
      });
      expect(await reconcileGatewayState(f.db, serverId, options)).toMatchObject({
        state: 'blocked',
        sleepJobId: pending.sleepJobId,
      });
    }
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
    expect(fixture.stop).not.toHaveBeenCalled();
  });
  it('measures ordinary idle without stopping until a current ingress fence is supplied', async () => {
    const fixture = await started();
    const initial = await report(fixture, { quiescenceUntil: undefined });
    expect(initial.sleepEligibleAt).toBe(new Date(clock.getTime() + 10000).toISOString());
    advance(10000);
    expect(await report(fixture, { quiescenceUntil: undefined })).toMatchObject({
      state: 'online',
      sleepJobId: null,
    });
    advance(1);
    const fenced = await report(fixture);
    expect(fenced.sleepJobId).not.toBeNull();
    const operation = await f.db
      .selectFrom('server_operations')
      .select('plan')
      .where('job_id', '=', fenced.sleepJobId ?? '')
      .executeTakeFirstOrThrow();
    expect(operation.plan.gatewayAutomation).toMatchObject({
      kind: 'sleep',
      quiescenceUntil: new Date(clock.getTime() + 15000).toISOString(),
    });
  });
  it('rejects a delayed report whose fence expired while validation waited', async () => {
    const fixture = await started();
    await report(fixture, { quiescenceUntil: undefined });
    advance(10000);
    await expect(
      report(
        fixture,
        {},
        {
          validateObservation: async () => {
            advance(15001);
          },
        },
      ),
    ).rejects.toThrow('validation_failed');
    expect(
      await f.db
        .selectFrom('server_operations')
        .selectAll()
        .where('server_id', '=', serverId)
        .where('action', '=', 'stop')
        .execute(),
    ).toHaveLength(0);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('state')
        .where('server_id', '=', serverId)
        .execute(),
    ).toEqual([{ state: 'running' }]);
  });
  it('rolls back an enqueued sleep if final route validation outlives its fence', async () => {
    const fixture = await started();
    await report(fixture);
    advance(10000);
    let validations = 0;
    expect(
      await report(
        fixture,
        {},
        {
          validateObservation: async () => {
            validations++;
            if (validations === 3) advance(15001);
          },
        },
      ),
    ).toMatchObject({ state: 'blocked', sleepJobId: null });
    expect(validations).toBe(3);
    expect((await row()).active_operation_id).toBeNull();
    expect(
      await f.db
        .selectFrom('server_operations')
        .selectAll()
        .where('server_id', '=', serverId)
        .where('action', '=', 'stop')
        .execute(),
    ).toHaveLength(0);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('state')
        .where('server_id', '=', serverId)
        .execute(),
    ).toEqual([{ state: 'running' }]);
  });
  it.each(['expired', 'missing'])(
    'refuses a new worker stop with an %s fence while retaining active RAM',
    async (condition) => {
      const fixture = await started();
      await report(fixture);
      advance(10000);
      const pending = await report(fixture);
      const operation = await f.db
        .selectFrom('server_operations')
        .select('plan')
        .where('job_id', '=', pending.sleepJobId ?? '')
        .executeTakeFirstOrThrow();
      const marker = operation.plan.gatewayAutomation as Record<string, unknown>;
      if (condition === 'missing') delete marker.quiescenceUntil;
      else marker.quiescenceUntil = new Date(Date.now() - 1).toISOString();
      await f.db
        .updateTable('server_operations')
        .set({ plan: JSON.stringify(operation.plan) })
        .where('job_id', '=', pending.sleepJobId ?? '')
        .execute();
      expect(await fixture.process(pending.sleepJobId ?? '')).toBe('failed');
      expect(fixture.stop).not.toHaveBeenCalled();
      expect((await reconcileGatewayState(f.db, serverId, options)).state).toBe('blocked');
      expect(
        await f.db
          .selectFrom('resource_reservations')
          .selectAll()
          .where('server_id', '=', serverId)
          .execute(),
      ).toHaveLength(1);
    },
  );
  it('checks expiry again after adapter setup immediately before stop power handoff', async () => {
    const fixture = await started();
    await report(fixture);
    advance(10000);
    const pending = await report(fixture);
    let sentPower = false;
    fixture.stop.mockImplementationOnce(async (_id, _identifier, callbacks) => {
      advance(15001);
      await callbacks.beforePower?.();
      sentPower = true;
      return { confirmed: false };
    });
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('failed');
    expect(sentPower).toBe(false);
    expect((await row()).runtime_state).toBe('running');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
  });
  it('recovers lost worker acknowledgment after proven stop even after the fence expires', async () => {
    const fixture = await started();
    await report(fixture);
    advance(10000);
    const pending = await report(fixture);
    fixture.lifecycle.checkpoint = async (point) => {
      if (point === 'remote_succeeded') throw new Error('isolated lost worker acknowledgment');
    };
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('waiting');
    advance(15001);
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('succeeded');
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect((await reconcileGatewayState(f.db, serverId, options)).state).toBe('sleeping');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
  });
  it('retains uncertain stop capacity after losing terminal proof, without replay after fence expiry', async () => {
    const fixture = await started();
    await report(fixture);
    advance(10000);
    const pending = await report(fixture);
    const stop = fixture.stop.getMockImplementation();
    if (!stop) throw new Error('Missing fixture stop');
    fixture.stop.mockImplementationOnce(async (id, identifier, callbacks) => {
      await stop(id, identifier, { ...callbacks, onConfirmed: async () => {} });
      return { confirmed: false };
    });
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('waiting');
    advance(15001);
    expect(await fixture.process(pending.sleepJobId ?? '')).toBe('waiting');
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
  });
  it.each([{ activeSessions: 1 }, { playerCount: 1 }, { idle: false }, { playerCount: undefined }])(
    'active or unknown game activity prevents sleep: %j',
    async (patch) => {
      const fixture = await started();
      await report(fixture);
      advance(10000);
      expect((await report(fixture, patch)).sleepJobId).toBeNull();
    },
  );
  it('gaps in idle observations reset the idle interval', async () => {
    const fixture = await started();
    await report(fixture);
    advance(16000);
    expect((await report(fixture)).sleepJobId).toBeNull();
    advance(9000);
    expect((await report(fixture)).sleepJobId).toBeNull();
  });
  it('keeps a ready game routable during a backup without sleeping over its active operation', async () => {
    const fixture = await started();
    await report(fixture);
    await enqueueServerOperation(f.db, f.context, serverId, {
      action: 'backup',
      idempotencyKey: randomUUID(),
    });
    advance(10000);
    expect(await report(fixture)).toMatchObject({ state: 'online', sleepJobId: null });
    expect((await getGatewayState(f.db, serverId, options)).state).toBe('online');
  });
  it('reconstructs the same durable wake state through a fresh database connection', async () => {
    await configure();
    const pending = await wake();
    const recovered = createDatabase(process.env.NH_TEST_DATABASE_URL ?? '', {
      options: `-c search_path=${database.schema}`,
    });
    try {
      const state = await getGatewayState(recovered.db, serverId, options);
      expect(state.wakeJobId).toBe(pending.wakeJobId);
      expect(
        (
          await requestGatewayWake(
            recovered.db,
            serverId,
            { generation: state.generation, intent: 'join' },
            options,
          )
        ).wakeJobId,
      ).toBe(pending.wakeJobId);
    } finally {
      await recovered.db.destroy();
    }
  });
  it('uses only recent same-profile measured cycles for reliable startup estimates', async () => {
    await configure();
    const fixture = await lifecycleFixture();
    for (let index = 0; index < 11; index++) {
      // Production refreshes host admission evidence before each wake. Eleven
      // real DB-backed cycles can outlive the strict four-second sample age.
      await f.observe();
      const state = await wake();
      expect({
        index,
        state: state.state,
        code: state.errorCode,
        hasJob: Boolean(state.wakeJobId),
      }).toEqual({ index, state: 'waking', code: null, hasJob: true });
      expect(await fixture.process(state.wakeJobId ?? '')).toBe('waiting');
      advance(1000 + index * 100);
      expect(await fixture.process(state.wakeJobId ?? '')).toBe('succeeded');
      const current = { ...fixture, state };
      const ready = await report(current);
      if (index < 4) expect(ready.startupEstimate).toBeNull();
      else if (index === 4)
        expect(ready.startupEstimate).toEqual({ sampleCount: 5, p50Ms: 1200, p90Ms: 1400 });
      else if (index === 10)
        expect(ready.startupEstimate).toEqual({ sampleCount: 10, p50Ms: 1500, p90Ms: 1900 });
      advance(10000);
      const stopping = await report(current);
      expect(await fixture.process(stopping.sleepJobId ?? '')).toBe('succeeded');
      advance(1);
      expect(await fixture.process(stopping.sleepJobId ?? '')).toBe('duplicate');
      await reconcileGatewayState(f.db, serverId, options);
    }
    expect((await configure({ gameVersion: '2' })).startupEstimate).toBeNull();
    expect((await configure({ estimateMaxAgeSeconds: 60 })).startupEstimate?.sampleCount).toBe(5);
    advance(61000);
    expect((await getGatewayState(f.db, serverId, options)).startupEstimate).toBeNull();
  });
});

it('rebinds Gateway readiness to the admitted process after an offline backup', async () => {
  const running = await started();
  expect((await report(running)).state).toBe('online');
  const previous = await getGatewayState(f.db, serverId, options);
  const snapshots: Array<import('@nickhosting/pterodactyl-adapter').Backup> = [];
  running.lifecycle.adapter = {
    ...running.lifecycle.adapter,
    createBackup: async (_id, input) => {
      const snapshot = {
        uuid: randomUUID(),
        name: input.name,
        is_successful: true,
        is_locked: false,
        ignored_files: [],
        checksum: 'sha256:fixture',
        bytes: 1,
        created_at: clock.toISOString(),
        completed_at: clock.toISOString(),
      };
      snapshots.push(snapshot);
      return snapshot;
    },
    getBackup: async (_id, id) => {
      const snapshot = snapshots.find((backup) => backup.uuid === id);
      if (!snapshot) throw new Error('Unknown fixture backup');
      return snapshot;
    },
  };
  running.lifecycle.backupPolicy = async () => ({ offline: 'required' });
  const operation = await enqueueServerOperation(f.db, f.context, serverId, {
    action: 'backup',
    idempotencyKey: randomUUID(),
  });
  expect(await running.process(operation.jobId)).toBe('waiting');
  const offline = await getGatewayState(f.db, serverId, options);
  expect(offline.processStartedAt).toBeNull();
  expect(offline.generation).toBe(previous.generation);
  advance(1000);
  expect(await running.process(operation.jobId)).toBe('succeeded');
  const resumed = await getGatewayState(f.db, serverId, options);
  expect(resumed.wakeJobId).toBe(operation.jobId);
  expect((await report(running, { wakeJobId: operation.jobId })).state).toBe('online');
});
