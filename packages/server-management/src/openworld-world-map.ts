import { createHash } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { sql } from 'kysely';
import { readOpenworldFactories } from '../../../games/openworld/src/factories.js';
import {
  type MapCatalog,
  mapPalette,
  readMapCatalog,
  readMapMeshBinary,
  readMapSeedFeatures,
  readMapSeedTile,
  readMapSurfaceBinary,
  readMapTexture,
  seedLegend,
} from '../../../games/openworld/src/map-binary.js';
import {
  readOpenworldCreatures,
  readOpenworldSpace,
} from '../../../games/openworld/src/map-layers.js';
import { readMeshBatch } from '../../../games/openworld/src/map-mesh-batch.js';
import {
  readMapChanges,
  readMapColumns,
  readMapIndex,
  readMapPlayers,
  readMapTile,
} from '../../../games/openworld/src/map-terrain.js';
import {
  dispatchOpenworldCheckpoint,
  readOpenworldCheckpoints,
  readOpenworldMapWorlds,
} from '../../../games/openworld/src/native-checkpoints.js';
import type {
  OpenworldCheckpoint,
  OpenworldCheckpointAction,
  OpenworldMapWorld,
} from '../../../games/openworld/src/world-map.js';
import { openworldActionReceipt } from './openworld-action-receipts.js';
import {
  assertCurrentOpenworldScope,
  createOpenworldNativeConnection,
  type OpenworldNativeOptions,
  type OpenworldScope,
  openworldProcessRef,
  readOpenworldScope,
  sharedReads,
} from './openworld-telemetry.js';
import { OpenworldTerrainCache } from './openworld-terrain-cache.js';

type Native = Parameters<typeof readMapIndex>[0];
type MapQuery = { world: string; processRef: string };
type CheckpointRequest = MapQuery & { requestId: string; action: OpenworldCheckpointAction };
type Bounds = { i0: number; j0: number; i1: number; j1: number };
type ColumnQuery = MapQuery & {
  face: number;
  stamp?: number;
  stride: number;
  sample?: '1';
  bounds?: Bounds;
};

const revision = (row: OpenworldCheckpoint) =>
  createHash('sha256').update(JSON.stringify(row)).digest('hex');

// Keep the full span for "Show full index" while bounding the points used for framing.
function sampledColumns(packed: Uint32Array) {
  const limit = 4096;
  const count = packed.length / 2;
  if (count <= limit) return visibleColumns(packed, 1);
  let minX = 0,
    maxX = 0,
    minZ = 0,
    maxZ = 0;
  for (let i = 2; i < packed.length; i += 2) {
    const x = packed[i] as number,
      z = packed[i + 1] as number;
    if (x < (packed[minX] as number)) minX = i;
    if (x > (packed[maxX] as number)) maxX = i;
    if (z < (packed[minZ + 1] as number)) minZ = i;
    if (z > (packed[maxZ + 1] as number)) maxZ = i;
  }
  const offsets = new Set([minX, maxX, minZ, maxZ]);
  const samples = limit - offsets.size;
  for (let n = 0; n < samples; n++) offsets.add(2 * Math.floor((n * count) / samples));
  return {
    columns: Array.from(offsets, (i): [number, number] => [
      packed[i] as number,
      packed[i + 1] as number,
    ]),
  };
}
function visibleColumns(packed: Uint32Array, stride: number, bounds?: Bounds) {
  const columns: [number, number][] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < packed.length; offset += 2) {
    const i = packed[offset] as number,
      j = packed[offset + 1] as number;
    if (bounds && (i < bounds.i0 || i > bounds.i1 || j < bounds.j0 || j > bounds.j1)) continue;
    const x = Math.floor(i / stride) * stride,
      y = Math.floor(j / stride) * stride;
    if (stride > 1) {
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (columns.length >= 32768) throw new DomainError('validation_failed');
    columns.push([x, y]);
  }
  return { columns };
}

