import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { authSessionId } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import type {
  ApplicationServer,
  PterodactylAdapter,
  Resources,
} from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reserveStart } from './admission.js';
import { setGatewayPolicy } from './gateway-orchestration.js';
import { type LifecycleOptions, processServerOperation } from './lifecycle.js';
import { authorizeQueuedEffect } from './runtime.js';
import {
  createSchedule,
  deleteSchedule,
  getAutomationConsent,
  listScheduleOutcomes,
  listSchedules,
  previewSchedule,
  runDueSchedules,
  runScheduleNow,
  setAutomationConsent,
  updateSchedule,
} from './schedules.js';
import { managementFixture, pendingUploadFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
let at: Date;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  await database.db.updateTable('server_schedules').set({ enabled: false }).execute();
  f = await managementFixture(database.db, { interactive: true });
  serverId = await f.server();
  at = new Date(Date.now() + 10_000);
});
const input = (patch: Record<string, unknown> = {}) => ({
  name: 'Daily backup',
  action: 'backup',
  timing: { kind: 'once', at: at.toISOString() },
  timeZone: 'Europe/Rome',
  enabled: true,
  ...patch,
});
const create = (patch: Record<string, unknown> = {}) =>
  createSchedule(f.db, f.context, serverId, input(patch));
const due = (now = at) => runDueSchedules(f.db, {}, { now });
const outcomes = (id: string) => listScheduleOutcomes(f.db, f.context, serverId, id);
async function allowStarts() {
  await setGatewayPolicy(f.db, f.context, serverId, {
    enabled: true,
    protocolId: 'fixture',
    gameVersion: '1',
    idleTimeoutSeconds: 10,
    readinessTimeoutSeconds: 60,
    readinessMaxAgeSeconds: 15,
    estimateMaxAgeSeconds: 86400,
    wakeRetrySeconds: 10,
    mode: 'auto',
  });
}
async function jobOf(scheduleId: string) {
  const job = (await outcomes(scheduleId)).items[0]?.jobId;
  if (!job) throw new Error('Expected a dispatched lifecycle job');
  return job;
}

