import { createHash, randomUUID } from 'node:crypto';
import {
  type AuthContext,
  assertAuthContext,
  type createLogger,
  DomainError,
  type SecretCodec,
} from '@nickhosting/core';
import {
  assertStoragePolicyIdle,
  type Database,
  getSecret,
  getSettings,
} from '@nickhosting/database';
import { evaluateGameAccess, type FilemanReadService } from '@nickhosting/game-sdk';
import {
  type ApplicationServer,
  type ContainerObserver,
  createContainerObserver,
  createPterodactylAdapter,
  createTransportCoordinator,
  type DirectoryBatchResult,
  type DirectoryBatchSettings,
  type PrivateTransferCache,
  type PterodactylAdapter,
  PterodactylError,
  relativePath,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { type Environment, reserveInstallation, reserveStart } from './admission.js';
import { resolveHostOverride } from './configuration.js';
import { createDirectoryIdentityCache, directoryServerIdentity } from './directory-identity.js';
import {
  cleanupServerExternalServices,
  type ExternalServiceOptions,
  reconcileExternalServices,
  reconcileServerStorageQuota,
} from './external.js';
import { createFileDiskUsageCache, trackFileDiskMutations } from './file-disk-usage.js';
import { createFilemanReadService } from './fileman-read.js';
import { createFilemanJobServices } from './fileman-transfers.js';
import {
  createGameRuntimeDispatcher,
  type FileMutationContext,
  type RuntimeImageContext,
  trustedGameModules,
} from './game-modules.js';
import { refreshHostObservations } from './host-observations.js';
import { currentInteractiveContext } from './interactive-context.js';
import {
  createLifecycleProcessor,
  type ExternalStopReceipt,
  reconcileManagedServer,
  verifyManagedIdentity,
} from './lifecycle.js';
import { minecraftContentAllowsOnline } from './minecraft-content-contracts.js';
import { createMinecraftModuleRuntime } from './minecraft-module.js';
import { createMinecraftWorldPreparation } from './minecraft-world-preparation.js';
import type { OperationTiming } from './operation-timing.js';
import { resolveProviderCredential } from './provider-accounts.js';
import {
  backupSchemaAvailable,
  providerBackupEventsEnabled,
  readProviderBackupCompletion,
} from './provider-backup-events.js';
import { cachedProviderStartLimits } from './provider-change-feed.js';
import { supportsProviderFileOperations } from './provider-file-operations.js';
import { assertGatewaySleepFence, authorizeServer } from './registry.js';
import { authorizeScheduledEffect } from './schedules.js';
import { createScopedProviderAdapter } from './scoped-provider-adapter.js';
import { assertIdleSleepAllowed } from './sleep-policy.js';
import {
  refreshStorageObservations,
  type StorageObservationScope,
} from './storage-observations.js';
import { createStoragePolicyService } from './storage-policy.js';
import { assertNoPendingUpload } from './upload-admission.js';
import type { UploadTiming } from './upload-timing.js';
import { assertAutoWakeAllowed } from './wake-policy.js';
import { createWorldSelectionAccess } from './world-selection-access.js';

/** A queued operation retains attribution, never a permanently elevated authorization snapshot. */
export async function authorizeQueuedEffect(
  db: Kysely<Database>,
  jobId: string,
  serverId: string,
  env: Environment = {},
  adapter?: PterodactylAdapter,
  timing?: OperationTiming,
) {
  const job = await traceOperation(timing, 'job', () =>
    db.selectFrom('operation_jobs').selectAll().where('id', '=', jobId).executeTakeFirst(),
  );
  const operation = await traceOperation(timing, 'operation', () =>
    db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', jobId)
      .where('server_id', '=', serverId)
      .executeTakeFirst(),
  );
  if (!job || !operation) throw new DomainError('forbidden');
  const user = await traceOperation(timing, 'actor', () =>
    db.selectFrom('user').select(['id', 'role']).where('id', '=', job.actor_id).executeTakeFirst(),
  );
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
  const server = await traceOperation(timing, 'access', () =>
    authorizeServer(
      db,
      context,
      serverId,
      ['start', 'stop', 'restart', 'backup'].includes(operation.action)
        ? 'server:operate'
        : 'server:manage',
    ),
  );
  if (server.owner_id !== job.resource_owner_id) throw new DomainError('forbidden');
  if (operation.plan.scheduleAutomation !== undefined)
    await authorizeScheduledEffect(db, jobId, serverId);
  if (operation.action === 'backup' && operation.phase === 'backup_resume') {
    const gateway = await db
      .selectFrom('gateway_server_states')
      .select('generation')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (
      server.automatic_starts_paused ||
      ['manually_stopped', 'maintenance'].includes(server.intent) ||
      server.intent !== operation.plan.backupPriorIntent ||
      (gateway?.generation ?? null) !== (operation.plan.backupGatewayGeneration ?? null)
    )
      throw new DomainError('forbidden');
  }
  if (
    operation.action === 'provision' &&
    operation.phase === 'initial_start' &&
    server.automatic_starts_paused
  )
    throw new DomainError('forbidden');
  const game = await traceOperation(timing, 'game', () => trustedGameModules.resolve(db, serverId));

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
        (server.automatic_starts_paused ||
          operation.action !== 'start' ||
          policy.wake_job_id !== jobId ||
          policy.state !== 'waking')) ||
      (marker.kind === 'sleep' &&
        (operation.action !== 'stop' ||
          policy.sleep_job_id !== jobId ||
          server.intent !== 'sleeping'))
    )
      throw new DomainError('forbidden');
    if (marker.kind === 'wake') await assertAutoWakeAllowed(db, serverId, policy, env);
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
  const module = game.module;
  if (module) {
    const resourceOwner = await traceOperation(timing, 'owner', () =>
      db
        .selectFrom('user')
        .select(['id', 'role'])
        .where('id', '=', server.owner_id)
        .executeTakeFirst(),
    );
    if (!resourceOwner) throw new DomainError('forbidden');
    await traceOperation(timing, 'policy', () =>
      module.authorizeOperation({
        db,
        server,
        mapping: game.mapping,
        operation,
        context,
        resourceOwner,
        env,
        adapter,
      }),
    );
  }

  return context;
}

