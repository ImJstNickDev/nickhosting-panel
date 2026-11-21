import { createHash } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { sql } from 'kysely';
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
  const players = sharedReads<Awaited<ReturnType<typeof readMapPlayers>>>(64, now, 1000);
  const key = (scope: OpenworldScope, ...args: (string | number | undefined)[]) =>
    JSON.stringify([scope.liveKey, ...args]);
  let runningTiles = 0;
  function withNative<T>(
    scope: OpenworldScope,
    work: (native: Native) => Promise<T>,
    retry = true,
  ) {
    return connect(
      scope,
      (origin, token, signal) => work({ origin, token, signal, fetcher }),
      retry,
    );
  }
  const listWorlds = (scope: OpenworldScope) =>
    worlds.get(scope.liveKey, 15000, () => withNative(scope, readOpenworldMapWorlds));
  async function read<T>(
    who: AuthContext,
    id: string,
    processRef: string | undefined,
    work: (scope: OpenworldScope) => Promise<T>,
    requirePlayerInspection = false,
    project?: (result: T, current: OpenworldScope) => T,
  ) {
    const reader = { who, resource: 'map' as const, requirePlayerInspection };
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
    work: (scope: OpenworldScope) => Promise<T>,
    project?: (result: T, current: OpenworldScope) => T,
  ) {
    return read(
      who,
      id,
      q.processRef,
      async (scope) => {
        if (!(await listWorlds(scope)).some((w) => w.key === q.world))
          throw new DomainError('not_found');
        return work(scope);
      },
      false,
      project,
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
        true,
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
          if (result.reset || result.stamp !== q.since || result.columns.length)
            indexes.invalidate(key(scope, q.world));
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
              await dispatchOpenworldCheckpoint(n, world, action);
            });
          }),
        false,
      );
    },
  };
}
