import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, getSettings } from '@nickhosting/database';
import {
  createRuntimeMetadataClient,
  type FabricCatalogResponse,
  fetchMinecraftProtocols,
  minecraftManifestUrl,
  minecraftRuntimeRequestSchema,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import type { Environment } from './admission.js';
import { getFabricCatalog } from './fabric-catalog.js';
import { currentInteractiveContext } from './interactive-context.js';
import { cachedMinecraftManifest } from './minecraft-metadata.js';
import { minecraftMappingDigest, registerMinecraftCombination } from './minecraft-registry.js';
import { ownerOnly, parse } from './registry.js';

const registrationSchema = z
  .object({
    mappingId: z.uuid(),
    release: minecraftRuntimeRequestSchema.shape.release,
    loaderVersion: minecraftRuntimeRequestSchema.shape.loaderVersion.unwrap(),
  })
  .strict();
type RegistrationOptions = {
  metadata?: RuntimeMetadataClient;
  protocols?: typeof fetchMinecraftProtocols;
};
function requireCatalog(catalog: FabricCatalogResponse) {
  if (!catalog.synced || !catalog.relations || !catalog.latestInstallerVersion)
    throw new DomainError('integration_unavailable', 503, { reason: 'fabric_catalog_unavailable' });
  return {
    ...catalog,
    relations: catalog.relations,
    latestInstallerVersion: catalog.latestInstallerVersion,
  };
}

/** Discovery chooses the pair; the existing registry owns immutable runtime resolution.
 * Installer "latest" is frozen to the last complete catalog at request time. */
export async function registerFabricCatalogCombination(
  db: Kysely<Database>,
  adapter: PterodactylAdapter | (() => Promise<PterodactylAdapter>),
  context: AuthContext,
  input: unknown,
  env: Environment = {},
  options: RegistrationOptions = {},
) {
  ownerOnly(context);
  const value = parse(registrationSchema, input);
  const catalog = requireCatalog(await getFabricCatalog(db));
  return registerFromCatalog(db, adapter, context, value, catalog, env, options);
}

/** A single accepted snapshot defines all choices in this request, including a
 * bounded scan. Publication during resolution only affects later requests. */
async function registerFromCatalog(
  db: Kysely<Database>,
  adapter: PterodactylAdapter | (() => Promise<PterodactylAdapter>),
  context: AuthContext,
  value: z.infer<typeof registrationSchema>,
  catalog: ReturnType<typeof requireCatalog>,
  env: Environment,
  options: RegistrationOptions,
) {
  const setIndex = catalog.relations.gameLoaderSets[value.release];
  if (
    setIndex === undefined ||
    !catalog.relations.loaderSets[setIndex]?.includes(value.loaderVersion)
  )
    throw new DomainError('validation_failed', 400, { reason: 'fabric_pair_unavailable' });
  const installerVersion = catalog.latestInstallerVersion;
  const existing = await db.transaction().execute(async (tx) => {
    ownerOnly(await currentInteractiveContext(tx, context, env));
    const mapping = await tx
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', value.mappingId)
      .executeTakeFirst();
    if (!mapping?.enabled || mapping.game_id !== 'minecraft' || mapping.runtime_id !== 'fabric')
      throw new DomainError('configuration_invalid', 400, { reason: 'fabric_catalog_mapping' });
    // Explicit Owner disablement is retained; re-registering does not re-enable a choice.
    return tx
      .selectFrom('minecraft_combinations')
      .select('id')
      .where('mapping_id', '=', mapping.id)
      .where('mapping_digest', '=', minecraftMappingDigest(mapping))
      .where(sql<string>`combination->>'profile'`, '=', 'fabric')
      .where(sql<string>`combination->>'release'`, '=', value.release)
      .where(sql<string>`combination->>'loaderVersion'`, '=', value.loaderVersion)
      .where(sql<string>`combination->>'installerVersion'`, '=', installerVersion)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  });
  if (existing) return existing;
  const { values } = await getSettings(db, env);
  const upstream =
    options.metadata ??
    createRuntimeMetadataClient({ userAgent: values.contentMetadataUserAgent ?? '' });
  const metadata: RuntimeMetadataClient = {
    read: (url) =>
      !options.metadata && url === minecraftManifestUrl
        ? cachedMinecraftManifest(db)
        : upstream.read(url),
  };
  return registerMinecraftCombination(
    db,
    typeof adapter === 'function' ? await adapter() : adapter,
    context,
    {
      mappingId: value.mappingId,
      runtime: {
        profile: 'fabric',
        release: value.release,
        loaderVersion: value.loaderVersion,
        installerVersion,
      },
    },
    env,
    { metadata, ...(options.protocols ? { protocols: options.protocols } : {}) },
  );
}

/** Explicit Owner scan: one recommended associated Loader per game, never a
 * Cartesian product. Alternative pairs use the same single-registration path. */
export async function syncFabricRegisteredCatalog(
  db: Kysely<Database>,
  adapter: PterodactylAdapter | (() => Promise<PterodactylAdapter>),
  context: AuthContext,
  input: unknown,
  env: Environment = {},
  options: RegistrationOptions = {},
) {
  ownerOnly(context);
  const value = parse(
    z
      .object({
        mappingId: z.uuid(),
        all: z.boolean().default(false),
        cursor: z.number().int().min(0).max(2000).default(0),
        limit: z.number().int().min(1).max(20).default(5),
      })
      .strict(),
    input,
  );
  ownerOnly(await currentInteractiveContext(db, context, env));
  const [snapshot, mapping] = await Promise.all([
    getFabricCatalog(db),
    db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', value.mappingId)
      .executeTakeFirst(),
  ]);
  const catalog = requireCatalog(snapshot);
  if (!mapping?.enabled || mapping.game_id !== 'minecraft' || mapping.runtime_id !== 'fabric')
    throw new DomainError('configuration_invalid', 400, { reason: 'fabric_catalog_mapping' });
  const games = catalog.games.filter((game) => value.all || game.stable);
  const stableLoaders = new Set(
    catalog.loaders.filter((loader) => loader.stable).map((loader) => loader.version),
  );
  const { values } = await getSettings(db, env);
  const upstream =
    options.metadata ??
    createRuntimeMetadataClient({ userAgent: values.contentMetadataUserAgent ?? '' });
  const reads = new Map<string, ReturnType<RuntimeMetadataClient['read']>>();
  const metadata: RuntimeMetadataClient = {
    read(url) {
      let read = reads.get(url);
      if (!read) {
        read =
          !options.metadata && url === minecraftManifestUrl
            ? cachedMinecraftManifest(db)
            : upstream.read(url);
        reads.set(url, read);
      }
      return read;
    },
  };
  let protocolResult: ReturnType<typeof fetchMinecraftProtocols> | undefined;
  const protocols: typeof fetchMinecraftProtocols = (source) => {
    protocolResult ??= (options.protocols ?? fetchMinecraftProtocols)(source);
    return protocolResult;
  };
  let provider: Promise<PterodactylAdapter> | undefined;
  const getAdapter = () =>
    (provider ??= Promise.resolve(typeof adapter === 'function' ? adapter() : adapter).then(
      (original) => {
        const cached = Object.create(original) as PterodactylAdapter;
        const eggs = new Map<string, ReturnType<PterodactylAdapter['getEgg']>>();
        cached.getEgg = (nest, egg) => {
          const key = `${nest}:${egg}`;
          let result = eggs.get(key);
          if (!result) {
            result = original.getEgg(nest, egg);
            eggs.set(key, result);
          }
          return result;
        };
        return cached;
      },
    ));
  const items: {
    version: string;
    releaseType: string;
    status: 'registered' | 'unavailable';
    id?: string;
    reason?: string;
  }[] = [];
  for (const game of games.slice(value.cursor, value.cursor + value.limit)) {
    const loaders =
      catalog.relations.loaderSets[catalog.relations.gameLoaderSets[game.version] ?? -1] ?? [];
    const loaderVersion = loaders.find((version) => stableLoaders.has(version)) ?? loaders[0];
    const base = { version: game.version, releaseType: game.stable ? 'release' : 'snapshot' };
    if (!loaderVersion) {
      items.push({ ...base, status: 'unavailable', reason: 'fabric_pair_unavailable' });
      continue;
    }
    try {
      const registered = await registerFromCatalog(
        db,
        getAdapter,
        context,
        parse(registrationSchema, { mappingId: mapping.id, release: game.version, loaderVersion }),
        catalog,
        env,
        { metadata, protocols },
      );
      items.push({ ...base, status: 'registered', id: registered.id });
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        !['integration_unavailable', 'configuration_invalid', 'validation_failed'].includes(
          error.code,
        )
      )
        throw error;
      items.push({
        ...base,
        status: 'unavailable',
        reason: typeof error.details?.reason === 'string' ? error.details.reason : error.code,
      });
    }
  }
  const next = value.cursor + value.limit;
  return { items, nextCursor: next < games.length ? next : null, total: games.length };
}
