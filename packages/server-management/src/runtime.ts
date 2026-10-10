import {
  type AuthContext,
  assertAuthContext,
  type createLogger,
  DomainError,
  type SecretCodec,
} from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import { evaluateGameAccess } from '@nickhosting/game-sdk';
import {
  type ApplicationServer,
  type ContainerObserver,
  createContainerObserver,
  createPterodactylAdapter,
  type PterodactylAdapter,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import {
  type Environment,
  observeLocalHost,
  reserveInstallation,
  reserveStart,
} from './admission.js';
import { resolveHostOverride } from './configuration.js';
import {
  cleanupServerExternalServices,
  type ExternalServiceOptions,
  reconcileExternalServices,
} from './external.js';
import {
  createGameRuntimeDispatcher,
  type RuntimeImageContext,
  trustedGameModules,
} from './game-modules.js';
import { currentInteractiveContext } from './interactive-context.js';
import {
  createLifecycleProcessor,
  type ExternalStopReceipt,
  reconcileManagedServer,
  verifyManagedIdentity,
} from './lifecycle.js';
import { createMinecraftModuleRuntime } from './minecraft-module.js';
import { assertGatewaySleepFence, authorizeServer } from './registry.js';
import { authorizeScheduledEffect } from './schedules.js';
import { assertIdleSleepAllowed } from './sleep-policy.js';
import { assertNoPendingUpload } from './upload-admission.js';

/** A queued operation retains attribution, never a permanently elevated authorization snapshot. */
export async function authorizeQueuedEffect(
  db: Kysely<Database>,
  jobId: string,
  serverId: string,
  env: Environment = {},
  adapter?: PterodactylAdapter,
) {
  const job = await db
    .selectFrom('operation_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst();
  const operation = await db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', jobId)
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (!job || !operation) throw new DomainError('forbidden');
  const user = await db
    .selectFrom('user')
    .select(['id', 'role'])
    .where('id', '=', job.actor_id)
    .executeTakeFirst();
  if (!user) throw new DomainError('unauthenticated');
  let context: AuthContext = {
    actorUserId: user.id,
    subjectUserId: job.subject_id,
    role: user.role,
    sessionType: 'regular',
    ownerElevation: false,
  };
  if (job.support_session_id) {
    const support = await db
      .selectFrom('support_sessions')
      .selectAll()
      .where('id', '=', job.support_session_id)
      .executeTakeFirst();
    if (
      !support ||
      support.actor_user_id !== job.actor_id ||
      support.subject_user_id !== job.subject_id
    )
      throw new DomainError('support_invalid');
    const parent = await db
      .selectFrom('session')
      .select(['userId', 'expiresAt'])
      .where('id', '=', support.parent_session_id)
      .executeTakeFirst();
    if (!parent || parent.userId !== job.actor_id || parent.expiresAt <= new Date())
      throw new DomainError('support_expired');
    const { values } = await getSettings(db, env);
    context = {
      ...context,
      sessionType: 'support',
      ownerElevation: true,
      support: {
        id: support.id,
        startedAt: support.started_at,
        expiresAt: support.expires_at,
        lastActivityAt: support.last_activity_at,
        revokedAt: support.revoked_at,
        reason: support.reason,
        idleTtlSeconds: values.supportIdleTtlSeconds,
        absoluteTtlSeconds: values.supportAbsoluteTtlSeconds,
      },
    };
  }
  assertAuthContext(context);
  const server = await authorizeServer(
    db,
    context,
    serverId,
    ['start', 'stop', 'restart', 'backup'].includes(operation.action)
      ? 'server:operate'
      : 'server:manage',
  );
  if (server.owner_id !== job.resource_owner_id) throw new DomainError('forbidden');
  if (operation.plan.scheduleAutomation !== undefined)
    await authorizeScheduledEffect(db, jobId, serverId);
  const game = await trustedGameModules.resolve(db, serverId);

  if (operation.plan.gatewayAutomation !== undefined) {
    if (server.connection_mode === 'direct') throw new DomainError('forbidden');
    const marker = operation.plan.gatewayAutomation;
    if (
      typeof marker !== 'object' ||
      marker === null ||
      !('generation' in marker) ||
      typeof marker.generation !== 'string' ||
      !('kind' in marker) ||
      !['wake', 'sleep'].includes(String(marker.kind))
    )
      throw new DomainError('forbidden');
    const policy = await db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (
      !policy?.enabled ||
      policy.generation !== marker.generation ||
      ['manually_stopped', 'maintenance'].includes(server.intent) ||
      (marker.kind === 'wake' &&
        (operation.action !== 'start' ||
          policy.wake_job_id !== jobId ||
          policy.state !== 'waking')) ||
      (marker.kind === 'sleep' &&
        (operation.action !== 'stop' ||
          policy.sleep_job_id !== jobId ||
          server.intent !== 'sleeping'))
    )
      throw new DomainError('forbidden');
    assertGatewaySleepFence(operation.plan, new Date(), true);
    // Recovered effects already handed off remain confirmable; new stops must
    // still satisfy the current inherited policy and retained positive idle proof.
    if (marker.kind === 'sleep' && operation.plan.gatewaySleepHandoffAt === undefined)
      await assertIdleSleepAllowed(db, serverId, env);
  }

  if (operation.action === 'provision') {
    const mapping = await db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', server.mapping_id)
      .executeTakeFirstOrThrow();
    const node = await db
      .selectFrom('managed_nodes')
      .select('enabled')
      .where('id', '=', mapping.node_id)
      .executeTakeFirst();
    if (!mapping.enabled || !node?.enabled) throw new DomainError('forbidden');
    const owner = await db
      .selectFrom('user')
      .select(['id', 'role'])
      .where('id', '=', server.owner_id)
      .executeTakeFirst();
    if (!owner) throw new DomainError('forbidden');
    const rollout = await db
      .selectFrom('game_rollouts')
      .selectAll()
      .where('integration_id', '=', mapping.game_id)
      .executeTakeFirstOrThrow();
    if (
      !evaluateGameAccess(
        { gameId: mapping.game_id, state: rollout.state, allowedUserIds: rollout.allowlist },
        game.module?.provisionAsResourceOwner
          ? { userId: owner.id, role: owner.role }
          : { userId: context.subjectUserId, role: context.role },
      ).canCreate
    )
      throw new DomainError('forbidden');
  }
  if (game.module) {
    const resourceOwner = await db
      .selectFrom('user')
      .select(['id', 'role'])
      .where('id', '=', server.owner_id)
      .executeTakeFirst();
    if (!resourceOwner) throw new DomainError('forbidden');
    await game.module.authorizeOperation({
      db,
      server,
      mapping: game.mapping,
      operation,
      context,
      resourceOwner,
      env,
      adapter,
    });
  }

  return context;
}

export interface ManagementOptions {
  logger?: ReturnType<typeof createLogger>;
  db: Kysely<Database>;
  codec: SecretCodec;
  env?: Environment;
  adapter?: PterodactylAdapter;
  containerObserver?: ContainerObserver;
  cleanupExternal?: (serverId: string, connection: Kysely<Database>) => Promise<void>;
  reconcileExternal?: (
    connection: Kysely<Database>,
  ) => Promise<{ recovered: number; failed: number }>;
}

export async function createManagementRuntime(options: ManagementOptions) {
  async function timed<T>(
    jobId: string,
    serverId: string,
    stage: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    let outcome = 'failed';
    try {
      const result = await work();
      outcome = 'succeeded';
      return result;
    } finally {
      // Diagnostics must never alter authorization, reservations or external effects.
      try {
        options.logger?.log('info', 'server.runtime_stage', {
          jobId,
          serverId,
          stage,
          durationMs: Math.round((performance.now() - started) * 1000) / 1000,
          outcome,
        });
      } catch {}
    }
  }
  const { db } = options;
  const env = options.env ?? {};
  const { values } = await getSettings(db, env);
  const applicationKey = options.adapter
    ? undefined
    : await getSecret(db, options.codec, 'pterodactylApplicationKey', env);
  const clientKey = options.adapter
    ? undefined
    : await getSecret(db, options.codec, 'pterodactylClientKey', env);
  if (!options.adapter && (!values.pterodactylBaseUrl || !applicationKey || !clientKey))
    throw new DomainError('integration_unavailable');
  const containerObserver =
    options.containerObserver ??
    (values.dockerObserverSocket
      ? createContainerObserver(values.dockerObserverSocket)
      : undefined);
  const adapter =
    options.adapter ??
    createPterodactylAdapter({
      baseURL: values.pterodactylBaseUrl ?? '',
      applicationKey: applicationKey ?? '',
      clientKey,
      webSocketOrigins: values.pterodactylWebSocketOrigins,
      downloadOrigins: values.pterodactylDownloadOrigins,
      uploadOrigins: values.pterodactylUploadOrigins,
      containerObserver,
    });
  const externalOptions: ExternalServiceOptions = {
    codec: options.codec,
    env,
    verifyServer: async (connection, serverId) => {
      const server = await connection
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!server?.pterodactyl_id) throw new DomainError('not_found');
      await verifyManagedIdentity(
        connection,
        server,
        await adapter.getApplicationServer(server.pterodactyl_id),
      );
    },
  };

  async function refreshObservations(connection: Kysely<Database> = db, serverId?: string) {
    const hosts = serverId
      ? await connection
          .selectFrom('physical_hosts as host')
          .innerJoin('managed_nodes as node', 'node.physical_host_id', 'host.id')
          .innerJoin('managed_servers as server', 'server.node_id', 'node.id')
          .selectAll('host')
          .where('server.id', '=', serverId)
          .execute()
      : await connection.selectFrom('physical_hosts').selectAll().execute();
    for (const stored of hosts) {
      const host = resolveHostOverride(stored, env);
      if (host.enabled && env.NH_OBSERVER_ID === host.observer_id) {
        // Conservative admission does not credit cached managed telemetry against
        // a newer host sample. All direct servers and other workloads stay counted.
        await observeLocalHost(connection, host.id, env.NH_OBSERVER_ID, {}, env);
      }
    }
  }
  async function verifyObservationHost(serverId: string, connection: Kysely<Database>) {
    const row = await connection
      .selectFrom('managed_servers as server')
      .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
      .innerJoin('physical_hosts as host', 'host.id', 'node.physical_host_id')
      .selectAll('host')
      .where('server.id', '=', serverId)
      .executeTakeFirst();
    const host = row ? resolveHostOverride(row, env) : undefined;
    if (
      !containerObserver ||
      !host ||
      !env.NH_OBSERVER_ID ||
      env.NH_OBSERVER_ID !== host.observer_id
    )
      throw new DomainError('configuration_invalid');
    await containerObserver.preflight();
  }
  async function observedImageDigest(
    connection: Kysely<Database>,
    serverId: string,
    remote?: Awaited<ReturnType<PterodactylAdapter['getApplicationServer']>>,
    observerPreflight?: Promise<void>,
  ) {
    await (observerPreflight ?? verifyObservationHost(serverId, connection));
    const server = await connection
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!server?.pterodactyl_uuid || !server.pterodactyl_id || !containerObserver?.imageIdentity)
      throw new DomainError('configuration_invalid');
    await verifyManagedIdentity(
      connection,
      server,
      remote ?? (await adapter.getApplicationServer(server.pterodactyl_id)),
    );
    const digest = await containerObserver.imageIdentity(server.pterodactyl_uuid);
    if (digest !== null && !/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new DomainError('integration_unavailable');
    return digest;
  }
  const minecraft = createMinecraftModuleRuntime({
    db,
    codec: options.codec,
    env,
    adapter,
    observedImageDigest,
    authorizeJob: (connection, jobId, serverId) =>
      authorizeQueuedEffect(connection, jobId, serverId, env, adapter),
  });
  const gameRuntime = createGameRuntimeDispatcher(
    trustedGameModules,
    new Map([[minecraft.id, minecraft]]),
  );
  // Kept for existing M4 callers; common hooks below dispatch through game identity.
  const minecraftOptions = minecraft.minecraftOptions;
  const assertMinecraftRuntimeImage = minecraft.assertMinecraftRuntimeImage;
  async function assertRuntimeImage(
    serverId: string,
    connection: Kysely<Database>,
    requireObserved = true,
    context?: RuntimeImageContext,
  ) {
    return (await gameRuntime(connection, serverId))?.assertRuntimeImage(
      serverId,
      connection,
      requireObserved,
      context,
    );
  }
  async function assertFileMutation(
    serverId: string,
    paths: readonly string[],
    connection: Kysely<Database> = db,
  ) {
    await (await gameRuntime(connection, serverId))?.assertFileMutation(
      serverId,
      paths,
      connection,
    );
  }
  const lifecycle = {
    env,
    logger: options.logger,
    verifyInitialInstallation: async (context: import('./lifecycle.js').GameLifecycleContext) =>
      (await gameRuntime(context.db, context.server.id))?.verifyInitialInstallation?.(context) ??
      null,
    confirmInitialInstallationStopped: async (serverId: string, connection: Kysely<Database>) => {
      await verifyObservationHost(serverId, connection);
      const server = await connection
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!server?.pterodactyl_uuid || !server.pterodactyl_id || !containerObserver)
        throw new DomainError('configuration_invalid');
      await verifyManagedIdentity(
        connection,
        server,
        await adapter.getApplicationServer(server.pterodactyl_id),
      );
      return (
        (await containerObserver.stopped(server.pterodactyl_uuid, 'installer')) &&
        (await containerObserver.stopped(server.pterodactyl_uuid, 'server'))
      );
    },
    configureGameProvision: async (context: import('./lifecycle.js').GameLifecycleContext) =>
      (await gameRuntime(context.db, context.server.id))?.configureProvision(context) ?? true,
    processGameContent: async (context: import('./lifecycle.js').GameLifecycleContext) => {
      const module = await gameRuntime(context.db, context.server.id);
      if (!module) throw new DomainError('integration_unavailable');
      return module.processContent(context);
    },
    verifyGameRestore: async (context: import('./lifecycle.js').GameLifecycleContext) =>
      (await gameRuntime(context.db, context.server.id))?.verifyRestore(context) ?? true,
    verifyObservationHost,
    confirmAlreadyStopped: async (serverId: string, connection: Kysely<Database>) => {
      await verifyObservationHost(serverId, connection);
      const server = await connection
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!server?.pterodactyl_uuid || !server.pterodactyl_id || !containerObserver)
        throw new DomainError('configuration_invalid');
      await verifyManagedIdentity(
        connection,
        server,
        await adapter.getApplicationServer(server.pterodactyl_id),
      );
      return containerObserver.stopped(server.pterodactyl_uuid, 'server');
    },
    observeExternalStop: async (
      serverId: string,
      connection: Kysely<Database>,
    ): Promise<ExternalStopReceipt | null> => {
      await verifyObservationHost(serverId, connection);
      const server = await connection
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (
        !server?.pterodactyl_uuid ||
        !server.pterodactyl_id ||
        !server.pterodactyl_identifier ||
        !containerObserver?.terminalProcess
      )
        return null;
      await verifyManagedIdentity(
        connection,
        server,
        await adapter.getApplicationServer(server.pterodactyl_id),
      );
      const before = await containerObserver.terminalProcess(server.pterodactyl_uuid);
      if (!before) return null;
      const events = await adapter.listPowerActivity(server.pterodactyl_identifier);
      const latest = events[0];
      if (!latest) return null;
      const at = Date.parse(latest.timestamp);
      const ties = events.filter((event) => Date.parse(event.timestamp) === at);
      if (
        ties.some(
          (event) =>
            !['server:power.stop', 'server:power.kill'].includes(event.event) || event.is_api,
        )
      )
        return null;
      // Provider activities have second precision. Require the command's whole
      // second to follow process creation; never adopt an old preboot stop.
      if (
        at < Date.parse(before.startedAt) ||
        at > Date.now() ||
        at > Date.parse(before.finishedAt) + 1000
      )
        return null;
      const after = await containerObserver.terminalProcess(server.pterodactyl_uuid);
      await verifyManagedIdentity(
        connection,
        server,
        await adapter.getApplicationServer(server.pterodactyl_id),
      );
      if (!after || JSON.stringify(before) !== JSON.stringify(after)) return null;
      return {
        ...after,
        activityId: latest.id,
        activityAt: latest.timestamp,
        action: latest.event === 'server:power.kill' ? 'kill' : 'stop',
      };
    },
    observeReconciliationProcessStart: async (
      serverId: string,
      connection: Kysely<Database>,
      remote?: Awaited<ReturnType<PterodactylAdapter['getApplicationServer']>>,
    ) => {
      await verifyObservationHost(serverId, connection);
      const server = await connection
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (
        !server?.pterodactyl_uuid ||
        !server.pterodactyl_id ||
        !containerObserver?.processStartedAt
      )
        throw new DomainError('configuration_invalid');
      await verifyManagedIdentity(
        connection,
        server,
        remote ?? (await adapter.getApplicationServer(server.pterodactyl_id)),
      );
      return containerObserver.processStartedAt(server.pterodactyl_uuid);
    },
    observeProcessStart: async (serverId: string, connection: Kysely<Database>) => {
      await verifyObservationHost(serverId, connection);
      const server = await connection
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (
        !server?.pterodactyl_uuid ||
        !server.pterodactyl_id ||
        !containerObserver?.processStartedAt
      )
        throw new DomainError('configuration_invalid');
      const remote = await adapter.getApplicationServer(server.pterodactyl_id);
      await verifyManagedIdentity(connection, server, remote);
      const processStartedAt = containerObserver.processStartedAt.bind(containerObserver);
      const uuid = server.pterodactyl_uuid;
      const before = await processStartedAt(uuid);
      const module = await gameRuntime(connection, serverId);
      return module
        ? module.verifyProcessEpoch(
            serverId,
            connection,
            before,
            () => processStartedAt(uuid),
            remote,
          )
        : before;
    },
    adapter,
    // Recheck revocable local authority at intermediate durable/console
    // boundaries. Provider/image proofs belong to the final effect handoff,
    // not every intermediate authorization in the same operation.
    authorizeIntent: (jobId: string, serverId: string, connection: Kysely<Database>) =>
      authorizeQueuedEffect(connection, jobId, serverId, env, adapter).then(() => undefined),
    // authorizeEffect below binds each final handoff to this server's host.
    effectAuthorizationVerifiesHost: true,
    authorizeEffect: async (
      jobId: string,
      serverId: string,
      connection: Kysely<Database>,
      context?: { providerServer?: ApplicationServer | Promise<ApplicationServer> },
    ) => {
      const stage = <T>(name: string, work: () => Promise<T>) =>
        timed(jobId, serverId, `authorize_effect.${name}`, work);
      const observerPreflight = stage('observer_preflight', () =>
        verifyObservationHost(serverId, connection),
      );
      // Even stop must re-read revocable authority after the external preflight.
      await observerPreflight;
      await stage('authorization', () =>
        authorizeQueuedEffect(connection, jobId, serverId, env, adapter),
      );
      const operation = await connection
        .selectFrom('server_operations')
        .select(['action', 'phase'])
        .where('job_id', '=', jobId)
        .executeTakeFirstOrThrow();
      if (
        ['start', 'restart'].includes(operation.action) ||
        (operation.action === 'provision' && operation.phase === 'initial_start')
      ) {
        await stage('runtime_image', () =>
          assertRuntimeImage(serverId, connection, false, { ...context, observerPreflight }),
        );
        // A compiled game may have no image hook. Its provider proof must still
        // settle before reading final revocable authority.
        await context?.providerServer;
        // Observer/provider proofs can outlive an automation grant. Re-read the
        // current actor, schedule revision, consent and Gateway generation only
        // after those slow proofs, at the final handoff to a new remote effect.
        await stage('final_authorization', () =>
          authorizeQueuedEffect(connection, jobId, serverId, env, adapter),
        );
      }
    },
    reserveInstallation: async (serverId: string, jobId: string, connection: Kysely<Database>) => {
      const checks = await Promise.allSettled([
        verifyObservationHost(serverId, connection),
        refreshObservations(connection, serverId),
      ]);
      for (const result of checks) if (result.status === 'rejected') throw result.reason;
      await reserveInstallation(connection, serverId, jobId, env);
    },
    reserveStart: async (
      serverId: string,
      jobId: string,
      action: 'start' | 'restart',
      connection: Kysely<Database>,
    ) => {
      const stage = <T>(name: string, work: () => Promise<T>) =>
        timed(jobId, serverId, `reserve_start.${name}`, work);
      // Image/launch identity is checked once immediately before power, after
      // durable preparation. Admission still requires a fresh physical sample.
      const checks = await Promise.allSettled([
        stage('observer_preflight', () => verifyObservationHost(serverId, connection)),
        stage('host_sampling', () => refreshObservations(connection, serverId)),
      ]);
      for (const result of checks) if (result.status === 'rejected') throw result.reason;
      await stage('atomic_admission', () => reserveStart(connection, serverId, jobId, action, env));
    },
    beforeDelete:
      options.cleanupExternal ??
      ((serverId: string, connection: Kysely<Database>) =>
        cleanupServerExternalServices(connection, serverId, externalOptions)),
  };
  const process = createLifecycleProcessor(db, lifecycle);

  async function reconcile() {
    const servers = await db
      .selectFrom('managed_servers')
      .select(['id'])
      .where('deleted_at', 'is', null)
      .where('pterodactyl_id', 'is not', null)
      .execute();
    const failures: string[] = [];
    for (const server of servers) {
      try {
        await reconcileManagedServer(db, server.id, lifecycle);
      } catch {
        failures.push(server.id);
      }
    }
    await refreshObservations();
    const external = options.reconcileExternal
      ? await options.reconcileExternal(db)
      : await reconcileExternalServices(db, externalOptions);
    await db
      .deleteFrom('server_metrics')
      .where('observed_at', '<', new Date(Date.now() - 30 * 86400000))
      .execute();
    return { observed: servers.length - failures.length, unavailable: failures, external };
  }
  /** Streaming transfers must not retain a session/role snapshot. Uploads use
   * their already-pinned lock connection; downloads borrow only for each check. */
  async function authorizeTransfer(
    context: AuthContext,
    serverId: string,
    write: boolean,
    connection: Kysely<Database> = db,
  ): Promise<void> {
    const current = await currentInteractiveContext(connection, context, env);
    const server = await authorizeServer(
      connection,
      current,
      serverId,
      write ? 'server:manage' : 'server:read',
    );
    if (
      !server.pterodactyl_id ||
      !server.pterodactyl_identifier ||
      (write && server.active_operation_id)
    )
      throw new DomainError('conflict');
  }
  /** Direct file/command mutations share the lifecycle lock, so wipe/delete cannot race them. */
  async function access<T>(
    context: AuthContext,
    serverId: string,
    write: boolean,
    work: (identifier: string, connection: Kysely<Database>, current: AuthContext) => Promise<T>,
  ) {
    return db.connection().execute(async (connection) => {
      if (write) {
        const lock = await sql<{
          acquired: boolean;
        }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`},0)) as acquired`.execute(
          connection,
        );
        if (!lock.rows[0]?.acquired) throw new DomainError('conflict');
      }
      try {
        const current = await currentInteractiveContext(connection, context, env);
        const server = await authorizeServer(
          connection,
          current,
          serverId,
          write ? 'server:manage' : 'server:read',
        );
        if (!server.pterodactyl_id || !server.pterodactyl_identifier)
          throw new DomainError('conflict');
        if (write && server.active_operation_id) throw new DomainError('conflict');
        if (write) await assertNoPendingUpload(connection, serverId);
        await verifyManagedIdentity(
          connection,
          server,
          await adapter.getApplicationServer(server.pterodactyl_id),
        );
        // Identity corroboration may itself wait on a remote API. Recheck directly
        // before the effect rather than extending an old authorization across it.
        const refreshed = await currentInteractiveContext(connection, current, env);
        await authorizeServer(
          connection,
          refreshed,
          serverId,
          write ? 'server:manage' : 'server:read',
        );
        return await work(server.pterodactyl_identifier, connection, refreshed);
      } finally {
        if (write)
          await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`},0))`.execute(
            connection,
          );
      }
    });
  }
  return {
    adapter,
    containerObserver,
    refreshObservations,
    process,
    reconcile,
    access,
    authorizeTransfer,
    lifecycle,
    externalOptions,
    minecraftOptions,
    assertMinecraftRuntimeImage,
    assertFileMutation,
  };
}
export type ManagementRuntime = Awaited<ReturnType<typeof createManagementRuntime>>;
