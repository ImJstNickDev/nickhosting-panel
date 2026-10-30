import { isDeepStrictEqual } from 'node:util';
import {
  type AuthContext,
  DomainError,
  resolveContentStoragePath,
  runtimeStorageRoot,
  type SecretCodec,
} from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import {
  minecraftManifest,
  minecraftReadinessSource,
  minecraftRuntimeMappingSchema,
  resolveMinecraftGatewayMessages,
} from '@nickhosting/minecraft';
import {
  type PterodactylAdapter,
  provisionPlanSchema,
  type ServerFile,
} from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import type { Environment } from './admission.js';
import type {
  FileMutationContext,
  GameOperationAuthorization,
  GameRuntimeHooks,
  TrustedGameModule,
} from './game-modules.js';
import { requireMinecraftGatewayProtocol } from './gateway-registry.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { cleanupMinecraftBackup, prepareMinecraftBackup } from './minecraft-backup.js';
import {
  assertMinecraftPlayerConfiguration,
  assertMinecraftRuntimePathsPreserved,
  configureMinecraftProvision,
  type MinecraftContentOptions,
  processMinecraftContent,
  verifyMinecraftInitialInstallation,
  verifyMinecraftRestore,
} from './minecraft-content.js';
import { minecraftStoredConfigurationSchema } from './minecraft-content-contracts.js';
import {
  inspectMinecraftCombination,
  minecraftCatalog,
  requireMinecraftChoice,
} from './minecraft-registry.js';
import {
  assertMinecraftEggEnvironment,
  assertMinecraftRemoteLaunch,
  assertMinecraftVerifiedLaunch,
  minecraftProvisionEnvironment,
  requireMinecraftRuntimeImageEvidence,
} from './minecraft-runtime-evidence.js';
import { minecraftProvisionStartup } from './minecraft-startup.js';
import { minecraftContentProviders } from './minecraft-world-catalog.js';

async function authorizeOperation(input: GameOperationAuthorization) {
  const { db, server, operation, mapping, env, adapter, resourceOwner: owner } = input;
  const serverId = server.id;
  if (['start', 'restart'].includes(operation.action)) {
    const minecraft = await db
      .selectFrom('minecraft_server_profiles')
      .select('installed')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (minecraft && !minecraft.installed) throw new DomainError('conflict');
  }
  if (operation.action === 'provision') {
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', server.id)
      .executeTakeFirst();
    if (mapping.game_id === 'minecraft' || profile) {
      if (!profile || mapping.game_id !== 'minecraft')
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
      // Provisioning persists validated player identities before subsequent effects;
      // reauthorization must validate that internal shape, not the public request shape.
      assertMinecraftPlayerConfiguration(
        choice,
        minecraftStoredConfigurationSchema.parse(profile.configuration),
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
        (mapping.image_mode === 'static' && binding.image !== mapping.docker_image) ||
        plan.dockerImage !== binding.image ||
        plan.eggId !== mapping.egg_id ||
        plan.startup !== minecraftProvisionStartup(choice) ||
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
          choice,
        );
      }
    }
  }
}
export const minecraftModule: TrustedGameModule = {
  id: 'minecraft',
  manifest: minecraftManifest,
  provisionAsResourceOwner: true,
  resolveGatewayMessages(settings, context) {
    return resolveMinecraftGatewayMessages(settings.minecraftGatewayResponses, context.serverName, {
      variables: context.variables,
    });
  },
  readinessSource: minecraftReadinessSource,
  async gatewayPolicyBinding(db, server, env) {
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', server.id)
      .executeTakeFirst();
    if (!profile?.installed) return null;
    try {
      const choice = await inspectMinecraftCombination(db, profile.combination_id, env);
      const binding = { protocolId: 'minecraft-java', gameVersion: choice.combination.release };
      await requireMinecraftGatewayProtocol(
        db,
        server.id,
        { handlerId: binding.protocolId, gameVersion: binding.gameVersion },
        env,
      );
      return binding;
    } catch (error) {
      if (
        error instanceof DomainError &&
        ['integration_unavailable', 'configuration_invalid'].includes(error.code)
      )
        return null;
      throw error;
    }
  },
  resolveProvisionImage(mapping, binding) {
    const selected = minecraftRuntimeMappingSchema.parse(binding);
    if (selected.profile !== mapping.runtime_id) throw new DomainError('configuration_invalid');
    return selected.image;
  },
  async assertProfileBinding(db, server, mapping) {
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .select('server_id')
      .where('server_id', '=', server.id)
      .executeTakeFirst();
    if (profile && mapping.game_id !== 'minecraft') throw new DomainError('configuration_invalid');
  },
  authorizeOperation,
  async filterCatalog(db, context, entry, env) {
    const choices = await minecraftCatalog(db, context, env);
    const manifest = entry.manifest as {
      runtimes: Array<{ id: string; supportedGameVersions: string[] }>;
    };
    return {
      ...entry,
      manifest: {
        ...manifest,
        runtimes: manifest.runtimes
          .filter((runtime) => choices.some((choice) => choice.runtime === runtime.id))
          .map((runtime) => ({
            ...runtime,
            supportedGameVersions: [
              ...new Set(
                choices
                  .filter((choice) => choice.runtime === runtime.id)
                  .map((choice) => choice.version),
              ),
            ],
          })),
      },
    };
  },
};
export interface MinecraftModuleOptions {
  worldPreparation?: MinecraftContentOptions['worldPreparation'];
  db: Kysely<Database>;
  codec: SecretCodec;
  env: Environment;
  adapter: PterodactylAdapter;
  observedImageDigest: (
    connection: Kysely<Database>,
    serverId: string,
    remote?:
      | Awaited<ReturnType<PterodactylAdapter['getApplicationServer']>>
      | ReturnType<PterodactylAdapter['getApplicationServer']>,
    observerPreflight?: Promise<void>,
  ) => Promise<string | null>;
  authorizeJob: (
    connection: Kysely<Database>,
    jobId: string,
    serverId: string,
  ) => Promise<AuthContext>;
}
/** Existing M4 implementation lives here unchanged; the shared runtime only
 * dispatches compiled hooks while retaining admission, identity and job locks. */
