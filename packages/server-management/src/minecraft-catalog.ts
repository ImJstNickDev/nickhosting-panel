import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, getSettings } from '@nickhosting/database';
import {
  createRuntimeMetadataClient,
  fetchMinecraftProtocols,
  minecraftManifestUrl,
  minecraftReleaseCatalog,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Environment } from './admission.js';
import { cachedMinecraftManifest } from './minecraft-metadata.js';
import { registerMinecraftCombination, setMinecraftAvailability } from './minecraft-registry.js';
import { ownerOnly, parse } from './registry.js';

/** Explicit Owner discovery only. Batch size bounds provider/upstream work; repeat pages
 * are idempotent. No remote mutation or certification is performed. Compiled Vanilla installation
 * declarations enable newly discovered choices under the Owner-enabled mapping;
 * repeated discovery preserves any subsequent explicit Owner disablement. */
export async function syncMinecraftCatalog(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  context: AuthContext,
  input: unknown,
  env: Environment = {},
  options: { metadata?: RuntimeMetadataClient; protocols?: typeof fetchMinecraftProtocols } = {},
) {
  ownerOnly(context);
  const value = parse(
    z
      .object({
        mappingId: z.uuid(),
        all: z.boolean().default(false),
        enableSupported: z.boolean().default(false),
        cursor: z.number().int().min(0).max(20000).default(0),
        limit: z.number().int().min(1).max(20).default(10),
      })
      .strict(),
    input,
  );
  const mapping = await db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', value.mappingId)
    .executeTakeFirst();
  if (mapping?.game_id !== 'minecraft-java' || mapping.runtime_id !== 'vanilla' || !mapping.enabled)
    throw new DomainError('configuration_invalid', 400, { reason: 'minecraft_catalog_mapping' });
  const { values } = await getSettings(db, env);
  const underlying =
    options.metadata ??
    createRuntimeMetadataClient({ userAgent: values.minecraftMetadataUserAgent ?? '' });
  const reads = new Map<string, ReturnType<RuntimeMetadataClient['read']>>();
  const metadata: RuntimeMetadataClient = {
    read(url) {
      let result = reads.get(url);
      if (!result) {
        result =
          !options.metadata && url === minecraftManifestUrl
            ? cachedMinecraftManifest(db)
            : underlying.read(url);
        reads.set(url, result);
      }
      return result;
    },
  };
  const releases = await minecraftReleaseCatalog(metadata, value.all);
  let protocolResult: ReturnType<typeof fetchMinecraftProtocols> | undefined;
  const protocols: typeof fetchMinecraftProtocols = (source) => {
    protocolResult ??= (options.protocols ?? fetchMinecraftProtocols)(source);
    return protocolResult;
  };
  const items: {
    version: string;
    releaseType: string;
    status: 'registered' | 'unavailable';
    id?: string;
    reason?: string;
  }[] = [];
  for (const release of releases.slice(value.cursor, value.cursor + value.limit)) {
    try {
      const registered = await registerMinecraftCombination(
        db,
        adapter,
        context,
        {
          mappingId: mapping.id,
          runtime: { profile: 'vanilla', release: release.id },
        },
        env,
        { metadata, protocols },
      );
      if (value.enableSupported) {
        const current = await db
          .selectFrom('minecraft_combinations')
          .select('enabled')
          .where('id', '=', registered.id)
          .executeTakeFirstOrThrow();
        if (!current.enabled)
          await setMinecraftAvailability(db, context, registered.id, { enabled: true }, env);
      }
      items.push({
        version: release.id,
        releaseType: release.type,
        status: 'registered',
        id: registered.id,
      });
    } catch (error) {
      // Revocation, database errors and unexpected exceptions must stop the batch.
      if (
        !(error instanceof DomainError) ||
        !['integration_unavailable', 'configuration_invalid', 'validation_failed'].includes(
          error.code,
        )
      )
        throw error;
      const reason = typeof error.details?.reason === 'string' ? error.details.reason : error.code;
      items.push({ version: release.id, releaseType: release.type, status: 'unavailable', reason });
    }
  }
  const next = value.cursor + value.limit;
  return { items, nextCursor: next < releases.length ? next : null, total: releases.length };
}