async function lifecycleFixture() {
  const server = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  if (server.provider_user_id === null) throw new Error('Missing fixture provider account');
  const allocations = await f.db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .execute();
  const remote: ApplicationServer = {
    id: server.pterodactyl_id ?? 0,
    uuid: server.pterodactyl_uuid ?? '',
    identifier: server.pterodactyl_identifier ?? '',
    external_id: server.external_id,
    name: 'isolated',
    description: '',
    suspended: false,
    limits: server.limits,
    feature_limits: { databases: 0, allocations: 3, backups: 1 },
    user: server.provider_user_id,
    node: f.providerNodeId,
    allocation:
      allocations.find((allocation) => allocation.is_primary)?.pterodactyl_allocation_id ?? 0,
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  let state: Resources['current_state'] = 'offline';
  let processStart: string | null = null;
  let processClock = new Date();
  const power = vi.fn(async () => {
    state = 'running';
    processClock = new Date(processClock.getTime() + 1);
    processStart = processClock.toISOString();
  });
  const adapter = {
    getApplicationServer: vi.fn(async () => structuredClone(remote)),
    getResources: vi.fn(
      async (): Promise<Resources> => ({
        current_state: state,
        is_suspended: false,
        resources: {
          memory_bytes: 0,
          cpu_absolute: 0,
          disk_bytes: 0,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
          uptime: state === 'running' ? 100 : 0,
        },
      }),
    ),
    power,
    stopWithConfirmation: vi.fn(
      async (
        _applicationId: number,
        _identifier: string,
        callbacks: Parameters<PterodactylAdapter['stopWithConfirmation']>[2],
      ) => {
        expect(await callbacks.authorize()).toBe(true);
        await callbacks.beforePower?.();
        state = 'offline';
        processStart = null;
        await callbacks.onConfirmed();
        return { confirmed: true };
      },
    ),
  } as unknown as PterodactylAdapter;
  const options: LifecycleOptions = {
    adapter,
    now: () => processClock,
    settleMs: 0,
    authorizeEffect: async (jobId, id, db) => {
      await authorizeQueuedEffect(db, jobId, id);
    },
    reserveStart: (id, jobId, action, db) => reserveStart(db, id, jobId, action),
    observeProcessStart: async () => processStart,
    confirmAlreadyStopped: async () => state === 'offline',
  };
  const process = async (jobId: string) => {
    await f.db
      .updateTable('operation_jobs')
      .set({ next_attempt_at: new Date(0) })
      .where('id', '=', jobId)
      .execute();
    return processServerOperation(f.db, jobId, options);
  };
  return { options, power, process };
}

describe('durable generic schedules', () => {
  it.each([
    { name: 'no consent audit', intent: 'manually_stopped', events: [], paused: false },
    { name: 'latest explicit pause', intent: 'manually_stopped', events: [false], paused: true },
    { name: 'later grant', intent: 'manually_stopped', events: [false, true], paused: false },
    { name: 'later pause', intent: 'manually_stopped', events: [true, false], paused: true },
    { name: 'running intent', intent: 'auto_wake_enabled', events: [false], paused: false },
    {
      name: 'tied contradictory audit',
      intent: 'manually_stopped',
      events: [true, false],
      paused: false,
      tied: true,
    },
  ] as const)(
    'backfills pause conservatively for $name without repairing lifecycle',
    async (scenario) => {
      await allowStarts();
      await f.db
        .updateTable('managed_servers')
        .set({ intent: scenario.intent, runtime_state: 'running', readiness: 'ready' })
        .where('id', '=', serverId)
        .execute();
      for (const [index, allowed] of scenario.events.entries()) {
        await f.db
          .insertInto('audit_events')
          .values({
            id: randomUUID(),
            action: 'server.automation_consent.updated',
            actor_user_id: f.context.actorUserId,
            subject_user_id: f.context.subjectUserId,
            correlation_id: randomUUID(),
            metadata: { serverId, allowed },
            created_at: new Date(at.getTime() + ('tied' in scenario ? 0 : index * 1000)),
          })
          .execute();
      }
      const migration = await readFile(
        new URL('../../database/migrations/041_automatic_start_pause.sql', import.meta.url),
        'utf8',
      );
      // Reapply only in this suite's generated schema, then roll back the entire
      // schema change so the migration ledger and later tests remain consistent.
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        const before = await client.query('SELECT * FROM managed_servers WHERE id = $1', [
          serverId,
        ]);
        const gateway = await client.query(
          'SELECT * FROM gateway_server_states WHERE server_id = $1',
          [serverId],
        );
        await client.query('ALTER TABLE managed_servers DROP COLUMN automatic_starts_paused');
        await client.query(migration);
        const after = await client.query('SELECT * FROM managed_servers WHERE id = $1', [serverId]);
        expect(after.rows[0]).toEqual({
          ...before.rows[0],
          automatic_starts_paused: scenario.paused,
        });
        expect(
          (
            await client.query('SELECT * FROM gateway_server_states WHERE server_id = $1', [
              serverId,
            ])
          ).rows,
        ).toEqual(gateway.rows);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    },
  );

  it('pauses and resumes automatic starts without disturbing ready runtime or Gateway state', async () => {
    await allowStarts();
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'auto_wake_enabled', runtime_state: 'running', readiness: 'ready' })
      .where('id', '=', serverId)
      .execute();
    await f.db
      .updateTable('gateway_server_states')
      .set({ state: 'online', readiness_observed_at: at, idle_since: at })
      .where('server_id', '=', serverId)
      .execute();
    const policy = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    for (const allowed of [false, true]) {
      expect(
        await setAutomationConsent(f.db, f.context, serverId, {
          allowed,
          expectedAllowed: !allowed,
          expectedIntent: 'auto_wake_enabled',
        }),
      ).toMatchObject({ allowed, expectedIntent: 'auto_wake_enabled' });
      expect(
        await f.db
          .selectFrom('managed_servers')
          .select(['intent', 'runtime_state', 'readiness', 'automatic_starts_paused'])
          .where('id', '=', serverId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        intent: 'auto_wake_enabled',
        runtime_state: 'running',
        readiness: 'ready',
        automatic_starts_paused: !allowed,
      });
      expect(
        await f.db
          .selectFrom('gateway_server_states')
          .selectAll()
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow(),
      ).toEqual(policy);
    }
  });

  it('rejects missing or stale expected consent even when the lifecycle intent is unchanged', async () => {
    await allowStarts();
    const consent = await getAutomationConsent(f.db, f.context, serverId);
    await expect(
      setAutomationConsent(f.db, f.context, serverId, {
        allowed: false,
        expectedIntent: consent.expectedIntent,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await setAutomationConsent(f.db, f.context, serverId, {
      allowed: false,
      expectedAllowed: true,
      expectedIntent: consent.expectedIntent,
    });
    await expect(
      setAutomationConsent(f.db, f.context, serverId, {
        allowed: true,
        expectedAllowed: true,
        expectedIntent: consent.expectedIntent,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await getAutomationConsent(f.db, f.context, serverId)).toMatchObject({
      allowed: false,
      expectedIntent: consent.expectedIntent,
    });
  });

  it.each(['start', 'restart'])('skips a paused scheduled %s before admission', async (action) => {
    await allowStarts();
    const consent = await getAutomationConsent(f.db, f.context, serverId);
    await setAutomationConsent(f.db, f.context, serverId, {
      allowed: false,
      expectedAllowed: true,
      expectedIntent: consent.expectedIntent,
    });
    const schedule = await create({ action });
    expect(await due()).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(schedule.id)).items[0]).toMatchObject({
      reason: 'manual_stop_suppressed',
      jobId: null,
    });
  });

  it('preserves queued sleep work and authorizes scheduled stops while starts are paused', async () => {
    await allowStarts();
    const schedule = await create({ action: 'stop' });
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    const jobId = await jobOf(schedule.id);
    const policy = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const consent = await getAutomationConsent(f.db, f.context, serverId);
    await setAutomationConsent(f.db, f.context, serverId, {
      allowed: false,
      expectedAllowed: consent.allowed,
      expectedIntent: consent.expectedIntent,
    });
    expect(
      await f.db
        .selectFrom('gateway_server_states')
        .selectAll()
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual(policy);
    expect(policy.sleep_job_id).toBe(jobId);
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).resolves.toMatchObject({
      sessionType: 'regular',
    });
    expect(await getAutomationConsent(f.db, f.context, serverId)).toMatchObject({
      allowed: false,
      expectedIntent: 'sleeping',
    });
    await expect(
      setAutomationConsent(f.db, f.context, serverId, {
        allowed: true,
        expectedAllowed: false,
        expectedIntent: 'sleeping',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('admits a scheduled stop after automatic starts have already been paused', async () => {
    await allowStarts();
    const consent = await getAutomationConsent(f.db, f.context, serverId);
    await setAutomationConsent(f.db, f.context, serverId, {
      allowed: false,
      expectedAllowed: true,
      expectedIntent: consent.expectedIntent,
    });
    const schedule = await create({ action: 'stop' });
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    await expect(
      authorizeQueuedEffect(f.db, await jobOf(schedule.id), serverId),
    ).resolves.toMatchObject({ sessionType: 'regular' });
  });

  it('keeps direct scheduled starts independent of stale Gateway policy', async () => {
    await allowStarts();
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'direct' })
      .where('id', '=', serverId)
      .execute();
    expect(await getAutomationConsent(f.db, f.context, serverId)).toMatchObject({
      allowed: true,
      gatewayConfigured: false,
      gatewayEnabled: false,
    });
    const before = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const consent = await getAutomationConsent(f.db, f.context, serverId);
    await setAutomationConsent(f.db, f.context, serverId, {
      allowed: false,
      expectedAllowed: consent.allowed,
      expectedIntent: consent.expectedIntent,
    });
    expect(
      await f.db
        .selectFrom('gateway_server_states')
        .selectAll()
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    await setAutomationConsent(f.db, f.context, serverId, {
      allowed: true,
      expectedAllowed: false,
      expectedIntent: consent.expectedIntent,
    });
    const schedule = await create({ action: 'start' });
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    await expect(
      authorizeQueuedEffect(f.db, await jobOf(schedule.id), serverId),
    ).resolves.toMatchObject({ subjectUserId: f.context.subjectUserId });
  });
  it('requires explicit automatic-start consent without inventing Gateway policy', async () => {
    expect(await getAutomationConsent(f.db, f.context, serverId)).toMatchObject({
      allowed: false,
      gatewayConfigured: false,
    });
    await create({ action: 'start' });
    expect((await getAutomationConsent(f.db, f.context, serverId)).allowed).toBe(false);
    expect(
      await setAutomationConsent(f.db, f.context, serverId, {
        allowed: true,
        expectedAllowed: false,
        expectedIntent: 'manually_stopped',
      }),
    ).toMatchObject({ allowed: true, gatewayConfigured: false, gatewayEnabled: false });
    expect(
      await f.db
        .selectFrom('gateway_server_states')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
  });

  it.each(['gateway', 'direct'] as const)(
    'revokes a queued %s start and forbids rearm until the old job safely settles',
    async (connectionMode) => {
      await f.db
        .updateTable('managed_servers')
        .set({ connection_mode: connectionMode })
        .where('id', '=', serverId)
        .execute();
      if (connectionMode === 'gateway') await allowStarts();
      const initialConsent = await getAutomationConsent(f.db, f.context, serverId);
      await setAutomationConsent(f.db, f.context, serverId, {
        allowed: true,
        expectedAllowed: initialConsent.allowed,
        expectedIntent: initialConsent.expectedIntent,
      });
      const schedule = await create({ action: 'start' });
      await due();
      const jobId = await jobOf(schedule.id);
      const consent = await getAutomationConsent(f.db, f.context, serverId);
      await setAutomationConsent(f.db, f.context, serverId, {
        allowed: false,
        expectedAllowed: consent.allowed,
        expectedIntent: consent.expectedIntent,
      });
      await expect(authorizeQueuedEffect(f.db, jobId, serverId)).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(
        setAutomationConsent(f.db, f.context, serverId, {
          allowed: true,
          expectedAllowed: false,
          expectedIntent: consent.expectedIntent,
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      const fixture = await lifecycleFixture();
      expect(await fixture.process(jobId)).toBe('failed');
      expect(fixture.power).not.toHaveBeenCalled();
      expect(
        (
          await setAutomationConsent(f.db, f.context, serverId, {
            allowed: true,
            expectedAllowed: false,
            expectedIntent: consent.expectedIntent,
          })
        ).allowed,
      ).toBe(true);
      expect(await fixture.process(jobId)).toBe('duplicate');
      expect(fixture.power).not.toHaveBeenCalled();
    },
  );

  it('cannot use consent to enable a disabled Gateway or bypass maintenance/uploads', async () => {
    await allowStarts();
    await f.db
      .updateTable('gateway_server_states')
      .set({ enabled: false })
      .where('server_id', '=', serverId)
      .execute();
    const before = await getAutomationConsent(f.db, f.context, serverId);
    expect(
      (
        await setAutomationConsent(f.db, f.context, serverId, {
          allowed: true,
          expectedAllowed: before.allowed,
          expectedIntent: before.expectedIntent,
        })
      ).gatewayEnabled,
    ).toBe(false);
    await pendingUploadFixture(f.db, serverId);
    const current = await getAutomationConsent(f.db, f.context, serverId);
    expect(current.grantBlockedReason).toBe('upload_pending');
    await expect(
      setAutomationConsent(f.db, f.context, serverId, {
        allowed: true,
        expectedAllowed: current.allowed,
        expectedIntent: current.expectedIntent,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'maintenance' })
      .where('id', '=', serverId)
      .execute();
    expect(
      (
        await setAutomationConsent(f.db, f.context, serverId, {
          allowed: false,
          expectedAllowed: false,
          expectedIntent: 'maintenance',
        })
      ).expectedIntent,
    ).toBe('maintenance');
    await expect(
      setAutomationConsent(f.db, f.context, serverId, {
        allowed: true,
        expectedAllowed: false,
        expectedIntent: 'maintenance',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('requires regular current manager authority and protects list/outcome scopes', async () => {
    const other = await managementFixture(f.db, { interactive: true });
    await expect(createSchedule(f.db, other.context, serverId, input())).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      createSchedule(f.db, { ...f.context, sessionType: 'support' }, serverId, input()),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const schedule = await create();
    await expect(listSchedules(f.db, other.context, serverId)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      listScheduleOutcomes(f.db, other.context, serverId, schedule.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await f.db
      .deleteFrom('session')
      .where('id', '=', f.context[authSessionId] ?? '')
      .execute();
    await expect(
      updateSchedule(f.db, f.context, serverId, schedule.id, { ...input(), revision: 1 }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('updates with revision checks and soft deletion retains outcomes without replay', async () => {
    const schedule = await create();
    const changed = await updateSchedule(f.db, f.context, serverId, schedule.id, {
      ...input({ enabled: false }),
      revision: 1,
    });
    expect(changed.revision).toBe(2);
    await expect(
      updateSchedule(f.db, f.context, serverId, schedule.id, { ...input(), revision: 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await due()).toEqual({ dispatched: 0, skipped: 0 });
    await updateSchedule(f.db, f.context, serverId, schedule.id, { ...input(), revision: 2 });
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    await deleteSchedule(f.db, f.context, serverId, schedule.id, { revision: 3 });
    expect(await listSchedules(f.db, f.context, serverId)).toEqual([]);
    expect((await outcomes(schedule.id)).items).toHaveLength(1);
    expect(await due()).toEqual({ dispatched: 0, skipped: 0 });
  });

  it('admits one occurrence/job under simultaneous workers and fresh-process recovery', async () => {
    const schedule = await create();
    const results = await Promise.all(Array.from({ length: 6 }, () => due()));
    expect(results.reduce((sum, result) => sum + result.dispatched, 0)).toBe(1);
    const jobId = await jobOf(schedule.id);
    expect(
      await f.db
        .selectFrom('job_outbox')
        .select('job_id')
        .where('job_id', '=', jobId)
        .executeTakeFirst(),
    ).toBeDefined();
    const reopened = createDatabase(process.env.NH_TEST_DATABASE_URL ?? '', {
      options: `-c search_path=${database.schema}`,
    });
    try {
      expect(await runDueSchedules(reopened.db, {}, { now: at })).toEqual({
        dispatched: 0,
        skipped: 0,
      });
    } finally {
      await reopened.db.destroy();
    }
    expect((await outcomes(schedule.id)).items).toHaveLength(1);
  });

  it('rolls back occurrence, next due and lifecycle job together on transaction failure', async () => {
    const schedule = await create();
    await database.pool.query(
      "CREATE FUNCTION fail_schedule_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated rollback fixture'; END $$",
    );
    await database.pool.query(
      'CREATE TRIGGER fail_schedule_fixture BEFORE INSERT ON schedule_occurrences FOR EACH ROW EXECUTE FUNCTION fail_schedule_fixture()',
    );
    try {
      const onError = vi.fn();
      expect(await runDueSchedules(f.db, {}, { now: at, onError })).toEqual({
        dispatched: 0,
        skipped: 0,
        failures: 1,
      });
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      await database.pool.query('DROP TRIGGER fail_schedule_fixture ON schedule_occurrences');
    }
    expect((await outcomes(schedule.id)).items).toEqual([]);
    expect(
      (
        await f.db
          .selectFrom('managed_servers')
          .select('active_operation_id')
          .where('id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).active_operation_id,
    ).toBeNull();
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
  });

  it('skips manual-stop and maintenance without weakening consent', async () => {
    const schedule = await create({ action: 'start' });
    expect(await due()).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(schedule.id)).items[0]?.reason).toBe('manual_stop_suppressed');
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'maintenance' })
      .where('id', '=', serverId)
      .execute();
    const restart = await create({ action: 'restart' });
    expect(await due()).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(restart.id)).items[0]?.reason).toBe('manual_stop_suppressed');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('refuses capacity immediately and never retries that occurrence after capacity returns', async () => {
    await allowStarts();
    const schedule = await create({ action: 'start' });
    await f.observe({ availableMemoryMiB: 128 });
    expect(await due()).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(schedule.id)).items[0]?.reason).toBe('resources_unavailable');
    await f.observe();
    expect(await due()).toEqual({ dispatched: 0, skipped: 0 });
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('retains only the newest interval due and reports missed/late occurrences', async () => {
    const schedule = await create({
      timing: { kind: 'interval', firstAt: at.toISOString(), everySeconds: 600 },
    });
    expect(await due(new Date(at.getTime() + 3_600_000))).toEqual({ dispatched: 1, skipped: 0 });
    expect((await outcomes(schedule.id)).items[0]).toMatchObject({ missedCount: 6 });
    const late = await create();
    expect(await due(new Date(at.getTime() + 360_000))).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(late.id)).items[0]?.reason).toBe('schedule_late');
  });

  it('revokes delegated creator permissions both before enqueue and before effect', async () => {
    const actor = await managementFixture(f.db, { interactive: true });
    const projectId = randomUUID();
    await f.db
      .insertInto('projects')
      .values({ id: projectId, owner_id: f.context.actorUserId, name: 'isolated project' })
      .execute();
    await f.db
      .insertInto('project_members')
      .values({ project_id: projectId, user_id: actor.context.actorUserId, role: 'manager' })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ project_id: projectId })
      .where('id', '=', serverId)
      .execute();
    const first = await createSchedule(f.db, actor.context, serverId, input());
    await f.db
      .updateTable('project_members')
      .set({ role: 'operator' })
      .where('project_id', '=', projectId)
      .execute();
    expect(await due()).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(first.id)).items[0]?.reason).toBe('forbidden');
    await f.db
      .updateTable('project_members')
      .set({ role: 'manager' })
      .where('project_id', '=', projectId)
      .execute();
    const second = await createSchedule(f.db, actor.context, serverId, input());
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    const jobId = await jobOf(second.id);
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).resolves.toMatchObject({
      sessionType: 'regular',
    });
    await f.db.deleteFrom('project_members').where('project_id', '=', projectId).execute();
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('fences paused starts and refuses rearm while an older admitted start remains active', async () => {
    await allowStarts();
    const schedule = await create({ action: 'start' });
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    const jobId = await jobOf(schedule.id);
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).resolves.toMatchObject({
      sessionType: 'regular',
    });
    const consent = await getAutomationConsent(f.db, f.context, serverId);
    await setAutomationConsent(f.db, f.context, serverId, {
      allowed: false,
      expectedAllowed: consent.allowed,
      expectedIntent: consent.expectedIntent,
    });
    await expect(
      setAutomationConsent(f.db, f.context, serverId, {
        allowed: true,
        expectedAllowed: false,
        expectedIntent: consent.expectedIntent,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('scheduled stop preserves consent for later starts', async () => {
    await allowStarts();
    const schedule = await create({ action: 'stop' });
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    await expect(
      authorizeQueuedEffect(f.db, await jobOf(schedule.id), serverId),
    ).resolves.toMatchObject({ sessionType: 'regular' });
    expect(
      (
        await f.db
          .selectFrom('managed_servers')
          .select('intent')
          .where('id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).intent,
    ).toBe('sleeping');
    expect(
      (
        await f.db
          .selectFrom('gateway_server_states')
          .select('state')
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('sleeping');
    const next = await create({ action: 'start' });
    expect(await due()).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(next.id)).items[0]?.reason).toBe('conflict');
  });

  it('a conflicting scheduled stop does not revoke an already admitted start', async () => {
    await allowStarts();
    const start = await create({ action: 'start' });
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    const startJob = await jobOf(start.id);
    const stop = await create({ action: 'stop' });
    expect(await due()).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(stop.id)).items[0]?.reason).toBe('conflict');
    await expect(authorizeQueuedEffect(f.db, startJob, serverId)).resolves.toMatchObject({
      sessionType: 'regular',
    });
    expect(
      (
        await f.db
          .selectFrom('managed_servers')
          .select('intent')
          .where('id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).intent,
    ).toBe('auto_wake_enabled');
  });

  it('reauthorizes after prepared intent and prevents any provider call after disable', async () => {
    await allowStarts();
    const schedule = await create({ action: 'start' });
    await due();
    const jobId = await jobOf(schedule.id);
    const fixture = await lifecycleFixture();
    fixture.options.checkpoint = async (stage) => {
      if (stage === 'prepared')
        await updateSchedule(f.db, f.context, serverId, schedule.id, {
          ...input({ action: 'start', enabled: false }),
          revision: 1,
        });
    };
    expect(await fixture.process(jobId)).toBe('failed');
    expect(fixture.power).not.toHaveBeenCalled();
    expect((await outcomes(schedule.id)).items[0]).toMatchObject({
      jobState: 'failed',
      errorCode: 'forbidden',
      effectState: 'none',
    });
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('keeps reservations and reconciles a remotely successful lost response after disable', async () => {
    await allowStarts();
    const schedule = await create({ action: 'start' });
    await due();
    const jobId = await jobOf(schedule.id);
    const fixture = await lifecycleFixture();
    fixture.options.checkpoint = async (stage) => {
      if (stage === 'remote_succeeded') {
        await updateSchedule(f.db, f.context, serverId, schedule.id, {
          ...input({ action: 'start', enabled: false }),
          revision: 1,
        });
        throw new Error('isolated crash after remote effect');
      }
    };
    expect(await fixture.process(jobId)).toBe('waiting');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst(),
    ).toBeDefined();
    fixture.options.checkpoint = undefined;
    const recovered = await fixture.process(jobId);
    const detail = await f.db
      .selectFrom('server_operations')
      .select('plan')
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    const failedJob = await f.db
      .selectFrom('operation_jobs')
      .select('error_code')
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect({ recovered, reason: detail.plan.waitReason, error: failedJob.error_code }).toEqual({
      recovered: 'succeeded',
      reason: null,
      error: null,
    });
    expect(fixture.power).toHaveBeenCalledTimes(1);
    expect((await outcomes(schedule.id)).items[0]?.jobState).toBe('succeeded');
    expect(
      (
        await f.db
          .selectFrom('resource_reservations')
          .select('state')
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('running');
  });
});

it('persists backup options and disabled-by-default retention through scheduled dispatch', async () => {
  const schedule = await create({
    backupOptions: {
      name: 'Before maintenance',
      ignored: 'cache/**',
      isLocked: true,
      mode: 'offline',
    },
  });
  expect(schedule.backupOptions).toEqual({
    name: 'Before maintenance',
    ignored: 'cache/**',
    isLocked: true,
    mode: 'offline',
  });
  expect(schedule.retention).toEqual({ enabled: false, keepLast: 7 });
  expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
  const jobId = await jobOf(schedule.id);
  const operation = await f.db
    .selectFrom('server_operations')
    .select('plan')
    .where('job_id', '=', jobId)
    .executeTakeFirstOrThrow();
  expect(operation.plan.backupOptions).toEqual(schedule.backupOptions);
  expect(operation.plan.scheduleAutomation).toMatchObject({
    scheduleId: schedule.id,
    retention: { enabled: false, keepLast: 7 },
  });
});

it('requires a spare provider slot before enabling post-success retention', async () => {
  const mapping = await f.db
    .selectFrom('managed_servers as server')
    .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
    .select('mapping.feature_limits')
    .where('server.id', '=', serverId)
    .executeTakeFirstOrThrow();
  await expect(
    create({ retention: { enabled: true, keepLast: mapping.feature_limits.backups } }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
});

it('requires a new future time to reactivate a consumed one-shot', async () => {
  const schedule = await create();
  await due();
  expect((await listSchedules(f.db, f.context, serverId))[0]?.status).toBe('completed');
  await updateSchedule(f.db, f.context, serverId, schedule.id, {
    ...input({ enabled: false }),
    revision: 1,
  });
  await expect(
    updateSchedule(f.db, f.context, serverId, schedule.id, { ...input(), revision: 2 }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
});

it('runs a paused schedule explicitly once without consuming its next recurrence', async () => {
  const schedule = await create({ enabled: false, timing: { kind: 'daily', localTime: '04:00' } });
  const body = { revision: 1, idempotencyKey: 'manual_fixture_request' };
  const [one, two] = await Promise.all([
    runScheduleNow(f.db, f.context, serverId, schedule.id, body),
    runScheduleNow(f.db, f.context, serverId, schedule.id, body),
  ]);
  expect(one).toEqual(two);
  expect(one?.status).toBe('dispatched');
  const after = (await listSchedules(f.db, f.context, serverId))[0];
  expect(after?.nextRunAt).toEqual(schedule.nextRunAt);
  expect(after?.enabled).toBe(false);
  expect(after?.lastOutcome?.jobId).toBe(one?.jobId);
  expect((await outcomes(schedule.id)).items).toHaveLength(1);
  expect((await outcomes(schedule.id)).items[0]).toMatchObject({
    trigger: 'manual',
    requesterId: f.context.actorUserId,
  });
  await expect(authorizeQueuedEffect(f.db, one?.jobId as string, serverId)).resolves.toMatchObject({
    sessionType: 'regular',
  });
  await expect(
    runScheduleNow(f.db, f.context, serverId, schedule.id, { ...body, revision: 2 }),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it('preview has server access scope and remains read-only', async () => {
  const result = await previewSchedule(f.db, f.context, serverId, {
    timing: { kind: 'weekly', localTime: '03:00', weekdays: [1, 4] },
    timeZone: 'Europe/Rome',
  });
  expect(result.nextRuns).toHaveLength(5);
  expect(await listSchedules(f.db, f.context, serverId)).toEqual([]);
  const other = await managementFixture(f.db, { interactive: true });
  await expect(
    previewSchedule(f.db, other.context, serverId, {
      timing: { kind: 'daily', localTime: '03:00' },
      timeZone: 'UTC',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('keeps original creator separate from the manager authorizing an edit', async () => {
  const schedule = await create();
  const actor = await managementFixture(f.db, { interactive: true });
  const projectId = randomUUID();
  await f.db
    .insertInto('projects')
    .values({ id: projectId, owner_id: f.context.actorUserId, name: 'delegated calendar' })
    .execute();
  await f.db
    .insertInto('project_members')
    .values({ project_id: projectId, user_id: actor.context.actorUserId, role: 'manager' })
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ project_id: projectId })
    .where('id', '=', serverId)
    .execute();
  const changed = await updateSchedule(f.db, actor.context, serverId, schedule.id, {
    ...input(),
    revision: 1,
  });
  expect(changed.creatorId).toBe(f.context.actorUserId);
  expect(changed.authorizerId).toBe(actor.context.actorUserId);
  expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
  const job = await f.db
    .selectFrom('operation_jobs')
    .select('actor_id')
    .where('id', '=', await jobOf(schedule.id))
    .executeTakeFirstOrThrow();
  expect(job.actor_id).toBe(actor.context.actorUserId);
});

it('a failing candidate rolls back alone and does not block a different server', async () => {
  const broken = await create();
  const other = await f.server();
  const good = await createSchedule(f.db, f.context, other, input());
  await database.pool.query(
    `CREATE FUNCTION fail_one_schedule_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.schedule_id = '${broken.id}'::uuid THEN RAISE EXCEPTION 'isolated candidate'; END IF; RETURN NEW; END $$`,
  );
  await database.pool.query(
    'CREATE TRIGGER fail_one_schedule_fixture BEFORE INSERT ON schedule_occurrences FOR EACH ROW EXECUTE FUNCTION fail_one_schedule_fixture()',
  );
  try {
    expect(await due()).toEqual({ dispatched: 1, skipped: 0, failures: 1 });
    expect((await outcomes(broken.id)).items).toEqual([]);
    expect((await listScheduleOutcomes(f.db, f.context, other, good.id)).items[0]?.status).toBe(
      'dispatched',
    );
  } finally {
    await database.pool.query('DROP TRIGGER fail_one_schedule_fixture ON schedule_occurrences');
  }
});

it('history separates a completed backup from failed resumption and retention', async () => {
  const schedule = await create();
  await due();
  await f.db
    .updateTable('server_operations')
    .set({
      plan: JSON.stringify({
        backupComplete: true,
        backupResumeOutcome: 'failed',
        backupRetentionError: 'provider_unavailable',
      }),
    })
    .where('job_id', '=', await jobOf(schedule.id))
    .execute();
  expect((await outcomes(schedule.id)).items[0]?.backupResult).toEqual({
    state: 'succeeded',
    resume: 'failed',
    cleanupFailed: false,
    retentionFailed: true,
  });
});

it('confirmed scheduled shutdown returns to sleeping and allows the next admitted start', async () => {
  await allowStarts();
  const fixture = await lifecycleFixture();
  const start = await create({ action: 'start' });
  expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
  const startJob = await jobOf(start.id);
  expect(await fixture.process(startJob)).toBe('waiting');
  expect(await fixture.process(startJob)).toBe('succeeded');
  const stop = await create({ action: 'stop' });
  expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
  expect(await fixture.process(await jobOf(stop.id))).toBe('succeeded');
  const server = await f.db
    .selectFrom('managed_servers')
    .select(['intent', 'runtime_state'])
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  expect(server).toEqual({ intent: 'sleeping', runtime_state: 'offline' });
  const gateway = await f.db
    .selectFrom('gateway_server_states')
    .select(['state', 'sleep_job_id'])
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  expect(gateway).toEqual({ state: 'sleeping', sleep_job_id: null });
  await f.observe();
  const next = await create({ action: 'start' });
  expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
  await expect(authorizeQueuedEffect(f.db, await jobOf(next.id), serverId)).resolves.toMatchObject({
    sessionType: 'regular',
  });
});
