import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import type { Environment } from './admission.js';
import { verifyManagedIdentity } from './lifecycle.js';
import {
  inspectMinecraftWorlds,
  type MinecraftWorldFileStamp,
  type MinecraftWorldIndexInspection,
  type MinecraftWorldSnapshot,
} from './minecraft-content.js';
import type { ManagementRuntime } from './runtime.js';

type DB = Kysely<Database>;
type Runtime = Pick<
  ManagementRuntime,
  'adapter' | 'fileReadPhase' | 'consoleProviderBinding' | 'worldPreparation'
>;
export interface MinecraftWorldIndex {
  current: boolean;
  snapshot: MinecraftWorldSnapshot;
  nonWorldDirectories: string[];
  observedAt: Date;
}
type Stored = {
  scan_after: string | null;
  negative_until: Record<string, number> | null;
  snapshot: MinecraftWorldSnapshot | null;
  non_world_directories: string[];
  observed_at: Date | null;
  generation: string;
  finished_id: string | null;
  successful_generation: string | null;
};
function record(row?: Stored): MinecraftWorldIndex | undefined {
  if (!row?.snapshot || !row.observed_at) return;
  const now = Date.now();
  const current =
    row.successful_generation === row.generation && now - row.observed_at.getTime() < 60_000;
  return {
    current,
    snapshot: row.snapshot,
    observedAt: row.observed_at,
    nonWorldDirectories: current
      ? row.non_world_directories.filter(
          (name) => !row.negative_until || (row.negative_until[name] ?? 0) > now,
        )
      : [],
  };
}
function worldIndexScope(serverId: string, binding: string) {
  return sql`server_id=${serverId} AND binding=${binding}
    AND local_binding=minecraft_world_local_binding(server_id)`;
}
async function boundRow(db: DB, serverId: string, binding: string, lease?: string) {
  const result = await sql<Stored & { level_stamps: MinecraftWorldFileStamp[] }>`
    SELECT snapshot - 'scanAfter' - 'negativeUntil' AS snapshot,
      snapshot->>'scanAfter' AS scan_after, snapshot->'negativeUntil' AS negative_until, non_world_directories, observed_at, generation, finished_id, successful_generation
      ${lease ? sql`, CASE WHEN lease_id=${lease} AND generation=successful_generation THEN level_stamps END AS level_stamps` : sql` `}
    FROM minecraft_world_indexes WHERE ${worldIndexScope(serverId, binding)}`.execute(db);
  return result.rows[0];
}
/** Purely local read. The HTTP caller authorizes the current user before exposing any result. */
export async function readMinecraftWorldIndex(db: DB, serverId: string, providerBinding: string) {
  return record(await boundRow(db, serverId, providerBinding));
}
export async function currentMinecraftDatapackWorldNames(
  db: DB,
  serverId: string,
  binding: string,
) {
  const result = await sql<{ worlds: string[] }>`
    SELECT jsonb_path_query_array(snapshot, '$.worlds[*] ? (@.status != "unavailable").name') AS worlds
    FROM minecraft_world_indexes WHERE ${worldIndexScope(serverId, binding)} AND snapshot IS NOT NULL
      AND generation=successful_generation AND observed_at > now()-interval '60 seconds'`.execute(
    db,
  );
  return result.rows[0]?.worlds;
}
/** Fileman only needs root names. Keep the world's parsed metadata and the
 * reconciler's cursor/expiry map inside PostgreSQL for this projection. */
export async function readMinecraftWorldFilemanIndex(db: DB, serverId: string, binding: string) {
  const result = await sql<{
    worlds: string[];
    selectedWorld: string | null;
    nonWorldDirectories: string[];
  }>`
    SELECT jsonb_path_query_array(snapshot, '$.worlds[*].name') AS worlds,
      snapshot->>'selectedWorld' AS "selectedWorld",
      CASE WHEN generation=successful_generation AND observed_at > now()-interval '60 seconds' THEN
        ARRAY(SELECT name FROM unnest(non_world_directories) AS name
          WHERE snapshot->'negativeUntil' IS NULL OR
            (snapshot->'negativeUntil'->>name)::bigint > extract(epoch from now())*1000)
        ELSE ARRAY[]::text[] END AS "nonWorldDirectories"
    FROM minecraft_world_indexes WHERE ${worldIndexScope(serverId, binding)}
      AND snapshot IS NOT NULL AND observed_at IS NOT NULL`.execute(db);
  return result.rows[0] ?? { worlds: [], selectedWorld: null, nonWorldDirectories: [] };
}
type Claim = {
  id: string;
  generation: string;
  operationGeneration: string;
  localBinding: string | null;
};
async function claim(db: DB, serverId: string, scheduled: boolean): Promise<Claim | undefined> {
  const id = randomUUID();
  const result = await sql<{
    generation: string;
    operation_generation: string;
    local_binding: string | null;
  }>`
    UPDATE minecraft_world_indexes SET lease_id=${id}, lease_until=clock_timestamp()+interval '90 seconds'
    WHERE server_id=${serverId} AND (lease_id IS NULL OR lease_until <= clock_timestamp())
    AND EXISTS(SELECT 1 FROM managed_servers s WHERE s.id=server_id AND s.active_operation_id IS NULL)
    ${scheduled ? sql`AND next_scan_at <= clock_timestamp()` : sql``}
    RETURNING generation, operation_generation, minecraft_world_local_binding(server_id) AS local_binding`.execute(
    db,
  );
  const row = result.rows[0];
  return (
    row && {
      id,
      generation: row.generation,
      operationGeneration: row.operation_generation,
      localBinding: row.local_binding,
    }
  );
}

