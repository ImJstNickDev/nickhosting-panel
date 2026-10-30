import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { type PterodactylAdapter, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import type { Kysely, Selectable } from 'kysely';

const capabilities = new WeakMap<
  PterodactylAdapter,
  Map<string, { expires: number; value: Promise<boolean> }>
>();
/** Capability cache only. Each actual bridge operation authenticates and validates
 * the live managed identity again; this cache grants no file authority. */
export function supportsProviderFileOperations(adapter: PterodactylAdapter, identifier: string) {
  if (typeof adapter.getFileOperationCapabilities !== 'function') return Promise.resolve(false);
  let entries = capabilities.get(adapter);
  if (!entries) {
    entries = new Map();
    capabilities.set(adapter, entries);
  }
  const old = entries.get(identifier);
  if (old && old.expires > Date.now()) return old.value;
  const value = adapter
    .getFileOperationCapabilities(identifier)
    .then(() => true)
    .catch((error) => {
      if (error instanceof PterodactylError && [404, 405].includes(error.upstreamStatus ?? 0))
        return false;
      entries?.delete(identifier);
      throw error;
    });
  if (entries.size >= 1000) entries.delete(entries.keys().next().value as string);
  entries.set(identifier, { expires: Date.now() + 60_000, value });
  return value;
}

export async function providerFileIdentity(
  db: Kysely<Database>,
  server: Selectable<Database['managed_servers']>,
) {
  const node = await db
    .selectFrom('managed_nodes')
    .select('pterodactyl_node_id')
    .where('id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  if (!server.pterodactyl_id || !server.pterodactyl_uuid || !server.pterodactyl_identifier)
    throw new DomainError('conflict');
  return {
    providerId: server.pterodactyl_id,
    providerUuid: server.pterodactyl_uuid,
    identifier: server.pterodactyl_identifier,
    externalId: server.external_id,
    nodeId: node.pterodactyl_node_id,
  };
}
