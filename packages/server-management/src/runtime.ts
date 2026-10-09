import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CurseForgeProvider, SafeContentHttp } from '@nickhosting/content-providers';
import {
  type AuthContext,
  assertAuthContext,
  DomainError,
  type SecretCodec,
} from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import { evaluateGameAccess } from '@nickhosting/game-sdk';
import { minecraftRuntimeMappingSchema } from '@nickhosting/minecraft';
import {
  type ContainerObserver,
  createContainerObserver,
  createPterodactylAdapter,
  type PterodactylAdapter,
  provisionPlanSchema,
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
import { currentInteractiveContext } from './interactive-context.js';
import {
  createLifecycleProcessor,
  reconcileManagedServer,
  verifyManagedIdentity,
} from './lifecycle.js';
import {
  assertMinecraftLaunchInputs,
  assertMinecraftRuntimePathsPreserved,
  configureMinecraftProvision,
  type MinecraftContentOptions,
  processMinecraftContent,
  verifyMinecraftRestore,
} from './minecraft-content.js';
import { requireMinecraftChoice } from './minecraft-registry.js';
import {
  assertMinecraftEggEnvironment,
  assertMinecraftRemoteLaunch,
  assertMinecraftVerifiedLaunch,
  minecraftProvisionEnvironment,
  requireMinecraftRuntimeImageEvidence,
} from './minecraft-runtime-evidence.js';
import { assertGatewaySleepFence, authorizeServer } from './registry.js';
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
  if (['start', 'restart'].includes(operation.action)) {
    const minecraft = await db
      .selectFrom('minecraft_server_profiles')
      .select('installed')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (minecraft && !minecraft.installed) throw new DomainError('conflict');
  }

  if (operation.plan.gatewayAutomation !== undefined) {
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
        mapping.game_id === 'minecraft-java'
          ? { userId: owner.id, role: owner.role }
          : { userId: context.subjectUserId, role: context.role },
      ).canCreate
    )
      throw new DomainError('forbidden');
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', server.id)
      .executeTakeFirst();
    if (mapping.game_id === 'minecraft-java' || profile) {
      if (!profile || mapping.game_id !== 'minecraft-java')
        throw new DomainError('configuration_invalid');
      // The queued actor remains separately authorized above. Compatibility and
      // tester eligibility belong to the resource owner, never an elevated helper.
      const choice = await requireMinecraftChoice(
        db,
        {
          actorUserId: owner.id,
          subjectUserId: owner.id,
          role: owner.role,
          sessionType: 'regular',
          ownerElevation: false,
        },
        profile.combination_id,
        env,
      );
      const binding = minecraftRuntimeMappingSchema.parse(choice.row.binding);
      const plan = provisionPlanSchema.parse(operation.plan.provision);
      const variables = await minecraftProvisionEnvironment(db, serverId, choice);
      if (!adapter) throw new DomainError('configuration_invalid');
      await assertMinecraftEggEnvironment(adapter, choice, variables);
      if (
        choice.row.mapping_id !== server.mapping_id ||
        choice.row.mapping_digest !== choice.mappingDigest ||
        choice.combination.profile !== mapping.runtime_id ||
        binding.image !== mapping.docker_image ||
        plan.dockerImage !== binding.image ||
        plan.eggId !== mapping.egg_id ||
        plan.startup !== mapping.startup ||
        !isDeepStrictEqual(plan.environment, variables)
      )
        throw new DomainError('configuration_invalid');
      {
        const allocation = await db
          .selectFrom('server_allocations')
          .selectAll()
          .where('server_id', '=', serverId)
          .where('is_primary', '=', true)
          .executeTakeFirstOrThrow();
        const evidence = await requireMinecraftRuntimeImageEvidence(db, serverId, null, env);
        assertMinecraftVerifiedLaunch(
          plan.startup,
          {
            ...variables,
            SERVER_MEMORY: String(plan.limits.memory),
            SERVER_IP: allocation.address,
            SERVER_PORT: String(allocation.port),
            P_SERVER_UUID: server.pterodactyl_uuid ?? 'unassigned',
          },
          binding.profile,
          binding.artifactPaths.server,
          evidence.report,
        );
      }
    }
  }
  return context;
}

export interface ManagementOptions {
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

