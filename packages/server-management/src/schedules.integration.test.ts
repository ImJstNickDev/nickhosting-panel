import { randomUUID } from 'node:crypto';
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
  runDueSchedules,
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
    user: 1,
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
  const power = vi.fn(async () => {
    state = 'running';
    processStart = new Date().toISOString();
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
  } as unknown as PterodactylAdapter;
  const options: LifecycleOptions = {
    adapter,
    settleMs: 0,
    authorizeEffect: async (jobId, id, db) => {
      await authorizeQueuedEffect(db, jobId, id);
    },
    reserveStart: (id, jobId, action, db) => reserveStart(db, id, jobId, action),
    observeProcessStart: async () => processStart,
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

  it('revokes a queued start and forbids rearm until the old job safely settles', async () => {
    await setAutomationConsent(f.db, f.context, serverId, {
      allowed: true,
      expectedIntent: 'manually_stopped',
    });
    const schedule = await create({ action: 'start' });
    await due();
    const jobId = await jobOf(schedule.id);
    const consent = await getAutomationConsent(f.db, f.context, serverId);
    await setAutomationConsent(f.db, f.context, serverId, {
      allowed: false,
      expectedIntent: consent.expectedIntent,
    });
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      setAutomationConsent(f.db, f.context, serverId, {
        allowed: true,
        expectedIntent: 'manually_stopped',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const fixture = await lifecycleFixture();
    expect(await fixture.process(jobId)).toBe('failed');
    expect(fixture.power).not.toHaveBeenCalled();
    expect(
      (
        await setAutomationConsent(f.db, f.context, serverId, {
          allowed: true,
          expectedIntent: 'manually_stopped',
        })
      ).allowed,
    ).toBe(true);
    expect(await fixture.process(jobId)).toBe('duplicate');
    expect(fixture.power).not.toHaveBeenCalled();
  });

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
          expectedIntent: 'maintenance',
        })
      ).expectedIntent,
    ).toBe('maintenance');
    await expect(
      setAutomationConsent(f.db, f.context, serverId, {
        allowed: true,
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
      await expect(due()).rejects.toThrow('isolated rollback fixture');
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

  it('fences manual-stop then rearm against an older admitted start', async () => {
    await allowStarts();
    const schedule = await create({ action: 'start' });
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    const jobId = await jobOf(schedule.id);
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).resolves.toMatchObject({
      sessionType: 'regular',
    });
    await allowStarts();
    await expect(authorizeQueuedEffect(f.db, jobId, serverId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('scheduled stop suppresses future scheduled starts until an explicit rearm', async () => {
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
    ).toBe('manually_stopped');
    expect(
      (
        await f.db
          .selectFrom('gateway_server_states')
          .select('state')
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('manually_stopped');
    const next = await create({ action: 'start' });
    expect(await due()).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(next.id)).items[0]?.reason).toBe('manual_stop_suppressed');
  });

  it('scheduled stop revokes a queued wake even when the stop itself conflicts', async () => {
    await allowStarts();
    const start = await create({ action: 'start' });
    expect(await due()).toEqual({ dispatched: 1, skipped: 0 });
    const startJob = await jobOf(start.id);
    const stop = await create({ action: 'stop' });
    expect(await due()).toEqual({ dispatched: 0, skipped: 1 });
    expect((await outcomes(stop.id)).items[0]?.reason).toBe('conflict');
    await expect(authorizeQueuedEffect(f.db, startJob, serverId)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(
      (
        await f.db
          .selectFrom('managed_servers')
          .select('intent')
          .where('id', '=', serverId)
          .executeTakeFirstOrThrow()
      ).intent,
    ).toBe('manually_stopped');
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
    expect(await fixture.process(jobId)).toBe('succeeded');
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
