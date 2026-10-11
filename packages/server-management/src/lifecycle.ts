import { randomUUID } from 'node:crypto';
import {
  type AuthContext,
  assertPermission,
  authSessionId,
  type createLogger,
  DomainError,
  safeError,
} from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import { parseCommand, processJob } from '@nickhosting/jobs';
import {
  type ApplicationServer,
  type BuildUpdate,
  type PterodactylAdapter,
  PterodactylError,
  limitsSchema as providerLimitsSchema,
  provisionPlanSchema,
  type Resources,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources, physicalMemoryMiB } from './admission.js';
import { assertServerBackendAllocations, canonicalAllocationAddress } from './allocation-pool.js';
import { effectiveNodeOverhead } from './configuration.js';
import { reconcileGatewayState } from './gateway-orchestration.js';
import {
  activateProvisionGateway,
  assertProvisionGatewayStart,
  prepareProvisionGatewayStart,
} from './gateway-provision.js';
import { currentInteractiveContext } from './interactive-context.js';
import { assertGatewaySleepFence, revokeGatewayRoutesForDeletion } from './registry.js';
import { assertIdleSleepAllowed } from './sleep-policy.js';
import { consumeStopEscalation, stopEscalation } from './stop-escalation.js';
import { assertNoPendingUpload } from './upload-admission.js';

type Server = Selectable<Database['managed_servers']>;
type Operation = Selectable<Database['server_operations']>;
type Result =
  | 'succeeded'
  | 'failed'
  | 'waiting'
  | 'deferred'
  | 'inactive'
  | 'duplicate'
  | 'missing';
