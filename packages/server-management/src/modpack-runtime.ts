import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type ContentTarget, contentTargetSchema } from '@nickhosting/content-providers';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, notifyGatewayChange } from '@nickhosting/database';
import {
  minecraftDeclaredCapabilities,
  minecraftRuntimeMappingSchema,
  minecraftRuntimeProfiles,
} from '@nickhosting/minecraft';
import type { ApplicationServer, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources, reserveInstallation } from './admission.js';
import { assertManagedIdentity, readManagedIdentity } from './managed-identity.js';
import {
  attestMinecraftRuntimeInstallation,
  type MinecraftContentOptions,
} from './minecraft-content.js';
import {
  type MinecraftModpackRuntimeBinding,
  modpackDigest,
  modpackRuntimeBindingSchema,
  sameModpackTarget,
} from './minecraft-modpacks-plan.js';
import { requireMinecraftChoice, resolveFabricCreationChoice } from './minecraft-registry.js';
import {
  assertMinecraftEggEnvironment,
  assertMinecraftRemoteLaunch,
  minecraftProvisionEnvironment,
} from './minecraft-runtime-evidence.js';
import { authorizeServer } from './registry.js';

type Server = Selectable<Database['managed_servers']>;
type Mapping = Selectable<Database['runtime_egg_mappings']>;
type Choice = Awaited<ReturnType<typeof requireMinecraftChoice>>;
type Allocation = Selectable<Database['server_allocations']>;
export function modpackRuntimeTarget(choice: Choice): ContentTarget {
  return {
    minecraftVersion: choice.combination.release,
    loader: choice.combination.profile,
    ...(choice.combination.loaderVersion
      ? { loaderVersion: choice.combination.loaderVersion }
      : {}),
  };
}
function declaredTarget(target: ContentTarget) {
  if (!minecraftRuntimeProfiles.some((profile) => profile === target.loader)) return false;
  return minecraftDeclaredCapabilities({
    profile: target.loader as Choice['combination']['profile'],
    release: target.minecraftVersion,
    releaseType: 'release',
    family: 'unknown',
    protocolId: null,
  }).installation;
}
export function modpackMappingCompatible(
  server: Pick<Server, 'node_id'>,
  source: Mapping,
  target: Mapping,
  allocations: Allocation[],
): boolean {
  return (
    target.enabled &&
    target.game_id === 'minecraft' &&
    target.node_id === server.node_id &&
    isDeepStrictEqual(source.feature_limits, target.feature_limits) &&
    target.port_roles.length === allocations.length &&
    target.port_roles.every((role) =>
      allocations.some(
        (allocation) =>
          allocation.role === role.role &&
          allocation.is_primary === role.primary &&
          isDeepStrictEqual([...allocation.protocols].sort(), [...role.protocols].sort()),
      ),
    )
  );
}
async function resourceOwner(db: Kysely<Database>, ownerId: string): Promise<AuthContext> {
  const user = await db
    .selectFrom('user')
    .select(['id', 'role'])
    .where('id', '=', ownerId)
    .executeTakeFirst();
  if (!user) throw new DomainError('provenance_mismatch');
  return {
    actorUserId: user.id,
    subjectUserId: user.id,
    role: user.role,
    sessionType: 'regular',
    ownerElevation: false,
  };
}
const eligibilityFailure = (error: unknown) =>
  error instanceof DomainError &&
  [
    'integration_unavailable',
    'forbidden',
    'configuration_invalid',
    'validation_failed',
    'unauthenticated',
  ].includes(error.code);

/** Matches exact immutable choices on the same node. Fabric may lazily register
 * an exact catalog loader using the original authenticated creation authority. */