export interface ManagementOptions {
  onInstallationAvailable?: (jobId: string, serverId: string) => void;
  logger?: ReturnType<typeof createLogger>;
  db: Kysely<Database>;
  codec: SecretCodec;
  env?: Environment;
  adapter?: PterodactylAdapter;
  transportCoordinator?: ReturnType<typeof createTransportCoordinator>;
  directoryIdentityCache?: ReturnType<typeof createDirectoryIdentityCache>;
  transferCache?: PrivateTransferCache;
  containerObserver?: ContainerObserver;
  cleanupExternal?: (serverId: string, connection: Kysely<Database>) => Promise<void>;
  reconcileExternal?: (
    connection: Kysely<Database>,
  ) => Promise<{ recovered: number; failed: number }>;
}

const injectedAdapterBindings = new WeakMap<PterodactylAdapter, string>();
const fileDiskUsageCaches = new WeakMap<
  Kysely<Database>,
  ReturnType<typeof createFileDiskUsageCache>
>();
// Performance settings only, never authorization or directory contents. Runtime
// instances are request-scoped, so retain bounded metadata across those instances.
const directoryBatchSettings = new WeakMap<
  Kysely<Database>,
  Map<string, { expiresAt: number; value: Promise<DirectoryBatchSettings> }>
>();
const traceOperation = <T>(
  timing: OperationTiming | undefined,
  name: string,
  work: () => Promise<T>,
) => (timing ? timing.measure(name, work) : work());

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
  const directoryIdentityCache =
    options.directoryIdentityCache ??
    createDirectoryIdentityCache(undefined, options.transferCache);
  const env = options.env ?? {};
  const [{ values }, applicationKey] = await Promise.all([
    getSettings(db, env),
    options.adapter
      ? Promise.resolve(undefined)
      : getSecret(db, options.codec, 'pterodactylApplicationKey', env),
  ]);
  // Internal reuse fence only: never expose or log a credential-derived binding.
  let consoleProviderBinding: string;
  if (options.adapter) {
    consoleProviderBinding = injectedAdapterBindings.get(options.adapter) ?? randomUUID();
    injectedAdapterBindings.set(options.adapter, consoleProviderBinding);
  } else {
    consoleProviderBinding = createHash('sha256')
      .update(
        JSON.stringify([
          values.pterodactylBaseUrl,
          applicationKey,
          values.pterodactylWebSocketOrigins,
        ]),
      )
      .digest('hex');
  }
  if (!options.adapter && (!values.pterodactylBaseUrl || !applicationKey))
    throw new DomainError('integration_unavailable');
  const containerObserver =
    options.containerObserver ??
    (values.dockerObserverSocket
      ? createContainerObserver(values.dockerObserverSocket)
      : undefined);
  const adapterOptions = {
    transferCache: options.transferCache,
    coordinator: options.transportCoordinator,
    baseURL: values.pterodactylBaseUrl ?? '',
    applicationKey: applicationKey ?? '',
    webSocketOrigins: values.pterodactylWebSocketOrigins,
    downloadOrigins: values.pterodactylDownloadOrigins,
    uploadOrigins: values.pterodactylUploadOrigins,
    containerObserver,
  };
  const diskUsageCache = fileDiskUsageCaches.get(db) ?? createFileDiskUsageCache();
  fileDiskUsageCaches.set(db, diskUsageCache);
  const rawAdapter =
    options.adapter ??
    createScopedProviderAdapter(
      createPterodactylAdapter(adapterOptions),
      async (identifier, timing) => {
        const read = () =>
          db
            .selectFrom('managed_servers')
            .innerJoin(
              'managed_nodes as transfer_node',
              'transfer_node.id',
              'managed_servers.node_id',
            )
            .selectAll('managed_servers')
            .select('transfer_node.pterodactyl_node_id as transfer_node_id')
            .where('managed_servers.pterodactyl_identifier', '=', identifier)
            .where('managed_servers.deleted_at', 'is', null)
            .executeTakeFirst();
        const server = timing ? await timing.measure('file.serverRead', read) : await read();
        if (!server) throw new DomainError('provenance_mismatch');
        const credential = await resolveProviderCredential(
          db,
          options.codec,
          { serverId: server.id },
          adapterOptions.baseURL,
          timing,
        );
        const create = () =>
          createPterodactylAdapter({
            ...adapterOptions,
            clientKey: credential.clientApiKey,
            managedProviderIdentity: {
              providerId: server.pterodactyl_id as number,
              providerUuid: server.pterodactyl_uuid as string,
              identifier: server.pterodactyl_identifier as string,
              externalId: server.external_id,
              nodeId: server.transfer_node_id,
            },
            fileDownloadBinding: createHash('sha256')
              .update(
                JSON.stringify([
                  directoryServerIdentity(server),
                  server.transfer_node_id,
                  credential.credentialRevision,
                ]),
              )
              .digest('hex'),
          });
        return timing ? timing.measureSync('file.adapterCreate', create) : create();
      },
    );
  const adapter = trackFileDiskMutations(rawAdapter, diskUsageCache);
  async function consoleBindingForServer(serverId: string, timing?: UploadTiming) {
    if (options.adapter) return consoleProviderBinding;
    const credential = await resolveProviderCredential(
      db,
      options.codec,
      { serverId },
      adapterOptions.baseURL,
      timing,
    );
    return createHash('sha256')
      .update(
        JSON.stringify([
          consoleProviderBinding,
          credential.userId,
          credential.providerUserId,
          credential.credentialRevision,
        ]),
      )
      .digest('hex');
  }
  function diskScope(server: Parameters<typeof directoryServerIdentity>[0], binding: string) {
    return JSON.stringify([directoryServerIdentity(server), binding]);
  }
  /** Feed only authenticated provider events accepted by the existing relay. */
  function observeConsoleDisk(
    server: Parameters<typeof directoryServerIdentity>[0],
    providerBinding: string,
  ) {
    return diskUsageCache.observe(
      server.pterodactyl_identifier ?? '',
      diskScope(server, providerBinding),
    );
  }
  async function fileDiskUsage(
    server: Parameters<typeof directoryServerIdentity>[0],
    identifier: string,
    timing?: UploadTiming,
  ) {
    const binding = await consoleBindingForServer(server.id, timing);
    const cached = diskUsageCache.read(diskScope(server, binding));
    if (cached !== undefined) return cached;
    const read = () => adapter.getResources(identifier);
    const resources = timing ? await timing.measure('copy.diskFallback', read) : await read();
    return resources.resources.disk_bytes;
  }
  const externalOptions: ExternalServiceOptions = {
    codec: options.codec,
    env,
    readServerDiskUsage: async (connection, serverId) => {
      const server = await connection
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!server?.pterodactyl_id || !server.pterodactyl_identifier)
        throw new DomainError('not_found');
      await verifyManagedIdentity(
        connection,
        server,
        await adapter.getApplicationServer(server.pterodactyl_id),
      );
      const started = Date.now();
      const { resources } = await adapter.getResources(server.pterodactyl_identifier);
      if (
        Date.now() - started > 30_000 ||
        !Number.isSafeInteger(resources.disk_bytes) ||
        resources.disk_bytes < 0
      )
        throw new DomainError('resources_unavailable');
      return resources.disk_bytes;
    },
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
    await refreshHostObservations(connection, env, { serverId });
  }
  async function prepareStartAdmission(
    serverId: string,
    jobId: string,
    connection: Kysely<Database>,
    action: 'start' | 'restart' = 'start',
  ) {
    const stage = <T>(name: string, work: () => Promise<T>) =>
      timed(jobId, serverId, `reserve_start.${name}`, work);
    // Sampling is read-only with respect to the server. Reservation remains
    // deferred until lifecycle has verified the provider identity and limits.
    const checks = await Promise.allSettled([
      stage('observer_preflight', () => verifyObservationHost(serverId, connection)),
      stage('host_sampling', () => refreshObservations(connection, serverId)),
    ]);
    for (const result of checks) if (result.status === 'rejected') throw result.reason;
    return () =>
      stage('atomic_admission', () => reserveStart(connection, serverId, jobId, action, env));
  }
  async function verifyObservationHost(
    serverId: string,
    connection: Kysely<Database>,
    timing?: OperationTiming,
  ) {
    const row = await traceOperation(timing, 'binding', () =>
      connection
        .selectFrom('managed_servers as server')
        .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
        .innerJoin('physical_hosts as host', 'host.id', 'node.physical_host_id')
        .selectAll('host')
        .where('server.id', '=', serverId)
        .executeTakeFirst(),
    );
    const host = row ? resolveHostOverride(row, env) : undefined;
    if (
      !containerObserver ||
      !host ||
      !env.NH_OBSERVER_ID ||
      env.NH_OBSERVER_ID !== host.observer_id
    )
      throw new DomainError('configuration_invalid');
    await traceOperation(timing, 'preflight', () => containerObserver.preflight());
  }
  async function observedImageDigest(
    connection: Kysely<Database>,
    serverId: string,
    remote?: ApplicationServer | Promise<ApplicationServer>,
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
    // Local container identity and provider identity are independent reads.
    // Settle both before releasing the connection or accepting either proof.
    const proofs = await Promise.allSettled([
      Promise.resolve(remote ?? adapter.getApplicationServer(server.pterodactyl_id)).then((value) =>
        verifyManagedIdentity(connection, server, value),
      ),
      containerObserver.imageIdentity(server.pterodactyl_uuid),
    ]);
    for (const proof of proofs) if (proof.status === 'rejected') throw proof.reason;
    if (proofs[1].status !== 'fulfilled') throw new DomainError('integration_unavailable');
    const digest = proofs[1].value;
    if (digest !== null && !/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new DomainError('integration_unavailable');
    return digest;
  }
  const worldPreparation = options.transferCache
    ? createMinecraftWorldPreparation(options.transferCache, consoleProviderBinding)
    : undefined;
  const worldSelectionAccess = options.transferCache
    ? createWorldSelectionAccess(
        options.transferCache,
        JSON.stringify([
          consoleProviderBinding,
          values.dockerObserverSocket,
          env.NH_OBSERVER_ID,
          env.NH_HOST_POLICIES,
        ]),
      )
    : undefined;
  async function prepareWorldSelection(
    server: Awaited<ReturnType<typeof authorizeServer>>,
    connection: Kysely<Database>,
  ) {
    // Opening Worlds overlaps this physical observation and grant preparation
    // with the inventory. Neither performs a game-file mutation.
    await Promise.all([
      worldSelectionAccess?.prepare(connection, server, async () => {
        await verifyObservationHost(server.id, connection);
        if (!containerObserver || !server.pterodactyl_uuid) return false;
        return containerObserver.stopped(server.pterodactyl_uuid, 'server');
      }),
      server.pterodactyl_identifier
        ? adapter
            .prepareFileWrite(server.pterodactyl_identifier, 'server.properties')
            .catch(() => {})
        : undefined,
    ]);
  }
  const minecraft = createMinecraftModuleRuntime({
    db,
    codec: options.codec,
    env,
    adapter,
    worldPreparation,
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
    context?: FileMutationContext,
  ) {
    await (await gameRuntime(connection, serverId))?.assertFileMutation(
      serverId,
      paths,
      connection,
      context,
    );
  }
  const lifecycle = {
    onInstallationAvailable: options.onInstallationAvailable,
    supportsManagedFileOperations: async (serverId: string, connection: Kysely<Database>) => {
      const server = await connection
        .selectFrom('managed_servers')
        .select('pterodactyl_identifier')
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();
      return (
        Boolean(server.pterodactyl_identifier) &&
        supportsProviderFileOperations(adapter, server.pterodactyl_identifier as string)
      );
    },
    fileman: (context: import('./lifecycle.js').GameLifecycleContext) =>
      createFilemanJobServices(context, {
        env,
        listDirectories: (directories) =>
          fileDirectoryBatch(
            context.server.pterodactyl_identifier ?? '',
            context.server,
            directories,
            undefined,
            context.timing?.child('directories'),
          ),
        authorize: () =>
          authorizeQueuedEffect(
            context.db,
            context.operation().job_id,
            context.server.id,
            env,
            adapter,
          ),
      }),
    backupEventsEnabled: providerBackupEventsEnabled,
    backupSchemaAvailable,
    readBackupCompletion: readProviderBackupCompletion,
    backupPolicy: async (context: import('./lifecycle.js').GameLifecycleContext) =>
      (await trustedGameModules.resolve(context.db, context.server.id)).module?.manifest
        .backupPolicy ?? { offline: 'required' as const },
    prepareBackup: async (
      context: import('./lifecycle.js').GameLifecycleContext,
      mode: 'offline' | 'live',
    ) => {
      await (await gameRuntime(context.db, context.server.id))?.prepareBackup?.(context, mode);
    },
    cleanupBackup: async (
      context: import('./lifecycle.js').GameLifecycleContext,
      mode: 'offline' | 'live',
    ) => {
      await (await gameRuntime(context.db, context.server.id))?.cleanupBackup?.(context, mode);
    },
    cachedStartLimits: (serverId: string, connection: Kysely<Database>) =>
      cachedProviderStartLimits(connection, serverId, values.pterodactylBaseUrl ?? ''),
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
      const module = await traceOperation(context.timing, 'game.resolve', () =>
        gameRuntime(context.db, context.server.id),
      );
      if (!module) throw new DomainError('integration_unavailable');
      return traceOperation(context.timing, 'game.process', () => module.processContent(context));
    },
    verifyGameRestore: async (context: import('./lifecycle.js').GameLifecycleContext) =>
      (await gameRuntime(context.db, context.server.id))?.verifyRestore(context) ?? true,
    verifyObservationHost,
    ...(worldSelectionAccess
      ? {
          assertWorldSelectionAccess: worldSelectionAccess.assert,
          worldSelectionIdentity: (
            server: Awaited<ReturnType<typeof authorizeServer>>,
            connection: Kysely<Database>,
          ) => {
            if (!server.pterodactyl_id) throw new DomainError('conflict');
            return directoryIdentityCache.verify(
              connection,
              server,
              consoleProviderBinding,
              () => adapter.getApplicationServer(server.pterodactyl_id as number),
              db,
            );
          },
        }
      : {}),
    confirmAlreadyStopped: async (
      serverId: string,
      connection: Kysely<Database>,
      context?: {
        providerServer: Promise<ApplicationServer>;
        observerPreflight?: Promise<void>;
        timing?: OperationTiming;
      },
    ) => {
      const server = await traceOperation(context?.timing, 'server', () =>
        connection
          .selectFrom('managed_servers')
          .selectAll()
          .where('id', '=', serverId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      );
      if (!server?.pterodactyl_uuid || !server.pterodactyl_id || !containerObserver)
        throw new DomainError('configuration_invalid');
      const proofs = await Promise.allSettled([
        context?.observerPreflight ??
          verifyObservationHost(serverId, connection, context?.timing?.child('host')),
        (context?.providerServer ?? adapter.getApplicationServer(server.pterodactyl_id)).then(
          (remote) =>
            traceOperation(context?.timing, 'identity', () =>
              verifyManagedIdentity(connection, server, remote),
            ),
        ),
      ]);
      for (const proof of proofs) if (proof.status === 'rejected') throw proof.reason;
      const uuid = server.pterodactyl_uuid;
      return traceOperation(context?.timing, 'process', () =>
        containerObserver.stopped(uuid, 'server'),
      );
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
    observeProviderProcessStart: async (serverId: string, connection: Kysely<Database>) => {
      await verifyObservationHost(serverId, connection);
      const server = await connection
        .selectFrom('managed_servers')
        .select('pterodactyl_uuid')
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!server?.pterodactyl_uuid || !containerObserver?.processStartedAt)
        throw new DomainError('configuration_invalid');
      return containerObserver.processStartedAt(server.pterodactyl_uuid);
    },
    observeProcessStart: async (serverId: string, connection: Kysely<Database>) => {
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
      // Independent, read-only prerequisites share this observation's connection.
      // Settle every branch before returning it to a caller that may release it.
      const observerPreflight = verifyObservationHost(serverId, connection);
      const processStartedAt = containerObserver.processStartedAt.bind(containerObserver);
      const uuid = server.pterodactyl_uuid;
      const remote = adapter.getApplicationServer(server.pterodactyl_id).then(async (value) => {
        await verifyManagedIdentity(connection, server, value);
        return value;
      });
      const module = gameRuntime(connection, serverId);
      // Bind Docker inspection to the host first, but do not serialize it behind
      // the provider round trip. The same in-flight remote proof is consumed by
      // the module; neither an image nor an epoch alone grants readiness.
      const before = observerPreflight.then(() => processStartedAt(uuid));
      const verification = Promise.all([module, before]).then(([runtime, epoch]) =>
        runtime
          ? runtime.verifyProcessEpoch(
              serverId,
              connection,
              epoch,
              () => processStartedAt(uuid),
              remote,
              observerPreflight,
            )
          : epoch,
      );
      // Include every branch even if module discovery or the first epoch fails:
      // no database/observer work may outlive the caller's connection lease.
      const proofs = await Promise.allSettled([
        observerPreflight,
        remote,
        module,
        before,
        verification,
      ]);
      for (const proof of proofs) if (proof.status === 'rejected') throw proof.reason;
      const result = proofs[4];
      if (result.status !== 'fulfilled') throw new DomainError('integration_unavailable');
      return result.value;
    },
    adapter,
    // Recheck revocable local authority at intermediate durable/console
    // boundaries. Provider/image proofs belong to the final effect handoff,
    // not every intermediate authorization in the same operation.
    authorizeIntent: (
      jobId: string,
      serverId: string,
      connection: Kysely<Database>,
      context?: { timing?: OperationTiming },
    ) =>
      traceOperation(context?.timing, 'intent', () =>
        authorizeQueuedEffect(connection, jobId, serverId, env, adapter, context?.timing).then(
          () => undefined,
        ),
      ),
    // authorizeEffect below binds each final handoff to this server's host.
    effectAuthorizationVerifiesHost: true,
    authorizeEffect: async (
      jobId: string,
      serverId: string,
      connection: Kysely<Database>,
      context?: {
        timing?: OperationTiming;
        providerServer?: ApplicationServer | Promise<ApplicationServer>;
        observerPreflight?: Promise<void>;
        deferFinalIntentCheck?: true;
        startAdmissionValidated?: true;
      },
    ) => {
      if (context?.startAdmissionValidated) {
        // Only a prepared clean Start with its own atomic reservation may use
        // local handoff authorization. Provision/recovery keep full proofs.
        const prepared = await connection
          .selectFrom('server_operations as operation')
          .innerJoin('managed_servers as server', 'server.id', 'operation.server_id')
          .innerJoin('resource_reservations as reservation', 'reservation.server_id', 'server.id')
          .select('operation.job_id')
          .where('operation.job_id', '=', jobId)
          .where('operation.server_id', '=', serverId)
          .where('operation.action', '=', 'start')
          .where('operation.phase', '=', 'power')
          .where('operation.effect_state', '=', 'prepared')
          .where('server.active_operation_id', '=', jobId)
          .where('reservation.operation_id', '=', jobId)
          .where('reservation.state', '=', 'starting')
          .executeTakeFirst();
        if (!prepared) throw new DomainError('conflict');
        await authorizeQueuedEffect(connection, jobId, serverId, env, adapter);
        return;
      }
      const operation = await connection
        .selectFrom('server_operations')
        .select(['action', 'phase', 'plan'])
        .where('job_id', '=', jobId)
        .executeTakeFirstOrThrow();
      if (
        operation.action === 'minecraft-content' &&
        minecraftContentAllowsOnline(operation.plan.minecraftContent)
      ) {
        // This operation only imports/removes an inactive directory through the adapter.
        // Lifecycle owns provider identity; host/process/image observations have
        // no bearing on this file effect. Keep current local authority at handoff.
        await authorizeQueuedEffect(connection, jobId, serverId, env, adapter);
        return;
      }
      const stage = <T>(name: string, work: () => Promise<T>) =>
        timed(jobId, serverId, `authorize_effect.${name}`, work);
      const observerPreflight =
        context?.observerPreflight ??
        stage('observer_preflight', () => verifyObservationHost(serverId, connection));
      // Even stop must re-read revocable authority after the external preflight.
      await observerPreflight;
      await stage('authorization', () =>
        authorizeQueuedEffect(connection, jobId, serverId, env, adapter),
      );

      if (
        ['start', 'restart'].includes(operation.action) ||
        (operation.action === 'provision' && operation.phase === 'initial_start') ||
        (operation.action === 'backup' && operation.phase === 'backup_resume')
      ) {
        await stage('runtime_image', () =>
          assertRuntimeImage(serverId, connection, false, {
            ...context,
            observerPreflight,
            validateEggMetadata: operation.action === 'provision',
          }),
        );
        // A compiled game may have no image hook. Its provider proof must still
        // settle before reading final revocable authority.
        await context?.providerServer;
        // Observer/provider proofs can outlive an automation grant. Re-read the
        // current actor, schedule revision, consent and Gateway generation only
        // after those slow proofs, at the final handoff to a new remote effect.
        // Lifecycle can own this exact final guard after all proofs settle.
        // Standalone callers still receive the complete authorization contract.
        if (!context?.deferFinalIntentCheck)
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
    prepareStartAdmission,
    reserveStart: async (
      serverId: string,
      jobId: string,
      action: 'start' | 'restart',
      connection: Kysely<Database>,
    ) => {
      await (await prepareStartAdmission(serverId, jobId, connection, action))();
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
    const deferred: string[] = [];
    let observed = 0;
    for (const server of servers) {
      try {
        if ((await reconcileManagedServer(db, server.id, lifecycle)) === 'observed') observed++;
        else deferred.push(server.id);
      } catch {
        failures.push(server.id);
      }
    }
    const external = options.reconcileExternal
      ? await options.reconcileExternal(db)
      : await reconcileExternalServices(db, externalOptions);
    await db
      .deleteFrom('server_metrics')
      .where('observed_at', '<', new Date(Date.now() - 30 * 86400000))
      .execute();
    return { observed, deferred, unavailable: failures, external };
  }
  /** Streaming transfers must not retain a session/role snapshot. Uploads use
   * their already-pinned lock connection; downloads borrow only for each check. */
  async function assertStorageMutationAllowed(connection: Kysely<Database>, cleanup: boolean) {
    if (!cleanup) return assertStoragePolicyIdle(connection);
    // Only explicit file/backup deletion uses this path. A blocked plan needs a
    // way to reclaim space; active application still excludes cleanup effects.
    const applying = await connection
      .selectFrom('storage_policy_transitions')
      .select('id')
      .where('status', '=', 'applying')
      .executeTakeFirst();
    if (applying) throw new DomainError('conflict');
  }
  async function authorizeTransfer(
    context: AuthContext,
    serverId: string,
    write: boolean,
    connection: Kysely<Database> = db,
    timing?: UploadTiming,
    expectedServer?: Awaited<ReturnType<typeof authorizeServer>>,
    storageCleanup = false,
  ): Promise<void> {
    const timed = <T>(name: string, work: () => Promise<T>) =>
      timing ? timing.measure(name, work) : work();
    const current = await timed('transfer.sessionRead', () =>
      currentInteractiveContext(connection, context, env),
    );
    const server = await timed('transfer.serverPermission', () =>
      authorizeServer(connection, current, serverId, write ? 'server:manage' : 'server:read'),
    );
    if (write) await assertStorageMutationAllowed(connection, storageCleanup);
    if (
      !server.pterodactyl_id ||
      !server.pterodactyl_identifier ||
      (write && server.active_operation_id) ||
      (expectedServer &&
        (directoryServerIdentity(server) !== directoryServerIdentity(expectedServer) ||
          uploadBatchBinding(server) !== uploadBatchBinding(expectedServer)))
    )
      throw new DomainError('conflict');
  }
  /** Direct file/command mutations share the lifecycle lock, so wipe/delete cannot race them. */
  async function withAccess<T>(
    context: AuthContext,
    serverId: string,
    write: boolean,
    work: (
      identifier: string,
      connection: Kysely<Database>,
      current: AuthContext,
      server: Awaited<ReturnType<typeof authorizeServer>>,
    ) => Promise<T>,
    identityMode:
      | 'fresh'
      | 'directory'
      | 'upload'
      | 'upload-batch'
      | 'upload-prepare'
      | 'upload-transfer' = 'fresh',
    timing?: UploadTiming,
    storageCleanup = false,
  ) {
    const timed = <T>(name: string, work: () => Promise<T>) =>
      timing ? timing.measure(name, work) : work();
    const reuseIdentity = identityMode !== 'fresh';
    const sharedUpload = identityMode === 'upload-batch' || identityMode === 'upload-transfer';
    const run = async (connection: Kysely<Database>) => {
      let identityAttempted = false;
      if (write) {
        const lock = await timed('access.serverLock', () =>
          (sharedUpload
            ? sql<{
                acquired: boolean;
              }>`select pg_try_advisory_lock_shared(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`},0)) as acquired`
            : sql<{
                acquired: boolean;
              }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`},0)) as acquired`
          ).execute(connection),
        );
        // This request has not entered the callback or started any provider effect.
        if (!lock.rows[0]?.acquired) throw new DomainError('operation_busy');
      }
      try {
        const current = await timed('access.sessionFirst', () =>
          currentInteractiveContext(connection, context, env),
        );
        const server = await timed('access.permissionFirst', () =>
          authorizeServer(connection, current, serverId, write ? 'server:manage' : 'server:read'),
        );
        if (!server.pterodactyl_id || !server.pterodactyl_identifier)
          throw new DomainError('conflict');
        if (write && server.active_operation_id) throw new DomainError('conflict');
        if (write) await assertStorageMutationAllowed(connection, storageCleanup);
        if (write && !sharedUpload && identityMode !== 'upload-prepare')
          await assertNoPendingUpload(connection, serverId);
        identityAttempted = true;
        if (reuseIdentity)
          await timed('access.identityProof', () =>
            directoryIdentityCache.verify(
              connection,
              server,
              consoleProviderBinding,
              () => adapter.getApplicationServer(server.pterodactyl_id as number),
              db,
            ),
          );
        else {
          const remote = await timed('access.identityFetch', () =>
            adapter.getApplicationServer(server.pterodactyl_id as number),
          );
          await timed('access.identityVerify', () =>
            verifyManagedIdentity(connection, server, remote),
          );
        }
        // Binary batches perform their final fresh authorization after admission,
        // directly before the provider POST. Only that path may defer this check;
        // preparation, cancellation and ordinary effects still recheck here.
        if (identityMode === 'upload-transfer')
          return await work(server.pterodactyl_identifier, connection, current, server);
        // Identity corroboration may itself wait on a remote API. Recheck directly
        // before the effect rather than extending an old authorization across it.
        const refreshed = await timed('access.sessionSecond', () =>
          currentInteractiveContext(connection, current, env),
        );
        const latest = await timed('access.permissionSecond', () =>
          authorizeServer(connection, refreshed, serverId, write ? 'server:manage' : 'server:read'),
        );
        if (reuseIdentity && directoryServerIdentity(latest) !== directoryServerIdentity(server))
          throw new DomainError('conflict');
        if (write) await assertStorageMutationAllowed(connection, storageCleanup);
        return await work(server.pterodactyl_identifier, connection, refreshed, server);
      } catch (error) {
        if (identityAttempted) directoryIdentityCache.invalidate(serverId);
        throw error;
      } finally {
        if (write)
          await timed('access.serverUnlock', () =>
            (sharedUpload
              ? sql`select pg_advisory_unlock_shared(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`},0))`
              : sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:server:${serverId}`},0))`
            ).execute(connection),
          );
      }
    };
    // Directory reads hold no lifecycle lock. Do not pin a pool connection while
    // waiting for a background renewal that itself needs that pool (even max=1).
    if (!timing || identityMode === 'directory')
      return identityMode === 'directory' ? run(db) : db.connection().execute(run);
    const acquired = timing.start('access.connectionAcquire');
    let released: (() => void) | undefined;
    try {
      return await db.connection().execute(async (connection) => {
        acquired();
        try {
          return await run(connection);
        } finally {
          released = timing.start('access.connectionRelease');
        }
      });
    } finally {
      acquired();
      released?.();
    }
  }
  // Existing generic access callers keep fresh remote corroboration. Uploads
  // explicitly reuse identity only; authorization, locks and file checks remain fresh.
  function access<T>(
    context: AuthContext,
    serverId: string,
    write: boolean,
    work: Parameters<typeof withAccess<T>>[3],
    timing?: UploadTiming,
  ) {
    return withAccess(context, serverId, write, work, 'fresh', timing);
  }
  /** Callbacks are restricted to explicit deletion, preserving all normal
   * session, ownership, provider-identity and exclusive server-lock checks. */
  function cleanupAccess<T>(
    context: AuthContext,
    serverId: string,
    work: Parameters<typeof withAccess<T>>[3],
    timing?: UploadTiming,
  ) {
    return withAccess(context, serverId, true, work, 'fresh', timing, true);
  }
  function authorizeCleanupTransfer(
    context: AuthContext,
    serverId: string,
    connection: Kysely<Database>,
    timing?: UploadTiming,
  ) {
    return authorizeTransfer(context, serverId, true, connection, timing, undefined, true);
  }
  async function listFiles(
    context: AuthContext,
    serverId: string,
    path: string,
    prepareDownloads = true,
  ) {
    const { identifier, files } = await withAccess(
      context,
      serverId,
      false,
      async (identifier) => ({ identifier, files: await adapter.listFiles(identifier, path) }),
      'directory',
    );
    // The authenticated listing is already available. Issuance is optional
    // background work and must not delay or replace a successful directory response.
    if (prepareDownloads) {
      const paths = files
        .filter((file) => file.is_file && !file.is_symlink)
        .map((file) => (path ? `${path}/${file.name}` : file.name));
      if (paths.length) void adapter.prefetchDownloads(identifier, paths).catch(() => {});
    }
    return files;
  }
  /** Already-authorized callers share the bounded settings/chunk transport without
   * entering access a second time. Directory contents stay operation-local. */
  async function fileDirectoryBatch(
    identifier: string,
    server: Parameters<typeof directoryServerIdentity>[0],
    directories: string[],
    signal?: AbortSignal,
    timing?: OperationTiming,
  ): Promise<DirectoryBatchResult[]> {
    signal?.throwIfAborted();
    let cache = directoryBatchSettings.get(db);
    if (!cache) {
      cache = new Map();
      directoryBatchSettings.set(db, cache);
    }
    const key = JSON.stringify([consoleProviderBinding, directoryServerIdentity(server)]);
    let settings = cache.get(key);
    if (timing) {
      const cached = settings && settings.expiresAt > performance.now();
      timing.measureSync(cached ? 'settings.hit' : 'settings.miss', () => {});
    }
    if (!settings || settings.expiresAt <= performance.now()) {
      cache.delete(key);
      if (cache.size >= 256) cache.delete(cache.keys().next().value as string);
      settings = {
        expiresAt: performance.now() + 60_000,
        value: adapter.getDirectoryBatchSettings(identifier, timing?.child('settings')),
      };
      cache.set(key, settings);
    }
    let configuration: DirectoryBatchSettings;
    try {
      const pending = settings.value;
      configuration = await traceOperation(timing, 'settings.lookup', () => pending);
    } catch (error) {
      // Missing optional endpoints need a cooldown; transient outages must
      // not disable prefetch for a full minute after the provider recovers.
      if (
        !(error instanceof PterodactylError && [404, 405].includes(error.upstreamStatus ?? 0)) &&
        cache.get(key) === settings
      )
        cache.delete(key);
      throw error;
    }
    const { directoryBatchLimit, directoryTimeoutSeconds } = configuration;
    const deadline = performance.now() + directoryTimeoutSeconds * 1000;
    const results: DirectoryBatchResult[] = [];
    let responseBytes = 0;
    for (let offset = 0; offset < directories.length; offset += directoryBatchLimit) {
      signal?.throwIfAborted();
      if (performance.now() >= deadline) {
        results.push(
          ...directories
            .slice(offset)
            .map((directory) => ({ directory, error: 'deadline_exceeded' as const })),
        );
        break;
      }
      const chunk = await traceOperation(timing, 'batch', () =>
        adapter.listDirectoriesBatch(
          identifier,
          directories.slice(offset, offset + directoryBatchLimit),
          timing?.child('request'),
        ),
      );
      // Splitting for a lower Owner limit must not multiply the response budget.
      responseBytes += Buffer.byteLength(JSON.stringify(chunk), 'utf8');
      if (responseBytes > 8 * 1024 * 1024) throw new DomainError('integration_unavailable');
      results.push(...chunk);
    }
    return results;
  }
  async function listDirectories(
    context: AuthContext,
    serverId: string,
    directories: string[],
    signal?: AbortSignal,
  ): Promise<DirectoryBatchResult[]> {
    signal?.throwIfAborted();
    if (
      !Array.isArray(directories) ||
      !directories.length ||
      directories.length > 48 ||
      new Set(directories).size !== directories.length
    )
      throw new DomainError('validation_failed');
    for (const path of directories) {
      relativePath(path, true);
      if (Buffer.byteLength(path, 'utf8') > 4096 || /\p{C}/u.test(path))
        throw new DomainError('validation_failed');
    }
    const outcome = await withAccess(
      context,
      serverId,
      false,
      async (identifier, _connection, _current, server) => {
        try {
          const results = await fileDirectoryBatch(identifier, server, directories, signal);
          // Optional metadata prefetch must never issue download URLs, fetch file
          // contents, or fan out to native listings when Blueprint is unavailable.
          return { results };
        } catch (error) {
          if (
            (error instanceof PterodactylError &&
              [401, 403, 409].includes(error.upstreamStatus ?? 0)) ||
            (error instanceof DomainError && error.code === 'provenance_mismatch')
          )
            directoryIdentityCache.invalidate(serverId);
          // Optional prefetch errors say nothing about the identity proof we
          // just established, except explicit contradictory identity/access
          // responses above. Leave it reusable for missing endpoints/outages.
          return { error };
        }
      },
      'directory',
    );
    if ('error' in outcome) throw outcome.error;
    return outcome.results;
  }
  function fileReadAccess<T>(
    context: AuthContext,
    serverId: string,
    work: Parameters<typeof withAccess<T>>[3],
    timing?: UploadTiming,
  ) {
    return withAccess(context, serverId, false, work, 'directory', timing);
  }
  /** A fresh request-local Fileman phase for an already-authorized managed
   * access callback. It reuses the configured batch directory transport. */
  function fileReadPhase(
    identifier: string,
    server: Awaited<ReturnType<typeof authorizeServer>>,
    signal?: AbortSignal,
  ) {
    return createFilemanReadService({
      adapter,
      identifier,
      authorize: async () => {},
      signal,
      listDirectories: (directories) => fileDirectoryBatch(identifier, server, directories, signal),
    });
  }
  /** One private read phase: initial managed access plus a final authorization
   * boundary before returning bytes, rather than repeated checks for each file. */
  function fileReadScope<T>(
    context: AuthContext,
    serverId: string,
    work: (
      files: FilemanReadService,
      ...args: Parameters<Parameters<typeof withAccess<T>>[3]>
    ) => Promise<T>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    return fileReadAccess(context, serverId, async (identifier, connection, current, server) => {
      const files = fileReadPhase(identifier, server, signal);
      const result = await work(files, identifier, connection, current, server);
      signal?.throwIfAborted();
      await authorizeTransfer(current, serverId, false, connection, undefined, server);
      return result;
    });
  }
  /** Optional preparation only. Grants stay inside the adapter and never confer
   * permission to write; the eventual durable effect keeps its own final guards. */
  async function prepareFileWrites(
    context: AuthContext,
    serverId: string,
    paths: readonly string[],
  ) {
    if (!paths.length || paths.length > 4 || new Set(paths).size !== paths.length)
      throw new DomainError('validation_failed');
    for (const path of paths) {
      relativePath(path);
      if (Buffer.byteLength(path, 'utf8') > 4096 || /\p{C}/u.test(path))
        throw new DomainError('validation_failed');
    }
    const outcome = await fileReadAccess(
      context,
      serverId,
      async (identifier, connection, current, server) => {
        try {
          await authorizeTransfer(current, serverId, true, connection, undefined, server);
          const prepared = await Promise.allSettled(
            paths.map((path) => adapter.prepareFileWrite(identifier, path)),
          );
          for (const result of prepared) if (result.status === 'rejected') throw result.reason;
          return {};
        } catch (error) {
          // Optional grant preparation can be unavailable to a reader or while a
          // job is active. Neither contradicts the managed identity just proved.
          return { error };
        }
      },
    );
    if ('error' in outcome) throw outcome.error;
  }
  function fileMutationAccess<T>(
    context: AuthContext,
    serverId: string,
    work: Parameters<typeof withAccess<T>>[3],
    timing?: UploadTiming,
  ) {
    // Reuse the same bounded identity proof as browsing/uploads, while retaining
    // fresh authorization, exclusive lifecycle locking and pending-upload fences.
    return withAccess(context, serverId, true, work, 'upload', timing);
  }
  function uploadAccess<T>(
    context: AuthContext,
    serverId: string,
    work: Parameters<typeof withAccess<T>>[3],
  ) {
    // The API upload gate reserves pool capacity for background proof renewals
    // and transfer authorization while this write holds its pinned connection.
    return withAccess(context, serverId, true, work, 'upload');
  }
  /** The callback must validate/consume its durable batch entry before sending
   * bytes. Shared upload locks still exclude lifecycle and ordinary mutations.
   * Only actual binary transfers may opt into deferred authorization; they must
   * call authorizeTransfer with the verified server directly before provider POST. */
  function uploadBatchAccess<T>(
    context: AuthContext,
    serverId: string,
    work: Parameters<typeof withAccess<T>>[3],
    prepare = false,
    timing?: UploadTiming,
    transfer = false,
  ) {
    return withAccess(
      context,
      serverId,
      true,
      work,
      prepare ? 'upload-prepare' : transfer ? 'upload-transfer' : 'upload-batch',
      timing,
    );
  }
  function uploadBatchBinding(server: Parameters<typeof directoryServerIdentity>[0]) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          directoryServerIdentity(server),
          consoleProviderBinding,
          values.pterodactylUploadOrigins,
          server.limits,
          server.mapping_id,
        ]),
      )
      .digest('hex');
  }
  return {
    adapter,
    consoleProviderBinding,
    consoleBindingForServer,
    observeConsoleDisk,
    fileDiskUsage,
    containerObserver,
    refreshObservations,
    refreshStorage: (connection: Kysely<Database> = db, scope?: StorageObservationScope) =>
      refreshStorageObservations(connection, adapter, env, scope),
    storagePolicy: createStoragePolicyService({
      db,
      adapter,
      env,
      reconcileSftp: async (connection, serverId, diskMiB) => {
        await reconcileServerStorageQuota(connection, serverId, diskMiB, externalOptions, {
          assumeServerLock: true,
        });
      },
    }),
    process,
    reconcile,
    access,
    cleanupAccess,
    uploadAccess,
    uploadBatchAccess,
    uploadBatchBinding,
    listFiles,
    listDirectories,
    fileReadAccess,
    fileReadPhase,
    fileReadScope,
    prepareFileWrites,
    fileMutationAccess,
    fileDirectoryBatch,
    authorizeTransfer,
    authorizeCleanupTransfer,
    lifecycle,
    externalOptions,
    minecraftOptions,
    worldPreparation,
    prepareWorldSelection,
    assertMinecraftRuntimeImage,
    assertFileMutation,
  };
}
export type ManagementRuntime = Awaited<ReturnType<typeof createManagementRuntime>>;

/** Process-scoped request coordination; settings and credentials still resolve on each runtime. */
export const createManagementTransportCoordinator = createTransportCoordinator;
