import { randomUUID } from 'node:crypto';
import { createLogger } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  getGatewayState,
  type ManagementRuntime,
  setGatewayPolicy,
} from '@nickhosting/server-management';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { reconcileServers } from './reconcile.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
it('retired and invalid Gateway states cannot starve other servers or external recovery', async () => {
  const f = await managementFixture(database.db, { interactive: true });
  const ids = await Promise.all([f.server(), f.server(), f.server()]);
  for (const id of ids)
    await setGatewayPolicy(f.db, f.context, id, {
      enabled: true,
      protocolId: 'fixture',
      gameVersion: '1',
      idleTimeoutSeconds: null,
      readinessTimeoutSeconds: 1,
      readinessMaxAgeSeconds: 15,
      estimateMaxAgeSeconds: 60,
      wakeRetrySeconds: 1,
    });
  const [deleted, invalid, waiting] = ids;
  if (!deleted || !invalid || !waiting) throw new Error('Missing fixture');
  await f.db
    .updateTable('managed_servers')
    .set({ deleted_at: new Date() })
    .where('id', '=', deleted)
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ pterodactyl_uuid: null, pterodactyl_id: null, pterodactyl_identifier: null })
    .where('id', '=', invalid)
    .execute();
  await f.db
    .updateTable('gateway_server_states')
    .set({ state: 'waking', startup_deadline_at: new Date(Date.now() - 2000) })
    .where('server_id', '=', waiting)
    .execute();
  const reconcile = vi.fn(async () => ({ external: { failed: 0 }, unavailable: [] }));
  const events: unknown[] = [];
  await reconcileServers(
    f.db,
    async () => ({ reconcile }) as unknown as ManagementRuntime,
    createLogger((record) => events.push(record)),
    {},
  );
  expect(reconcile).toHaveBeenCalledOnce();
  expect((await getGatewayState(f.db, waiting)).state).not.toBe('waking');
  expect(JSON.stringify(events)).toContain(invalid);
  expect(JSON.stringify(events)).not.toContain(deleted);
  // A separate missing provider ID does not create/import a new server.
  expect(
    await f.db.selectFrom('managed_servers').selectAll().where('id', '=', randomUUID()).execute(),
  ).toEqual([]);
});

it('continues credential recovery after the last server is deleted', async () => {
  const isolated = await createTestDatabase();
  try {
    const f = await managementFixture(isolated.db, { interactive: true });
    const serverId = await f.server();
    await f.db
      .insertInto('external_sftp_credentials')
      .values({
        id: randomUUID(),
        server_id: serverId,
        actor_id: f.context.actorUserId,
        envelope: JSON.stringify({ fixture: true }),
        provider_ref: null,
        expires_at: new Date(Date.now() + 60_000),
        state: 'revoking',
      })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ deleted_at: new Date() })
      .where('id', '=', serverId)
      .execute();
    const reconcile = vi.fn(async () => ({ external: { failed: 0 }, unavailable: [] }));
    await reconcileServers(
      f.db,
      async () => ({ reconcile }) as unknown as ManagementRuntime,
      createLogger(() => {}),
      {},
    );
    expect(reconcile).toHaveBeenCalledOnce();
    await f.db.updateTable('external_sftp_credentials').set({ state: 'revoked' }).execute();
    reconcile.mockClear();
    await reconcileServers(
      f.db,
      async () => ({ reconcile }) as unknown as ManagementRuntime,
      createLogger(() => {}),
      {},
    );
    expect(reconcile).not.toHaveBeenCalled();
  } finally {
    await isolated.destroy();
  }
});

it('runs shared-host registration reconciliation before the first server exists', async () => {
  const isolated = await createTestDatabase();
  try {
    const f = await managementFixture(isolated.db, { interactive: true });
    const game = await f.db
      .selectFrom('game_integrations')
      .select('manifest')
      .where('id', '=', f.gameId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('game_integrations')
      .set({
        manifest: JSON.stringify({
          ...(game.manifest as Record<string, unknown>),
          connection: { mode: 'shared-host', defaultLabel: 'fixture', allowCustomSubdomain: false },
        }),
      })
      .where('id', '=', f.gameId)
      .execute();
    const reconcile = vi.fn(async () => ({ external: { failed: 0 }, unavailable: [] }));
    await reconcileServers(
      f.db,
      async () => ({ reconcile }) as unknown as ManagementRuntime,
      createLogger(() => {}),
      {},
    );
    expect(reconcile).toHaveBeenCalledOnce();
  } finally {
    await isolated.destroy();
  }
});

it('reconciles a consumed hostname claim when its server was deleted before DNS intent existed', async () => {
  const isolated = await createTestDatabase();
  try {
    const f = await managementFixture(isolated.db, { interactive: true });
    const serverId = await f.server();
    await f.db
      .insertInto('dns_hostname_reservations')
      .values({ hostname: 'orphan.example.test', owner_id: serverId, release_after: null })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ deleted_at: new Date() })
      .where('id', '=', serverId)
      .execute();
    const reconcile = vi.fn(async () => ({ external: { failed: 0 }, unavailable: [] }));
    await reconcileServers(
      f.db,
      async () => ({ reconcile }) as unknown as ManagementRuntime,
      createLogger(() => {}),
      {},
    );
    expect(reconcile).toHaveBeenCalledOnce();
  } finally {
    await isolated.destroy();
  }
});

