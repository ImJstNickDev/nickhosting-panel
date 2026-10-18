import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import {
  type ApplicationServer,
  applicationServerSchema,
  type PrivateTransferCache,
} from '@nickhosting/pterodactyl-adapter';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import { assertManagedIdentity, managedIdentityClaims } from './managed-identity.js';

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
      managedIdentityClaims(server.id).as('claims'),
    ])
    .where('n.id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  if (row.identity_invalidated) throw new DomainError('provenance_mismatch');
  return {
    binding: JSON.stringify([providerBinding, directoryServerIdentity(server), row]),
    identity: { pterodactyl_node_id: row.pterodactyl_node_id, allocations: row.claims ?? [] },
  };
}

const sharedProofSchema = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive().safe(),
    remote: applicationServerSchema,
  })
  .strict();

/** Bounded, non-sliding identity proofs, optionally shared through the private transfer cache.
 * Never an authorization, file-content, or process-state cache. */
export function createDirectoryIdentityCache(
  now: () => number = () => performance.now(),
  shared?: PrivateTransferCache,
) {
  const ttlMs = 60_000;
  type Entry = {
    scope: string;
    expiresAt: number;
    proof: Promise<ApplicationServer>;
    sharedKey: string;
    used: boolean;
    timer?: ReturnType<typeof setTimeout>;
    refresh?: Promise<void>;
    refreshFailed?: boolean;
  };
  const entries = new Map<string, Entry>();
  const skipShared = new Set<string>();
  let closed = false;
  function invalidate(serverId: string) {
    const entry = entries.get(serverId);
    clearTimeout(entry?.timer);
    entries.delete(serverId);
    if (shared && entry) {
      // Even if deletion fails, this process must obtain a new remote proof.
      if (skipShared.size >= 1024) skipShared.delete(skipShared.values().next().value as string);
      skipShared.add(serverId);
      void shared.delete(entry.sharedKey).catch(() => {});
    }
  }
  return {
    invalidate,
    close() {
      closed = true;
      for (const entry of entries.values()) clearTimeout(entry.timer);
      entries.clear();
      skipShared.clear();
    },
    async verify(
      db: Kysely<Database>,
      server: Server,
      providerBinding: string,
      read: () => Promise<ApplicationServer>,
      backgroundDb: Kysely<Database> = db,
    ) {
      if (closed) throw new DomainError('integration_unavailable');
      const snapshot = await scope(db, server, providerBinding);
      const binding = snapshot.binding;
      if (closed) throw new DomainError('integration_unavailable');
      const bindingHash = createHash('sha256').update(binding).digest('hex');
      const sharedKey = `fileman.identity.v1:${bindingHash}`;
      function prepare(
        connection: Kysely<Database>,
        used: boolean,
        allowShared: boolean,
        previous?: Entry,
      ): Entry {
        const absoluteExpiry = Date.now() + ttlMs;
        const entry = {
          scope: binding,
          expiresAt: now() + ttlMs,
          sharedKey,
          used,
        } as Entry;
        entry.proof = (async () => {
          let remote: ApplicationServer | undefined;
          let restored = false;
          if (shared && allowShared) {
            try {
              const encoded = await shared.get(sharedKey);
              if (encoded && Buffer.byteLength(encoded) <= 1024 ** 2) {
                const value = sharedProofSchema.safeParse(JSON.parse(encoded));
                const remaining = value.success ? value.data.expiresAt - Date.now() : 0;
                if (
                  value.success &&
                  value.data.scope === bindingHash &&
                  remaining > 0 &&
                  remaining <= ttlMs
                ) {
                  assertManagedIdentity(server, value.data.remote, snapshot.identity);
                  remote = value.data.remote;
                  entry.expiresAt = now() + (value.data.expiresAt - Date.now());
                  restored = true;
                }
              }
            } catch {
              // Optional cache failures use the ordinary authenticated provider read.
            }
          }
          remote ??= await read();
          if (!restored) assertManagedIdentity(server, remote, snapshot.identity);
          const currentEntry = () =>
            entries.get(server.id) === entry ||
            (previous !== undefined && entries.get(server.id) === previous);
          if (
            (await scope(connection, server, providerBinding)).binding !== binding ||
            entry.expiresAt <= now() ||
            closed ||
            !currentEntry()
          )
            throw new DomainError('conflict');
          if (shared && !restored) {
            const parsed = applicationServerSchema.safeParse(remote);
            const remaining = absoluteExpiry - Date.now();
            if (parsed.success && remaining > 0 && remaining <= ttlMs) {
              const value = JSON.stringify({
                scope: bindingHash,
                expiresAt: absoluteExpiry,
                remote: parsed.data,
              });
              if (Buffer.byteLength(value) <= 1024 ** 2)
                await shared.put(sharedKey, value, remaining).catch(() => {});
            }
          }
          if (closed || !currentEntry() || entry.expiresAt <= now()) {
            if (shared && !restored) await shared.delete(sharedKey).catch(() => {});
            throw new DomainError('conflict');
          }
          return remote;
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
            (await scope(backgroundDb, current, providerBinding)).binding !== binding
          )
            throw new DomainError('conflict');
          const replacement = prepare(backgroundDb, false, false, entry);
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
        const remote = await cached.proof;
        if (entries.get(server.id)?.scope !== binding) throw new DomainError('conflict');
        cached.used = true;
        if (cached.expiresAt - now() <= 5_000) refresh(cached);
        if (cached.expiresAt > now()) return remote;
        await cached.refresh;
        const renewed = entries.get(server.id);
        if (renewed?.scope !== binding || renewed.expiresAt <= now())
          throw new DomainError('conflict');
        renewed.used = true;
        return renewed.proof;
      }
      invalidate(server.id);
      if (entries.size >= 1024) invalidate(entries.keys().next().value as string);
      const allowShared = !skipShared.delete(server.id);
      const entry = prepare(db, true, allowShared);
      entries.set(server.id, entry);
      try {
        const remote = await entry.proof;
        if (entries.get(server.id) !== entry) throw new DomainError('conflict');
        arm(entry);
        return remote;
      } catch (error) {
        if (entries.get(server.id) === entry) invalidate(server.id);
        throw error;
      }
    },
  };
}