export interface GameLifecycleContext {
  db: Kysely<Database>;
  server: Server;
  adapter: PterodactylAdapter;
  operation: () => Operation;
  authorize: () => Promise<void>;
  assertStopped: () => Promise<void>;
  update: (patch: {
    phase?: string;
    effect_state?: Operation['effect_state'];
    effect_started_at?: Date | null;
    plan?: Record<string, unknown>;
  }) => Promise<void>;
  effect: <T>(
    phase: string,
    perform: () => Promise<T>,
    patch?: (result: T) => Record<string, unknown>,
  ) => Promise<boolean>;
  event: (messageKey: string, data?: Record<string, unknown>) => Promise<void>;
  backup: () => Promise<boolean>;
}
export interface InitialInstallationOutputs {
  integrationId: string;
  combinationId: string;
  mappingDigest: string;
  imageDigest: string;
  files: { path: string; sha256: string; size: number }[];
}
export interface ExternalStopReceipt {
  containerId: string;
  startedAt: string;
  finishedAt: string;
  activityId: string;
  activityAt: string;
  action: 'stop' | 'kill';
}
export interface LifecycleOptions {
  logger?: ReturnType<typeof createLogger>;
  adapter: PterodactylAdapter;
  /** Game hooks run under the same pinned server lock and durable effect journal. */
  configureGameProvision?: (context: GameLifecycleContext) => Promise<boolean>;
  /** Read-only, trusted integration attestation; never used for reinstall/wipe. */
  verifyInitialInstallation?: (
    context: GameLifecycleContext,
  ) => Promise<InitialInstallationOutputs | null>;
  /** Host-bound proof that both the installer and game process are stopped. */
  confirmInitialInstallationStopped?: (
    serverId: string,
    connection: Kysely<Database>,
  ) => Promise<boolean>;
  processGameContent?: (context: GameLifecycleContext) => Promise<boolean>;
  verifyGameRestore?: (context: GameLifecycleContext) => Promise<boolean>;
  env?: Environment;
  /** Rechecks current actor, subject, support lifetime and project access before new effects. */
  authorizeEffect: (
    jobId: string,
    serverId: string,
    connection: Kysely<Database>,
    context?: {
      providerServer?: ApplicationServer | Promise<ApplicationServer>;
      /** Clean Start has matched fresh provider limits and reserved local resources. */
      startAdmissionValidated?: true;
      /** This caller performs authorizeIntent after every slow proof settles.
       * Only the lifecycle final power handoff may opt out of the nested guard. */
      deferFinalIntentCheck?: true;
    },
  ) => Promise<void>;
  /** Current DB permission/policy only. External effects still require authorizeEffect
   * at the final handoff; internal stop-console checks may use this scoped guard. */
  authorizeIntent?: (
    jobId: string,
    serverId: string,
    connection: Kysely<Database>,
  ) => Promise<void>;
  /** Explicit runtime guarantee; other callers retain the independent host check. */
  effectAuthorizationVerifiesHost?: boolean;
  /** Production binds host-local observations to this server's current physical host. */
  verifyObservationHost?: (serverId: string, connection: Kysely<Database>) => Promise<void>;
  /** Trusted host-bound running process start. Null proves non-running/absent;
   * unavailability must throw. Production always supplies this observer. */
  observeProcessStart?: (serverId: string, connection: Kysely<Database>) => Promise<string | null>;
  /** Provider-ready integrations may refresh an already admitted process epoch
   * locally; remote identity/drift stays with subscription setup/reconciliation. */
  observeProviderProcessStart?: (
    serverId: string,
    connection: Kysely<Database>,
  ) => Promise<string | null>;
  /** Fresh host/registry-bound process epoch only, without re-attesting game files.
   * Reconciliation may use it only to corroborate a durable successful power receipt. */
  observeReconciliationProcessStart?: (
    serverId: string,
    connection: Kysely<Database>,
    remote?: ApplicationServer,
  ) => Promise<string | null>;
  /** Successful interactive provider stop/kill plus matching exact terminal process evidence. */
  observeExternalStop?: (
    serverId: string,
    connection: Kysely<Database>,
  ) => Promise<ExternalStopReceipt | null>;
  /** Physical proof for a no-op stop, only when no compute/installer reservation exists. */
  confirmAlreadyStopped?: (
    serverId: string,
    connection: Kysely<Database>,
    context?: {
      providerServer: Promise<ApplicationServer>;
      observerPreflight?: Promise<void>;
    },
  ) => Promise<boolean>;
  /** Read-only host sampling may overlap provider reads. The returned admission
   * function is invoked only after provider identity/limits have been validated. */
  prepareStartAdmission?: (
    serverId: string,
    jobId: string,
    connection: Kysely<Database>,
  ) => Promise<() => Promise<void>>;
  /** Optional authenticated, identity-bound provider feed; null requires the normal provider read. */
  cachedStartLimits?: (
    serverId: string,
    connection: Kysely<Database>,
  ) => Promise<ApplicationServer['limits'] | null>;
  /** Fresh admission revalidation before a power effect, not an implicit reservation. */
  reserveStart?: (
    serverId: string,
    jobId: string,
    action: 'start' | 'restart',
    connection: Kysely<Database>,
  ) => Promise<void>;
  /** Physical-only installer admission, refreshed before each new installer effect. */
  reserveInstallation?: (
    serverId: string,
    jobId: string,
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

const isGatewaySleep = (operation: Operation) => {
  const marker = operation.plan.gatewayAutomation;
  return (
    typeof marker === 'object' && marker !== null && 'kind' in marker && marker.kind === 'sleep'
  );
};

const isMissing = (error: unknown) =>
  error instanceof PterodactylError && error.reason === 'not_found';
const installed = (remote: ApplicationServer) =>
  !remote.status && (remote.container.installed === true || remote.container.installed === 1);
const installationPending = (remote: ApplicationServer) =>
  remote.status === 'installing' || !remote.container.installed;
const nowOf = (options: LifecycleOptions) => options.now?.() ?? new Date();
const settleOf = (options: LifecycleOptions) => options.settleMs ?? 21_000;

/** Docker RFC3339Nano timestamps cannot be compared through Date alone: doing
 * so loses sub-millisecond evidence at the intent or future-time boundary. */
function processStartTime(value: unknown): bigint | null {
  if (typeof value !== 'string' || !z.iso.datetime({ offset: true }).safeParse(value).success)
    return null;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!parts) return null;
  const seconds = Date.parse(`${parts[1]}${parts[3]}`);
  if (!Number.isFinite(seconds)) return null;
  const nanos = BigInt(seconds) * 1_000_000n + BigInt((parts[2] ?? '').padEnd(9, '0'));
  return nanos > 0n ? nanos : null;
}

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
  const reported = remote.relationships?.allocations?.data.map((item) => item.attributes);
  const expected = allocations.map((allocation) => allocation.pterodactyl_allocation_id);
  if (
    !primary ||
    !reported ||
    reported.length !== expected.length ||
    allocations.some(
      (claim) =>
        !reported.some(
          (allocation) =>
            allocation.id === claim.pterodactyl_allocation_id &&
            allocation.assigned &&
            canonicalAllocationAddress(allocation.ip) !== '' &&
            canonicalAllocationAddress(allocation.ip) === claim.address &&
            allocation.port === claim.port,
        ),
    ) ||
    remote.external_id !== server.external_id ||
    remote.node !== node.pterodactyl_node_id ||
    remote.user !== server.provider_user_id ||
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
        readiness:
          resources.current_state === 'running'
            ? server.runtime_state === 'running' && server.readiness === 'ready'
              ? 'ready'
              : 'loading'
            : 'unknown',
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
  const log = (event: string, data: Record<string, unknown>) => {
    try {
      options.logger?.log('info', event, {
        jobId,
        serverId: initial.server_id,
        action: initial.action,
        ...data,
      });
    } catch {
      /* Diagnostics must never affect authorization or provider operations. */
    }
  };
  const timed = async <T>(
    stage:
      | 'authorization'
      | 'provider_identity'
      | 'provider_resources'
      | 'provider_limits'
      | 'process_observation'
      | 'provider_effect',
    work: () => Promise<T>,
  ): Promise<T> => {
    const began = performance.now();
    let outcome = 'error';
    try {
      const value = await work();
      outcome = 'ok';
      return value;
    } finally {
      log('servers.operation_stage', {
        stage,
        outcome,
        durationMs: Math.round(performance.now() - began),
      });
    }
  };
  const lockStarted = performance.now();
  let acquired = false;
  return withServerLock(db, initial.server_id, async (db) => {
    acquired = true;
    log('servers.operation_stage', {
      stage: 'server_lock',
      outcome: 'acquired',
      durationMs: Math.round(performance.now() - lockStarted),
    });
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
    if (job.next_attempt_at > nowOf(options)) {
      log('servers.operation_deferred', {
        reason: 'not_due',
        nextAttemptAt: job.next_attempt_at.toISOString(),
      });
      return 'deferred';
    }
    let server = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', operation.server_id)
      .executeTakeFirstOrThrow();
    // Obsolete operations must not enter the transport's short contention retry.
    if (server.active_operation_id !== jobId || server.deleted_at) {
      log('servers.operation_deferred', { reason: 'inactive' });
      return 'inactive';
    }
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
      const poll = typeof operation.plan.pollCount === 'number' ? operation.plan.pollCount + 1 : 1;
      const processConfirmation =
        options.observeProcessStart !== undefined &&
        (['start', 'restart'].includes(operation.action) ||
          (operation.action === 'provision' && operation.phase === 'initial_start')) &&
        ['power_confirmation', 'start_terminal_unproven', 'restart_terminal_unproven'].includes(
          reason,
        );
      // A fresh process signal must not wait behind exponential resource-cache
      // polling. Provider failures and unrelated operations retain their backoff.
      const delay = processConfirmation ? 2000 : Math.min(10_000, 1_000 * 2 ** Math.min(poll, 4));
      const next = new Date(nowOf(options).getTime() + delay + Math.floor(Math.random() * 500));
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
      const changed = operation.plan.waitReason !== reason;
      await update({ plan: { ...operation.plan, waitReason: reason, pollCount: poll } });
      if (changed) {
        await event('servers.operation.waiting', { phase: operation.phase, reason });
      }
      return 'waiting';
    };
    const finish = async (
      success: boolean,
      release = false,
      code: string | null = null,
      alreadyStopped = false,
      confirmedStopped = false,
    ): Promise<Result> => {
      let rollbackLimits: Record<string, unknown> | undefined;
      if (
        !success &&
        operation.action === 'configure' &&
        operation.plan.rejected === true &&
        operation.effect_state === 'none'
      ) {
        const previous = providerLimitsSchema.safeParse(operation.plan.previousLimits);
        if (previous.success) {
          let remote: ApplicationServer;
          try {
            remote = await timed('provider_identity', () => ownedRemote(db, server, options));
          } catch {
            return wait('configuration_rollback_verification', 'integration_unavailable');
          }
          if (
            ['memory', 'cpu', 'disk', 'swap', 'io'].every(
              (key) =>
                remote.limits[key as keyof typeof remote.limits] ===
                previous.data[key as keyof typeof previous.data],
            ) &&
            (remote.limits.threads ?? '') === (previous.data.threads ?? '')
          )
            rollbackLimits = { ...previous.data, threads: previous.data.threads ?? undefined };
        }
      }
      const completed = await db.transaction().execute(async (tx) => {
        await lockResources(tx);
        if (alreadyStopped) {
          const compute = await tx
            .selectFrom('resource_reservations')
            .select('server_id')
            .where('server_id', '=', server.id)
            .executeTakeFirst();
          const installation = await tx
            .selectFrom('installation_reservations')
            .select('server_id')
            .where('server_id', '=', server.id)
            .executeTakeFirst();
          if (compute || installation) return false;
          if (!isGatewaySleep(operation))
            await tx
              .updateTable('managed_servers')
              .set({ intent: 'manually_stopped' })
              .where('id', '=', server.id)
              .execute();
        }
        if (
          !success &&
          operation.action === 'reinstall' &&
          (operation.plan.installationEffectPrepared !== true ||
            (operation.plan.rejected === true && operation.effect_state === 'none')) &&
          ['pending', 'installing', 'installed', 'failed'].includes(
            String(operation.plan.previousInstallationState),
          )
        )
          await tx
            .updateTable('managed_servers')
            .set({
              installation_state: operation.plan
                .previousInstallationState as Server['installation_state'],
            })
            .where('id', '=', server.id)
            .execute();
        if (rollbackLimits)
          await tx
            .updateTable('managed_servers')
            .set({ limits: JSON.stringify(rollbackLimits) })
            .where('id', '=', server.id)
            .execute();
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
        if (
          operation.plan.installConfirmed === true ||
          operation.plan.installationEffectPrepared !== true ||
          (operation.effect_state === 'none' && operation.plan.rejected === true)
        )
          await tx
            .deleteFrom('installation_reservations')
            .where('server_id', '=', server.id)
            .where('operation_id', '=', jobId)
            .execute();
        if (release)
          await tx.deleteFrom('resource_reservations').where('server_id', '=', server.id).execute();
        else if (
          operation.plan.reservationCreated === true &&
          (operation.action === 'start' ||
            (operation.action === 'provision' && operation.plan.autoStart === true)) &&
          (operation.plan.powerEffectPrepared !== true ||
            (operation.effect_state === 'none' && operation.plan.rejected === true))
        )
          await tx
            .deleteFrom('resource_reservations')
            .where('server_id', '=', server.id)
            .where('operation_id', '=', jobId)
            .execute();
        await tx
          .updateTable('managed_servers')
          .set({
            active_operation_id: null,
            updated_at: nowOf(options),
            ...(confirmedStopped
              ? {
                  runtime_state: 'offline' as const,
                  readiness: 'unknown' as const,
                  last_observed_at: nowOf(options),
                  ...(!isGatewaySleep(operation) ? { intent: 'manually_stopped' as const } : {}),
                }
              : {}),
          })
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
            plan: alreadyStopped
              ? JSON.stringify({
                  ...operation.plan,
                  stopNoOp: true,
                  stopAlreadyOfflineConfirmedAt: nowOf(options).toISOString(),
                })
              : !success &&
                  operation.action === 'provision' &&
                  server.pterodactyl_id === null &&
                  operation.phase === 'planned' &&
                  operation.effect_state === 'none'
                ? JSON.stringify({ ...operation.plan, noExternalEffect: true })
                : undefined,
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
            data: JSON.stringify({
              action: operation.action,
              code,
              ...(operation.plan.externalStopConfirmed
                ? {
                    source: 'provider_activity',
                    reason: 'external_stop',
                    receipt: operation.plan.externalStopConfirmed,
                  }
                : {}),
            }),
          })
          .execute();
        await tx.deleteFrom('job_outbox').where('job_id', '=', jobId).execute();
        return true;
      });
      if (!completed) return wait('already_stopped_reservation_changed', 'operation_uncertain');
      if (success && confirmedStopped && isGatewaySleep(operation)) {
        // Reuse the canonical durable transition now rather than waiting for a
        // worker tick. A crash/failure here is recovered by the same reconciler
        // and cannot undo the already committed confirmed stop.
        await reconcileGatewayState(db, server.id, { env: options.env }).catch(() => {
          log('servers.sleep_reconciliation_deferred', {});
        });
      }
      return success ? 'succeeded' : 'failed';
    };
    const requireQuiescentReservation = async () => {
      await db.transaction().execute(async (tx) => {
        await lockResources(tx);
        if (
          await tx
            .selectFrom('resource_reservations')
            .select('server_id')
            .where('server_id', '=', server.id)
            .executeTakeFirst()
        )
          throw new DomainError('operation_uncertain');
      });
    };
    const effect = async <T>(
      phase: string,
      perform: (verifiedServer?: ApplicationServer) => Promise<T>,
      patch?: (result: T) => Record<string, unknown>,
      preparationServer?: ApplicationServer,
    ): Promise<boolean> => {
      await timed('authorization', () =>
        (['power', 'initial_start'].includes(phase)
          ? (options.authorizeIntent ?? options.authorizeEffect)
          : options.authorizeEffect)(jobId, server.id, db),
      );
      await db.transaction().execute(async (tx) => {
        await lockResources(tx);
        await assertNoPendingUpload(tx, server.id);
        if (
          await tx
            .selectFrom('installation_reservations')
            .select('server_id')
            .where('server_id', '=', server.id)
            .where('operation_id', '!=', jobId)
            .executeTakeFirst()
        )
          throw new DomainError('operation_uncertain');
      });
      if (
        ['configure', 'reinstall', 'wipe', 'restore', 'delete', 'minecraft-content'].includes(
          operation.action,
        )
      )
        await requireQuiescentReservation();
      const attempts = z
        .record(z.string(), z.number().int().nonnegative())
        .parse(operation.plan.effectAttempts ?? {});
      const attempt = (attempts[phase] ?? 0) + 1;
      if (attempt > job.max_attempts) throw new DomainError('operation_uncertain');
      const leanStart =
        phase === 'power' && operation.action === 'start' && operation.phase === 'planned';
      const finalPowerIdentity =
        phase === 'initial_start' ||
        (phase === 'power' && ['start', 'restart'].includes(operation.action));
      // Stop preparation may share this attempt's initial identity for its internal
      // status relay. beforePower always rechecks identity after the socket handshake.
      // Start identity belongs after durable preparation, not before that await.
      let verifiedServer = finalPowerIdentity
        ? undefined
        : (preparationServer ??
          (operation.action !== 'provision' || server.pterodactyl_id !== null
            ? await timed('provider_identity', () => ownedRemote(db, server, options))
            : undefined));
      await update({
        phase,
        effect_state: 'prepared',
        effect_started_at: nowOf(options),
        plan: {
          ...operation.plan,
          acknowledged: false,
          waitReason: null,
          effectAttempts: { ...attempts, [phase]: attempt },
          ...(['power', 'initial_start'].includes(phase) ? { powerEffectPrepared: true } : {}),
          ...(['provision', 'reinstall'].includes(phase)
            ? { installationEffectPrepared: true }
            : {}),
        },
      });
      await db
        .updateTable('operation_jobs')
        .set({ attempts: sql<number>`greatest(attempts, ${attempt})` })
        .where('id', '=', jobId)
        .execute();
      await event('servers.operation.effect_prepared', { phase });
      await options.checkpoint?.('prepared', operation);
      const minecraftProvision =
        operation.action === 'provision' &&
        (await db
          .selectFrom('minecraft_server_profiles')
          .select('server_id')
          .where('server_id', '=', server.id)
          .executeTakeFirst()) !== undefined;
      if (
        finalPowerIdentity ||
        ((operation.plan.gatewayAutomation !== undefined ||
          operation.plan.scheduleAutomation !== undefined ||
          minecraftProvision) &&
          !(phase === 'power' && operation.action === 'stop' && options.authorizeIntent))
      ) {
        // Preparing durable intent and provider identity checks can take time.
        // Do not carry an earlier automation grant across that interval. A
        // failure here proves perform() was never called, unlike a lost reply.
        try {
          if (operation.plan.gatewayAutomation !== undefined)
            assertGatewaySleepFence(operation.plan, nowOf(options));
          if (leanStart) {
            await timed('authorization', () =>
              options.authorizeEffect(jobId, server.id, db, {
                startAdmissionValidated: true,
                ...(options.authorizeIntent ? { deferFinalIntentCheck: true as const } : {}),
              }),
            );
            const authorizeIntent = options.authorizeIntent;
            if (authorizeIntent)
              await timed('authorization', () => authorizeIntent(jobId, server.id, db));
          } else if (finalPowerIdentity) {
            // Launch one fresh identity read and let independent runtime metadata
            // checks overlap it. Both proofs settle before any effect, including
            // for generic authorizers that do not consume the shared promise.
            const identity = timed('provider_identity', async () => {
              const value = await ownedRemote(db, server, options);
              // Preparation may wait: match the limits admission reserved using
              // this exact fresh snapshot, without another provider request.
              for (const key of ['memory', 'cpu', 'disk', 'swap', 'io'] as const)
                if (value.limits[key] !== server.limits[key])
                  throw new DomainError('provenance_mismatch');
              if (!installed(value) || value.suspended)
                throw new DomainError('configuration_invalid');
              return value;
            });
            const [ownership, authorization] = await Promise.allSettled([
              identity,
              timed('authorization', () =>
                options.authorizeEffect(jobId, server.id, db, {
                  providerServer: identity,
                  ...(options.authorizeIntent ? { deferFinalIntentCheck: true as const } : {}),
                }),
              ),
            ]);
            if (ownership.status === 'rejected') throw ownership.reason;
            if (authorization.status === 'rejected') throw authorization.reason;
            verifiedServer = ownership.value;
            // Generic authorizers may finish before the shared identity read.
            // Recheck current local authority after both await boundaries; callers
            // without a local guard retain a full fresh authorization fallback.
            await timed('authorization', () =>
              options.authorizeIntent
                ? options.authorizeIntent(jobId, server.id, db)
                : options.authorizeEffect(jobId, server.id, db, { providerServer: verifiedServer }),
            );
          } else {
            await timed('authorization', () => options.authorizeEffect(jobId, server.id, db));
          }
          if (phase === 'initial_start') await assertProvisionGatewayStart(db, server.id, jobId);
        } catch (error) {
          await update({
            effect_state: 'none',
            plan: {
              ...operation.plan,
              rejected: true,
              rejectionCode: safeError(error).code,
              powerEffectPrepared: false,
            },
          });
          throw error;
        }
      }
      let result: T;
      try {
        result = await timed('provider_effect', () => perform(verifiedServer));
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
    const installationCallbacks = (mutating: boolean) => ({
      authorize: async () => {
        try {
          await options.verifyObservationHost?.(server.id, db);
          if (mutating)
            await timed('authorization', () => options.authorizeEffect(jobId, server.id, db));
          await timed('provider_identity', () => ownedRemote(db, server, options));
          return true;
        } catch {
          return false;
        }
      },
      onConfirmed: async (outputs?: InitialInstallationOutputs) => {
        await db.transaction().execute(async (tx) => {
          await lockResources(tx);
          await tx
            .updateTable('server_operations')
            .set({
              plan: JSON.stringify({
                ...operation.plan,
                installConfirmed: true,
                installConfirmedAt: nowOf(options).toISOString(),
                installationProof: outputs
                  ? {
                      method: 'required_outputs_verified',
                      operationId: jobId,
                      providerUuid: server.pterodactyl_uuid,
                      ...outputs,
                    }
                  : { method: 'live_installation_event' },
              }),
              updated_at: nowOf(options),
            })
            .where('job_id', '=', jobId)
            .execute();
          await tx
            .deleteFrom('installation_reservations')
            .where('server_id', '=', server.id)
            .where('operation_id', '=', jobId)
            .execute();
        });
        operation = await db
          .selectFrom('server_operations')
          .selectAll()
          .where('job_id', '=', jobId)
          .executeTakeFirstOrThrow();
        await event('servers.operation.install_confirmed', {
          method: outputs ? 'required_outputs_verified' : 'live_installation_event',
        });
      },
    });
    const observeInstallation = async () => {
      if (operation.plan.installConfirmed === true) return true;
      await options.adapter.confirmInstallation(
        server.pterodactyl_id ?? 0,
        server.pterodactyl_identifier ?? '',
        installationCallbacks(false),
      );
      // A return value or a later cleared Panel status cannot substitute for persisted proof.
      return operation.plan.installConfirmed === true;
    };
    const settled = () =>
      operation.effect_started_at !== null &&
      nowOf(options).getTime() - operation.effect_started_at.getTime() >= settleOf(options);
    const resources = async () => {
      const value = await timed('provider_resources', () =>
        options.adapter.getResources(server.pterodactyl_identifier ?? ''),
      );
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

    const gameContext = (): GameLifecycleContext => ({
      db,
      server,
      adapter: options.adapter,
      operation: () => operation,
      update,
      effect,
      event,
      backup,
      authorize: () => options.authorizeEffect(jobId, server.id, db),
      assertStopped: async () => {
        await requireQuiescentReservation();
        if (!options.confirmAlreadyStopped || !(await options.confirmAlreadyStopped(server.id, db)))
          throw new DomainError('operation_uncertain');
      },
    });
    const recoverInitialInstallation = async () => {
      if (
        operation.action !== 'provision' ||
        operation.phase !== 'installation' ||
        operation.plan.installConfirmed === true ||
        !operation.effect_started_at ||
        operation.plan.installationEffectPrepared !== true ||
        !options.verifyInitialInstallation ||
        !options.confirmInitialInstallationStopped
      )
        return false;
      const plan = provisionPlanSchema.parse(operation.plan.provision);
      const assertOutcome = async () => {
        await timed('authorization', () => options.authorizeEffect(jobId, server.id, db));
        await options.verifyObservationHost?.(server.id, db);
        const remote = await timed('provider_identity', () => ownedRemote(db, server, options));
        if (
          !installed(remote) ||
          remote.egg !== plan.eggId ||
          !Number.isFinite(Date.parse(remote.created_at)) ||
          Date.parse(remote.created_at) <
            (operation.effect_started_at?.getTime() ?? Infinity) - 5_000 ||
          (await resources()).current_state !== 'offline' ||
          !(await options.confirmInitialInstallationStopped?.(server.id, db))
        )
          throw new DomainError('operation_uncertain');
      };
      await assertOutcome();
      const outputs = await options.verifyInitialInstallation(gameContext());
      if (!outputs) return false;
      // Streaming hashes can take time: never release installer admission using
      // authorization, provider identity or process observations from before the read.
      await assertOutcome();
      await installationCallbacks(false).onConfirmed(outputs);
      return true;
    };
    const completeExternalStop = async (): Promise<Result | null> => {
      if (
        !options.observeExternalStop ||
        !operation.effect_started_at ||
        !(
          (['start', 'restart'].includes(operation.action) && operation.phase === 'power') ||
          (operation.action === 'provision' && operation.phase === 'initial_start')
        )
      )
        return null;
      const receipt = await options.observeExternalStop(server.id, db);
      if (!receipt) return null;
      const started = processStartTime(receipt.startedAt);
      const finished = processStartTime(receipt.finishedAt);
      const effect = BigInt(operation.effect_started_at.getTime()) * 1_000_000n;
      if (
        started === null ||
        finished === null ||
        started <= effect ||
        finished < started ||
        finished > BigInt(nowOf(options).getTime()) * 1_000_000n ||
        Date.parse(receipt.activityAt) < operation.effect_started_at.getTime() ||
        receipt.startedAt === operation.plan.previousProcessStartedAt
      )
        return null;
      await update({
        plan: { ...operation.plan, waitReason: null, externalStopConfirmed: receipt },
      });
      // The process demonstrably started, then an interactive provider stop
      // ended that exact epoch. The start did not achieve its requested outcome;
      // suppress automatic wake and release only this physically confirmed stop.
      return finish(false, true, 'conflict', false, true);
    };
    const completeObservedStart = async (): Promise<Result | null> => {
      if (
        !options.observeProcessStart ||
        !operation.effect_started_at ||
        !(
          (['start', 'restart'].includes(operation.action) && operation.phase === 'power') ||
          (operation.action === 'provision' && operation.phase === 'initial_start')
        )
      )
        return null;
      const reason =
        operation.action === 'restart' ? 'restart_terminal_unproven' : 'start_terminal_unproven';
      let startedAt: string | null;
      try {
        startedAt = await timed(
          'process_observation',
          async () => (await options.observeProcessStart?.(server.id, db)) ?? null,
        );
      } catch {
        return wait(reason, 'operation_uncertain');
      }
      const started = processStartTime(startedAt);
      const previous = operation.plan.previousProcessStartedAt;
      const previousTime = processStartTime(previous);
      if (
        started === null ||
        started <= BigInt(operation.effect_started_at.getTime()) * 1_000_000n ||
        started > BigInt(nowOf(options).getTime()) * 1_000_000n ||
        (operation.action === 'restart' &&
          previous !== undefined &&
          previous !== null &&
          (previousTime === null || started === previousTime))
      )
        return wait(reason, 'operation_uncertain');
      // Fresh host-bound process proof supersedes Panel's cached resource state.
      // It confirms power only: game readiness and forwarding remain separate.
      await db.transaction().execute(async (tx) => {
        await lockResources(tx);
        const reservation = await tx
          .updateTable('resource_reservations')
          .set({ state: 'running', updated_at: nowOf(options) })
          .where('server_id', '=', server.id)
          .returning('server_id')
          .executeTakeFirst();
        if (!reservation) throw new DomainError('operation_uncertain');
        await tx
          .updateTable('managed_servers')
          .set({ runtime_state: 'running', last_observed_at: nowOf(options) })
          .where('id', '=', server.id)
          .execute();
      });
      await update({
        plan: {
          ...operation.plan,
          waitReason: null,
          ...(operation.action === 'restart'
            ? {
                restartConfirmed: true,
                restartConfirmedAt: nowOf(options).toISOString(),
                restartProcessStartedAt: startedAt,
              }
            : {
                startConfirmed: true,
                startConfirmedAt: nowOf(options).toISOString(),
                startProcessStartedAt: startedAt,
              }),
        },
      });
      return finish(true);
    };
    const consumeKill = (stillStopping: () => boolean = () => true) =>
      consumeStopEscalation(db, server.id, jobId, options.env ?? {}, {
        verify: async () => {
          const remote = await ownedRemote(db, server, options);
          const observe = options.observeReconciliationProcessStart;
          const baseline = operation.plan.stopProcessStartedAt;
          if (!observe || typeof baseline !== 'string' || !stillStopping()) return false;
          if (
            (await options.adapter.getResources(server.pterodactyl_identifier ?? ''))
              .current_state !== 'stopping'
          )
            return false;
          // Panel resource responses may be cached. Read the physical process epoch
          // last so a replacement during that request cannot inherit the old stop.
          return (await observe(server.id, db, remote)) === baseline && stillStopping();
        },
        power: () => {
          if (!stillStopping()) throw new DomainError('conflict');
          return options.adapter.power(server.pterodactyl_identifier ?? '', 'kill');
        },
      });
    const completeObservedStop = async (): Promise<Result | null> => {
      if (
        operation.action !== 'stop' ||
        operation.phase !== 'power' ||
        operation.plan.stopConfirmed !== true ||
        !options.confirmAlreadyStopped
      )
        return null;
      // The persisted terminal proof belongs to this operation. Recheck the
      // exact host/process before releasing capacity: Panel resources can still
      // report running for 20 seconds. This never grants another power effect.
      const providerServer = timed('provider_identity', () => ownedRemote(db, server, options));
      const observerPreflight = options.verifyObservationHost?.(server.id, db);
      // Share this attempt's proofs with the runtime instead of fetching the
      // same identity and Docker preflight twice. Generic observers cannot skip
      // either proof: all branches settle before capacity can be released.
      const proofs = await Promise.allSettled([
        providerServer,
        observerPreflight,
        options.confirmAlreadyStopped(server.id, db, { providerServer, observerPreflight }),
      ]);
      for (const proof of proofs) if (proof.status === 'rejected') throw proof.reason;
      if (proofs[2].status !== 'fulfilled' || !proofs[2].value)
        return wait('stop_terminal_unproven', 'operation_uncertain');
      return finish(true, true, null, false, true);
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
      if (operation.action === 'delete') {
        const leasesExpired = await db.transaction().execute(async (tx) => {
          await lockResources(tx);
          return revokeGatewayRoutesForDeletion(tx, server.id, nowOf(options));
        });
        // Return to the durable outbox instead of sleeping with a connection or
        // resource lock. This also fences old queued deletes and lost-response
        // recovery before either a remote mutation or local allocation release.
        if (!leasesExpired) return wait('gateway_lease_expiry');
      }
      if (operation.action === 'provision') {
        const plan = provisionPlanSchema.parse(operation.plan.provision);
        if (plan.externalId !== server.external_id) throw new DomainError('conflict');
        let remote = await options.adapter.findServerByExternalId(server.external_id);
        if (!server.pterodactyl_id) {
          if (operation.phase === 'planned') {
            if (remote) throw new DomainError('conflict');
            if (!options.reserveInstallation) throw new DomainError('configuration_invalid');
            const backend = await assertServerBackendAllocations(
              db,
              options.adapter,
              server.id,
              options.env,
            );
            const plannedIds = [plan.allocation.default, ...(plan.allocation.additional ?? [])];
            if (
              new Set(plannedIds).size !== plannedIds.length ||
              backend.length !== plannedIds.length ||
              backend.some((allocation) => !plannedIds.includes(allocation.id))
            )
              throw new DomainError('allocation_unavailable');
            await options.reserveInstallation(server.id, jobId, db);
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
              installation_state: 'installing',
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
        remote = await timed('provider_identity', () => ownedRemote(db, server, options));
        if (['install_failed', 'reinstall_failed'].includes(remote.status ?? '')) {
          await db
            .updateTable('managed_servers')
            .set({ installation_state: 'failed' })
            .where('id', '=', server.id)
            .execute();
          return finish(false, false, 'integration_unavailable');
        }
        if (
          operation.plan.installConfirmed !== true &&
          !(installed(remote) && (await recoverInitialInstallation())) &&
          !(await observeInstallation())
        )
          return wait('installation_terminal_unproven', 'operation_uncertain');
        remote = await timed('provider_identity', () => ownedRemote(db, server, options));
        if (!installed(remote)) return wait('installation');
        await db
          .updateTable('managed_servers')
          .set({ installation_state: 'installed' })
          .where('id', '=', server.id)
          .execute();
        if (operation.phase === 'initial_start') {
          const externalStop = await completeExternalStop();
          if (externalStop) return externalStop;
          await activateProvisionGateway(db, server.id, jobId, options.env);
          await update({});
          const observedStart = await completeObservedStart();
          if (observedStart) return observedStart;
          if (!settled()) return wait('resource_cache_expiry');
          const current = await resources();
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
          if (current.current_state === 'offline')
            return wait('start_preboot_or_unknown', 'operation_uncertain');
          return wait('power_confirmation');
        }
        const current = await resources();
        if (current.current_state !== 'offline') return wait('unexpected_provision_power_state');
        if (
          options.configureGameProvision &&
          !(await options.configureGameProvision(gameContext()))
        )
          return wait('game_configuration');
        await timed('authorization', () => options.authorizeEffect(jobId, server.id, db));
        await activateProvisionGateway(db, server.id, jobId, options.env);
        await update({});
        if (operation.plan.autoStart === true) {
          if (!options.reserveStart) throw new DomainError('configuration_invalid');
          if (typeof operation.plan.reservationCreated !== 'boolean') {
            const priorReservation = await db
              .selectFrom('resource_reservations')
              .select('server_id')
              .where('server_id', '=', server.id)
              .executeTakeFirst();
            await update({ plan: { ...operation.plan, reservationCreated: !priorReservation } });
          }
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
          await prepareProvisionGatewayStart(db, server.id, jobId, nowOf(options));
          await update({});
          await effect('initial_start', () =>
            options.adapter.power(server.pterodactyl_identifier ?? '', 'start'),
          );
          return wait('power_confirmation');
        }
        return finish(true);
      }

      if (operation.action === 'delete' && server.pterodactyl_id === null) {
        await timed('authorization', () => options.authorizeEffect(jobId, server.id, db));
        const rejected = await db
          .selectFrom('server_operations as operation')
          .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
          .select(['operation.effect_state', 'operation.plan', 'job.state'])
          .where('operation.server_id', '=', server.id)
          .where('operation.action', '=', 'provision')
          .executeTakeFirst();
        if (
          rejected?.state !== 'failed' ||
          rejected.effect_state !== 'none' ||
          (rejected.plan.rejected !== true && rejected.plan.noExternalEffect !== true)
        )
          throw new DomainError('operation_uncertain');
        if (await options.adapter.findServerByExternalId(server.external_id))
          throw new DomainError('provenance_mismatch');
        // Durable pre-effect failure or definite rejection plus corroborated absence proves no remote asset.
        return finish(true, true);
      }
      const leanPlannedStart = operation.action === 'start' && operation.phase === 'planned';
      let remote!: ApplicationServer;
      let cachedLimits: ApplicationServer['limits'] | null = null;
      let initialResources: Resources | undefined;
      let preparedStartAdmission: (() => Promise<void>) | undefined;
      try {
        if (leanPlannedStart) {
          // Keep one fresh limit snapshot: Wings does not enforce NickHosting's
          // active-resource reservations. No separate provider telemetry/inventory preflight.
          const [limits, admission] = await Promise.allSettled([
            timed('provider_limits', async () => {
              cachedLimits = (await options.cachedStartLimits?.(server.id, db)) ?? null;
              if (cachedLimits) return null;
              if (server.pterodactyl_id === null) throw new DomainError('conflict');
              return options.adapter.getApplicationServer(server.pterodactyl_id);
            }),
            options.prepareStartAdmission?.(server.id, jobId, db) ?? Promise.resolve(undefined),
          ]);
          if (limits.status === 'rejected') throw limits.reason;
          if (admission.status === 'rejected') throw admission.reason;
          if (limits.value) remote = limits.value;
          const node = await db
            .selectFrom('managed_nodes')
            .select('pterodactyl_node_id')
            .where('id', '=', server.node_id)
            .executeTakeFirstOrThrow();
          // The limits snapshot must describe the same stored power target; this
          // comparison requires no further provider or allocation inventory read.
          if (
            !cachedLimits &&
            (remote.node !== node.pterodactyl_node_id ||
              remote.id !== server.pterodactyl_id ||
              remote.identifier !== server.pterodactyl_identifier ||
              remote.uuid !== server.pterodactyl_uuid)
          )
            throw new DomainError('provenance_mismatch');
          preparedStartAdmission = admission.value;
        } else if (
          operation.phase === 'planned' &&
          ['start', 'stop', 'restart'].includes(operation.action)
        ) {
          // Independent reads overlap, but foreign identity must never publish telemetry.
          // Settle every promise even on failure so no rejection escapes the operation.
          const [identity, status, admission] = await Promise.allSettled([
            timed('provider_identity', () => ownedRemote(db, server, options)),
            timed('provider_resources', () =>
              options.adapter.getResources(server.pterodactyl_identifier ?? ''),
            ),
            operation.action === 'start' && options.prepareStartAdmission
              ? options.prepareStartAdmission(server.id, jobId, db)
              : Promise.resolve(undefined),
          ]);
          if (identity.status === 'rejected') throw identity.reason;
          if (status.status === 'rejected') throw status.reason;
          if (admission.status === 'rejected') throw admission.reason;
          preparedStartAdmission = admission.value;
          remote = identity.value;
          initialResources = status.value;
          await observation(db, server, initialResources, nowOf(options));
        } else {
          remote = await timed('provider_identity', () => ownedRemote(db, server, options));
        }
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
        const observedStop = await completeObservedStop();
        if (observedStop) return observedStop;
        const externalStop = await completeExternalStop();
        if (externalStop) return externalStop;
        const observedStart = await completeObservedStart();
        if (observedStart) return observedStart;
        const current = leanPlannedStart ? undefined : (initialResources ?? (await resources()));
        if (operation.phase === 'planned') {
          if (
            action === 'stop' &&
            current?.current_state === 'offline' &&
            options.confirmAlreadyStopped
          ) {
            const reservation = await db
              .selectFrom('resource_reservations')
              .select('server_id')
              .where('server_id', '=', server.id)
              .executeTakeFirst();
            if (!reservation) {
              try {
                if (!(await options.confirmAlreadyStopped(server.id, db)))
                  return wait('already_stopped_unproven', 'operation_uncertain');
              } catch {
                return wait('already_stopped_unproven', 'operation_uncertain');
              }
              await timed('authorization', () => options.authorizeEffect(jobId, server.id, db));
              return finish(true, false, null, true);
            }
          }
          if (action !== 'stop') {
            for (const key of ['memory', 'cpu', 'disk', 'swap', 'io'] as const) {
              if ((cachedLimits ?? remote.limits)[key] !== server.limits[key])
                throw new DomainError('provenance_mismatch');
            }
            if (!leanPlannedStart && (!installed(remote) || remote.suspended))
              throw new DomainError('configuration_invalid');
            if (preparedStartAdmission) await preparedStartAdmission();
            else if (options.reserveStart) await options.reserveStart(server.id, jobId, action, db);
            else throw new DomainError('configuration_invalid');
            const reservation = await db
              .selectFrom('resource_reservations')
              .select('server_id')
              .where('server_id', '=', server.id)
              .executeTakeFirst();
            if (!reservation) throw new DomainError('conflict');
          }
          let previousProcessStartedAt: string | null | undefined;
          if (action === 'restart' && options.observeProcessStart) {
            try {
              previousProcessStartedAt = await timed(
                'process_observation',
                async () => (await options.observeProcessStart?.(server.id, db)) ?? null,
              );
              const previousTime = processStartTime(previousProcessStartedAt);
              if (
                previousProcessStartedAt !== null &&
                (previousTime === null ||
                  previousTime > BigInt(nowOf(options).getTime()) * 1_000_000n)
              )
                return wait('restart_baseline_unavailable', 'operation_uncertain');
            } catch {
              return wait('restart_baseline_unavailable', 'operation_uncertain');
            }
          }
          await update({
            plan: {
              ...operation.plan,
              previousUptime: current?.resources.uptime ?? null,
              ...(action === 'restart' && options.observeProcessStart
                ? { previousProcessStartedAt }
                : {}),
            },
          });
          if (action === 'stop') {
            await effect(
              'power',
              async (verifiedServer) => {
                const result = await options.adapter.stopWithConfirmation(
                  server.pterodactyl_id ?? 0,
                  server.pterodactyl_identifier ?? '',
                  {
                    ...(verifiedServer ? { verifiedServer } : {}),
                    onStage: (stage, durationMs, outcome) =>
                      log('servers.stop_stage', { stage, durationMs, outcome }),
                    beforePower: async () => {
                      try {
                        // The socket/token handshake can wait. Fresh provider identity
                        // and host/effect authorization are independent read-only proofs.
                        // Settle both before durable handoff; neither alone permits power.
                        const providerServer = timed('provider_identity', () =>
                          ownedRemote(db, server, options),
                        );
                        const processBaseline = options.observeReconciliationProcessStart
                          ? providerServer.then((remote) =>
                              options.observeReconciliationProcessStart?.(server.id, db, remote),
                            )
                          : Promise.resolve(undefined);
                        const proofs = await Promise.allSettled([
                          providerServer,
                          processBaseline,
                          timed('authorization', async () => {
                            if (!options.effectAuthorizationVerifiesHost)
                              await options.verifyObservationHost?.(server.id, db);
                            await options.authorizeEffect(jobId, server.id, db, {
                              providerServer,
                            });
                          }),
                        ]);
                        for (const proof of proofs)
                          if (proof.status === 'rejected') throw proof.reason;
                        const startedAt = await processBaseline;
                        if (startedAt !== undefined)
                          await update({
                            plan: { ...operation.plan, stopProcessStartedAt: startedAt },
                          });
                        // Generic authorizers need not consume the shared promise.
                        // Always re-read revocable local authority after both proofs.
                        if (!isGatewaySleep(operation))
                          await timed('authorization', () =>
                            options.authorizeIntent
                              ? options.authorizeIntent(jobId, server.id, db)
                              : options.authorizeEffect(jobId, server.id, db, {
                                  providerServer,
                                }),
                          );
                        if (isGatewaySleep(operation)) {
                          assertGatewaySleepFence(operation.plan, nowOf(options));
                          await update({
                            plan: {
                              ...operation.plan,
                              gatewaySleepHandoffAt: nowOf(options).toISOString(),
                            },
                          });
                          await timed('authorization', () =>
                            (options.authorizeIntent ?? options.authorizeEffect)(
                              jobId,
                              server.id,
                              db,
                            ),
                          );
                          await assertIdleSleepAllowed(db, server.id, options.env);
                          // A durable write can wait; never outlive the original fence.
                          assertGatewaySleepFence(operation.plan, nowOf(options));
                        }
                      } catch (error) {
                        if (!(error instanceof DomainError)) throw error;
                        throw new PterodactylError('permission_denied', 'client', 'rejected');
                      }
                    },
                    authorize: async () => {
                      try {
                        // This internal status-only relay exposes nothing to a browser.
                        // Recheck current DB permissions without repeating provider reads.
                        await timed('authorization', () =>
                          (options.authorizeIntent ?? options.authorizeEffect)(
                            jobId,
                            server.id,
                            db,
                          ),
                        );
                        return true;
                      } catch {
                        return false;
                      }
                    },
                    onStoppingWait: consumeKill,
                    onConfirmed: async () => {
                      await update({
                        plan: {
                          ...operation.plan,
                          stopConfirmed: true,
                          stopConfirmedAt: nowOf(options).toISOString(),
                        },
                      });
                      await event('servers.operation.stop_confirmed');
                    },
                  },
                );
                // The persisted callback is the proof. A bare helper return cannot replace it.
                if (!result.confirmed || operation.plan.stopConfirmed !== true)
                  throw new PterodactylError('unavailable', 'client', 'unknown');
              },
              undefined,
              remote,
            );
          } else
            await effect('power', () =>
              options.adapter.power(server.pterodactyl_identifier ?? '', action),
            );
          const stopped = await completeObservedStop();
          if (stopped) return stopped;
          return wait('power_confirmation');
        }
        if (!current) throw new DomainError('operation_uncertain');
        if (action === 'stop' && operation.phase === 'power') {
          await consumeKill();
          const latest = await db
            .selectFrom('operation_jobs')
            .select('policy_snapshot')
            .where('id', '=', jobId)
            .executeTakeFirstOrThrow();
          const escalation = stopEscalation(latest.policy_snapshot);
          if (
            escalation &&
            escalation.state !== 'requested' &&
            escalation.state !== 'rejected' &&
            options.confirmAlreadyStopped &&
            (await options.confirmAlreadyStopped(server.id, db))
          ) {
            await update({
              plan: {
                ...operation.plan,
                stopConfirmed: true,
                stopConfirmedAt: nowOf(options).toISOString(),
              },
            });
            const completed = await completeObservedStop();
            if (completed) return completed;
          }
        }
        if (!settled()) return wait('resource_cache_expiry');
        if (action === 'stop' && current.current_state === 'offline') {
          // The backend adapter must corroborate its ordered WebSocket transition
          // with trusted, host-bound Docker non-running evidence before persisting proof.
          if (operation.plan.stopConfirmed !== true)
            return wait('stop_terminal_unproven', 'operation_uncertain');
          if (!isGatewaySleep(operation))
            await db
              .updateTable('managed_servers')
              .set({ intent: 'manually_stopped' })
              .where('id', '=', server.id)
              .execute();
          return finish(true, true);
        }
        if (action !== 'stop' && current.current_state === 'running') {
          if (action === 'restart') {
            // Isolated legacy fixtures can omit the host observer. Production
            // always supplies it and must never fall back to cached uptime.
            const restarted =
              operation.plan.transitionObserved === true ||
              (typeof operation.plan.previousUptime === 'number' &&
                current.resources.uptime !== undefined &&
                current.resources.uptime < operation.plan.previousUptime);
            if (!restarted) return wait('restart_outcome_unknown');
          }
          await db
            .updateTable('resource_reservations')
            .set({ state: 'running', updated_at: nowOf(options) })
            .where('server_id', '=', server.id)
            .execute();
          return finish(true);
        }
        if (action === 'start' && current.current_state === 'offline')
          return wait('start_preboot_or_unknown', 'operation_uncertain');
        if (action === 'restart' && current.current_state !== 'running')
          await update({ plan: { ...operation.plan, transitionObserved: true } });
        return wait('power_confirmation');
      }
      if (operation.action === 'backup') {
        if (await backup()) return finish(true);
        return wait('backup_confirmation');
      }
      await requireQuiescentReservation();
      if (!(await offline())) return wait('offline_confirmation');
      if (operation.action === 'minecraft-content') {
        if (!options.processGameContent) throw new DomainError('configuration_invalid');
        if (!(await options.processGameContent(gameContext())))
          return wait('game_content_confirmation');
        return finish(true);
      }
      if (operation.plan.backupBefore === true && operation.plan.backupComplete !== true) {
        if (!(await backup())) return wait('backup_confirmation');
      }
      if (operation.action === 'delete') {
        if (operation.phase !== 'delete') {
          await timed('authorization', () => options.authorizeEffect(jobId, server.id, db));
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
      if (
        ['wipe', 'reinstall'].includes(operation.action) &&
        operation.plan.minecraftConfigurationInvalidated !== true
      ) {
        const invalidated = await db
          .updateTable('minecraft_server_profiles')
          .set({
            installed: false,
            configuration_state: JSON.stringify({ status: 'pending', jobId: operation.job_id }),
            updated_at: nowOf(options),
          })
          .where('server_id', '=', server.id)
          .returning('server_id')
          .executeTakeFirst();
        if (invalidated)
          await update({
            plan: { ...operation.plan, minecraftConfigurationInvalidated: true },
          });
      }
      if (['wipe', 'reinstall', 'restore'].includes(operation.action))
        await db
          .updateTable('minecraft_server_profiles')
          .set({ installed: false, updated_at: nowOf(options) })
          .where('server_id', '=', server.id)
          .execute();
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
        // Game configuration may add durable phases after the installer. Never
        // interpret those phases as permission to run the installer again.
        if (operation.plan.installationEffectPrepared !== true) {
          if (!options.reserveInstallation) throw new DomainError('configuration_invalid');
          await options.reserveInstallation(server.id, jobId, db);
          if (operation.plan.previousInstallationState === undefined)
            await update({
              plan: { ...operation.plan, previousInstallationState: server.installation_state },
            });
          await db
            .updateTable('managed_servers')
            .set({ installation_state: 'installing' })
            .where('id', '=', server.id)
            .execute();
          await effect('reinstall', async () => {
            await options.adapter.reinstallWithConfirmation(
              server.pterodactyl_id ?? 0,
              server.pterodactyl_identifier ?? '',
              installationCallbacks(true),
            );
            if (operation.plan.installConfirmed !== true)
              throw new PterodactylError('unavailable', 'client', 'unknown');
          });
          return wait('installation');
        }
        if (['install_failed', 'reinstall_failed'].includes(remote.status ?? '')) {
          await db
            .updateTable('managed_servers')
            .set({ installation_state: 'failed' })
            .where('id', '=', server.id)
            .execute();
          return finish(false, false, 'integration_unavailable');
        }
        if (!(await observeInstallation()))
          return wait('installation_terminal_unproven', 'operation_uncertain');
        remote = await timed('provider_identity', () => ownedRemote(db, server, options));
        if (installed(remote) && settled()) {
          await db
            .updateTable('managed_servers')
            .set({ installation_state: 'installed' })
            .where('id', '=', server.id)
            .execute();
          if (
            options.configureGameProvision &&
            !(await options.configureGameProvision(gameContext()))
          )
            return wait('game_configuration');
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
          const copies = (
            await options.adapter.listBackups(server.pterodactyl_identifier ?? '')
          ).filter((backup) => backup.name === snapshot.name);
          if (copies.length !== 1 || copies[0]?.uuid !== backupId)
            throw new DomainError('conflict');
          const baseline = await options.adapter.listBackupActivity(
            server.pterodactyl_identifier ?? '',
          );
          await update({
            plan: {
              ...operation.plan,
              restoreBackupName: snapshot.name,
              restoreActivityBaseline: baseline.map((event) => event.id),
            },
          });
          await effect('restore', () =>
            options.adapter.restoreBackup(
              server.pterodactyl_identifier ?? '',
              backupId,
              operation.plan.truncate === true,
            ),
          );
          return wait('restore_confirmation');
        }
        // Panel clears restoring_backup for both success and failure. Only a new
        // correlated terminal activity event proves the outcome; HTTP 204 is not success.
        if (
          !operation.effect_started_at ||
          typeof operation.plan.restoreBackupName !== 'string' ||
          !Array.isArray(operation.plan.restoreActivityBaseline)
        )
          return wait('restore_evidence_missing', 'operation_uncertain');
        const baseline = new Set(z.array(z.string()).parse(operation.plan.restoreActivityBaseline));
        const activities = await options.adapter.listBackupActivity(
          server.pterodactyl_identifier ?? '',
        );
        const boundary = Math.floor(operation.effect_started_at.getTime() / 1000) * 1000;
        const terminal = activities.filter(
          (event) =>
            !baseline.has(event.id) &&
            event.properties.name === operation.plan.restoreBackupName &&
            Date.parse(event.timestamp) >= boundary &&
            Date.parse(event.timestamp) <= nowOf(options).getTime() + 1000 &&
            [
              'server:backup.restore-complete',
              'server.backup.restore-failed',
              'server:backup.restore-failed',
            ].includes(event.event),
        );
        if (terminal.length !== 1 || remote.status || !settled())
          return wait('restore_evidence_pending', 'operation_uncertain');
        const evidence = terminal[0];
        if (!evidence) return wait('restore_evidence_pending', 'operation_uncertain');
        await update({
          plan: {
            ...operation.plan,
            restoreEvidence: {
              id: evidence.id,
              event: evidence.event,
              timestamp: evidence.timestamp,
            },
          },
        });
        if (
          evidence.event === 'server:backup.restore-complete' &&
          options.verifyGameRestore &&
          !(await options.verifyGameRestore(gameContext()))
        )
          return wait('game_restore_verification');
        return finish(
          evidence.event === 'server:backup.restore-complete',
          true,
          evidence.event === 'server:backup.restore-complete' ? null : 'integration_unavailable',
        );
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
          'allocation_unavailable',
        ].includes(error.code)
      )
        return finish(false, false, code);
      if (operation.phase === 'installation' && code === 'operation_uncertain')
        return wait('installation_terminal_unproven', code);
      return wait('provider_unavailable', code);
    } finally {
      await db
        .updateTable('server_operations')
        .set({ lease_token: null, lease_until: null })
        .where('job_id', '=', jobId)
        .where('lease_token', '=', token)
        .execute();
    }
  }).then((result) => {
    if (!acquired)
      log('servers.operation_deferred', {
        reason: 'server_lock_busy',
        durationMs: Math.round(performance.now() - lockStarted),
      });
    return result;
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
    const remote = await ownedRemote(db, server, options);
    const state = ['install_failed', 'reinstall_failed'].includes(remote.status ?? '')
      ? 'failed'
      : installationPending(remote)
        ? 'installing'
        : server.installation_state;
    await db
      .updateTable('managed_servers')
      .set({ installation_state: state })
      .where('id', '=', server.id)
      .execute();
    let current = await options.adapter.getResources(server.pterodactyl_identifier ?? '');
    const now = nowOf(options);
    let externalStop: ExternalStopReceipt | null = null;
    if (!server.active_operation_id && options.observeExternalStop) {
      const reserved = await db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', server.id)
        .executeTakeFirst();
      if (
        reserved ||
        (server.intent === 'manually_stopped' && current.current_state !== 'offline')
      ) {
        try {
          externalStop = await options.observeExternalStop(server.id, db);
        } catch (error) {
          // Missing activity permission/observer evidence is not proof of a stop.
          // Continue conservative state reconciliation without releasing capacity.
          if (error instanceof DomainError && error.code === 'provenance_mismatch') throw error;
        }
      }
      if (externalStop)
        current = {
          ...current,
          current_state: 'offline',
          resources: { ...current.resources, memory_bytes: 0, cpu_absolute: 0 },
        };
    }
    if (
      !externalStop &&
      !server.active_operation_id &&
      server.intent !== 'manually_stopped' &&
      server.intent !== 'maintenance' &&
      installed(remote) &&
      ['offline', 'starting'].includes(current.current_state) &&
      options.observeReconciliationProcessStart
    ) {
      const latestPower = await db
        .selectFrom('server_operations as operation')
        .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
        .select([
          'operation.action',
          'operation.phase',
          'operation.plan',
          'operation.effect_state',
          'operation.effect_started_at',
          'job.state as job_state',
        ])
        .where('operation.server_id', '=', server.id)
        .where('operation.action', 'in', [
          'start',
          'restart',
          'stop',
          'provision',
          'reinstall',
          'wipe',
          'delete',
          'restore',
        ])
        .orderBy('operation.updated_at', 'desc')
        .orderBy('operation.job_id', 'desc')
        .executeTakeFirst();
      const restart = latestPower?.action === 'restart';
      const epoch = processStartTime(
        restart
          ? latestPower?.plan.restartProcessStartedAt
          : latestPower?.plan.startProcessStartedAt,
      );
      const confirmed = processStartTime(
        restart ? latestPower?.plan.restartConfirmedAt : latestPower?.plan.startConfirmedAt,
      );
      const reservation = await db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', server.id)
        .executeTakeFirst();
      if (
        reservation &&
        latestPower &&
        ['start', 'restart', 'provision'].includes(latestPower.action) &&
        latestPower.phase === 'complete' &&
        latestPower.job_state === 'succeeded' &&
        latestPower.effect_state === 'confirmed' &&
        latestPower.effect_started_at &&
        (restart ? latestPower.plan.restartConfirmed : latestPower.plan.startConfirmed) === true &&
        epoch !== null &&
        confirmed !== null &&
        epoch > BigInt(latestPower.effect_started_at.getTime()) * 1_000_000n &&
        confirmed >= epoch &&
        confirmed <= BigInt(now.getTime()) * 1_000_000n
      ) {
        try {
          const observed = processStartTime(
            await options.observeReconciliationProcessStart(server.id, db, remote),
          );
          // Panel caches resources across power transitions. Only a fresh proof
          // of the exact durably confirmed epoch supersedes that stale sample;
          // another process, unavailable observer or stop never inherits it.
          if (observed === epoch) current = { ...current, current_state: 'running' };
        } catch (error) {
          if (error instanceof DomainError && error.code === 'provenance_mismatch') throw error;
          // Preserve conservative cached-state accounting; never release capacity.
        }
      }
    }
    if (
      current.current_state !== 'offline' &&
      server.runtime_state === 'offline' &&
      !server.active_operation_id &&
      options.confirmAlreadyStopped
    ) {
      const latestPower = await db
        .selectFrom('server_operations')
        .select(['action', 'phase', 'plan'])
        .where('server_id', '=', server.id)
        .where('action', 'in', ['start', 'restart', 'stop', 'provision'])
        .orderBy('updated_at', 'desc')
        .orderBy('job_id', 'desc')
        .executeTakeFirst();
      const confirmedAt =
        typeof latestPower?.plan.stopConfirmedAt === 'string'
          ? Date.parse(latestPower.plan.stopConfirmedAt)
          : NaN;
      if (
        latestPower?.action === 'stop' &&
        latestPower.phase === 'complete' &&
        latestPower.plan.stopConfirmed === true &&
        confirmedAt <= now.getTime() &&
        now.getTime() - confirmedAt < settleOf(options)
      ) {
        // A completed ordered stop can precede expiry of Panel's resources
        // cache. Do not re-import that cached running sample as an external
        // start or recreate its released reservation. A new running process,
        // newer power operation or expired cache window defeats this exception.
        await options.verifyObservationHost?.(server.id, db);
        if (await options.confirmAlreadyStopped(server.id, db)) {
          await ownedRemote(db, server, options);
          return 'observed';
        }
      }
    }
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
      if (externalStop && !locked.active_operation_id) {
        await tx.deleteFrom('resource_reservations').where('server_id', '=', server.id).execute();
        await tx
          .updateTable('managed_servers')
          .set({
            intent: 'manually_stopped',
            runtime_state: 'offline',
            readiness: 'unknown',
            last_observed_at: now,
            updated_at: now,
          })
          .where('id', '=', server.id)
          .execute();
        if (reservation)
          await tx
            .insertInto('server_events')
            .values({
              server_id: server.id,
              job_id: null,
              actor_id: null,
              subject_id: server.owner_id,
              support_session_id: null,
              message_key: 'servers.operation.stop_confirmed',
              data: JSON.stringify({ source: 'provider_activity', receipt: externalStop }),
            })
            .execute();
        return;
      }
      const overhead = effectiveNodeOverhead(node, options.env);
      const physicalMemory = physicalMemoryMiB(server.limits.memory, overhead);
      const installation = await tx
        .selectFrom('installation_reservations')
        .selectAll()
        .where('server_id', '=', server.id)
        .executeTakeFirst();
      const installationMemory = physicalMemoryMiB(
        Math.max(server.limits.memory, node.installer_memory_mib),
        overhead,
      );
      if (installation && installationMemory > installation.memory_mib)
        await tx
          .updateTable('installation_reservations')
          .set({ memory_mib: installationMemory, updated_at: now })
          .where('server_id', '=', server.id)
          .execute();
      if (reservation && physicalMemory > reservation.physical_memory_mib)
        await tx
          .updateTable('resource_reservations')
          .set({ physical_memory_mib: physicalMemory, updated_at: now })
          .where('server_id', '=', server.id)
          .execute();
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
              physical_memory_mib: physicalMemory,
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
        // Wings automatic crash recovery can remain offline while a new start is
        // already executing. A cached offline sample does not prove final quiescence.
        await tx
          .updateTable('resource_reservations')
          .set({ state: 'uncertain', updated_at: now })
          .where('server_id', '=', server.id)
          .execute();
      }
    });
    return 'observed';
  });
}

