import { randomUUID } from 'node:crypto';
import { DomainError, safeError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { parseCommand, processJob } from '@nickhosting/jobs';
import {
  type ApplicationServer,
  type BuildUpdate,
  type PterodactylAdapter,
  PterodactylError,
  provisionPlanSchema,
  type Resources,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { lockResources } from './admission.js';

type Server = Selectable<Database['managed_servers']>;
type Operation = Selectable<Database['server_operations']>;
type Result = 'succeeded' | 'failed' | 'waiting' | 'deferred' | 'duplicate' | 'missing';
export interface LifecycleOptions {
  adapter: PterodactylAdapter;
  /** Rechecks current actor, subject, support lifetime and project access before new effects. */
  authorizeEffect: (jobId: string, serverId: string, connection: Kysely<Database>) => Promise<void>;
  /** Fresh admission revalidation before a power effect, not an implicit reservation. */
  reserveStart?: (
    serverId: string,
    jobId: string,
    action: 'start' | 'restart',
    connection: Kysely<Database>,
  ) => Promise<void>;
  /** Revokes external access and DNS first; must itself reconcile uncertain effects. */
  beforeDelete?: (serverId: string, connection: Kysely<Database>) => Promise<void>;
  /** Deterministic clock/cache boundary for isolated tests. Never a user-configured setting. */
  now?: () => Date;
  settleMs?: number;
  /** Fault injection for tests; production must not provide this hook. */
  checkpoint?: (
    point: 'prepared' | 'remote_succeeded' | 'confirmed',
    operation: Operation,
  ) => Promise<void>;
}

const isMissing = (error: unknown) =>
  error instanceof PterodactylError && error.reason === 'not_found';
const installed = (remote: ApplicationServer) =>
  !remote.status && (remote.container.installed === true || remote.container.installed === 1);
const installationPending = (remote: ApplicationServer) =>
  remote.status === 'installing' || !remote.container.installed;
const nowOf = (options: LifecycleOptions) => options.now?.() ?? new Date();
const settleOf = (options: LifecycleOptions) => options.settleMs ?? 21_000;

/** A PostgreSQL session lock spans bounded provider calls but no DB transaction does. */
async function withServerLock<T>(
  db: Kysely<Database>,
  serverId: string,
  work: (connection: Kysely<Database>) => Promise<T>,
): Promise<T | 'deferred'> {
  return db.connection().execute(async (connection) => {
    const result = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`}, 0)) as acquired`.execute(
      connection,
    );
    if (!result.rows[0]?.acquired) return 'deferred';
    try {
      return await work(connection);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`}, 0))`.execute(
        connection,
      );
    }
  });
}

/** Every mutation checks all durable identity dimensions, including every owned allocation. */
export async function verifyManagedIdentity(
  db: Kysely<Database>,
  server: Server,
  remote: ApplicationServer,
  provisioning = false,
): Promise<void> {
  const node = await db
    .selectFrom('managed_nodes')
    .selectAll()
    .where('id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  const allocations = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', server.id)
    .execute();
  const primary = allocations.find((allocation) => allocation.is_primary);
  const reported = remote.relationships?.allocations?.data.map((item) => item.attributes.id);
  const expected = allocations.map((allocation) => allocation.pterodactyl_allocation_id);
  if (
    !primary ||
    !reported ||
    reported.length !== expected.length ||
    expected.some((id) => !reported.includes(id)) ||
    remote.external_id !== server.external_id ||
    remote.node !== node.pterodactyl_node_id ||
    remote.user !== node.provision_user_id ||
    remote.allocation !== primary.pterodactyl_allocation_id ||
    (!provisioning &&
      (remote.id !== server.pterodactyl_id ||
        remote.uuid !== server.pterodactyl_uuid ||
        remote.identifier !== server.pterodactyl_identifier))
  ) {
    throw new DomainError('provenance_mismatch');
  }
}

async function ownedRemote(db: Kysely<Database>, server: Server, options: LifecycleOptions) {
  if (server.pterodactyl_id === null) throw new DomainError('conflict');
  const remote = await options.adapter.getApplicationServer(server.pterodactyl_id);
  await verifyManagedIdentity(db, server, remote);
  return remote;
}

async function observation(db: Kysely<Database>, server: Server, resources: Resources, now: Date) {
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable('managed_servers')
      .set({
        runtime_state: resources.current_state,
        readiness: resources.current_state === 'running' ? 'loading' : 'unknown',
        last_observed_at: now,
        updated_at: now,
      })
      .where('id', '=', server.id)
      .execute();
    const value = resources.resources;
    await tx
      .insertInto('server_metrics')
      .values({
        server_id: server.id,
        observed_at: now,
        memory_bytes: String(Math.floor(value.memory_bytes)),
        cpu_percent: value.cpu_absolute,
        disk_bytes: String(Math.floor(value.disk_bytes)),
        network_rx_bytes: String(Math.floor(value.network_rx_bytes)),
        network_tx_bytes: String(Math.floor(value.network_tx_bytes)),
      })
      .onConflict((conflict) => conflict.columns(['server_id', 'observed_at']).doNothing())
      .execute();
  });
}