  async function refreshObservations(connection: Kysely<Database> = db) {
    const hosts = await connection.selectFrom('physical_hosts').selectAll().execute();
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
  async function observedImageDigest(connection: Kysely<Database>, serverId: string) {
    await verifyObservationHost(serverId, connection);
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
      await adapter.getApplicationServer(server.pterodactyl_id),
    );
    const digest = await containerObserver.imageIdentity(server.pterodactyl_uuid);
    if (digest !== null && !/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new DomainError('integration_unavailable');
    return digest;
  }
  async function assertMinecraftRuntimeImage(
    serverId: string,
    connection: Kysely<Database> = db,
    requireObserved = true,
  ) {
    const profile = await connection
      .selectFrom('minecraft_server_profiles')
      .select('server_id')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!profile) {
      const mapping = await connection
        .selectFrom('managed_servers as server')
        .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
        .select('mapping.game_id')
        .where('server.id', '=', serverId)
        .executeTakeFirst();
      if (mapping?.game_id === 'minecraft-java') throw new DomainError('integration_unavailable');
      return;
    }
    const observed = await observedImageDigest(connection, serverId);
    const server = await connection
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    await assertMinecraftRemoteLaunch(
      connection,
      serverId,
      await adapter.getApplicationServer(server.pterodactyl_id ?? 0),
      env,
      adapter,
    );
    const evidence = await requireMinecraftRuntimeImageEvidence(
      connection,
      serverId,
      observed,
      env,
    );
    if (requireObserved && !evidence.verified) throw new DomainError('integration_unavailable');
    return evidence;
  }
  const launchEpochs = new Map<string, string>();
  async function assertLaunchFiles(serverId: string, connection: Kysely<Database>) {
    const profile = await connection
      .selectFrom('minecraft_server_profiles')
      .select('server_id')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!profile) return;
    const server = await connection
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    await assertMinecraftLaunchInputs(
      {
        db: connection,
        server,
        adapter,
        authorize: async () => {
          await verifyManagedIdentity(
            connection,
            server,
            await adapter.getApplicationServer(server.pterodactyl_id ?? 0),
          );
          await assertMinecraftRemoteLaunch(
            connection,
            serverId,
            await adapter.getApplicationServer(server.pterodactyl_id ?? 0),
            env,
            adapter,
          );
        },
      },
      { env, observedImageDigest },
    );
  }
  async function assertFileMutation(
    serverId: string,
    paths: readonly string[],
    connection: Kysely<Database> = db,
  ) {
    const profile = await connection
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!profile) return;
    const choice = await connection
      .selectFrom('minecraft_combinations')
      .select('binding')
      .where('id', '=', profile.combination_id)
      .executeTakeFirstOrThrow();
    const binding = minecraftRuntimeMappingSchema.parse(choice.binding);
    const additional = Object.values(binding.artifactPaths).filter(
      (path): path is string => typeof path === 'string',
    );
    if (binding.profile === 'fabric') additional.push('fabric-server-launcher.properties');
    if (binding.profile === 'forge') additional.push('user_jvm_args.txt');
    assertMinecraftRuntimePathsPreserved(paths, [
      ...(profile.installed_manifest as { path: string }[]),
      ...additional.map((path) => ({ path })),
    ]);
    const server = await connection
      .selectFrom('managed_servers')
      .select('pterodactyl_identifier')
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    if (!server.pterodactyl_identifier) throw new DomainError('conflict');
    // An SFTP-created alias must not turn an otherwise ordinary browser path
    // into a write through a protected launch file or its parent directory.
    for (const path of paths) {
      const components = path.split('/');
      let directory = '';
      for (const component of components) {
        const matches = (await adapter.listFiles(server.pterodactyl_identifier, directory)).filter(
          (entry) => entry.name.toLowerCase() === component.toLowerCase(),
        );
        if (
          matches.length > 1 ||
          matches.some((entry) => entry.is_symlink || entry.name !== component)
        )
          throw new DomainError('conflict');
        if (!matches.length) break;
        directory = [directory, component].filter(Boolean).join('/');
      }
    }
    launchEpochs.delete(serverId);
  }
  /** Resolve provider settings only for Minecraft calls, preserving other integrations. */
  async function minecraftOptions(): Promise<MinecraftContentOptions> {
    const { values: minecraft } = await getSettings(db, env);
    if (!minecraft.minecraftMetadataUserAgent) throw new DomainError('configuration_invalid');
    const http = new SafeContentHttp({
      userAgent: minecraft.minecraftMetadataUserAgent,
      allowedOrigins: [
        'https://api.modrinth.com',
        'https://api.curseforge.com',
        ...minecraft.minecraftDownloadOrigins,
      ],
    });
    const key = await getSecret(db, options.codec, 'curseforgeApiKey', env);
    const mountdataRoot = resolve(minecraft.minecraftContentRoot);
    return {
      http,
      mountdataRoot,
      sourceRoot: resolve(minecraft.minecraftSourceRoot),
      userAgent: minecraft.minecraftMetadataUserAgent,
      env,
      observedImageDigest,
      curseforge: key ? new CurseForgeProvider(http, { apiKey: key }) : undefined,
      authorizeJob: (connection, jobId, serverId) =>
        authorizeQueuedEffect(connection, jobId, serverId, env, adapter),
    };
  }
  const lifecycle = {
    env,
    configureGameProvision: async (context: import('./lifecycle.js').GameLifecycleContext) => {
      const profile = await context.db
        .selectFrom('minecraft_server_profiles')
        .select('server_id')
        .where('server_id', '=', context.server.id)
        .executeTakeFirst();
      return profile ? configureMinecraftProvision(context, await minecraftOptions()) : true;
    },
    processGameContent: async (context: import('./lifecycle.js').GameLifecycleContext) =>
      processMinecraftContent(context, await minecraftOptions()),
    verifyGameRestore: async (context: import('./lifecycle.js').GameLifecycleContext) => {
      const profile = await context.db
        .selectFrom('minecraft_server_profiles')
        .select('server_id')
        .where('server_id', '=', context.server.id)
        .executeTakeFirst();
      return profile ? verifyMinecraftRestore(context, await minecraftOptions()) : true;
    },
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
      await verifyManagedIdentity(
        connection,
        server,
        await adapter.getApplicationServer(server.pterodactyl_id),
      );
      const before = await containerObserver.processStartedAt(server.pterodactyl_uuid);
      const image = await assertMinecraftRuntimeImage(serverId, connection);
      if (!image) return before;
      if (before !== null) {
        const proof = `${before}:${image.report.runId}`;
        if (launchEpochs.get(serverId) !== proof) {
          await assertLaunchFiles(serverId, connection);
          // Store only after the second epoch read confirms the same process.
        }
      }
      // Image and process reads are separate pinned observations. A replacement
      // between them must not attach an old image proof to a new process epoch.
      const after = await containerObserver.processStartedAt(server.pterodactyl_uuid);
      if (before !== after) throw new DomainError('operation_uncertain');
      if (after !== null) launchEpochs.set(serverId, `${after}:${image.report.runId}`);
      else launchEpochs.delete(serverId);
      return after;
    },
    adapter,
    authorizeEffect: async (jobId: string, serverId: string, connection: Kysely<Database>) => {
      await verifyObservationHost(serverId, connection);
      await authorizeQueuedEffect(connection, jobId, serverId, env, adapter);
      const operation = await connection
        .selectFrom('server_operations')
        .select(['action', 'phase'])
        .where('job_id', '=', jobId)
        .executeTakeFirstOrThrow();
      if (
        ['start', 'restart'].includes(operation.action) ||
        (operation.action === 'provision' && operation.phase === 'initial_start')
      )
        await assertMinecraftRuntimeImage(serverId, connection, false);
    },
    reserveInstallation: async (serverId: string, jobId: string, connection: Kysely<Database>) => {
      await verifyObservationHost(serverId, connection);
      await refreshObservations(connection);
      await reserveInstallation(connection, serverId, jobId, env);
    },
    reserveStart: async (
      serverId: string,
      jobId: string,
      action: 'start' | 'restart',
      connection: Kysely<Database>,
    ) => {
      await verifyObservationHost(serverId, connection);
      await assertMinecraftRuntimeImage(serverId, connection, false);
      launchEpochs.delete(serverId);
      await assertLaunchFiles(serverId, connection);
      await refreshObservations(connection);
      await reserveStart(connection, serverId, jobId, action, env);
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
