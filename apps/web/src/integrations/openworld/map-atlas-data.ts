import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { apiError, safeApiPath } from '../../api/client.js';
import type { AtlasBounds, AtlasController, AtlasMaterial, AtlasRequest } from './atlas-types.js';
import type { FeatureKind } from './map-feature-layer.js';
import { type Footprint, footprintWindow, type MapFace } from './map-framing.js';
import { mapBase, mapData, mapParams, mapScope, scopeLost } from './map-query.js';
import type { ServerView } from './telemetry.js';

export type MapPalette = { materials: AtlasMaterial[]; voxelSize: number; faceEdgeMeters: number };
export type SeedLegend = {
  featureKinds?: FeatureKind[];
  biomes: { id: number; name: string; color: string }[];
  faceEdgeMeters: number;
  maxZoom: number;
};
type Delta = { stamp: number; reset: boolean; columns: [number, number, number][] };

export async function readAtlasResource(
  serverId: string,
  world: string,
  processRef: string,
  face: number,
  stamp: number,
  request: AtlasRequest,
  signal: AbortSignal,
) {
  const { kind, ...params } = request;
  const route = kind === 'surface' ? 'terrain' : kind === 'seed' ? 'seed-tile' : 'mesh';
  const query = mapParams({
    world,
    processRef,
    face,
    ...params,
    ...(kind === 'seed' ? {} : { stamp }),
  });
  const res = await fetch(safeApiPath(`${mapBase(serverId)}/${route}?${query}`), {
    signal,
    credentials: 'same-origin',
    redirect: 'error',
  });
  if (!res.ok)
    throw apiError(await res.json().catch(() => ({})), res.status, res.headers.get('Retry-After'));
  return res.status === 204 ? null : res.arrayBuffer();
}