export function createOpenworldWorldMap(options: OpenworldNativeOptions) {
  const { db, fetcher = fetch, now = Date.now } = options;
  const connect = createOpenworldNativeConnection(options);
  const worlds = sharedReads<Awaited<ReturnType<typeof readOpenworldMapWorlds>>>(64, now, 1000);
  const indexes = sharedReads<Awaited<ReturnType<typeof readMapIndex>>>(64, now, 1000);
  const columns = sharedReads<Uint32Array>(8, now, 1000);
  const deltas = sharedReads<Awaited<ReturnType<typeof readMapChanges>>>(8, now, 500);
  const tiles = sharedReads<Awaited<ReturnType<typeof readMapTile>>>(256, now, 500);
  const factories = sharedReads<Awaited<ReturnType<typeof readOpenworldFactories>>>(64, now, 1000);
  const creatures = sharedReads<Awaited<ReturnType<typeof readOpenworldCreatures>>>(64, now, 1000);
  const space = sharedReads<Awaited<ReturnType<typeof readOpenworldSpace>>>(32, now, 1000);
  const players = sharedReads<Awaited<ReturnType<typeof readMapPlayers>>>(64, now, 1000);
  const key = (scope: OpenworldScope, ...args: (string | number | undefined)[]) =>
    JSON.stringify([scope.liveKey, ...args]);
  const catalogs = sharedReads<MapCatalog>(24, now, 1500);
  const geometry = new OpenworldTerrainCache(
    {
      bytes: 64 * 1024 * 1024,
      entries: 2048,
      active: 48,
      perServer: 16,
      parallelPerServer: 3,
      finishStarted: true,
    },
    now,
  );
  const textures = new OpenworldTerrainCache(
    { bytes: 16 * 1024 * 1024, entries: 2048, active: 24, perServer: 8 },
    now,
  );
  const generation = new OpenworldTerrainCache(
    { bytes: 24 * 1024 * 1024, entries: 256, active: 4, perServer: 2, finishStarted: true },
    now,
  );
  let runningTiles = 0;
  function withNative<T>(
    scope: OpenworldScope,
    work: (native: Native) => Promise<T>,
    retry = true,
    timeoutMs = 8000,
    requestSignal?: AbortSignal,
  ) {
    return connect(
      scope,
      async (origin, token, timeout) => {
        const signal = requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout;
        try {
          return await work({ origin, token, signal, fetcher });
        } catch (error) {
          if (error instanceof DomainError) throw error;
          throw new DomainError(signal.aborted ? 'game_not_ready' : 'integration_unavailable');
        }
      },
      retry,
      timeoutMs,
    );
  }
  const listWorlds = (scope: OpenworldScope) =>
    worlds.get(scope.liveKey, 15000, () => withNative(scope, readOpenworldMapWorlds));
  async function read<T>(
    who: AuthContext,
    id: string,
    processRef: string | undefined,
    work: (scope: OpenworldScope) => Promise<T>,
    access:
      | { resource: 'map'; requirePlayerInspection?: boolean; requireSeedInspection?: boolean }
      | { resource: 'factories' } = {
      resource: 'map',
    },
    project?: (result: T, current: OpenworldScope) => T,
  ) {
    const reader = { who, ...access };
    const scope = await readOpenworldScope(db, id, reader);
    if (scope.reason) throw new DomainError('game_not_ready');
    if (processRef !== undefined && openworldProcessRef(scope) !== processRef)
      throw new DomainError('conflict');
    const result = await work(scope);
    // Every reader, including one sharing another reader's pending work, must
    // still have the grant and the same private process when the read completes.
    const current = await readOpenworldScope(db, id, reader);
    assertCurrentOpenworldScope(scope, current);
    return project ? project(result, current) : result;
  }
  async function worldRead<T>(
    who: AuthContext,
    id: string,
    q: MapQuery,
    work: (scope: OpenworldScope, world: OpenworldMapWorld) => Promise<T>,
    project?: (result: T, current: OpenworldScope) => T,
    requireSeedInspection = false,
  ) {
    return read(
      who,
      id,
      q.processRef,
      async (scope) => {
        const world = (await listWorlds(scope)).find((w) => w.key === q.world);
        if (!world) throw new DomainError('not_found');
        return work(scope, world);
      },
      { resource: 'map', requireSeedInspection },
      project,
    );
  }
  // Generation can keep a native worker occupied for seconds. Only cache misses
  // take a slot. Transaction-scoped locks also cover multiple API processes and
  // release automatically if a worker exits.
  function withGenerator<T>(
    scope: OpenworldScope,
    resource: string,
    work: (n: Native) => Promise<T>,
    abort?: AbortSignal,
  ) {
    const requestLock = `:ow-generator:read:${createHash('sha256').update(resource).digest('hex')}`;
    const serverSlots = `:ow-generator:server:${scope.serverId}:`;
    return withNative(
      scope,
      (n) =>
        db.transaction().execute(async (tx) => {
          const {
            rows: [slot],
          } = await sql<{ available: boolean }>`select
        pg_try_advisory_xact_lock(hashtextextended(current_schema() || ${requestLock},0))
        and exists (select 1 from generate_series(1,2) s where pg_try_advisory_xact_lock(hashtextextended(current_schema() || ${serverSlots} || s::text,0)))
        and exists (select 1 from generate_series(1,4) s where pg_try_advisory_xact_lock(hashtextextended(current_schema() || ':ow-generator:global:' || s::text,0)))
        as available`.execute(tx);
          if (!slot?.available) throw new DomainError('rate_limited');
          return work(n);
        }),
      true,
      55000,
      abort,
    );
  }
  function catalog(scope: OpenworldScope, world: OpenworldMapWorld) {
    return catalogs.get(key(scope, world.key), 60000, () =>
      withGenerator(scope, key(scope, world.key, 'catalog'), (n) => readMapCatalog(n, world)),
    );
  }
  type Surface = Parameters<typeof readMapSurfaceBinary>[1];
  type Mesh = Parameters<typeof readMapMeshBinary>[1];
  type Seed = Parameters<typeof readMapSeedTile>[2];
  function binary<T extends Surface | Mesh>(
    scope: OpenworldScope,
    q: MapQuery & T & { stamp?: number },
    signal: AbortSignal,
    load: (n: Native, q: T) => Promise<Uint8Array<ArrayBuffer> | null>,
  ) {
    const [i, j, n] = 'ci' in q ? [q.ci, q.cj, q.n] : [q.i, q.j, 0];
    const prefix = key(scope, q.world);
    const asset = `${prefix}|${[q.face, i, j, n, q.lod, q.stamp ?? ''].join(',')}`;
    return geometry.get(asset, scope.serverId, 45000, signal, async (abort, waited) => {
      if (waited) assertCurrentOpenworldScope(scope, await readOpenworldScope(db, scope.serverId));
      return withNative(scope, (native) => load(native, q), true, 8000, abort);
    });
  }
  function invalidateGeometry(
    scope: OpenworldScope,
    world: string,
    changes: Awaited<ReturnType<typeof readMapChanges>>,
  ) {
    const prefix = `${key(scope, world)}|`;
    // Deltas can contain thousands of columns. Materialize their affected blocks
    // once instead of walking the entire delta list for each resident cache entry.
    const touched = new Set<string>();
    if (!changes.reset && changes.columns.length < 4096) {
      for (const [face, i, j] of changes.columns)
        for (const n of [0, 1, 2, 4, 8, 16, 32]) {
          const side = n || 1;
          touched.add([face, i - (i % side), j - (j % side), n].join(','));
        }
    }
    geometry.invalidate(
      (k) =>
        k.startsWith(prefix) &&
        (changes.reset ||
          changes.columns.length >= 4096 ||
          touched.has(k.slice(prefix.length).split(',').slice(0, 4).join(','))),
    );
  }
  return {
    info(who: AuthContext, id: string) {
      return read(who, id, undefined, async (scope) => ({
        worlds: await listWorlds(scope),
        processRef: openworldProcessRef(scope),
      }));
    },
    players(who: AuthContext, id: string, processRef: string) {
      return read(
        who,
        id,
        processRef,
        async (scope) => ({
          ...(await players.get(scope.liveKey, 2000, () => withNative(scope, readMapPlayers))),
          processRef,
        }),
        { resource: 'map', requirePlayerInspection: true },
      );
    },
    factories(who: AuthContext, id: string) {
      return read(
        who,
        id,
        undefined,
        (scope) =>
          factories.get(scope.liveKey, 3000, () => withNative(scope, readOpenworldFactories)),
        { resource: 'factories' },
      );
    },
    creatures(who: AuthContext, id: string, q: MapQuery, markers: boolean) {
      return worldRead(who, id, q, (scope) =>
        creatures.get(key(scope, q.world, markers ? 1 : 0), 3000, () =>
          withNative(scope, (n) => readOpenworldCreatures(n, q.world, markers)),
        ),
      );
    },
    space(who: AuthContext, id: string, processRef: string) {
      return read(
        who,
        id,
        processRef,
        async (scope) => {
          // The native dashboard and other API processes can change checkpoint visibility.
          // Share only an in-flight sample; a later viewer needs a fresh visibility decision.
          const pending = space.get(scope.liveKey, 0, () => withNative(scope, readOpenworldSpace));
          const snapshot = await pending;
          if (!space.current(scope.liveKey, pending)) throw new DomainError('conflict');
          return snapshot;
        },
        { resource: 'map' },
        (data, current) => ({
          ...data,
          players: current.canInspectPlayers ? data.players : [],
          checkpoints: current.canManageCheckpoints
            ? data.checkpoints
            : data.checkpoints.filter((c) => c.visibility === 'players'),
        }),
      );
    },
    index(who: AuthContext, id: string, q: MapQuery) {
      return worldRead(who, id, q, async (scope) => {
        const k = key(scope, q.world);
        // A delta may supersede an in-flight fetch before its index is returned.
        for (let attempt = 0; attempt < 3; attempt++) {
          const pending = indexes.get(k, 1500, () =>
            withNative(scope, (n) => readMapIndex(n, q.world)),
          );
          const result = await pending;
          if (indexes.current(k, pending)) return result;
        }
        throw new DomainError('rate_limited');
      });
    },
    columns(who: AuthContext, id: string, q: ColumnQuery) {
      return worldRead(who, id, q, async (scope) => {
        const data = await columns.get(key(scope, q.world, q.face, q.stamp), 5000, () =>
          withNative(scope, async (n) => {
            const response = await readMapColumns(n, q.world, q.face);
            // Store each pair in eight bytes. A large face may be shared by many viewports.
            const packed = new Uint32Array(response.columns.length * 2);
            for (const [index, coordinates] of response.columns.entries()) {
              packed.set(coordinates, index * 2);
            }
            return packed;
          }),
        );
        return q.sample ? sampledColumns(data) : visibleColumns(data, q.stride, q.bounds);
      });
    },
    changes(who: AuthContext, id: string, q: MapQuery & { since: number }) {
      return worldRead(who, id, q, (scope) =>
        deltas.get(key(scope, q.world, q.since), 1000, async () => {
          const result = await withNative(scope, (n) => readMapChanges(n, q.world, q.since));
          if (result.reset || result.stamp !== q.since || result.columns.length) {
            indexes.invalidate(key(scope, q.world));
            invalidateGeometry(scope, q.world, result);
          }
          return result;
        }),
      );
    },
    surface(
      who: AuthContext,
      id: string,
      q: MapQuery & { face: number; ci: number; cj: number; stamp?: number },
    ) {
      return worldRead(who, id, q, (scope) =>
        tiles.get(key(scope, q.world, q.face, q.ci, q.cj, q.stamp), 15000, async () => {
          if (runningTiles >= 16) throw new DomainError('rate_limited');
          runningTiles++;
          try {
            return await withNative(scope, (n) => readMapTile(n, q.world, q.face, q.ci, q.cj));
          } finally {
            runningTiles--;
          }
        }),
      );
    },
    terrain(
      who: AuthContext,
      id: string,
      q: MapQuery & Surface & { stamp?: number },
      signal: AbortSignal,
    ) {
      return worldRead(who, id, q, (scope) => binary(scope, q, signal, readMapSurfaceBinary));
    },
    mesh(
      who: AuthContext,
      id: string,
      q: MapQuery & Mesh & { stamp?: number },
      signal: AbortSignal,
    ) {
      return worldRead(who, id, q, (scope) => binary(scope, q, signal, readMapMeshBinary));
    },
    meshes(
      who: AuthContext,
      id: string,
      q: MapQuery & Omit<Mesh, 'i' | 'j'> & { cells: [number, number][]; stamp?: number },
      signal: AbortSignal,
    ) {
      return worldRead(who, id, q, (scope) =>
        readMeshBatch(q.cells, signal, ([i, j], abort) =>
          binary(scope, { ...q, i, j }, abort, readMapMeshBinary),
        ),
      );
    },
    palette(who: AuthContext, id: string, q: MapQuery) {
      return worldRead(who, id, q, async (scope, world) => mapPalette(await catalog(scope, world)));
    },
    texture(who: AuthContext, id: string, q: MapQuery & { id: number }, signal: AbortSignal) {
      return worldRead(who, id, q, async (scope, world) => {
        const meta = await catalog(scope, world);
        return textures.get(
          key(scope, q.world, meta.version, q.id),
          scope.serverId,
          300000,
          signal,
          (abort) => withNative(scope, (n) => readMapTexture(n, meta, q.id), true, 8000, abort),
        );
      });
    },
    seedLegend(who: AuthContext, id: string, q: MapQuery) {
      return worldRead(
        who,
        id,
        q,
        async (scope, world) => seedLegend(await catalog(scope, world)),
        undefined,
        true,
      );
    },
    seedTile(who: AuthContext, id: string, q: MapQuery & Seed, signal: AbortSignal) {
      return worldRead(
        who,
        id,
        q,
        async (scope, world) => {
          const meta = await catalog(scope, world);
          const resource = key(
            scope,
            q.world,
            meta.version,
            meta.seedScheme,
            meta.seed,
            q.face,
            q.z,
            q.x,
            q.y,
          );
          return generation.get(resource, scope.serverId, 600000, signal, (abort) =>
            withGenerator(scope, resource, (n) => readMapSeedTile(n, meta, q), abort),
          );
        },
        undefined,
        true,
      );
    },
    seedFeatures(
      who: AuthContext,
      id: string,
      q: MapQuery & Seed & { kind: string },
      signal: AbortSignal,
    ) {
      return worldRead(
        who,
        id,
        q,
        async (scope, world) => {
          const meta = await catalog(scope, world);
          const resource = key(
            scope,
            q.world,
            meta.version,
            meta.seedScheme,
            meta.seed,
            q.face,
            q.z,
            q.x,
            q.y,
            q.kind,
          );
          const bytes = await generation.get(
            resource,
            scope.serverId,
            600000,
            signal,
            async (abort) => {
              const rows = await withGenerator(
                scope,
                resource,
                (n) => readMapSeedFeatures(n, meta, q),
                abort,
              );
              return new TextEncoder().encode(JSON.stringify(rows));
            },
          );
          return bytes;
        },
        undefined,
        true,
      );
    },
    checkpoints(who: AuthContext, id: string, q: MapQuery) {
      return worldRead(
        who,
        id,
        q,
        async (scope) => {
          const rows = await withNative(scope, (n) => readOpenworldCheckpoints(n, q.world));
          return { checkpoints: rows.map((row) => ({ ...row, revision: revision(row) })) };
        },
        (result, current) =>
          current.canManageCheckpoints
            ? result
            : {
                checkpoints: result.checkpoints
                  .filter((row) => row.visibility === 'players')
                  .map(({ revision: _revision, ...checkpoint }) => {
                    // The game labels the note as administrator-only even when the marker appears on the HUD.
                    const visible = { ...checkpoint, note: '' };
                    return { ...visible, revision: revision(visible) };
                  }),
              },
      );
    },
    async changeCheckpoint(who: AuthContext, id: string, input: CheckpointRequest) {
      const reader = { who, resource: 'map' as const, manageCheckpoints: true };
      const scope = await readOpenworldScope(db, id, reader);
      const { action, world } = input;
      const receipt = openworldActionReceipt(db, who, id, 'checkpoint', input, {
        checkpointAction: action.kind,
        ...(action.kind === 'create' ? {} : { checkpointId: action.id }),
      });
      const existing = await receipt.existing();
      if (existing) return existing;
      if (scope.reason) throw new DomainError('game_not_ready');
      if (openworldProcessRef(scope) !== input.processRef) throw new DomainError('conflict');
      return withNative(
        scope,
        (n) =>
          receipt.run(async (markDispatched) => {
            // Competing panel instances must not both accept the same checkpoint revision.
            await db.transaction().execute(async (tx) => {
              const lockKey = `:openworld:checkpoints:${id}`;
              const lock = await sql<{
                acquired: boolean;
              }>`select pg_try_advisory_xact_lock(hashtextextended(current_schema() || ${lockKey},0)) as acquired`.execute(
                tx,
              );
              if (!lock.rows[0]?.acquired) throw new DomainError('conflict');
              const currentWorlds = await readOpenworldMapWorlds(n);
              const match = currentWorlds.find((w) => w.key === world);
              if (!match) throw new DomainError('not_found');
              if (
                match.faceEdgeMeters != null &&
                action.kind !== 'delete' &&
                action.position?.type === 'face'
              ) {
                if (
                  action.position.x >= match.faceEdgeMeters ||
                  action.position.z >= match.faceEdgeMeters
                )
                  throw new DomainError('validation_failed');
              }
              if (action.kind !== 'create') {
                const current = (await readOpenworldCheckpoints(n, world)).find(
                  (row) => row.id === action.id,
                );
                if (!current) throw new DomainError('not_found');
                if (revision(current) !== action.revision) throw new DomainError('conflict');
              }
              assertCurrentOpenworldScope(scope, await readOpenworldScope(tx, id, reader));
              if (n.signal.aborted) throw new DomainError('game_not_ready');
              markDispatched();
              try {
                await dispatchOpenworldCheckpoint(n, world, action);
              } finally {
                // The game may have applied a visibility change even if its reply was lost.
                space.invalidate(scope.liveKey);
              }
            });
          }),
        false,
      );
    },
  };
}