/** No remote effect occurs inside a SQL transaction; every effect gets a committed intent first. */
export async function processServerOperation(
  db: Kysely<Database>,
  jobId: string,
  options: LifecycleOptions,
): Promise<Result> {
  if (
    !z.uuid().safeParse(jobId).success ||
    !Number.isFinite(settleOf(options)) ||
    settleOf(options) < 0
  )
    throw new DomainError('validation_failed');
  const initial = await db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', jobId)
    .executeTakeFirst();
  if (!initial) return 'missing';
  return withServerLock(db, initial.server_id, async (db) => {
    let operation = await db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    const job = await db
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    if (job.state === 'succeeded' || job.state === 'failed') return 'duplicate';
    if (job.next_attempt_at > nowOf(options)) return 'deferred';
    let server = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', operation.server_id)
      .executeTakeFirstOrThrow();
    if (server.active_operation_id !== jobId || server.deleted_at) return 'deferred';
    const token = randomUUID();
    const at = nowOf(options);
    await db
      .updateTable('server_operations')
      .set({ lease_token: token, lease_until: new Date(at.getTime() + 120_000), updated_at: at })
      .where('job_id', '=', jobId)
      .execute();
    await db
      .updateTable('operation_jobs')
      .set({ state: 'running', updated_at: at })
      .where('id', '=', jobId)
      .execute();

    const update = async (patch: {
      phase?: string;
      effect_state?: Operation['effect_state'];
      effect_started_at?: Date | null;
      plan?: Record<string, unknown>;
    }) => {
      await db
        .updateTable('server_operations')
        .set({
          ...patch,
          plan: patch.plan === undefined ? undefined : JSON.stringify(patch.plan),
          updated_at: nowOf(options),
        })
        .where('job_id', '=', jobId)
        .execute();
      operation = await db
        .selectFrom('server_operations')
        .selectAll()
        .where('job_id', '=', jobId)
        .executeTakeFirstOrThrow();
    };
    const event = async (messageKey: string, data: Record<string, unknown> = {}) => {
      await db
        .insertInto('server_events')
        .values({
          server_id: server.id,
          job_id: jobId,
          actor_id: job.actor_id,
          subject_id: job.subject_id,
          support_session_id: job.support_session_id,
          message_key: messageKey,
          data: JSON.stringify(data),
        })
        .execute();
    };
    const wait = async (reason = 'waiting', errorCode: string | null = null): Promise<Result> => {
      const next = new Date(nowOf(options).getTime() + 2_000);
      await db.transaction().execute(async (tx) => {
        await tx
          .updateTable('operation_jobs')
          .set({
            state: 'queued',
            error_code: errorCode,
            next_attempt_at: next,
            updated_at: nowOf(options),
          })
          .where('id', '=', jobId)
          .execute();
        await tx
          .updateTable('job_outbox')
          .set({ next_dispatch_at: next })
          .where('job_id', '=', jobId)
          .execute();
        await tx
          .updateTable('server_operations')
          .set({ lease_until: null, lease_token: null })
          .where('job_id', '=', jobId)
          .execute();
      });
      if (operation.plan.waitReason !== reason) {
        await update({ plan: { ...operation.plan, waitReason: reason } });
        await event('servers.operation.waiting', { phase: operation.phase, reason });
      }
      return 'waiting';
    };
    const finish = async (
      success: boolean,
      release = false,
      code: string | null = null,
    ): Promise<Result> => {
      await db.transaction().execute(async (tx) => {
        await lockResources(tx);
        await tx
          .selectFrom('managed_servers')
          .select('id')
          .where('id', '=', server.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (success && operation.action === 'delete') {
          await tx
            .updateTable('managed_servers')
            .set({ deleted_at: nowOf(options), runtime_state: 'offline', readiness: 'unknown' })
            .where('id', '=', server.id)
            .execute();
          await tx.deleteFrom('server_allocations').where('server_id', '=', server.id).execute();
          await tx
            .updateTable('test_asset_provenance')
            .set({ deleted_at: nowOf(options) })
            .where('server_id', '=', server.id)
            .execute();
        }
        if (release)
          await tx.deleteFrom('resource_reservations').where('server_id', '=', server.id).execute();
        await tx
          .updateTable('managed_servers')
          .set({ active_operation_id: null, updated_at: nowOf(options) })
          .where('id', '=', server.id)
          .where('active_operation_id', '=', jobId)
          .execute();
        await tx
          .updateTable('operation_jobs')
          .set({
            state: success ? 'succeeded' : 'failed',
            error_code: code,
            completed_at: nowOf(options),
            updated_at: nowOf(options),
          })
          .where('id', '=', jobId)
          .execute();
        await tx
          .updateTable('server_operations')
          .set({
            phase: success ? 'complete' : 'failed',
            effect_state: success ? 'confirmed' : operation.effect_state,
            lease_token: null,
            lease_until: null,
            updated_at: nowOf(options),
          })
          .where('job_id', '=', jobId)
          .execute();
        await tx
          .insertInto('job_steps')
          .values({
            job_id: jobId,
            step: `server.${operation.action}.${success ? 'complete' : 'failed'}`,
          })
          .onConflict((conflict) => conflict.columns(['job_id', 'step']).doNothing())
          .execute();
        await tx
          .insertInto('server_events')
          .values({
            server_id: server.id,
            job_id: jobId,
            actor_id: job.actor_id,
            subject_id: job.subject_id,
            support_session_id: job.support_session_id,
            message_key: success ? 'servers.operation.succeeded' : 'servers.operation.failed',
            data: JSON.stringify({ action: operation.action, code }),
          })
          .execute();
        await tx.deleteFrom('job_outbox').where('job_id', '=', jobId).execute();
      });
      return success ? 'succeeded' : 'failed';
    };
    const effect = async <T>(
      phase: string,
      perform: () => Promise<T>,
      patch?: (result: T) => Record<string, unknown>,
    ): Promise<boolean> => {
      await options.authorizeEffect(jobId, server.id, db);
      // Corroborate immediately before the effect, not only when the job was authorized.
      if (operation.action !== 'provision' || server.pterodactyl_id !== null)
        await ownedRemote(db, server, options);
      await update({
        phase,
        effect_state: 'prepared',
        effect_started_at: nowOf(options),
        plan: { ...operation.plan, acknowledged: false, waitReason: null },
      });
      await db
        .updateTable('operation_jobs')
        .set({ attempts: sql<number>`attempts + 1` })
        .where('id', '=', jobId)
        .execute();
      await event('servers.operation.effect_prepared', { phase });
      await options.checkpoint?.('prepared', operation);
      let result: T;
      try {
        result = await perform();
      } catch (error) {
        if (error instanceof PterodactylError && error.outcome === 'rejected') {
          await update({
            effect_state: 'none',
            plan: { ...operation.plan, rejected: true, rejectionCode: safeError(error).code },
          });
        } else {
          await update({ effect_state: 'uncertain' });
        }
        throw error;
      }
      await options.checkpoint?.('remote_succeeded', operation);
      await update({
        effect_state: 'confirmed',
        plan: { ...operation.plan, acknowledged: true, ...(patch?.(result) ?? {}) },
      });
      await options.checkpoint?.('confirmed', operation);
      return true;
    };
    const settled = () =>
      operation.effect_started_at !== null &&
      nowOf(options).getTime() - operation.effect_started_at.getTime() >= settleOf(options);
    const resources = async () => {
      const value = await options.adapter.getResources(server.pterodactyl_identifier ?? '');
      await observation(db, server, value, nowOf(options));
      return value;
    };
    const offline = async (): Promise<boolean> => {
      const value = await resources();
      if (value.current_state !== 'offline') {
        if (operation.plan.offlineSince !== undefined)
          await update({ plan: { ...operation.plan, offlineSince: undefined } });
        return false;
      }
      if (operation.plan.offlineSince === undefined) {
        await update({ plan: { ...operation.plan, offlineSince: nowOf(options).toISOString() } });
        return false;
      }
      return (
        nowOf(options).getTime() - Date.parse(String(operation.plan.offlineSince)) >=
        settleOf(options)
      );
    };
    const backup = async (): Promise<boolean> => {
      const name = `nickhosting-operation-${jobId}`;
      if (!operation.plan.backupId && operation.phase !== 'backup') {
        await effect(
          'backup',
          () => options.adapter.createBackup(server.pterodactyl_identifier ?? '', { name }),
          (result) => ({ backupId: result.uuid }),
        );
        return false;
      }
      if (!operation.plan.backupId) {
        const found = (
          await options.adapter.listBackups(server.pterodactyl_identifier ?? '')
        ).filter((entry) => entry.name === name);
        if (found.length > 1) throw new DomainError('conflict');
        if (found.length === 0) return false;
        await update({ plan: { ...operation.plan, backupId: found[0]?.uuid } });
      }
      const snapshot = await options.adapter.getBackup(
        server.pterodactyl_identifier ?? '',
        z.uuid().parse(operation.plan.backupId),
      );
      if (!snapshot.completed_at) return false;
      if (!snapshot.is_successful || !snapshot.checksum) {
        await update({ plan: { ...operation.plan, backupFailed: true } });
        throw new DomainError('integration_unavailable');
      }
      await update({
        phase: 'backup_complete',
        effect_state: 'confirmed',
        plan: { ...operation.plan, backupComplete: true },
      });
      return true;
    };

    try {
      const command = parseCommand(job.command);
      if (
        command.type !== 'server.operation' ||
        command.payload.serverId !== server.id ||
        command.payload.operationId !== jobId
      )
        throw new DomainError('validation_failed');
      if (operation.plan.rejected === true) return finish(false, false, 'integration_unavailable');
      if (operation.action === 'provision') {
        const plan = provisionPlanSchema.parse(operation.plan.provision);
        if (plan.externalId !== server.external_id) throw new DomainError('conflict');
        let remote = await options.adapter.findServerByExternalId(server.external_id);
        if (!server.pterodactyl_id) {
          if (operation.phase === 'planned') {
            if (remote) throw new DomainError('conflict');
            await effect('provision', () => options.adapter.createServer(plan));
            remote = await options.adapter.findServerByExternalId(server.external_id);
          }
          if (!remote) return wait('provision_outcome_unknown');
          await verifyManagedIdentity(db, server, remote, true);
          if (
            !operation.effect_started_at ||
            Date.parse(remote.created_at) < operation.effect_started_at.getTime() - 5_000 ||
            remote.egg !== plan.eggId
          )
            throw new DomainError('conflict');
          for (const key of ['memory', 'cpu', 'disk', 'swap', 'io'] as const)
            if (remote.limits[key] !== plan.limits[key]) throw new DomainError('conflict');
          await db
            .updateTable('managed_servers')
            .set({
              pterodactyl_id: remote.id,
              pterodactyl_uuid: remote.uuid,
              pterodactyl_identifier: remote.identifier,
              installation_state: installed(remote) ? 'installed' : 'installing',
              updated_at: nowOf(options),
            })
            .where('id', '=', server.id)
            .execute();
          server = await db
            .selectFrom('managed_servers')
            .selectAll()
            .where('id', '=', server.id)
            .executeTakeFirstOrThrow();
          await update({ phase: 'installation', effect_state: 'confirmed' });
        }
        remote = await ownedRemote(db, server, options);
        if (remote.status === 'install_failed') {
          await db
            .updateTable('managed_servers')
            .set({ installation_state: 'failed' })
            .where('id', '=', server.id)
            .execute();
          return finish(false, false, 'integration_unavailable');
        }
        if (!installed(remote)) return wait('installation');
        const current = await resources();
        await db
          .updateTable('managed_servers')
          .set({ installation_state: 'installed' })
          .where('id', '=', server.id)
          .execute();
        if (operation.phase === 'initial_start') {
          if (!settled()) return wait('resource_cache_expiry');
          if (current.current_state === 'running') {
            await db.transaction().execute(async (tx) => {
              await lockResources(tx);
              await tx
                .updateTable('resource_reservations')
                .set({ state: 'running', updated_at: nowOf(options) })
                .where('server_id', '=', server.id)
                .execute();
            });
            return finish(true);
          }
          if (current.current_state === 'offline') {
            await event('servers.operation.initial_start_failed');
            return finish(true, true);
          }
          return wait('power_confirmation');
        }
        if (current.current_state !== 'offline') return wait('unexpected_provision_power_state');
        if (operation.plan.autoStart === true) {
          if (!options.reserveStart) throw new DomainError('configuration_invalid');
          try {
            await options.reserveStart(server.id, jobId, 'start', db);
          } catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'resources_unavailable')
              throw error;
            await event('servers.operation.initial_start_denied');
            return finish(true);
          }
          const reservation = await db
            .selectFrom('resource_reservations')
            .select('server_id')
            .where('server_id', '=', server.id)
            .executeTakeFirst();
          if (!reservation) throw new DomainError('conflict');
          await effect('initial_start', () =>
            options.adapter.power(server.pterodactyl_identifier ?? '', 'start'),
          );
          return wait('power_confirmation');
        }
        return finish(true);
      }

      if (operation.action === 'delete' && server.pterodactyl_id === null) {
        await options.authorizeEffect(jobId, server.id, db);
        const rejected = await db
          .selectFrom('server_operations as operation')
          .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
          .select(['operation.effect_state', 'operation.plan', 'job.state'])
          .where('operation.server_id', '=', server.id)
          .where('operation.action', '=', 'provision')
          .executeTakeFirst();
        if (
          !rejected ||
          rejected.state !== 'failed' ||
          rejected.effect_state !== 'none' ||
          rejected.plan.rejected !== true
        )
          throw new DomainError('operation_uncertain');
        if (await options.adapter.findServerByExternalId(server.external_id))
          throw new DomainError('provenance_mismatch');
        // Definitively rejected provisioning has no remote identity and no possible remote effect.
        return finish(true, true);
      }
      let remote: ApplicationServer;
      try {
        remote = await ownedRemote(db, server, options);
      } catch (error) {
        if (
          operation.action === 'delete' &&
          operation.phase === 'delete' &&
          operation.effect_started_at &&
          isMissing(error)
        ) {
          // Absence confirms Panel deletion only, not disk erasure or provider-side backup disposal.
          return finish(true, true);
        }
        throw error;
      }
      if (['start', 'stop', 'restart'].includes(operation.action)) {
        const action = operation.action as 'start' | 'stop' | 'restart';
        const current = await resources();
        if (operation.phase === 'planned') {
          if (action !== 'stop') {
            for (const key of ['memory', 'cpu', 'disk', 'swap', 'io'] as const) {
              if (remote.limits[key] !== server.limits[key])
                throw new DomainError('provenance_mismatch');
            }
            if (!installed(remote) || remote.suspended || !options.reserveStart)
              throw new DomainError('configuration_invalid');
            await options.reserveStart(server.id, jobId, action, db);
            const reservation = await db
              .selectFrom('resource_reservations')
              .select('server_id')
              .where('server_id', '=', server.id)
              .executeTakeFirst();
            if (!reservation) throw new DomainError('conflict');
          }
          await update({
            plan: { ...operation.plan, previousUptime: current.resources.uptime ?? null },
          });
          await effect('power', () =>
            options.adapter.power(server.pterodactyl_identifier ?? '', action),
          );
          return wait('power_confirmation');
        }
        if (!settled()) return wait('resource_cache_expiry');
        if (action === 'stop' && current.current_state === 'offline') {
          await db
            .updateTable('managed_servers')
            .set({ intent: 'manually_stopped' })
            .where('id', '=', server.id)
            .execute();
          return finish(true, true);
        }
        if (action !== 'stop' && current.current_state === 'running') {
          const restarted =
            operation.plan.acknowledged === true ||
            operation.plan.transitionObserved === true ||
            (typeof operation.plan.previousUptime === 'number' &&
              current.resources.uptime !== undefined &&
              current.resources.uptime < operation.plan.previousUptime);
          if (action === 'restart' && !restarted) return wait('restart_outcome_unknown');
          await db
            .updateTable('resource_reservations')
            .set({ state: 'running', updated_at: nowOf(options) })
            .where('server_id', '=', server.id)
            .execute();
          return finish(true);
        }
        if (action === 'start' && current.current_state === 'offline')
          return finish(false, true, 'integration_unavailable');
        if (action === 'restart' && current.current_state !== 'running')
          await update({ plan: { ...operation.plan, transitionObserved: true } });
        return wait('power_confirmation');
      }
      if (operation.action === 'backup') {
        if (await backup()) return finish(true);
        return wait('backup_confirmation');
      }
      if (!(await offline())) return wait('offline_confirmation');
      if (operation.plan.backupBefore === true && operation.plan.backupComplete !== true) {
        if (!(await backup())) return wait('backup_confirmation');
      }
      if (operation.action === 'delete') {
        if (operation.phase !== 'delete') {
          await options.authorizeEffect(jobId, server.id, db);
          if (options.beforeDelete) await options.beforeDelete(server.id, db);
          else {
            const credential = await db
              .selectFrom('external_sftp_credentials')
              .select('id')
              .where('server_id', '=', server.id)
              .where('state', '!=', 'revoked')
              .executeTakeFirst();
            const dns = await db
              .selectFrom('dns_assignments')
              .select('id')
              .where('server_id', '=', server.id)
              .where('state', '!=', 'deleted')
              .executeTakeFirst();
            if (credential || dns) throw new DomainError('configuration_invalid');
          }
          await effect('delete', () => options.adapter.deleteServer(server.pterodactyl_id ?? 0));
        }
        return wait('delete_confirmation');
      }
      if (operation.action === 'configure') {
        const build = operation.plan.build as BuildUpdate | undefined;
        if (
          !build ||
          build.allocation !== remote.allocation ||
          build.add_allocations?.length ||
          build.remove_allocations?.length
        )
          throw new DomainError('validation_failed');
        const matches = () =>
          ['memory', 'cpu', 'disk', 'swap', 'io'].every(
            (key) =>
              remote.limits[key as keyof typeof remote.limits] === build[key as keyof BuildUpdate],
          ) &&
          (remote.limits.threads ?? '') === (build.threads ?? '') &&
          ['databases', 'allocations', 'backups'].every(
            (key) =>
              remote.feature_limits[key as keyof typeof remote.feature_limits] ===
              build.feature_limits[key as keyof typeof build.feature_limits],
          );
        if (operation.phase === 'configure' && matches()) {
          await db
            .updateTable('managed_servers')
            .set({
              limits: JSON.stringify({
                memory: build.memory,
                cpu: build.cpu,
                disk: build.disk,
                swap: build.swap,
                io: build.io,
                ...(build.threads === undefined ? {} : { threads: build.threads }),
              }),
            })
            .where('id', '=', server.id)
            .execute();
          return finish(true);
        }
        // A repeated absolute build PATCH converges on the same recorded desired state.
        await effect('configure', () =>
          options.adapter.updateBuild(server.pterodactyl_id ?? 0, build),
        );
        return wait('configuration_confirmation');
      }
      if (operation.action === 'wipe' && operation.plan.wipeComplete !== true) {
        if (!Array.isArray(operation.plan.wipeFiles)) {
          const entries = await options.adapter.listFiles(server.pterodactyl_identifier ?? '');
          await update({
            plan: {
              ...operation.plan,
              wipeFiles: entries.map((entry) => entry.name),
              wipeIndex: 0,
            },
          });
        }
        const names = z.array(z.string()).parse(operation.plan.wipeFiles);
        const index = z.number().int().nonnegative().parse(operation.plan.wipeIndex);
        const batch = names.slice(index, index + 1000);
        if (batch.length) {
          if (operation.phase === `wipe:${index}`) {
            const present = new Set(
              (await options.adapter.listFiles(server.pterodactyl_identifier ?? '')).map(
                (entry) => entry.name,
              ),
            );
            if (batch.some((name) => present.has(name))) return wait('wipe_outcome_unknown');
            await update({
              phase: 'wipe_batch_complete',
              effect_state: 'confirmed',
              plan: { ...operation.plan, wipeIndex: index + batch.length },
            });
          } else
            await effect(`wipe:${index}`, () =>
              options.adapter.deleteFiles(server.pterodactyl_identifier ?? '', '', batch),
            );
          return wait('wipe_confirmation');
        }
        const remaining = await options.adapter.listFiles(server.pterodactyl_identifier ?? '');
        if (remaining.length) return wait('wipe_unexpected_files');
        await update({ phase: 'wipe_complete', plan: { ...operation.plan, wipeComplete: true } });
      }
      if (operation.action === 'reinstall' || operation.action === 'wipe') {
        if (operation.phase !== 'reinstall') {
          await db
            .updateTable('managed_servers')
            .set({ installation_state: 'installing' })
            .where('id', '=', server.id)
            .execute();
          await effect('reinstall', () =>
            options.adapter.reinstall(server.pterodactyl_identifier ?? ''),
          );
          return wait('installation');
        }
        if (installationPending(remote))
          await update({ plan: { ...operation.plan, transitionObserved: true } });
        if (remote.status === 'install_failed')
          return finish(false, false, 'integration_unavailable');
        if (
          installed(remote) &&
          settled() &&
          (operation.plan.acknowledged === true || operation.plan.transitionObserved === true)
        ) {
          await db
            .updateTable('managed_servers')
            .set({ installation_state: 'installed' })
            .where('id', '=', server.id)
            .execute();
          return finish(true, true);
        }
        return wait('installation');
      }
      if (operation.action === 'restore') {
        const backupId = z.uuid().parse(operation.plan.backupId);
        if (operation.phase !== 'restore') {
          const snapshot = await options.adapter.getBackup(
            server.pterodactyl_identifier ?? '',
            backupId,
          );
          if (!snapshot.completed_at || !snapshot.is_successful || !snapshot.checksum)
            throw new DomainError('validation_failed');
          await effect('restore', () =>
            options.adapter.restoreBackup(
              server.pterodactyl_identifier ?? '',
              backupId,
              operation.plan.truncate === true,
            ),
          );
          return wait('restore_confirmation');
        }
        if (remote.status === 'restoring_backup')
          await update({ plan: { ...operation.plan, transitionObserved: true } });
        if (
          !remote.status &&
          settled() &&
          (operation.plan.acknowledged === true || operation.plan.transitionObserved === true)
        )
          return finish(true, true);
        return wait('restore_outcome_unknown');
      }
      throw new DomainError('validation_failed');
    } catch (error) {
      const code = safeError(error).code;
      if (operation.plan.rejected === true || operation.plan.backupFailed === true)
        return finish(false, false, code);
      if (operation.effect_state === 'prepared' || operation.effect_state === 'uncertain')
        return wait('remote_outcome_unknown', code);
      if (
        error instanceof DomainError &&
        [
          'validation_failed',
          'forbidden',
          'configuration_invalid',
          'conflict',
          'provenance_mismatch',
          'resources_unavailable',
        ].includes(error.code)
      )
        return finish(false, false, code);
      return wait('provider_unavailable', code);
    } finally {
      await db
        .updateTable('server_operations')
        .set({ lease_token: null, lease_until: null })
        .where('job_id', '=', jobId)
        .where('lease_token', '=', token)
        .execute();
    }
  });
}

