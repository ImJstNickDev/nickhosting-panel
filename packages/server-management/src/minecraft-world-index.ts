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
  snapshot: MinecraftWorldSnapshot;
  nonWorldDirectories: string[];
  observedAt: Date;
}
type Stored = {
  snapshot: MinecraftWorldSnapshot | null;
  non_world_directories: string[];
  observed_at: Date | null;
  generation: string;
  finished_id: string | null;
  successful_generation: string | null;
};
function record(row?: Stored): MinecraftWorldIndex | undefined {
  if (!row?.snapshot || !row.observed_at) return;
  return {
    snapshot: row.snapshot,
    observedAt: row.observed_at,
    nonWorldDirectories:
      row.successful_generation === row.generation &&
      Date.now() - row.observed_at.getTime() < 60_000
        ? row.non_world_directories
        : [],
  };
}
async function boundRow(db: DB, serverId: string, binding: string) {
  const result = await sql<Stored>`
    SELECT snapshot, non_world_directories, observed_at, generation, finished_id, successful_generation
    FROM minecraft_world_indexes WHERE server_id=${serverId} AND binding=${binding}
      AND local_binding=minecraft_world_local_binding(server_id)`.execute(db);
  return result.rows[0];
}
/** Purely local read. The HTTP caller authorizes the current user before exposing any result. */
export async function readMinecraftWorldIndex(db: DB, serverId: string, providerBinding: string) {
  return record(await boundRow(db, serverId, providerBinding));
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
      .select('profile.installed')
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
    const cached = await boundRow(db, serverId, runtime.consoleProviderBinding);
    const known = new Map(cached?.snapshot?.worlds.map((entry) => [entry.name, entry]));
    const previous: Map<
      string,
      MinecraftWorldFileStamp & {
        validation: NonNullable<MinecraftWorldSnapshot['worlds'][number]['validation']>;
      }
    > = new Map();
    if (scheduled && cached?.successful_generation === token.generation) {
      const revisions = await db
        .selectFrom('minecraft_world_indexes')
        .select('level_stamps')
        .where('server_id', '=', serverId)
        .where('lease_id', '=', token.id)
        .executeTakeFirst();
      for (const stamp of (revisions?.level_stamps ?? []) as MinecraftWorldFileStamp[]) {
        const world = known.get(stamp.name);
        if (world?.validation && world.status !== 'unavailable')
          previous.set(stamp.name, { ...stamp, validation: world.validation });
      }
    }
    const inspection: MinecraftWorldIndexInspection = {
      previous,
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
      inspection,
      `${token.generation}:${token.id}`,
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
      if (world.status === 'unavailable' && validation) world.validation = validation;
    }
    const { nonWorldDirectories, stamps } = inspection;
    const observed = new Set([
      ...snapshot.worlds.map((world) => world.name),
      ...nonWorldDirectories,
    ]);
    for (const [name, world] of known) {
      if (inspection.presentDirectories.has(name) && !observed.has(name))
        snapshot.worlds.push({ ...world, status: 'unavailable' });
    }
    signal.throwIfAborted();
    // A split dimension or interrupted save can be recognized before its first readable level.dat.
    for (const name of inspection.worldMarkerDirectories) {
      if (!observed.has(name) && !known.has(name))
        snapshot.worlds.push({ name, status: 'unavailable' });
    }
    const update = await sql<{ observed_at: Date }>`UPDATE minecraft_world_indexes
      SET snapshot=${JSON.stringify(snapshot)}::jsonb, level_stamps=${JSON.stringify(stamps)}::jsonb, non_world_directories=${nonWorldDirectories}::text[],
        observed_at=clock_timestamp(), successful_generation=generation, finished_id=${token.id}, denied_reason=NULL,
        local_binding=${token.localBinding}, binding=${runtime.consoleProviderBinding}, lease_id=NULL, lease_until=NULL,
        next_scan_at=minecraft_world_next_scan(server_id,clock_timestamp())
      WHERE server_id=${serverId} AND lease_id=${token.id} AND generation=${token.generation}
        AND operation_generation=${token.operationGeneration}
        AND EXISTS(SELECT 1 FROM managed_servers s WHERE s.id=server_id AND s.active_operation_id IS NULL)
        AND minecraft_world_local_binding(server_id)=${token.localBinding}
      RETURNING observed_at`.execute(db);
    const observedAt = update.rows[0]?.observed_at;
    if (observedAt) return { snapshot, nonWorldDirectories, observedAt };
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