export function createMinecraftModuleRuntime(options: MinecraftModuleOptions) {
  const { db, env, adapter, observedImageDigest } = options;
  async function assertMinecraftRuntimeImage(
    serverId: string,
    connection: Kysely<Database> = db,
    requireObserved = true,
    snapshot?:
      | Awaited<ReturnType<PterodactylAdapter['getApplicationServer']>>
      | ReturnType<PterodactylAdapter['getApplicationServer']>,
    observerPreflight?: Promise<void>,
    validateEggMetadata = true,
    verifiedProcessEpoch?: string,
  ) {
    const profile = await connection
      .selectFrom('minecraft_server_profiles')
      .select(['server_id', 'installed'])
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!profile) {
      const mapping = await connection
        .selectFrom('managed_servers as server')
        .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
        .select('mapping.game_id')
        .where('server.id', '=', serverId)
        .executeTakeFirst();
      if (mapping?.game_id === 'minecraft') throw new DomainError('integration_unavailable');
      return;
    }
    if (requireObserved && !profile.installed) throw new DomainError('integration_unavailable');
    const server = await connection
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    const remote = Promise.resolve(
      snapshot ?? adapter.getApplicationServer(server.pterodactyl_id ?? 0),
    );
    // Begin independent egg and provider lookups together; settle both branches
    // before returning a failed proof to the job lock's connection owner.
    const proofs = await Promise.allSettled([
      observedImageDigest(connection, serverId, remote, observerPreflight),
      assertMinecraftRemoteLaunch(connection, serverId, remote, env, adapter, validateEggMetadata),
    ]);
    for (const result of proofs) if (result.status === 'rejected') throw result.reason;
    const observed = proofs[0].status === 'fulfilled' ? proofs[0].value : null;
    const evidence = await requireMinecraftRuntimeImageEvidence(
      connection,
      serverId,
      observed,
      env,
      verifiedProcessEpoch,
    );
    if (requireObserved && !evidence.verified) throw new DomainError('integration_unavailable');
    return evidence;
  }
  async function assertFileMutation(
    serverId: string,
    paths: readonly string[],
    connection: Kysely<Database> = db,
    context?: FileMutationContext,
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
    const identifier = server.pterodactyl_identifier;
    if (!identifier) throw new DomainError('conflict');
    if (context && context.providerIdentifier !== identifier) throw new DomainError('conflict');
    const readDirectory =
      context?.listFiles ?? ((directory: string) => adapter.listFiles(identifier, directory));
    // These independent reads are fresh for this mutation. Deduplicate every
    // ancestor and bound concurrency, including large multi-file operations.
    const requested = new Set<string>();
    for (const path of paths) {
      let directory = '';
      for (const component of path.split('/')) {
        requested.add(directory);
        directory = [directory, component].filter(Boolean).join('/');
      }
    }
    const pending = [...requested];
    const directories = new Map<string, PromiseSettledResult<ServerFile[]>>();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        for (;;) {
          const directory = pending[next++];
          if (directory === undefined) return;
          try {
            directories.set(directory, {
              status: 'fulfilled',
              value: await readDirectory(directory),
            });
          } catch (reason) {
            directories.set(directory, { status: 'rejected', reason });
          }
        }
      }),
    );
    // An SFTP-created alias must not turn an otherwise ordinary browser path
    // into a write through a protected launch file or its parent directory.
    // Validate in the original order only after all started reads have drained:
    // a missing ancestor makes descendant errors irrelevant, and an unsafe
    // ancestor takes precedence over a speculative destination failure.
    for (const path of paths) {
      const components = path.split('/');
      let directory = '';
      for (const component of components) {
        const listing = directories.get(directory);
        if (!listing) throw new DomainError('integration_unavailable');
        if (listing.status === 'rejected') throw listing.reason;
        const matches = listing.value.filter(
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
  }
  /** Resolve provider settings only for Minecraft calls, preserving other integrations. */
  async function minecraftOptions(): Promise<MinecraftContentOptions> {
    const { values: minecraft, providers } = await minecraftContentProviders(
      db,
      options.codec,
      env,
    );
    if (!providers || !minecraft.contentMetadataUserAgent)
      throw new DomainError('configuration_invalid');
    const mountdataRoot = resolveContentStoragePath(minecraft.contentWorkRoot, env);
    return {
      ...providers,
      mountdataRoot,
      storageBoundary: runtimeStorageRoot(env),
      sourceRoot: resolveContentStoragePath(minecraft.contentSourceRoot, env),
      userAgent: minecraft.contentMetadataUserAgent,
      env,
      observedImageDigest,
      worldPreparation: options.worldPreparation,
      authorizeJob: (connection, jobId, serverId) =>
        options.authorizeJob(connection, jobId, serverId),
    };
  }

  const hooks: GameRuntimeHooks = {
    prepareBackup: prepareMinecraftBackup,
    cleanupBackup: cleanupMinecraftBackup,
    verifyInitialInstallation: (context) =>
      verifyMinecraftInitialInstallation(context, { env, observedImageDigest }),
    assertRuntimeImage: (serverId, connection, requireObserved, context) =>
      assertMinecraftRuntimeImage(
        serverId,
        connection,
        requireObserved,
        context?.providerServer,
        context?.observerPreflight,
        context?.validateEggMetadata,
      ),
    assertFileMutation,
    async configureProvision(context: GameLifecycleContext) {
      const profile = await context.db
        .selectFrom('minecraft_server_profiles')
        .select('server_id')
        .where('server_id', '=', context.server.id)
        .executeTakeFirst();
      return profile ? configureMinecraftProvision(context, await minecraftOptions()) : true;
    },
    async processContent(context: GameLifecycleContext) {
      const settings = context.timing
        ? await context.timing.measure('game.options', minecraftOptions)
        : await minecraftOptions();
      return processMinecraftContent(context, settings);
    },
    async verifyRestore(context: GameLifecycleContext) {
      const profile = await context.db
        .selectFrom('minecraft_server_profiles')
        .select('server_id')
        .where('server_id', '=', context.server.id)
        .executeTakeFirst();
      return profile ? verifyMinecraftRestore(context, await minecraftOptions()) : true;
    },
    async verifyProcessEpoch(serverId, connection, before, readAgain, remote, observerPreflight) {
      // Ordinary power/readiness trusts the installed artifact. Bytes are verified
      // by installation/content/restore workflows, not downloaded on every boot.
      // Current provider configuration, image and exact process identity stay fresh.
      // Egg installer metadata belongs to provisioning, not the running process.
      await assertMinecraftRuntimeImage(
        serverId,
        connection,
        before !== null,
        remote,
        observerPreflight,
        false,
        before ?? undefined,
      );
      const after = await readAgain();
      if (before !== after) throw new DomainError('operation_uncertain');
      return after;
    },
  };
  return { ...hooks, id: minecraftModule.id, minecraftOptions, assertMinecraftRuntimeImage };
}