async function reconcile(
  db: DB,
  serverId: string,
  runtime: Runtime,
  env: Environment,
  token: Claim,
  signal: AbortSignal,
  scheduled: boolean,
): Promise<MinecraftWorldIndex | undefined> {
  let denied: 'forbidden' | 'provenance_mismatch' | 'not_found' | null = null;
  try {
    if (!token.localBinding) throw new DomainError('provenance_mismatch');
    const server = await db
      .selectFrom('managed_servers')
      .innerJoin('minecraft_server_profiles as profile', 'profile.server_id', 'managed_servers.id')
      .selectAll('managed_servers')
      .select(['profile.installed', 'profile.combination_id'])
      .where('managed_servers.id', '=', serverId)
      .where('managed_servers.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!server) throw new DomainError('not_found');
    const check = async () => {
      signal.throwIfAborted();
      const row = await sql<{
        valid: boolean;
      }>`SELECT minecraft_world_local_binding(${serverId})=${token.localBinding} AS valid`.execute(
        db,
      );
      if (!row.rows[0]?.valid) throw new DomainError('provenance_mismatch');
    };
    await check();
    if (server.installed) {
      if (!server.pterodactyl_id || !server.pterodactyl_identifier)
        throw new DomainError('conflict');
      try {
        const remote = await runtime.adapter.getApplicationServer(server.pterodactyl_id);
        await verifyManagedIdentity(db, server, remote);
      } catch (failure) {
        if (failure instanceof PterodactylError && failure.upstreamStatus === 404)
          denied = 'not_found';
        throw failure;
      }
      await check();
    }
    const cached = await boundRow(db, serverId, runtime.consoleProviderBinding, token.id);
    const known = new Map(cached?.snapshot?.worlds.map((entry) => [entry.name, entry]));
    const previous: Map<
      string,
      MinecraftWorldFileStamp & {
        validation: NonNullable<MinecraftWorldSnapshot['worlds'][number]['validation']>;
      }
    > = new Map();
    if (cached?.successful_generation === token.generation) {
      for (const stamp of cached.level_stamps ?? []) {
        const world = known.get(stamp.name);
        if (world?.validation && world.status !== 'unavailable')
          previous.set(stamp.name, { ...stamp, validation: world.validation });
      }
    }
    const inspection: MinecraftWorldIndexInspection = {
      previous: scheduled ? previous : new Map(),
      scanAfter: cached?.scan_after ?? null,
      rotationMilliseconds: 60_000,
      knownWorlds: new Set(known.keys()),
      scannedDirectories: new Set(),
      forbiddenDirectories: new Set(),
      stamps: [],
      nonWorldDirectories: [],
      presentDirectories: new Set(),
      worldMarkerDirectories: new Set(),
    };
    const snapshot = await inspectMinecraftWorlds(
      db,
      runtime.adapter,
      serverId,
      check,
      env,
      signal,
      server.pterodactyl_identifier
        ? runtime.fileReadPhase(server.pterodactyl_identifier, server, signal)
        : undefined,
      scheduled ? undefined : runtime.worldPreparation,
      {
        indexInspection: inspection,
        preparationRevision: `${token.generation}:${token.id}`,
        verifiedServer: server,
      },
    );
    // A listing timeout cannot turn a previously observed world into a deleted world.
    // Retain the earlier metadata, but make its unavailable status explicit.
    snapshot.worlds = snapshot.worlds.filter(
      (world) =>
        world.status !== 'unavailable' ||
        known.has(world.name) ||
        inspection.worldMarkerDirectories.has(world.name),
    );
    for (const world of snapshot.worlds) {
      const validation = known.get(world.name)?.validation;
      if (
        world.status === 'unavailable' &&
        validation &&
        !inspection.forbiddenDirectories.has(world.name)
      ) {
        world.validation = validation;
      }
    }
    const { nonWorldDirectories, stamps } = inspection;
    const observed = new Set([
      ...snapshot.worlds.map((world) => world.name),
      ...nonWorldDirectories,
    ]);
    for (const [name, world] of known) {
      if (!inspection.presentDirectories.has(name) || observed.has(name)) continue;
      if (inspection.scannedDirectories.has(name)) {
        snapshot.worlds.push({ ...world, status: 'unavailable' });
      } else {
        snapshot.worlds.push(world);
        const stamp = previous.get(name);
        if (stamp)
          stamps.push({
            name,
            size: stamp.size,
            modifiedAt: stamp.modifiedAt,
            validatedAt: stamp.validatedAt,
          });
      }
    }
    signal.throwIfAborted();
    // A split dimension or interrupted save can be recognized before its first readable level.dat.
    for (const name of inspection.worldMarkerDirectories) {
      if (!observed.has(name) && !known.has(name))
        snapshot.worlds.push({ name, status: 'unavailable' });
    }
    // Merged rows keep the provider's root order as the scan window advances.
    const byName = new Map(snapshot.worlds.map((world) => [world.name, world]));
    snapshot.worlds = [...inspection.presentDirectories].flatMap((name) => byName.get(name) ?? []);
    // A large root can take several staggered minute slots to revisit each folder.
    // Keep an untouched negative only while its original proof is still valid.
    // Receipts that dirty the inventory clear the negative names in the same transaction.
    const negativeUntil = new Map<string, number>();
    if (inspection.scanAfter !== null) {
      const now = Date.now();
      for (const name of nonWorldDirectories)
        negativeUntil.set(name, now + inspection.rotationMilliseconds);
      if (cached?.successful_generation === token.generation && cached.observed_at) {
        for (const name of cached.non_world_directories) {
          if (!inspection.presentDirectories.has(name) || inspection.scannedDirectories.has(name))
            continue;
          const expires = cached.negative_until?.[name] ?? cached.observed_at.getTime() + 60_000;
          if (expires > now) {
            negativeUntil.set(name, expires);
            nonWorldDirectories.push(name);
          }
        }
      }
    }
    const storedSnapshot =
      inspection.scanAfter === null
        ? snapshot
        : {
            ...snapshot,
            scanAfter: inspection.scanAfter,
            negativeUntil: Object.fromEntries(negativeUntil),
          };
    const update = await sql<{ observed_at: Date }>`UPDATE minecraft_world_indexes
      SET snapshot=${JSON.stringify(storedSnapshot)}::jsonb, level_stamps=${JSON.stringify(stamps)}::jsonb, non_world_directories=${nonWorldDirectories}::text[],
        observed_at=clock_timestamp(), successful_generation=generation, finished_id=${token.id}, denied_reason=NULL,
        local_binding=${token.localBinding}, binding=${runtime.consoleProviderBinding}, lease_id=NULL, lease_until=NULL,
        next_scan_at=minecraft_world_next_scan(server_id,clock_timestamp())
      WHERE server_id=${serverId} AND lease_id=${token.id} AND generation=${token.generation}
        AND operation_generation=${token.operationGeneration}
        AND EXISTS(SELECT 1 FROM managed_servers s WHERE s.id=server_id AND s.active_operation_id IS NULL)
        AND minecraft_world_local_binding(server_id)=${token.localBinding}
      RETURNING observed_at`.execute(db);
    const observedAt = update.rows[0]?.observed_at;
    if (observedAt) {
      // Publication retires the old revision even if its cache entry cannot be deleted.
      if (
        inspection.forbiddenDirectories.size &&
        cached?.successful_generation &&
        cached.finished_id
      ) {
        await runtime.worldPreparation?.invalidate(
          server,
          server.combination_id,
          `${cached.successful_generation}:${cached.finished_id}`,
        );
      }
      return { current: true, snapshot, nonWorldDirectories, observedAt };
    }
    // An invalidation overtook this observation. Leave it due so a fresh read wins.
    await sql`UPDATE minecraft_world_indexes SET lease_id=NULL,lease_until=NULL
      WHERE server_id=${serverId} AND lease_id=${token.id}`.execute(db);
  } catch (failure) {
    if (failure instanceof DomainError && failure.code === 'provenance_mismatch')
      denied = 'provenance_mismatch';
    else if (
      (failure instanceof DomainError && ['unauthorized', 'forbidden'].includes(failure.code)) ||
      (failure instanceof PterodactylError && [401, 403].includes(failure.upstreamStatus ?? 0))
    )
      denied = 'forbidden';
    // Keep the last snapshot for a transient outage. A contradicted identity is never reusable.
    await sql`UPDATE minecraft_world_indexes SET lease_id=NULL,lease_until=NULL,finished_id=${token.id},
      successful_generation=NULL, non_world_directories='{}', denied_reason=${denied},
      binding=CASE WHEN ${denied !== null} THEN NULL ELSE binding END,
      next_scan_at=CASE WHEN generation=${token.generation} AND operation_generation=${token.operationGeneration} THEN minecraft_world_next_scan(server_id,clock_timestamp()) ELSE next_scan_at END
      WHERE server_id=${serverId} AND lease_id=${token.id}`.execute(db);
    if (denied) throw new DomainError(denied);
    throw failure;
  }
}
const interactiveScans = new WeakMap<DB, Map<string, Promise<MinecraftWorldIndex>>>();
/** Browser cancellation detaches that reader. A coalesced scan can still update the
 * inventory for the next visit and for other callers waiting on the same server. */
export async function refreshMinecraftWorldIndex(
  db: DB,
  serverId: string,
  runtime: Runtime,
  env: Environment,
  signal?: AbortSignal,
): Promise<MinecraftWorldIndex> {
  signal?.throwIfAborted();
  let scans = interactiveScans.get(db);
  if (!scans) {
    scans = new Map();
    interactiveScans.set(db, scans);
  }
  const key = JSON.stringify([serverId, runtime.consoleProviderBinding]);
  let scan = scans.get(key);
  if (!scan) {
    scan = refresh(db, serverId, runtime, env).finally(() => scans.delete(key));
    scans.set(key, scan);
  }
  if (!signal) return scan;
  const aborted = Promise.withResolvers<never>();
  const detach = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', detach, { once: true });
  try {
    return await Promise.race([scan, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', detach);
  }
}
/** The database lease also covers other API processes and the background worker. */
async function refresh(
  db: DB,
  serverId: string,
  runtime: Runtime,
  env: Environment,
): Promise<MinecraftWorldIndex> {
  const stop = AbortSignal.timeout(60_000);
  let joined: string | null = null;
  for (;;) {
    stop.throwIfAborted();
    const row = await db
      .selectFrom('minecraft_world_indexes')
      .innerJoin('managed_servers as server', 'server.id', 'minecraft_world_indexes.server_id')
      .select([
        'server.active_operation_id',
        'denied_reason',
        'lease_id',
        'finished_id',
        'generation',
        'successful_generation',
        sql<boolean>`lease_until > clock_timestamp()`.as('lease_active'),
      ])
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!row) throw new DomainError('not_found');
    if (row.active_operation_id) {
      const cached = await readMinecraftWorldIndex(db, serverId, runtime.consoleProviderBinding);
      if (cached) return cached;
      throw new DomainError('operation_busy');
    }
    if (joined && row.finished_id === joined) {
      if (row.successful_generation === null)
        throw new DomainError(row.denied_reason ?? 'integration_unavailable');
      if (row.successful_generation === row.generation) {
        const cached = await boundRow(db, serverId, runtime.consoleProviderBinding);
        if (cached?.finished_id === joined && cached.successful_generation === cached.generation) {
          const result = record(cached);
          if (result) return result;
        }
      }
    }
    if (row.lease_id && row.lease_active) {
      joined = row.lease_id;
      await delay(150, undefined, { signal: stop });
      continue;
    }
    const token = await claim(db, serverId, false);
    if (token) {
      const result = await reconcile(db, serverId, runtime, env, token, stop, false);
      if (result) return result;
    }
  }
}

export async function dueMinecraftWorldIndexes(db: DB, count: number) {
  const result = await sql<{ server_id: string }>`SELECT i.server_id FROM minecraft_world_indexes i
    JOIN managed_servers s ON s.id=i.server_id JOIN minecraft_server_profiles p ON p.server_id=s.id
    WHERE i.next_scan_at<=now() AND (i.lease_id IS NULL OR i.lease_until<=now())
      AND s.deleted_at IS NULL AND s.active_operation_id IS NULL AND p.installed AND s.installation_state='installed'
      AND s.pterodactyl_id IS NOT NULL AND s.pterodactyl_identifier IS NOT NULL
    ORDER BY i.next_scan_at,i.server_id LIMIT ${count}`.execute(db);
  return result.rows.map(({ server_id }) => server_id);
}
export async function reconcileDueMinecraftWorldIndex(
  db: DB,
  serverId: string,
  runtime: Runtime,
  env: Environment,
  signal: AbortSignal,
) {
  const token = await claim(db, serverId, true);
  if (token)
    await reconcile(
      db,
      serverId,
      runtime,
      env,
      token,
      AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      true,
    );
}