/** Owner acknowledgment ends a quarantined ambiguous job without claiming remote success. */
export async function resolveUncertainOperation(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  context: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment = {},
): Promise<'resolved' | 'deferred'> {
  assertPermission(context, 'platform:manage');
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
  const parsed = z
    .strictObject({
      jobId: z.uuid(),
      confirm: z.literal(true),
      reason: z.string().trim().min(12).max(500),
    })
    .safeParse(input);
  if (!parsed.success || !z.uuid().safeParse(serverId).success)
    throw new DomainError('validation_failed');
  return withServerLock(db, serverId, async (connection) => {
    const server = await connection
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const operation = await connection
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', parsed.data.jobId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!server || !operation) throw new DomainError('not_found');
    if (
      server.active_operation_id !== operation.job_id ||
      !operation.effect_started_at ||
      Date.now() - operation.effect_started_at.getTime() < 120_000
    )
      throw new DomainError('conflict');
    if (
      ['start', 'restart', 'stop'].includes(operation.action) ||
      operation.phase === 'initial_start'
    )
      throw new DomainError('operation_uncertain');
    if (!server.pterodactyl_id) throw new DomainError('operation_uncertain');
    const remote = await adapter.getApplicationServer(server.pterodactyl_id);
    await verifyManagedIdentity(connection, server, remote);
    const resources = await adapter.getResources(server.pterodactyl_identifier ?? '');
    if (remote.status || !installed(remote) || resources.current_state !== 'offline')
      throw new DomainError('conflict');
    await connection.transaction().execute(async (tx) => {
      await lockResources(tx);
      // A bound browser session can expire, be revoked or lose its Owner role
      // while waiting for this lock or provider proof. Check the live authority
      // on the pinned transaction immediately before any resolution mutation.
      // Unbound internal callers retain the existing domain-test contract.
      const current = context[authSessionId]
        ? await currentInteractiveContext(tx, context, env)
        : context;
      assertPermission(current, 'platform:manage');
      if (current.sessionType !== 'regular') throw new DomainError('forbidden');
      await tx
        .updateTable('operation_jobs')
        .set({
          state: 'failed',
          error_code: 'operation_uncertain',
          completed_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', operation.job_id)
        .execute();
      await tx
        .updateTable('server_operations')
        .set({
          phase: 'owner_resolved_failed',
          plan: JSON.stringify({
            ...operation.plan,
            ownerResolution: {
              actorId: current.actorUserId,
              reason: parsed.data.reason,
              at: new Date().toISOString(),
            },
          }),
          lease_token: null,
          lease_until: null,
          updated_at: new Date(),
        })
        .where('job_id', '=', operation.job_id)
        .execute();
      await tx
        .updateTable('managed_servers')
        .set({ active_operation_id: null, runtime_state: 'offline', updated_at: new Date() })
        .where('id', '=', serverId)
        .where('active_operation_id', '=', operation.job_id)
        .execute();
      // Retained reservations stay quarantined; elapsed offline time does not prove quiescence.
      await tx
        .updateTable('resource_reservations')
        .set({ state: 'uncertain', updated_at: new Date() })
        .where('server_id', '=', serverId)
        .execute();
      await tx.deleteFrom('job_outbox').where('job_id', '=', operation.job_id).execute();
      await recordAudit(tx, current, 'server.operation.owner_resolution', {
        serverId,
        jobId: operation.job_id,
        reason: parsed.data.reason,
        outcome: 'acknowledged_unknown_failure',
      });
      await tx
        .insertInto('server_events')
        .values({
          server_id: serverId,
          job_id: operation.job_id,
          actor_id: current.actorUserId,
          subject_id: current.subjectUserId,
          support_session_id: null,
          message_key: 'servers.operation.owner_resolution',
          data: JSON.stringify({ outcome: 'acknowledged_unknown_failure' }),
        })
        .execute();
    });
    return 'resolved' as const;
  });
}