export async function resolveModpackRuntime(input: {
  db: Kysely<Database>;
  adapter: PterodactylAdapter;
  context: AuthContext;
  serverId: string;
  target: ContentTarget;
  env?: Environment;
}): Promise<MinecraftModpackRuntimeBinding | null> {
  const { db, adapter, context, serverId, env = {} } = input;
  const target = contentTargetSchema.parse(input.target);
  const server = await authorizeServer(db, context, serverId, 'server:manage');
  if (!declaredTarget(target) || (target.loader === 'fabric' && !target.loaderVersion)) return null;
  const [source, allocations, mappings, owner] = await Promise.all([
    db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', server.mapping_id)
      .executeTakeFirstOrThrow(),
    db.selectFrom('server_allocations').selectAll().where('server_id', '=', serverId).execute(),
    db
      .selectFrom('runtime_egg_mappings')
      .innerJoin('managed_nodes', 'managed_nodes.id', 'runtime_egg_mappings.node_id')
      .selectAll('runtime_egg_mappings')
      .where('runtime_egg_mappings.game_id', '=', 'minecraft')
      .where('runtime_egg_mappings.runtime_id', '=', target.loader)
      .where('runtime_egg_mappings.node_id', '=', server.node_id)
      .where('runtime_egg_mappings.enabled', '=', true)
      .where('managed_nodes.enabled', '=', true)
      .orderBy('runtime_egg_mappings.id')
      .execute(),
    resourceOwner(db, server.owner_id),
  ]);
  const usable = mappings
    .filter((mapping) => modpackMappingCompatible(server, source, mapping, allocations))
    .sort(
      (left, right) =>
        Number(right.id === server.mapping_id) - Number(left.id === server.mapping_id),
    );
  const accepted = async (choice: Choice) => {
    if (
      !choice.capabilities.installation ||
      (server.connection_mode === 'gateway' && !choice.capabilities.gateway) ||
      !sameModpackTarget(target, modpackRuntimeTarget(choice))
    )
      return null;
    await requireMinecraftChoice(db, owner, choice.row.id, env);
    return {
      combinationId: choice.row.id,
      mappingId: choice.mapping.id,
      target: modpackRuntimeTarget(choice),
    };
  };
  for (const mapping of usable) {
    const rows = await db
      .selectFrom('minecraft_combinations')
      .select('id')
      .where('mapping_id', '=', mapping.id)
      .where(sql<string>`combination->>'release'`, '=', target.minecraftVersion)
      .where(sql<string>`combination->>'profile'`, '=', target.loader)
      .where(
        sql<string>`coalesce(combination->>'loaderVersion', '')`,
        '=',
        target.loaderVersion ?? '',
      )
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    for (const row of rows) {
      try {
        const value = await accepted(await requireMinecraftChoice(db, context, row.id, env));
        if (value) return value;
      } catch (error) {
        if (!eligibilityFailure(error)) throw error;
      }
    }
    if (target.loader === 'fabric' && target.loaderVersion) {
      try {
        const value = await accepted(
          await resolveFabricCreationChoice(
            db,
            adapter,
            context,
            {
              choiceId: `fabric:${mapping.id}:${target.minecraftVersion}`,
              loaderVersion: target.loaderVersion,
            },
            env,
          ),
        );
        if (value) return value;
      } catch (error) {
        if (!eligibilityFailure(error)) throw error;
      }
    }
  }
  return null;
}

const transitionSchema = z
  .object({
    version: z.literal(1),
    operationId: z.uuid(),
    serverId: z.uuid(),
    sourceMappingId: z.uuid(),
    sourceCombinationId: z.uuid(),
    target: modpackRuntimeBindingSchema,
    identityDigest: z.string(),
    mappingDigest: z.string(),
    startupDigest: z.string(),
    state: z.enum([
      'planned',
      'startup-dispatched',
      'startup-confirmed',
      'installation-dispatched',
      'installation-confirmed',
      'verified',
    ]),
  })
  .strict();
export type ModpackRuntimeTransition = z.infer<typeof transitionSchema>;
export interface ConfigureModpackRuntimeOptions {
  db: Kysely<Database>;
  adapter: PterodactylAdapter;
  serverId: string;
  operationId: string;
  context: AuthContext;
  binding: MinecraftModpackRuntimeBinding;
  env?: Environment;
  readTransition(): Promise<unknown>;
  saveTransition(value: ModpackRuntimeTransition): Promise<void>;
  /** The host already holds its exclusive lifecycle lock and managed server guard. */
  assertStopped(): Promise<void>;
  authorize(): Promise<void>;
  contentOptions: Pick<MinecraftContentOptions, 'observedImageDigest' | 'env'>;
}

/** Explicit stopped transition. Durable dispatch markers prevent retries from
 * launching the installer twice; uncertain effects require read-only recovery. */
