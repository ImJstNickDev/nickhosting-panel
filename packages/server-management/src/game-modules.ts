import { type AuthContext, DomainError } from '@nickhosting/core';
import type { Database, gameCatalog } from '@nickhosting/database';
import { type GameManifest, gameManifestSchema } from '@nickhosting/game-sdk';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely, Selectable } from 'kysely';
import type { DB, Environment } from './admission.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { minecraftModule } from './minecraft-module.js';

export type ManagedGameServer = Selectable<Database['managed_servers']>;
export type GameMapping = Selectable<Database['runtime_egg_mappings']>;
export type GameCatalogEntry = Awaited<ReturnType<typeof gameCatalog>>[number];
export interface GameOperationAuthorization {
  db: Kysely<Database>;
  server: ManagedGameServer;
  mapping: GameMapping;
  operation: Selectable<Database['server_operations']>;
  context: AuthContext;
  resourceOwner: { id: string; role: 'owner' | 'operator' | 'user' };
  env: Environment;
  adapter?: PterodactylAdapter;
}
/** Executable policy belongs to compiled first-party code, never stored manifests
 * or Owner capability flags. Stored game metadata can select, not create, hooks. */
export interface TrustedGameModule {
  id: string;
  manifest: GameManifest;
  provisionAsResourceOwner: boolean;
  /** Read-only binding for initial automation configuration; compiled modules only. */
  gatewayPolicyBinding?(
    db: DB,
    server: ManagedGameServer,
    env: Environment,
  ): Promise<{ protocolId: string; gameVersion: string } | null>;
  /** Parse a previously validated immutable combination binding; never resolve
   * current policy again for a queued operation or an existing server. */
  resolveProvisionImage?(mapping: GameMapping, binding: unknown): string;
  assertProfileBinding(
    db: Kysely<Database>,
    server: ManagedGameServer,
    mapping: GameMapping,
  ): Promise<void>;
  authorizeOperation(input: GameOperationAuthorization): Promise<void>;
  filterCatalog(
    db: Kysely<Database>,
    context: AuthContext,
    entry: GameCatalogEntry,
    env: Environment,
  ): Promise<GameCatalogEntry>;
}
export interface GameRuntimeHooks {
  configureProvision(context: GameLifecycleContext): Promise<boolean>;
  verifyInitialInstallation?(
    context: GameLifecycleContext,
  ): Promise<import('./lifecycle.js').InitialInstallationOutputs | null>;
  processContent(context: GameLifecycleContext): Promise<boolean>;
  verifyRestore(context: GameLifecycleContext): Promise<boolean>;
  assertRuntimeImage(
    serverId: string,
    connection: Kysely<Database>,
    requireObserved: boolean,
  ): Promise<unknown>;
  assertLaunchFiles(serverId: string, connection: Kysely<Database>): Promise<void>;
  assertFileMutation(
    serverId: string,
    paths: readonly string[],
    connection: Kysely<Database>,
  ): Promise<void>;
  invalidateLaunchEpoch(serverId: string): void;
  verifyProcessEpoch(
    serverId: string,
    connection: Kysely<Database>,
    before: string | null,
    readAgain: () => Promise<string | null>,
  ): Promise<string | null>;
}
/** Composition API for compiled modules and isolated fixtures. No HTTP/config
 * handler accepts this type and no dynamic import is derived from database data. */
export function createGameModuleRegistry(modules: readonly TrustedGameModule[]) {
  const definitions = new Map<string, TrustedGameModule>();
  for (const definition of modules) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(definition.id) ||
      definitions.has(definition.id) ||
      definition.manifest.id !== definition.id
    )
      throw new DomainError('configuration_invalid');
    definitions.set(
      definition.id,
      Object.freeze({ ...definition, manifest: gameManifestSchema.parse(definition.manifest) }),
    );
  }
  return Object.freeze({
    list() {
      return [...definitions.values()];
    },
    get(id: string) {
      return definitions.get(id);
    },
    async resolve(db: Kysely<Database>, serverId: string) {
      const server = await db
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!server) throw new DomainError('not_found');
      const mapping = await db
        .selectFrom('runtime_egg_mappings')
        .selectAll()
        .where('id', '=', server.mapping_id)
        .executeTakeFirstOrThrow();
      // A profile retained under a changed game identity cannot evade its fences
      // by dispatching to a different (or unregistered) game module.
      for (const module of definitions.values())
        await module.assertProfileBinding(db, server, mapping);
      return { server, mapping, module: definitions.get(mapping.game_id) };
    },
    async catalog(
      db: Kysely<Database>,
      context: AuthContext,
      entries: readonly GameCatalogEntry[],
      env: Environment = {},
    ) {
      return Promise.all(
        entries.map(
          (entry) => definitions.get(entry.id)?.filterCatalog(db, context, entry, env) ?? entry,
        ),
      );
    },
  });
}
export const trustedGameModules = createGameModuleRegistry([minecraftModule]);

/** A registry-bound dispatcher protects all content/lifecycle entry points.
 * Unknown generic games retain M2 lifecycle support but cannot acquire content
 * execution just by declaring a capability. */
export function createGameRuntimeDispatcher(
  registry: ReturnType<typeof createGameModuleRegistry>,
  runtimes: ReadonlyMap<string, GameRuntimeHooks>,
) {
  const bound = new Map(runtimes);
  for (const id of bound.keys())
    if (!registry.get(id)) throw new DomainError('configuration_invalid');
  return async (db: Kysely<Database>, serverId: string) => {
    const selected = await registry.resolve(db, serverId);
    if (!selected.module) return undefined;
    const runtime = bound.get(selected.module.id);
    if (!runtime) throw new DomainError('integration_unavailable');
    return runtime;
  };
}