export function useAtlasCoverage(
  server: ServerView,
  world: string,
  face: number,
  processRef: string,
  stamp: number,
  extent: MapFace | undefined,
  bounds: AtlasBounds | undefined,
  scene: React.RefObject<AtlasController | null>,
  refreshIndex: () => void,
) {
  const stampRef = useRef(stamp);
  const [revision, setRevision] = useState(stamp);
  const count = extent?.count ?? 0;
  const enumerable = count > 0 && count <= 262144;
  const sparse =
    !!extent &&
    Math.max((extent?.i1 ?? 0) - (extent?.i0 ?? 0), (extent?.j1 ?? 0) - (extent?.j0 ?? 0)) > 4096;
  const scope = mapScope(server);
  const params = { world, face, processRef, stamp: revision };
  const changes = useQuery({
    queryKey: [...scope, 'atlas-changes', processRef, world, face],
    queryFn: ({ signal }) =>
      mapData<Delta>(
        server,
        `/changes?${mapParams({ world, processRef, since: stampRef.current })}`,
        signal,
      ),
    retry: false,
    gcTime: 0,
    refetchInterval: (q) => (scopeLost(q.state.error) ? false : 12000),
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    const d = changes.data;
    if (!d || (!d.reset && d.stamp === stampRef.current)) return;
    stampRef.current = d.stamp;
    const cells = d.columns
      .filter((c) => c[0] === face)
      .map(([, i, j]): [number, number] => [i, j]);
    if (d.reset || cells.length) {
      scene.current?.invalidate(d.reset ? null : cells);
      setRevision(d.stamp);
    }
    if (d.reset || d.columns.length) refreshIndex();
  }, [changes.data, face, refreshIndex, scene]);
  const whole = enumerable && count <= 4096;
  const samplePath = `/columns?${mapParams({ ...params, stride: 1, sample: 1 })}`;
  const sample = useQuery({
    queryKey: [...scope, samplePath],
    queryFn: ({ signal }) => mapData<Footprint>(server, samplePath, signal),
    enabled: enumerable && (whole || sparse),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const visible = !whole && enumerable && bounds ? footprintWindow(bounds) : undefined;
  const clipped =
    visible && extent
      ? {
          stride: visible.stride,
          i0: Math.max(visible.i0, extent.i0 ?? 0),
          j0: Math.max(visible.j0, extent.j0 ?? 0),
          i1: Math.min(visible.i1, extent.i1 ?? Infinity),
          j1: Math.min(visible.j1, extent.j1 ?? Infinity),
        }
      : null;
  const window = clipped && clipped.i0 <= clipped.i1 && clipped.j0 <= clipped.j1 ? clipped : null;
  const { i0, i1, j0, j1 } = visible ?? {};
  const audited = useMemo(
    () =>
      i0 !== undefined && i1 !== undefined && j0 !== undefined && j1 !== undefined
        ? { i0, i1, j0, j1 }
        : undefined,
    [i0, i1, j0, j1],
  );
  const path = window ? `/columns?${mapParams({ ...params, ...window })}` : '';
  const local = useQuery({
    queryKey: [...scope, path],
    queryFn: ({ signal }) => mapData<Footprint>(server, path, signal),
    enabled: !!window,
    staleTime: Infinity,
    gcTime: 30000,
    retry: false,
  });
  const data = whole ? sample.data : local.data;
  return {
    stamp: stampRef,
    audited,
    sample: sample.data,
    data,
    stride: whole ? 1 : (window?.stride ?? 1),
    empty: !count || (!!bounds && enumerable && !whole && !window),
    oversized: count > 262144,
    error:
      changes.error ??
      (enumerable && (whole || sparse) ? sample.error : null) ??
      (window ? local.error : null),
    retry: () => {
      if (changes.error) void changes.refetch();
      if (sample.error && enumerable) void sample.refetch();
      if (local.error && window) void local.refetch();
    },
  };
}

type MeshRequest = Extract<AtlasRequest, { kind: 'mesh' }>;
export async function readAtlasMeshes(
  serverId: string,
  world: string,
  processRef: string,
  face: number,
  stamp: number,
  requests: readonly MeshRequest[],
  signal: AbortSignal,
): Promise<(ArrayBuffer | null)[]> {
  const first = requests[0];
  if (!first) return [];
  if (requests.length > 16 || requests.some((r) => r.lod !== first.lod)) throw apiError({}, 400);
  const params = mapParams({
    world,
    processRef,
    face,
    stamp,
    lod: first.lod,
    cells: requests.map((r) => `${r.i},${r.j}`).join(';'),
  });
  const response = await fetch(safeApiPath(`${mapBase(serverId)}/meshes?${params}`), {
    credentials: 'same-origin',
    signal,
    redirect: 'error',
  });
  if (response.status === 413 && requests.length > 1) {
    // Only unusually dense geometry crosses the response byte limit. Keep the
    // two retries serial so a single viewport cannot multiply upstream concurrency.
    await response.body?.cancel();
    const half = Math.ceil(requests.length / 2);
    const left = await readAtlasMeshes(
      serverId,
      world,
      processRef,
      face,
      stamp,
      requests.slice(0, half),
      signal,
    );
    return left.concat(
      await readAtlasMeshes(serverId, world, processRef, face, stamp, requests.slice(half), signal),
    );
  }
  if (!response.ok)
    throw apiError(
      await response.json().catch(() => ({})),
      response.status,
      response.headers.get('Retry-After'),
    );
  return decodeAtlasMeshes(await response.arrayBuffer(), requests);
}

export function decodeAtlasMeshes(bytes: ArrayBuffer, requests: readonly MeshRequest[]) {
  const view = new DataView(bytes);
  const invalid = () => apiError({ error: { code: 'integration_unavailable' } }, 502);
  if (
    bytes.byteLength < 8 ||
    bytes.byteLength > 8 * 1024 * 1024 ||
    view.getUint32(0) !== 0x4e484d42 ||
    view.getUint16(4, true) !== 1 ||
    view.getUint16(6, true) !== requests.length
  )
    throw invalid();
  let cursor = 8;
  const meshes = requests.map((r) => {
    if (
      cursor + 12 > bytes.byteLength ||
      view.getInt32(cursor, true) !== r.i ||
      view.getInt32(cursor + 4, true) !== r.j
    )
      throw invalid();
    const size = view.getUint32(cursor + 8, true);
    cursor += 12;
    if (size > 4 * 1024 * 1024 || cursor + size > bytes.byteLength) throw invalid();
    const mesh = size ? bytes.slice(cursor, cursor + size) : null;
    cursor += size;
    return mesh;
  });
  if (cursor !== bytes.byteLength) throw invalid();
  return meshes;
}