it('uses one indexed due lookup for one or one hundred stable states and recovers only committed changes after restart', async () => {
  const isolated = await createTestDatabase();
  const url = process.env.NH_TEST_DATABASE_URL;
  if (!url) throw new Error('Missing isolated fixture database');
  const reopened = createDatabase(url, { options: `-c search_path=${isolated.schema}` });
  try {
    const f = await managementFixture(isolated.db);
    const warnings: unknown[] = [];
    const logger = createLogger((record) => warnings.push(record));
    const management = async () =>
      ({
        reconcile: async () => ({ external: { failed: 0 }, unavailable: [] }),
      }) as unknown as ManagementRuntime;
    let statements = 0;
    const db = reopened.db.withPlugin({
      transformQuery({ node }) {
        return node;
      },
      async transformResult({ result }) {
        statements++;
        return result;
      },
    });
    const poll = () => reconcileServers(db, management, logger, {});
    async function seed(n: number) {
      const result = await isolated.pool.query<{ id: string }>(
        `insert into managed_servers
        (id,owner_id,mapping_id,node_id,name,external_id,limits,pterodactyl_id,pterodactyl_uuid,pterodactyl_identifier,installation_state,runtime_state,intent)
        select gen_random_uuid(), $1,$2,$3,'Gateway fixture', gen_random_uuid()::text, $4::jsonb,g+1000,gen_random_uuid(),gen_random_uuid()::text,
          'installed','offline','sleeping' from generate_series($5::integer,$6::integer) g returning id`,
        [
          f.context.subjectUserId,
          f.mappingId,
          f.nodeId,
          JSON.stringify(f.limits),
          n === 1 ? 1 : 2,
          n,
        ],
      );
      const ids = result.rows.map((r) => r.id);
      await isolated.pool.query(
        `insert into gateway_server_states
        (server_id,generation,enabled,protocol_id,game_version,state,readiness_timeout_seconds,readiness_max_age_seconds,estimate_max_age_seconds,wake_retry_seconds)
        select id,gen_random_uuid(),true,'fixture','1','sleeping',30,15,60,1 from unnest($1::uuid[]) id`,
        [ids],
      );
      return ids[0];
    }
    const target = await seed(1);
    if (!target) throw new Error('Missing fixture state');
    await poll();
    expect(statements).toBe(3);
    await seed(100);
    statements = 0;
    await poll();
    expect(statements).toBe(3);
    // Harmless provider observations update this timestamp in every sweep.
    await f.db.updateTable('managed_servers').set({ updated_at: new Date() }).execute();
    statements = 0;
    await poll();
    expect(statements).toBe(3);

    // Producers commit while no worker is running. Another process observes and
    // repairs the mismatch, then leaves an empty due index on its next tick.
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'maintenance' })
      .where('id', '=', target)
      .execute();
    await poll();
    expect((await getGatewayState(f.db, target)).state).toBe('maintenance');
    expect(
      (
        await f.db
          .selectFrom('gateway_server_states')
          .select('state')
          .where('server_id', '=', target)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('maintenance');
    await poll();
    statements = 0;
    await poll();
    expect(statements).toBe(3);

    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'auto_wake_enabled', runtime_state: 'running' })
      .where('id', '=', target)
      .execute();
    const t0 = new Date(Date.now() - 10_000);
    await f.db
      .updateTable('gateway_server_states')
      .set({ state: 'online', process_started_at: t0.toISOString(), readiness_observed_at: t0 })
      .where('server_id', '=', target)
      .execute();
    await poll();
    const heartbeat = new Date();
    await f.db
      .updateTable('gateway_server_states')
      .set({ readiness_observed_at: heartbeat })
      .where('server_id', '=', target)
      .execute();
    const timer = await isolated.pool.query<{ due_at: Date; pending: boolean }>(
      'select due_at,pending from gateway_reconciliation where server_id=$1',
      [target],
    );
    expect(timer.rows[0]?.pending).toBe(false);
    expect(timer.rows[0]?.due_at.getTime()).toBe(heartbeat.getTime() + 15_001);
    statements = 0;
    await poll();
    expect(statements).toBe(3);
    // The drainer already selected the expired revision when a producer renews
    // its evidence. It must recheck after acquiring the domain lock.
    const producer = await isolated.pool.connect();
    let inFlight: Promise<void> | undefined;
    try {
      await f.db
        .updateTable('gateway_server_states')
        .set({ readiness_observed_at: new Date(Date.now() - 20_000) })
        .where('server_id', '=', target)
        .execute();
      await producer.query('BEGIN');
      await producer.query(
        "select pg_advisory_xact_lock(hashtextextended(current_schema() || ':resources',0))",
      );
      const selected = Promise.withResolvers<void>();
      let reads = 0;
      const paused = db.withPlugin({
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          if (++reads === 2) selected.resolve();
          return result;
        },
      });
      inFlight = reconcileServers(paused, management, logger, {});
      await Promise.race([selected.promise, inFlight]);
      await producer.query(
        'update gateway_server_states set readiness_observed_at=now() where server_id=$1',
        [target],
      );
      await producer.query('COMMIT');
    } catch (error) {
      await producer.query('ROLLBACK');
      throw error;
    } finally {
      producer.release();
      await inFlight;
    }
    expect((await getGatewayState(f.db, target)).state).toBe('online');
    statements = 0;
    await poll();
    expect(statements).toBe(3);
    await f.db
      .updateTable('gateway_server_states')
      .set({ readiness_observed_at: new Date(Date.now() - 20_000) })
      .where('server_id', '=', target)
      .execute();
    await poll();
    expect(
      (
        await f.db
          .selectFrom('gateway_server_states')
          .select('state')
          .where('server_id', '=', target)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('blocked');
    expect(warnings).toEqual([]);
  } finally {
    await reopened.db.destroy();
    await isolated.destroy();
  }
});

