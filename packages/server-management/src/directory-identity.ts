import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { ApplicationServer } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
import { verifyManagedIdentity } from './lifecycle.js';

type Server = Selectable<Database['managed_servers']>;

/** Identity only: metadata, activity and power-state updates do not invalidate browsing. */
export function directoryServerIdentity(server: Server) {
  return JSON.stringify([
    server.id,
    server.owner_id,
    server.node_id,
    server.provider_user_id,
    server.pterodactyl_id,
    server.pterodactyl_uuid,
    server.pterodactyl_identifier,
    server.external_id,
    server.deleted_at,
  ]);
}

/** One local query; never fetch/decrypt a credential or contact the provider here. */
async function scope(db: Kysely<Database>, server: Server, providerBinding: string) {
  const row = await db
    .selectFrom('managed_nodes as n')
    .leftJoin('provider_accounts as a', (join) => join.on('a.user_id', '=', server.owner_id))
    .leftJoin('provider_change_feeds as f', 'f.instance_id', 'a.instance_id')
    .leftJoin('provider_server_projections as p', (join) => join.on('p.server_id', '=', server.id))
    .select([
      'n.pterodactyl_node_id',
      'a.instance_id',
      'a.provider_url',
      'a.provider_id',
      'a.provider_uuid',
      'a.external_id',
      'a.status',
      'a.key_operation_id',
      'a.key_identifier',
      'f.enabled',
      'f.provider_url as feed_provider_url',
      'p.instance_id as projection_instance',
      'p.revision',
      'p.valid',
      'p.identity_invalidated',
      sql<unknown>`(select jsonb_agg(to_jsonb(claim) order by claim.pterodactyl_allocation_id)
        from server_allocations claim where claim.server_id = ${server.id})`.as('claims'),
    ])
    .where('n.id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  if (row.identity_invalidated) throw new DomainError('provenance_mismatch');
  return JSON.stringify([providerBinding, directoryServerIdentity(server), row]);
}

/** API-process scoped, bounded and non-sliding. Never an authorization or file-content cache. */
export function createDirectoryIdentityCache(now: () => number = () => performance.now()) {
  const ttlMs = 60_000;
  type Entry = {
    scope: string;
    expiresAt: number;
    proof: Promise<void>;
    used: boolean;
    timer?: ReturnType<typeof setTimeout>;
    refresh?: Promise<void>;
    refreshFailed?: boolean;
  };
  const entries = new Map<string, Entry>();
  let closed = false;
  function invalidate(serverId: string) {
    clearTimeout(entries.get(serverId)?.timer);
    entries.delete(serverId);
  }
  return {
    invalidate,
    close() {
      closed = true;
      for (const id of entries.keys()) invalidate(id);
    },
    async verify(
      db: Kysely<Database>,
      server: Server,
      providerBinding: string,
      read: () => Promise<ApplicationServer>,
      backgroundDb: Kysely<Database> = db,
    ) {
      if (closed) throw new DomainError('integration_unavailable');
      const binding = await scope(db, server, providerBinding);
      if (closed) throw new DomainError('integration_unavailable');
      function prepare(connection: Kysely<Database>, used: boolean): Entry {
        const entry: Entry = {
          scope: binding,
          expiresAt: now() + ttlMs,
          proof: Promise.resolve(),
          used,
        };
        entry.proof = (async () => {
          await verifyManagedIdentity(connection, server, await read());
          if (
            (await scope(connection, server, providerBinding)) !== binding ||
            entry.expiresAt <= now()
          )
            throw new DomainError('conflict');
        })();
        return entry;
      }
      function arm(entry: Entry) {
        // One renewal after use; an unused renewed proof does not poll forever.
        entry.timer = setTimeout(
          () => {
            if (entry.used && entries.get(server.id) === entry) refresh(entry);
          },
          Math.max(0, entry.expiresAt - 5_000 - now()),
        );
        entry.timer.unref();
      }
      function refresh(entry: Entry) {
        if (entry.refresh) return;
        clearTimeout(entry.timer);
        // Use the pool, never a request's released pinned connection. A failed
        // renewal cannot extend the old deadline or create a tight retry loop.
        entry.refresh = (async () => {
          const current = await backgroundDb
            .selectFrom('managed_servers')
            .selectAll()
            .where('id', '=', server.id)
            .executeTakeFirst();
          if (
            !current ||
            directoryServerIdentity(current) !== directoryServerIdentity(server) ||
            (await scope(backgroundDb, current, providerBinding)) !== binding
          )
            throw new DomainError('conflict');
          const replacement = prepare(backgroundDb, false);
          await replacement.proof;
          if (entries.get(server.id) !== entry) throw new DomainError('conflict');
          entries.set(server.id, replacement);
          arm(replacement);
        })().catch((error: unknown) => {
          entry.refreshFailed = true;
          // Known identity drift must take effect immediately, even before TTL.
          if (
            error instanceof DomainError &&
            ['conflict', 'provenance_mismatch'].includes(error.code) &&
            entries.get(server.id) === entry
          )
            invalidate(server.id);
          throw error;
        });
        void entry.refresh.catch(() => {});
      }
      const cached = entries.get(server.id);
      if (cached?.scope === binding && !(cached.expiresAt <= now() && cached.refreshFailed)) {
        await cached.proof;
        if (entries.get(server.id)?.scope !== binding) throw new DomainError('conflict');
        cached.used = true;
        if (cached.expiresAt - now() <= 5_000) refresh(cached);
        if (cached.expiresAt > now()) return;
        await cached.refresh;
        const renewed = entries.get(server.id);
        if (renewed?.scope !== binding || renewed.expiresAt <= now())
          throw new DomainError('conflict');
        renewed.used = true;
        return;
      }
      invalidate(server.id);
      if (entries.size >= 1024) invalidate(entries.keys().next().value as string);
      const entry = prepare(db, true);
      entries.set(server.id, entry);
      try {
        await entry.proof;
        if (entries.get(server.id) !== entry) throw new DomainError('conflict');
        arm(entry);
      } catch (error) {
        if (entries.get(server.id) === entry) invalidate(server.id);
        throw error;
      }
    },
  };
}
