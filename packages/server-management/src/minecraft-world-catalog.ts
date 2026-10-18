import { createHash } from 'node:crypto';
import {
  type ContentHttp,
  CurseForgeProvider,
  SafeContentHttp,
} from '@nickhosting/content-providers';
import {
  type AuthContext,
  contentPolicyValues,
  DomainError,
  type SecretCodec,
} from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import type { Kysely } from 'kysely';
import type { Environment } from './admission.js';
import { authorizeMinecraftWorldCatalog } from './minecraft-sources.js';
import {
  minecraftWorldFilesSchema,
  minecraftWorldProjectId,
  minecraftWorldSearchSchema,
} from './minecraft-world-catalog-contracts.js';
import { parse } from './registry.js';

type Providers = { http: ContentHttp; curseforge?: CurseForgeProvider };
const providers = new WeakMap<
  Kysely<Database>,
  { fingerprint: string; override?: ContentHttp; value: Providers }
>();

/** Share provider instances across requests and the existing content pipeline.
 * Effective settings and write-only credentials are checked before using a cached
 * instance, so changing either immediately drops its private metadata cache.
 */
export async function minecraftContentProviders(
  db: Kysely<Database>,
  codec: SecretCodec,
  env: Environment = {},
  override?: ContentHttp,
) {
  const curseforgeEnabled =
    env.NH_DEPLOYMENT_ENV !== 'development' || env.NH_DEV_CURSEFORGE_ENABLED === 'true';
  const [{ values }, key] = await Promise.all([
    getSettings(db, env),
    curseforgeEnabled ? getSecret(db, codec, 'curseforgeApiKey', env) : undefined,
  ]);
  if (!values.contentMetadataUserAgent && !override) {
    providers.delete(db);
    return { values, providers: undefined };
  }
  const origins = [
    'https://api.modrinth.com',
    'https://api.curseforge.com',
    ...contentPolicyValues(values, 'minecraft').downloadOrigins,
  ];
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([values.contentMetadataUserAgent, origins, curseforgeEnabled, key]))
    .digest('hex');
  let cached = providers.get(db);
  if (cached?.fingerprint !== fingerprint || cached.override !== override) {
    const http =
      override ??
      new SafeContentHttp({
        userAgent: values.contentMetadataUserAgent as string,
        allowedOrigins: origins,
      });
    cached = {
      fingerprint,
      override,
      value: { http, curseforge: key ? new CurseForgeProvider(http, { apiKey: key }) : undefined },
    };
    providers.set(db, cached);
  }
  return { values, providers: cached.value };
}

// Short, bounded metadata reuse is shared across viewers; archive acquisition
// separately rechecks the selected file and its distribution permission.
const metadata = new WeakMap<
  CurseForgeProvider,
  Map<string, { until: number; value: Promise<unknown> }>
>();
const metadataTtlMs = 60_000;
const metadataEntries = 128;
function cachedMetadata<T>(provider: CurseForgeProvider, key: string, load: () => Promise<T>) {
  let cache = metadata.get(provider);
  if (!cache) {
    cache = new Map();
    metadata.set(provider, cache);
  }
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.until > now) return existing.value as Promise<T>;
  for (const [entry, value] of cache) if (value.until <= now) cache.delete(entry);
  while (cache.size >= metadataEntries) cache.delete(cache.keys().next().value as string);
  const owned = cache;
  // A browser cancel must not cancel another viewer's coalesced metadata read.
  const value = load().catch((error: unknown) => {
    if (owned.get(key)?.value === value) owned.delete(key);
    throw error;
  });
  cache.set(key, { until: now + metadataTtlMs, value });
  return value;
}

export function createMinecraftWorldCatalog(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  options: { codec: SecretCodec; env?: Environment; http?: ContentHttp },
) {
  async function configured() {
    await authorizeMinecraftWorldCatalog(db, context, serverId);
    return (await minecraftContentProviders(db, options.codec, options.env, options.http))
      .providers;
  }
  async function required() {
    const provider = (await configured())?.curseforge;
    if (!provider) throw new DomainError('integration_unavailable');
    return provider;
  }
  return {
    async availability() {
      return {
        providers: [
          { id: 'curseforge' as const, available: Boolean((await configured())?.curseforge) },
        ],
      };
    },
    async search(input: unknown) {
      const query = parse(minecraftWorldSearchSchema, input);
      const provider = await required();
      return cachedMetadata(provider, JSON.stringify(['search', query]), () =>
        provider.searchWorlds(query.query, query.offset, query.gameVersion),
      );
    },
    async files(project: string, input: unknown) {
      const projectId = parse(minecraftWorldProjectId, project);
      const query = parse(minecraftWorldFilesSchema, input);
      const provider = await required();
      return cachedMetadata(provider, JSON.stringify(['files', projectId, query.offset]), () =>
        provider.worldFiles(projectId, query.offset),
      );
    },
  };
}