it('finishes a committed sleep only after job success, confirmed offline state and reservation release', async () => {
  const isolated = await createTestDatabase();
  try {
    const f = await managementFixture(isolated.db, { interactive: true });
    const id = await f.server();
    await setGatewayPolicy(f.db, f.context, id, {
      enabled: true,
      protocolId: 'fixture',
      gameVersion: '1',
      idleTimeoutSeconds: null,
      readinessTimeoutSeconds: 20,
      readinessMaxAgeSeconds: 15,
      estimateMaxAgeSeconds: 60,
      wakeRetrySeconds: 1,
    });
    const job = randomUUID();
    await f.db
      .insertInto('operation_jobs')
      .values({
        id: job,
        actor_id: f.context.actorUserId,
        subject_id: f.context.subjectUserId,
        resource_owner_id: f.context.subjectUserId,
        idempotency_key: randomUUID(),
        command_hash: '0'.repeat(64),
        max_attempts: 1,
        command: '{}',
        policy_snapshot: '{}',
        state: 'running',
      })
      .execute();
    await f.db
      .insertInto('resource_reservations')
      .values({
        server_id: id,
        owner_id: f.context.subjectUserId,
        physical_host_id: f.hostId,
        memory_mib: 128,
        physical_memory_mib: 148,
        cpu_percent: 10,
        state: 'running',
        operation_id: job,
      })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'sleeping', runtime_state: 'offline' })
      .where('id', '=', id)
      .execute();
    await f.db
      .updateTable('gateway_server_states')
      .set({ state: 'blocked', sleep_job_id: job })
      .where('server_id', '=', id)
      .execute();
    const warnings: unknown[] = [];
    const poll = () =>
      reconcileServers(
        f.db,
        async () =>
          ({
            reconcile: async () => ({ external: { failed: 0 }, unavailable: [] }),
          }) as unknown as ManagementRuntime,
        createLogger((r) => warnings.push(r)),
        {},
      );
    const parked = async () =>
      expect(
        (
          await isolated.pool.query(
            'select due_at from gateway_reconciliation where server_id=$1',
            [id],
          )
        ).rows[0]?.due_at,
      ).toBeNull();
    await poll();
    await parked();
    await f.db
      .updateTable('operation_jobs')
      .set({ state: 'succeeded', completed_at: new Date() })
      .where('id', '=', job)
      .execute();
    await poll();
    await parked();
    const state = () =>
      f.db
        .selectFrom('gateway_server_states')
        .select(['state', 'sleep_job_id'])
        .where('server_id', '=', id)
        .executeTakeFirstOrThrow();
    expect(await state()).toEqual({ state: 'blocked', sleep_job_id: job });
    await f.db.deleteFrom('resource_reservations').where('server_id', '=', id).execute();
    await poll();
    expect(await state()).toEqual({ state: 'sleeping', sleep_job_id: null });
    expect(warnings).toEqual([]);
  } finally {
    await isolated.destroy();
  }
});
