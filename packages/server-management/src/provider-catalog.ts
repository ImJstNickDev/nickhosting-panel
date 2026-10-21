import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import {
  createRuntimeMetadataClient,
  type FabricCatalogResponse,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { Kysely, Selectable } from 'kysely';
import { minecraftMetadataRefreshMs } from './minecraft-metadata.js';

type DB = Kysely<Database>;
type Provider = 'fabric' | 'paper' | 'forge';
type SyncRow = Selectable<Database['minecraft_metadata_sync']>;
export interface ProviderCatalogRefreshOptions {
  client?: RuntimeMetadataClient;
  userAgent?: string;
  now?: () => Date;
}
const leaseMs = 60_000;
const heartbeatMs = 20_000;
const minimumAttemptMs = 60_000;
const runDeadlineMs = 180_000;
export function readProviderCatalog(db: DB, provider: Provider) {
  return db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '=', provider)
    .executeTakeFirst();
}
export function providerCatalogStatus(
  row: SyncRow | undefined,
  synced: boolean,
  now: Date,
): FabricCatalogResponse['status'] {
  return {
    lastCheckedAt: row?.last_checked_at?.toISOString() ?? null,
    lastSuccessAt: row?.last_success_at?.toISOString() ?? null,
    nextCheckAt: row?.next_check_at?.toISOString() ?? null,
    lastError: row?.last_error ?? null,
    syncState:
      row?.lease_id && row.lease_until && row.lease_until > now
        ? 'refreshing'
        : row?.requested_at
          ? 'queued'
          : 'idle',
    stale:
      !synced ||
      !row?.last_success_at ||
      now.getTime() - row.last_success_at.getTime() >= minecraftMetadataRefreshMs,
  };
}
/** Durably enqueue without provider I/O. Row locking coalesces requests across API processes. */
export async function requestProviderCatalogRefresh(db: DB, provider: Provider, now: Date) {
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('minecraft_metadata_sync')
      .selectAll()
      .where('id', '=', provider)
      .forUpdate()
      .executeTakeFirst();
    // selectAll remains compatible with the pre-046 schema during rolling deployment.
    if (!row || row.requested_at === undefined) throw new DomainError('integration_unavailable');
    if (row.requested_at || (row.lease_id && row.lease_until && row.lease_until > now)) return;
    const due = Math.max(now.getTime(), (row.last_checked_at?.getTime() ?? 0) + minimumAttemptMs);
    await trx
      .updateTable('minecraft_metadata_sync')
      .set({ requested_at: now, next_check_at: new Date(due) })
      .where('id', '=', provider)
      .execute();
  });
}
/** Worker-only. Requests survive process loss; only a live lease holder can publish or clear them. */
export async function refreshProviderCatalog<Snapshot>(
  db: DB,
  provider: Provider,
  definition: {
    parse: (input: unknown) => Snapshot | undefined;
    fetch: (
      client: RuntimeMetadataClient,
      options: {
        onProgress: () => Promise<void>;
        previous?: Snapshot;
      },
    ) => Promise<Snapshot>;
    count: (snapshot: Snapshot) => number;
  },
  options: ProviderCatalogRefreshOptions,
) {
  const now = options.now ?? (() => new Date());
  const started = now();
  const leaseId = randomUUID();
  const deployed = await db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '=', provider)
    .executeTakeFirst();
  if (!deployed || deployed.requested_at === undefined)
    return { state: 'skipped' as const, changed: 0 };
  const claim = await db
    .updateTable('minecraft_metadata_sync')
    .set({
      lease_id: leaseId,
      lease_until: new Date(started.getTime() + leaseMs),
      last_checked_at: started,
    })
    .where('id', '=', provider)
    .where('next_check_at', '<=', started)
    .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', started)]))
    .returning(['manifest_hash', 'manifest_json'])
    .executeTakeFirst();
  if (!claim) return { state: 'skipped' as const, changed: 0 };
  const deadline = started.getTime() + runDeadlineMs;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), runDeadlineMs);
  let lastHeartbeat = started.getTime();
  const onProgress = async () => {
    const at = now();
    if (at.getTime() >= deadline || abort.signal.aborted)
      throw new DomainError('integration_unavailable');
    if (at.getTime() - lastHeartbeat < heartbeatMs) return;
    const renewed = await db
      .updateTable('minecraft_metadata_sync')
      .set({ lease_until: new Date(at.getTime() + leaseMs) })
      .where('id', '=', provider)
      .where('lease_id', '=', leaseId)
      .where('lease_until', '>', at)
      .returning('id')
      .executeTakeFirst();
    if (!renewed) throw new DomainError('operation_busy');
    lastHeartbeat = at.getTime();
  };
  try {
    const snapshot = await definition.fetch(
      options.client ??
        createRuntimeMetadataClient({
          userAgent: options.userAgent ?? '',
          timeoutMs: 10_000,
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]),
            }),
        }),
      {
        onProgress,
        previous: definition.parse(claim.manifest_json),
      },
    );
    await onProgress();
    const document = JSON.stringify(snapshot);
    const hash = createHash('sha256').update(document).digest('hex');
    const finished = now();
    const changed = claim.manifest_hash !== hash;
    const committed = await db
      .updateTable('minecraft_metadata_sync')
      .set({
        ...(changed ? { manifest_json: document, manifest_hash: hash } : {}),
        last_checked_at: finished,
        last_success_at: finished,
        next_check_at: new Date(finished.getTime() + minecraftMetadataRefreshMs),
        last_error: null,
        requested_at: null,
        lease_id: null,
        lease_until: null,
      })
      .where('id', '=', provider)
      .where('lease_id', '=', leaseId)
      .where('lease_until', '>', finished)
      .returning('id')
      .executeTakeFirst();
    if (!committed) return { state: 'skipped' as const, changed: 0 };
    return {
      state: changed ? ('updated' as const) : ('unchanged' as const),
      changed: changed ? definition.count(snapshot) : 0,
    };
  } catch {
    const finished = now();
    const failed = await db
      .updateTable('minecraft_metadata_sync')
      .set({
        last_checked_at: finished,
        next_check_at: new Date(finished.getTime() + minimumAttemptMs),
        last_error: `${provider}_metadata_refresh_failed`,
        requested_at: null,
        lease_id: null,
        lease_until: null,
      })
      .where('id', '=', provider)
      .where('lease_id', '=', leaseId)
      .where('lease_until', '>', finished)
      .returning('id')
      .executeTakeFirst();
    return { state: failed ? ('failed' as const) : ('skipped' as const), changed: 0 };
  } finally {
    clearTimeout(timer);
  }
}