/** Route by the PostgreSQL command, never by caller-supplied Redis payloads. */
export function createLifecycleProcessor(db: Kysely<Database>, options: LifecycleOptions) {
  return async (jobId: string): Promise<string> => {
    const row = await db
      .selectFrom('operation_jobs')
      .select('command')
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (!row) return 'missing';
    const command = parseCommand(row.command);
    return command.type === 'server.operation'
      ? processServerOperation(db, jobId, options)
      : processJob(db, jobId);
  };
}

/** Read reconciliation never imports or changes a remote server. It errs toward retaining capacity. */
export async function reconcileManagedServer(
  db: Kysely<Database>,
  serverId: string,
  options: LifecycleOptions,
): Promise<'observed' | 'deferred'> {
  return withServerLock(db, serverId, async (db) => {
    const server = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!server?.pterodactyl_id) return 'deferred';
    await ownedRemote(db, server, options);
    const current = await options.adapter.getResources(server.pterodactyl_identifier ?? '');
    const now = nowOf(options);
    await observation(db, server, current, now);
    await db.transaction().execute(async (tx) => {
      await lockResources(tx);
      const node = await tx
        .selectFrom('managed_nodes')
        .selectAll()
        .where('id', '=', server.node_id)
        .executeTakeFirstOrThrow();
      // Match admission lock order: physical host before user and server state.
      await tx
        .selectFrom('physical_hosts')
        .select('id')
        .where('id', '=', node.physical_host_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await tx
        .selectFrom('user')
        .select('id')
        .where('id', '=', server.owner_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const locked = await tx
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', server.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const reservation = await tx
        .selectFrom('resource_reservations')
        .selectAll()
        .where('server_id', '=', server.id)
        .executeTakeFirst();
      if (current.current_state !== 'offline') {
        if (reservation && !locked.active_operation_id)
          await tx
            .updateTable('resource_reservations')
            .set({
              state: current.current_state === 'running' ? 'running' : 'starting',
              updated_at: now,
            })
            .where('server_id', '=', server.id)
            .execute();
        if (!reservation) {
          await tx
            .insertInto('resource_reservations')
            .values({
              server_id: server.id,
              owner_id: server.owner_id,
              physical_host_id: node.physical_host_id,
              memory_mib: server.limits.memory,
              cpu_percent: server.limits.cpu,
              operation_id: locked.active_operation_id ?? randomUUID(),
              state: current.current_state === 'running' ? 'running' : 'uncertain',
              updated_at: now,
            })
            .execute();
          await tx
            .insertInto('server_events')
            .values({
              server_id: server.id,
              job_id: locked.active_operation_id,
              actor_id: null,
              subject_id: server.owner_id,
              support_session_id: null,
              message_key: 'servers.reconciliation.external_start',
              data: JSON.stringify({ reservationExceedsPolicyPossible: true }),
            })
            .execute();
        }
      } else if (reservation && !locked.active_operation_id) {
        if (reservation.state !== 'uncertain') {
          await tx
            .updateTable('resource_reservations')
            .set({ state: 'uncertain', updated_at: now })
            .where('server_id', '=', server.id)
            .execute();
          return;
        }
        const latest = await tx
          .selectFrom('server_operations')
          .select('effect_started_at')
          .where('server_id', '=', server.id)
          .where('effect_started_at', 'is not', null)
          .orderBy('effect_started_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        const barrier = Math.max(
          reservation.updated_at.getTime(),
          latest?.effect_started_at?.getTime() ?? 0,
        );
        if (now.getTime() - barrier >= settleOf(options))
          await tx.deleteFrom('resource_reservations').where('server_id', '=', server.id).execute();
      }
    });
    return 'observed';
  });
}