export async function configureModpackRuntime(
  options: ConfigureModpackRuntimeOptions,
): Promise<void> {
  const { db, adapter, serverId, operationId, context, env = {} } = options;
  const binding = modpackRuntimeBindingSchema.parse(options.binding);
  await options.authorize();
  await options.assertStopped();
  let server = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  if (!server.pterodactyl_id || !server.pterodactyl_identifier || !server.pterodactyl_uuid)
    throw new DomainError('provenance_mismatch');
  const choice = await requireMinecraftChoice(db, context, binding.combinationId, env);
  await requireMinecraftChoice(
    db,
    await resourceOwner(db, server.owner_id),
    binding.combinationId,
    env,
  );
  if (
    !choice.capabilities.installation ||
    (server.connection_mode === 'gateway' && !choice.capabilities.gateway) ||
    !declaredTarget(binding.target) ||
    choice.mapping.id !== binding.mappingId ||
    !sameModpackTarget(binding.target, modpackRuntimeTarget(choice))
  )
    throw new DomainError('integration_unavailable');
  const profile = await db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  const [source, allocations, identity] = await Promise.all([
    db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', server.mapping_id)
      .executeTakeFirstOrThrow(),
    db.selectFrom('server_allocations').selectAll().where('server_id', '=', serverId).execute(),
    readManagedIdentity(db, server),
  ]);
  if (!modpackMappingCompatible(server, source, choice.mapping, allocations))
    throw new DomainError('conflict');
  const environment = await minecraftProvisionEnvironment(db, serverId, choice);
  await assertMinecraftEggEnvironment(adapter, choice, environment);
  const mapping = minecraftRuntimeMappingSchema.parse(choice.row.binding);
  const startup = {
    startup: choice.mapping.startup,
    environment,
    egg: choice.mapping.egg_id,
    image: mapping.image,
    skip_scripts: false,
  };
  const identityDigest = modpackDigest({
    id: server.id,
    ownerId: server.owner_id,
    nodeId: server.node_id,
    externalId: server.external_id,
    providerId: server.pterodactyl_id,
    providerUuid: server.pterodactyl_uuid,
    providerIdentifier: server.pterodactyl_identifier,
    providerUserId: server.provider_user_id,
    identity,
  });
  const saved = await options.readTransition();
  let journal = saved
    ? transitionSchema.parse(saved)
    : transitionSchema.parse({
        version: 1,
        operationId,
        serverId,
        sourceMappingId: server.mapping_id,
        sourceCombinationId: profile.combination_id,
        target: binding,
        identityDigest,
        mappingDigest: choice.mappingDigest,
        startupDigest: modpackDigest(startup),
        state: 'planned',
      });
  if (
    journal.operationId !== operationId ||
    journal.serverId !== serverId ||
    journal.identityDigest !== identityDigest ||
    journal.mappingDigest !== choice.mappingDigest ||
    journal.startupDigest !== modpackDigest(startup) ||
    modpackDigest(journal.target) !== modpackDigest(binding) ||
    ![journal.sourceMappingId, binding.mappingId].includes(server.mapping_id) ||
    ![journal.sourceCombinationId, binding.combinationId].includes(profile.combination_id)
  )
    throw new DomainError('provenance_mismatch');
  const save = async (state: ModpackRuntimeTransition['state']) => {
    journal = { ...journal, state };
    await options.saveTransition(journal);
  };
  const remote = async (): Promise<ApplicationServer> => {
    await options.authorize();
    const current = await adapter.getApplicationServer(server.pterodactyl_id as number);
    assertManagedIdentity(server, current, await readManagedIdentity(db, server));
    return current;
  };
  const matchesStartup = (current: ApplicationServer) =>
    current.egg === startup.egg &&
    current.container.image === startup.image &&
    current.container.startup_command === startup.startup &&
    Object.entries(environment).every(
      ([key, value]) => String(current.container.environment?.[key]) === value,
    );
  if (!saved) await save('planned');
  if (journal.state === 'verified') {
    await assertMinecraftRemoteLaunch(db, serverId, await remote(), env, adapter);
    if (
      server.mapping_id !== binding.mappingId ||
      profile.combination_id !== binding.combinationId ||
      !profile.installed
    )
      throw new DomainError('provenance_mismatch');
    return;
  }
  if (journal.state === 'planned') {
    await reserveInstallation(db, serverId, operationId, env);
    await remote();
    await options.assertStopped();
    await save('startup-dispatched');
    await options.authorize();
    const changed = await adapter.updateStartup(server.pterodactyl_id, startup);
    assertManagedIdentity(server, changed, identity);
    if (!matchesStartup(changed)) throw new DomainError('operation_uncertain');
    await save('startup-confirmed');
  } else if (journal.state === 'startup-dispatched') {
    if (!matchesStartup(await remote())) throw new DomainError('operation_uncertain');
    await save('startup-confirmed');
  }
  if (journal.state === 'startup-confirmed') {
    await reserveInstallation(db, serverId, operationId, env);
    await options.assertStopped();
    await options.authorize();
    await db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const currentProfile = await tx
        .selectFrom('minecraft_server_profiles')
        .selectAll()
        .where('server_id', '=', serverId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        current.owner_id !== server.owner_id ||
        current.node_id !== server.node_id ||
        ![journal.sourceMappingId, binding.mappingId].includes(current.mapping_id) ||
        ![journal.sourceCombinationId, binding.combinationId].includes(
          currentProfile.combination_id,
        )
      )
        throw new DomainError('provenance_mismatch');
      await tx
        .updateTable('managed_servers')
        .set({
          mapping_id: binding.mappingId,
          installation_state: 'installing',
          readiness: 'unknown',
          updated_at: new Date(),
        })
        .where('id', '=', serverId)
        .execute();
      await tx
        .updateTable('minecraft_server_profiles')
        .set({
          combination_id: binding.combinationId,
          installed: false,
          runtime_image_digest: null,
          runtime_image_transition: 'null',
          updated_at: new Date(),
        })
        .where('server_id', '=', serverId)
        .execute();
    });
    server = { ...server, mapping_id: binding.mappingId };
    await options.assertStopped();
    const proof = await remote();
    if (!matchesStartup(proof)) throw new DomainError('provenance_mismatch');
    await save('installation-dispatched');
    const outcome = await adapter.reinstallWithConfirmation(
      server.pterodactyl_id as number,
      server.pterodactyl_identifier as string,
      {
        verifiedServer: proof,
        serverUUID: server.pterodactyl_uuid as string,
        authorize: async () => {
          try {
            await remote();
            return true;
          } catch {
            return false;
          }
        },
        onConfirmed: async () => {
          await remote();
          await save('installation-confirmed');
          await db
            .deleteFrom('installation_reservations')
            .where('server_id', '=', serverId)
            .where('operation_id', '=', operationId)
            .execute();
        },
      },
    );
    if (
      !outcome.confirmed ||
      (journal as ModpackRuntimeTransition).state !== 'installation-confirmed'
    )
      throw new DomainError('operation_uncertain');
  } else if (journal.state === 'installation-dispatched')
    throw new DomainError('operation_uncertain');
  if (journal.state !== 'installation-confirmed') throw new DomainError('operation_uncertain');
  await options.assertStopped();
  await attestMinecraftRuntimeInstallation(
    { db, adapter, server, authorize: options.authorize, assertStopped: options.assertStopped },
    { ...options.contentOptions, env },
  );
  await options.authorize();
  await db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await tx
      .updateTable('managed_servers')
      .set({ installation_state: 'installed', updated_at: new Date() })
      .where('id', '=', serverId)
      .where('mapping_id', '=', binding.mappingId)
      .where('owner_id', '=', server.owner_id)
      .returning(['intent', 'connection_mode'])
      .executeTakeFirst();
    if (!current) throw new DomainError('provenance_mismatch');
    await tx
      .updateTable('minecraft_server_profiles')
      .set({
        runtime_image_transition: JSON.stringify({
          operationId,
          combinationId: binding.combinationId,
          after: new Date().toISOString(),
        }),
      })
      .where('server_id', '=', serverId)
      .where('combination_id', '=', binding.combinationId)
      .execute();
    if (current.connection_mode === 'gateway') {
      // Preserve Owner policy and all public endpoints. Old readiness and wake
      // receipts describe the former runtime and cannot authorize this one.
      await tx
        .updateTable('gateway_server_states')
        .set({
          generation: randomUUID(),
          game_version: binding.target.minecraftVersion,
          state:
            current.intent === 'maintenance'
              ? 'maintenance'
              : current.intent === 'manually_stopped'
                ? 'manually_stopped'
                : 'blocked',
          wake_job_id: null,
          sleep_job_id: null,
          process_started_at: null,
          readiness_observed_at: null,
          startup_deadline_at: null,
          idle_since: null,
          last_observed_at: null,
          last_activity_at: null,
          blocked_until: null,
          error_code: null,
          updated_at: new Date(),
        })
        .where('server_id', '=', serverId)
        .execute();
      await notifyGatewayChange(tx);
    }
  });
  await save('verified');
}
