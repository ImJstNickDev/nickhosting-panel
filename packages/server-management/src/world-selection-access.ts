import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { PrivateTransferCache } from '@nickhosting/pterodactyl-adapter';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import { directoryServerIdentity } from './directory-identity.js';

type Server = Selectable<Database['managed_servers']>;
const ttlMs = 15 * 60_000;
const proof = z.object({ revision: z.string(), observedAt: z.number().finite() }).strict();

/** An opening-time observation, not a continuous physical-stop guarantee.
 * The locked mutation still checks current local state, authority and reservations. */
export function createWorldSelectionAccess(cache: PrivateTransferCache, providerBinding: string) {
  const key = (server: Server) =>
    `minecraft.world-selection-access.v1:${createHash('sha256')
      .update(JSON.stringify([providerBinding, directoryServerIdentity(server), server.mapping_id]))
      .digest('hex')}`;
  async function revision(db: Kysely<Database>, server: Server, opening = false) {
    const current = await db
      .selectFrom('managed_servers as server')
      .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
      .innerJoin('physical_hosts as host', 'host.id', 'node.physical_host_id')
      .selectAll('server')
      .select(['host.id as host_id', 'host.observer_id'])
      .select((eb) =>
        eb
          .selectFrom('server_operations as operation')
          .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
          .select('job.id')
          .whereRef('operation.server_id', '=', 'server.id')
          .where('operation.action', 'in', [
            'provision',
            'start',
            'stop',
            'restart',
            'reinstall',
            'wipe',
            'restore',
            'backup',
            'configure',
            'delete',
          ])
          .orderBy('job.created_at', 'desc')
          .orderBy('job.id', 'desc')
          .limit(1)
          .as('latest_power_id'),
      )
      .where('server.id', '=', server.id)
      .executeTakeFirstOrThrow();
    if (
      (opening && current.active_operation_id !== null) ||
      current.deleted_at ||
      current.runtime_state !== 'offline' ||
      directoryServerIdentity(current) !== directoryServerIdentity(server) ||
      current.mapping_id !== server.mapping_id
    )
      throw new DomainError('conflict');
    return JSON.stringify([current.host_id, current.observer_id, current.latest_power_id ?? null]);
  }
  return {
    async prepare(db: Kysely<Database>, server: Server, observe: () => Promise<boolean>) {
      const storageKey = key(server);
      try {
        await cache.delete(storageKey);
        const before = await revision(db, server, true);
        if (!(await observe()) || (await revision(db, server, true)) !== before) return;
        await cache.put(
          storageKey,
          JSON.stringify({ revision: before, observedAt: Date.now() }),
          ttlMs,
        );
      } catch {
        // Browsing remains available even when selection cannot be prepared.
      }
    },
    async assert(db: Kysely<Database>, server: Server) {
      try {
        const raw = await cache.get(key(server));
        const stored = proof.parse(JSON.parse(raw ?? 'null'));
        const age = Date.now() - stored.observedAt;
        if (age < 0 || age >= ttlMs || stored.revision !== (await revision(db, server)))
          throw new DomainError('conflict');
      } catch {
        // Reopen/refresh Worlds to observe again; do not put Docker back on Select.
        throw new DomainError('conflict');
      }
    },
  };
}
