import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import {
  createRuntimeMetadataClient,
  minecraftManifestUrl,
  minecraftReleaseCatalog,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import { type Kysely, sql } from 'kysely';

export const minecraftMetadataRefreshMs = 15 * 60 * 1000;
const retryMs = 60_000;
const leaseMs = 60_000;
type DB = Kysely<Database>;

export async function getMinecraftMetadataStatus(db: DB, now = new Date()) {
  const row = await db
    .selectFrom('minecraft_metadata_sync')
    .select(['last_checked_at', 'last_success_at', 'next_check_at', 'last_error'])
    .where('id', '=', 'mojang')
    .executeTakeFirst();
  return {
    lastCheckedAt: row?.last_checked_at?.toISOString() ?? null,
    lastSuccessAt: row?.last_success_at?.toISOString() ?? null,
    nextCheckAt: row?.next_check_at?.toISOString() ?? null,
    lastError: row?.last_error ?? null,
    stale:
      !row?.last_success_at ||
      now.getTime() - row.last_success_at.getTime() > minecraftMetadataRefreshMs,
  };
}

/** Local-only manifest reader. It never falls back to network on a request path. */
export async function cachedMinecraftManifest(db: DB) {
  const row = await db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '=', 'mojang')
    .executeTakeFirst();
  if (!row?.manifest_json || !row.last_success_at)
    throw new DomainError('integration_unavailable', 503, {
      reason: 'minecraft_metadata_not_synced',
    });
  const bytes = new TextEncoder().encode(JSON.stringify(row.manifest_json));
  return {
    bytes,
    evidence: {
      url: minecraftManifestUrl,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      retrievedAt: row.last_success_at.toISOString(),
    },
  };
}

/** A durable lease elects one downloader, including across worker restarts. Network
 * work happens outside transactions; only the still-current lease may commit. */
export async function refreshMinecraftMetadata(
  db: DB,
  options: { client?: RuntimeMetadataClient; userAgent?: string; now?: () => Date },
) {
  const now = options.now ?? (() => new Date());
  const started = now();
  const leaseId = randomUUID();
  await db
    .insertInto('minecraft_metadata_sync')
    .values({
      id: 'mojang',
      manifest_json: null,
      manifest_hash: null,
      last_checked_at: null,
      last_success_at: null,
      next_check_at: started,
      last_error: null,
      lease_id: null,
      lease_until: null,
    })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  const claim = await db
    .updateTable('minecraft_metadata_sync')
    .set({
      lease_id: leaseId,
      lease_until: new Date(started.getTime() + leaseMs),
    })
    .where('id', '=', 'mojang')
    .where('next_check_at', '<=', started)
    .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', started)]))
    .returning('manifest_hash')
    .executeTakeFirst();
  if (!claim) return { state: 'skipped' as const, changed: 0 };
  try {
    const client =
      options.client ??
      createRuntimeMetadataClient({ userAgent: options.userAgent ?? '', timeoutMs: 10_000 });
    const document = await client.read(minecraftManifestUrl);
    // Reuse the integration's strict parser, trusted-origin checks and entry bound.
    const releases = await minecraftReleaseCatalog({ read: async () => document }, true);
    if (releases.length === 0) throw new DomainError('integration_unavailable');
    const manifest = new TextDecoder('utf-8', { fatal: true }).decode(document.bytes);
    const hash = createHash('sha256').update(document.bytes).digest('hex');
    return await db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('minecraft_metadata_sync')
        .select(['lease_id', 'lease_until', 'manifest_hash'])
        .where('id', '=', 'mojang')
        .forUpdate()
        .executeTakeFirstOrThrow();
      const finished = now();
      if (current.lease_id !== leaseId || !current.lease_until || current.lease_until <= finished)
        return { state: 'skipped' as const, changed: 0 };
      let changed = 0;
      if (current.manifest_hash !== hash) {
        // PostgreSQL's conditional upsert leaves identical version rows untouched.
        // No deletion: transient upstream omission must not erase known chronology.
        for (let offset = 0; offset < releases.length; offset += 500) {
          const rows = releases.slice(offset, offset + 500).map((r) => ({
            id: r.id,
            release_type: r.type,
            release_time: r.releaseTime ? new Date(r.releaseTime) : null,
            metadata_url: r.url,
            sha1: r.sha1,
          }));
          const result = await tx
            .insertInto('minecraft_release_metadata')
            .values(rows)
            .onConflict((c) =>
              c
                .column('id')
                .doUpdateSet((eb) => ({
                  release_type: eb.ref('excluded.release_type'),
                  release_time: eb.ref('excluded.release_time'),
                  metadata_url: eb.ref('excluded.metadata_url'),
                  sha1: eb.ref('excluded.sha1'),
                }))
                .where(
                  sql<boolean>`(minecraft_release_metadata.release_type, minecraft_release_metadata.release_time, minecraft_release_metadata.metadata_url, minecraft_release_metadata.sha1) is distinct from (excluded.release_type, excluded.release_time, excluded.metadata_url, excluded.sha1)`,
                ),
            )
            .returning('id')
            .execute();
          changed += result.length;
        }
      }
      await tx
        .updateTable('minecraft_metadata_sync')
        .set({
          ...(current.manifest_hash !== hash
            ? { manifest_json: manifest, manifest_hash: hash }
            : {}),
          last_checked_at: finished,
          last_success_at: finished,
          next_check_at: new Date(finished.getTime() + minecraftMetadataRefreshMs),
          last_error: null,
          lease_id: null,
          lease_until: null,
        })
        .where('id', '=', 'mojang')
        .execute();
      return {
        state: current.manifest_hash === hash ? ('unchanged' as const) : ('updated' as const),
        changed,
      };
    });
  } catch {
    const finished = now();
    await db
      .updateTable('minecraft_metadata_sync')
      .set({
        last_checked_at: finished,
        next_check_at: new Date(finished.getTime() + retryMs),
        last_error: 'minecraft_metadata_refresh_failed',
        lease_id: null,
        lease_until: null,
      })
      .where('id', '=', 'mojang')
      .where('lease_id', '=', leaseId)
      .execute();
    return { state: 'failed' as const, changed: 0 };
  }
}
