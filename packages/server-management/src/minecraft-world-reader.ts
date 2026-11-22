import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import {
  type DirectoryBatchResult,
  type PterodactylAdapter,
  PterodactylError,
  type WorldScanGuard,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
import type { FilemanReadService } from '../../game-sdk/src/fileman-read.js';
import { canonicalAllocationAddress } from './allocation-pool.js';
import { filemanEntry } from './fileman-read.js';
import { readManagedIdentity } from './managed-identity.js';

export type MinecraftWorldReader = Pick<
  FilemanReadService,
  'list' | 'listMany' | 'read' | 'prepare'
>;
type Server = Selectable<Database['managed_servers']> & { egg_id: number; nest_id: number };

/** The worker consumes an existing authenticated observation. Neither a missing
 * capability nor an older extension causes an Application discovery per job. */
export async function readWorldScanPrincipal(db: Kysely<Database>, binding: string) {
  const { rows } = await sql<{
    principal: string;
  }>`select extension->>'worldReadPrincipal' as principal
    from blueprint_capability_discovery where singleton and binding=${binding}
    and checked_at > now() - interval '60 seconds' and checked_at <= now()
    and extension->>'worldReadPrincipal' ~ '^[0-9a-f]{64}$'`.execute(db);
  return rows[0]?.principal;
}

/** Every directory is read with the same native identity precondition. Root listing and
 * the private, one-use server.properties grant come from one guarded Client request. */
export async function openScheduledWorldReader(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  server: Server,
  principal: string,
  signal: AbortSignal,
  batch: (
    directories: string[],
    read: (paths: string[]) => Promise<DirectoryBatchResult[]>,
  ) => Promise<DirectoryBatchResult[]>,
): Promise<MinecraftWorldReader | undefined> {
  const identifier = server.pterodactyl_identifier;
  const { readWorldDirectories, prepareWorldFiles } = adapter;
  if (!readWorldDirectories || !prepareWorldFiles) return;
  const [identity, owner] = await Promise.all([
    readManagedIdentity(db, server),
    db
      .selectFrom('provider_accounts')
      .select(['instance_id', 'provider_id', 'provider_uuid', 'external_id', 'key_identifier'])
      .where('user_id', '=', server.owner_id)
      .where('status', '=', 'ready')
      .executeTakeFirst(),
  ]);
  const primary = identity.allocations.find((a) => a.is_primary);
  if (
    !identifier ||
    !server.pterodactyl_id ||
    !server.pterodactyl_uuid ||
    !primary ||
    identity.allocations.some(
      ({ address }) => !address || canonicalAllocationAddress(address) !== address,
    ) ||
    !owner?.instance_id ||
    !owner.provider_uuid ||
    !owner.external_id ||
    !owner.key_identifier ||
    !owner.provider_id ||
    owner.provider_id !== server.provider_user_id
  )
    throw new DomainError('provenance_mismatch');
  // Earlier installations may explicitly link an existing provider user. Such an
  // identity cannot be a NickPanel-provisioned technical user.
  if (owner.external_id !== `nh:${owner.instance_id}:${server.owner_id}`.toLowerCase()) return;
  const guard: WorldScanGuard = {
    principal,
    clientKeyIdentifier: owner.key_identifier,
    instanceId: owner.instance_id,
    nickUserId: server.owner_id,
    ownerUuid: owner.provider_uuid,
    ownerExternalId: owner.external_id,
    server: {
      providerId: server.pterodactyl_id,
      providerUuid: server.pterodactyl_uuid,
      identifier,
      externalId: server.external_id,
      nodeId: identity.pterodactyl_node_id,
    },
    placement: [
      owner.provider_id,
      server.nest_id,
      server.egg_id,
      primary.pterodactyl_allocation_id,
    ],
    allocations: identity.allocations.map((a) => [a.pterodactyl_allocation_id, a.address, a.port]),
  };
  // Leave room for the directory chunk within Blueprint's 512 KiB JSON limit.
  if (Buffer.byteLength(JSON.stringify(guard)) > 256 * 1024) return;
  signal.throwIfAborted();
  let first: Awaited<ReturnType<typeof readWorldDirectories>>;
  try {
    first = await readWorldDirectories(identifier, [''], guard);
  } catch (error) {
    if (error instanceof PterodactylError && [404, 405, 412].includes(error.upstreamStatus ?? 0))
      return;
    throw error;
  }
  const root = first.results[0];
  if (root?.directory !== '') throw new DomainError('integration_unavailable');
  if ('error' in root) {
    if (root.error === 'forbidden') throw new DomainError('forbidden');
    throw new DomainError('integration_unavailable');
  }
  const rootFiles = root.files.map(filemanEntry);
  const properties = first.properties;
  const grants = new Map<string, (maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>>();
  return {
    async list(directory) {
      signal.throwIfAborted();
      if (directory !== '') throw new DomainError('validation_failed');
      return rootFiles;
    },
    async listMany(directories) {
      const results = await batch([...directories], async (paths) => {
        signal.throwIfAborted();
        return (await readWorldDirectories(identifier, paths, guard)).results;
      });
      return results.map((result) =>
        'files' in result ? { ...result, files: result.files.map(filemanEntry) } : result,
      );
    },
    async prepare(paths) {
      signal.throwIfAborted();
      const reads = await prepareWorldFiles(identifier, [...paths], guard);
      for (const [i, path] of paths.entries()) {
        const read = reads[i];
        if (!read) throw new DomainError('integration_unavailable');
        grants.set(path, read);
      }
    },
    async read({ path, maxBytes }) {
      signal.throwIfAborted();
      if (path === 'server.properties') return properties;
      const read = grants.get(path);
      if (!read) throw new DomainError('integration_unavailable');
      grants.delete(path);
      return read(maxBytes, signal);
    },
  };
}
