import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CurseForgeProvider, SafeContentHttp } from '@nickhosting/content-providers';
import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import { minecraftManifest, minecraftRuntimeMappingSchema } from '@nickhosting/minecraft';
import { type PterodactylAdapter, provisionPlanSchema } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import type { Environment } from './admission.js';
import type {
  GameOperationAuthorization,
  GameRuntimeHooks,
  TrustedGameModule,
} from './game-modules.js';
import { requireMinecraftGatewayProtocol } from './gateway-registry.js';
import { type GameLifecycleContext, verifyManagedIdentity } from './lifecycle.js';
import {
  assertMinecraftLaunchInputs,
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
}
export const minecraftModule: TrustedGameModule = {
  id: 'minecraft-java',
  manifest: minecraftManifest,
  provisionAsResourceOwner: true,
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
    if (profile && mapping.game_id !== 'minecraft-java')
      throw new DomainError('configuration_invalid');
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
interface LaunchAttestation {
  proof: string;
  complete: Promise<void>;
}
// Management runtimes are request/job scoped. Only successful artifact proofs
// and their in-flight work may survive them; provider/auth checks never do.
const launchAttestations = new WeakMap<Kysely<Database>, Map<string, LaunchAttestation>>();
const maxLaunchAttestations = 1024;
export interface MinecraftModuleOptions {
  db: Kysely<Database>;
  codec: SecretCodec;
  env: Environment;
  adapter: PterodactylAdapter;
  observedImageDigest: (
    connection: Kysely<Database>,
    serverId: string,
    remote?: Awaited<ReturnType<PterodactylAdapter['getApplicationServer']>>,
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
    const server = await connection
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    const remote = await adapter.getApplicationServer(server.pterodactyl_id ?? 0);
    const observed = await observedImageDigest(connection, serverId, remote);
    await assertMinecraftRemoteLaunch(connection, serverId, remote, env, adapter);
    const evidence = await requireMinecraftRuntimeImageEvidence(
      connection,
      serverId,
      observed,
      env,
    );
    if (requireObserved && !evidence.verified) throw new DomainError('integration_unavailable');
    return evidence;
  }
  let launchEpochs = launchAttestations.get(db);
  if (!launchEpochs) {
    launchEpochs = new Map<string, LaunchAttestation>();
    launchAttestations.set(db, launchEpochs);
  }
  const attestations = launchEpochs;
  async function launchProof(
    serverId: string,
    connection: Kysely<Database>,
    epoch: string,
    image: Awaited<ReturnType<typeof assertMinecraftRuntimeImage>>,
  ) {
    const profile = await connection
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const choice = await inspectMinecraftCombination(connection, profile.combination_id, env);
    // Profile revision/manifest also invalidate proofs across API and worker
    // processes after content changes or restoration. Current evidence and
    // immutable artifact/binding metadata must agree even for the same process.
    return createHash('sha256')
      .update(
        JSON.stringify({
          epoch,
          image,
          profile,
          choice: choice.row,
          mapping: choice.mapping,
          // SQL row order is not evidence identity.
          evidence: choice.evidence.map((report) => JSON.stringify(report)).sort(),
        }),
      )
      .digest('hex');
  }
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
          // One fresh provider snapshot serves both checks within this authorization.
          // Each later transfer boundary still obtains its own fresh snapshot.
          const remote = await adapter.getApplicationServer(server.pterodactyl_id ?? 0);
          await verifyManagedIdentity(connection, server, remote);
          await assertMinecraftRemoteLaunch(connection, serverId, remote, env, adapter);
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
    attestations.delete(serverId);
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
        options.authorizeJob(connection, jobId, serverId),
    };
  }

  const hooks: GameRuntimeHooks = {
    verifyInitialInstallation: (context) =>
      verifyMinecraftInitialInstallation(context, { env, observedImageDigest }),
    assertRuntimeImage: assertMinecraftRuntimeImage,
    assertLaunchFiles,
    assertFileMutation,
    invalidateLaunchEpoch: (serverId) => {
      attestations.delete(serverId);
    },
    async configureProvision(context: GameLifecycleContext) {
      const profile = await context.db
        .selectFrom('minecraft_server_profiles')
        .select('server_id')
        .where('server_id', '=', context.server.id)
        .executeTakeFirst();
      return profile ? configureMinecraftProvision(context, await minecraftOptions()) : true;
    },
    async processContent(context: GameLifecycleContext) {
      return processMinecraftContent(context, await minecraftOptions());
    },
    async verifyRestore(context: GameLifecycleContext) {
      const profile = await context.db
        .selectFrom('minecraft_server_profiles')
        .select('server_id')
        .where('server_id', '=', context.server.id)
        .executeTakeFirst();
      return profile ? verifyMinecraftRestore(context, await minecraftOptions()) : true;
    },
    async verifyProcessEpoch(serverId, connection, before, readAgain) {
      // Fresh on every caller, including cache hits: current provider identity,
      // launch configuration, Docker image and support/evidence authorization.
      const image = await assertMinecraftRuntimeImage(serverId, connection);
      if (!image) return before;
      if (before === null) {
        attestations.delete(serverId);
        if ((await readAgain()) !== null) throw new DomainError('operation_uncertain');
        return null;
      }
      const proof = await launchProof(serverId, connection, before, image);
      let entry = attestations.get(serverId);
      if (entry?.proof !== proof) {
        entry = { proof, complete: Promise.resolve() };
        const pending = entry;
        if (attestations.size >= maxLaunchAttestations)
          attestations.delete(attestations.keys().next().value as string);
        attestations.set(serverId, pending);
        pending.complete = (async () => {
          await assertLaunchFiles(serverId, connection);
          // Never retain a proof acquired across a restart, profile change or
          // explicit invalidation while the potentially large file streamed.
          if (
            (await readAgain()) !== before ||
            (await launchProof(serverId, connection, before, image)) !== proof ||
            attestations.get(serverId) !== pending
          )
            throw new DomainError('operation_uncertain');
        })().catch((error: unknown) => {
          if (attestations.get(serverId) === pending) attestations.delete(serverId);
          throw error;
        });
      }
      await entry.complete;
      // Every singleflight waiter independently checks its process epoch and
      // current DB inputs; a successful peer cannot bless a replacement process.
      const after = await readAgain();
      if (
        before !== after ||
        (await launchProof(serverId, connection, before, image)) !== proof ||
        attestations.get(serverId) !== entry
      )
        throw new DomainError('operation_uncertain');
      return after;
    },
  };
  return { ...hooks, id: minecraftModule.id, minecraftOptions, assertMinecraftRuntimeImage };
}
