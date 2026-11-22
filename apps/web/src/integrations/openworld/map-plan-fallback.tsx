import { useQueries, useQuery } from '@tanstack/react-query';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import type { OpenworldCreatureLayer } from '../../../../../games/openworld/src/map-layers.js';
import { maxOpenworldMapColumn } from '../../../../../games/openworld/src/world-map.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice } from '../../components/ui.js';
import { CheckpointGlyph, type MapCheckpoint, type MapPoint } from './map-checkpoints.js';
import { MapFps } from './map-fps.js';
import {
  type Area,
  type Bounds,
  type Footprint,
  fit,
  type MapFace,
  populatedExtent,
} from './map-framing.js';
import { type MapPlayer, playerHref } from './map-players.js';
import { mapKey as k, mapData, mapParams, mapScope, scopeLost } from './map-query.js';
import { MapStatsMenu } from './map-stats-menu.js';
import type { ServerView } from './telemetry.js';

type Surface = { side: number; samples: number[] };
type Delta = { stamp: number; reset: boolean; columns: [number, number, number][] };
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const columnSize = 16,
  tileColumns = 8,
  tileSize = columnSize * tileColumns;
const textures = new WeakMap<Surface, HTMLCanvasElement>();
function surfaceImage(tile: Surface) {
  const cached = textures.get(tile);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = tile.side;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const image = ctx.createImageData(tile.side, tile.side);
  for (const [i, rgb] of tile.samples.entries()) {
    if (rgb < 0) continue;
    const j = i * 4;
    image.data[j] = rgb >>> 16;
    image.data[j + 1] = (rgb >>> 8) & 255;
    image.data[j + 2] = rgb & 255;
    image.data[j + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  textures.set(tile, c);
  return c;
}
export type MapViewportProps = {
  debug: boolean;
  onToggleDebug: () => void;
  server: ServerView;
  world: string;
  edge: number;
  checkpointEdge: number;
  face: number;
  extent?: MapFace;
  stamp: number;
  processRef: string;
  checkpoints: MapCheckpoint[];
  players: MapPlayer[];
  creatures?: OpenworldCreatureLayer;
  focus: MapPoint | null;
  selectedId: number | null;
  onSelect: (c: MapCheckpoint) => void;
  onCreate?: (p: MapPoint) => void;
  onScopeError: (e: unknown) => void;
  onRefreshIndex: () => void;
};

export function MapPlanFallback({
  debug,
  onToggleDebug,
  server,
  world,
  edge,
  checkpointEdge,
  face,
  extent,
  stamp,
  processRef,
  checkpoints,
  players,
  creatures,
  focus,
  selectedId,
  onSelect,
  onCreate,
  onScopeError,
  onRefreshIndex,
}: MapViewportProps) {
  const t = useT(),
    host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const debugFrames = useRef<number | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => {
      if (e)
        setSize({
          width: Math.round(e.contentRect.width),
          height: Math.round(e.contentRect.height),
        });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const cursor = useRef(stamp);
  const [revisions, setRevisions] = useState<{
    all: number;
    tiles: Map<string, number>;
    columns: number;
  }>(() => ({ all: stamp, tiles: new Map(), columns: stamp }));
  const change = useQuery({
    queryKey: [...mapScope(server), 'terrain-changes', world, face, processRef],
    queryFn: ({ signal }) =>
      mapData<Delta>(
        server,
        `/changes?${mapParams({ world, processRef, since: cursor.current })}`,
        signal,
      ),
    retry: false,
    gcTime: 0,
    refetchInterval: (q) => (scopeLost(q.state.error) ? false : 12000),
    refetchIntervalInBackground: false,
  });
  const delta = change.data;
  useEffect(() => {
    if (!delta || (delta.stamp === cursor.current && !delta.reset)) return;
    cursor.current = delta.stamp;
    if (!delta.reset && !delta.columns.length) return;
    setRevisions((prev) => {
      if (delta.reset || prev.tiles.size + delta.columns.length > 1024)
        return { all: delta.stamp, tiles: new Map(), columns: delta.stamp };
      const tiles = new Map(prev.tiles);
      let touched = false;
      for (const [f, i, j] of delta.columns)
        if (f === face) {
          tiles.set(`${i - (i % 8)},${j - (j % 8)}`, delta.stamp);
          touched = true;
        }
      return touched ? { ...prev, tiles, columns: delta.stamp } : prev;
    });
    onRefreshIndex();
  }, [delta, face, onRefreshIndex]);
  const investigateFootprint =
    !!extent &&
    extent.count > 0 &&
    extent.count <= 262144 &&
    Math.max((extent.i1 ?? 0) - (extent.i0 ?? 0), (extent.j1 ?? 0) - (extent.j0 ?? 0)) > 4096;
  const footprintPath = `/columns?${mapParams({ world, face, processRef, stride: 1, sample: 1, stamp: revisions.columns })}`;
  const footprint = useQuery({
    queryKey: [...mapScope(server), footprintPath],
    queryFn: ({ signal }) => mapData<Footprint>(server, footprintPath, signal),
    enabled: investigateFootprint,
    placeholderData: (prior) => prior,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
  const sample = investigateFootprint ? footprint.data : undefined;
  const completeFootprint = investigateFootprint && extent.count <= 4096;
  const core = useMemo(() => populatedExtent(extent, sample), [extent, sample]);
  const aspect = size.width / Math.max(1, size.height) || 1;
  const [manual, setManual] = useState<Area | null>(null);
  const area =
      manual ??
      fit(edge, core ?? extent, aspect, checkpoints.find((c) => c.pos.face === face)?.pos),
    px = size.width / area.span || 1;
  const zSpan = size.height / px;
  const minX = area.x - area.span / 2,
    minZ = area.z - zSpan / 2;
  const colMax = Math.min(maxOpenworldMapColumn, Math.ceil(edge / 16) - 1);
  const bounds: Bounds = {
    i0: clamp(Math.floor(minX / 16), 0, colMax),
    j0: clamp(Math.floor(minZ / 16), 0, colMax),
    i1: clamp(Math.floor((minX + area.span) / 16), 0, colMax),
    j1: clamp(Math.floor((minZ + zSpan) / 16), 0, colMax),
  };
  const [draftPan, setDraftPan] = useState<{ dx: number; dy: number } | null>(null);
  const [pick, setPick] = useState(false);
  const canPlace = onCreate !== undefined;
  useEffect(() => {
    if (!canPlace) setPick(false);
  }, [canPlace]);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (focus?.face === face) {
      setManual({
        x: clamp(focus.x, 0, edge),
        z: clamp(focus.z, 0, edge),
        span: Math.min(edge, 240),
      });
    }
  }, [focus, edge, face]);
  const tiles: { ci: number; cj: number }[] = [];
  const iStart = bounds.i0 - (bounds.i0 % 8),
    jStart = bounds.j0 - (bounds.j0 % 8);
  const overview =
    (1 + Math.floor((bounds.i1 - iStart) / 8)) * (1 + Math.floor((bounds.j1 - jStart) / 8)) > 16;
  if (!overview && size.width)
    for (let ci = iStart; ci <= bounds.i1; ci += 8)
      for (let cj = jStart; cj <= bounds.j1; cj += 8)
        if (
          extent?.i0 != null &&
          extent.i1 != null &&
          extent.j0 != null &&
          extent.j1 != null &&
          ci <= extent.i1 &&
          ci + 7 >= extent.i0 &&
          cj <= extent.j1 &&
          cj + 7 >= extent.j0
        )
          tiles.push({ ci, cj });
  const tileQueries = useQueries({
    queries: tiles.map(({ ci, cj }) => {
      const stamp = revisions.tiles.get(`${ci},${cj}`) ?? revisions.all;
      const path = `/surface?${mapParams({ world, face, processRef, ci, cj, stamp })}`;
      return {
        queryKey: [...mapScope(server), path],
        queryFn: ({ signal }: { signal: AbortSignal }) => mapData<Surface>(server, path, signal),
        gcTime: 0,
        staleTime: Infinity,
        retry: false,
      };
    }),
  });
  const stride = completeFootprint
    ? 1
    : Math.min(
        2 ** 31,
        2 **
          Math.max(
            0,
            Math.ceil(
              Math.log2(Math.max(bounds.i1 - bounds.i0 + 1, bounds.j1 - bounds.j0 + 1) / 64),
            ),
          ),
      );
  const tooWide = overview && (extent?.count ?? 0) > 262144;
  const columnPath =
    '/columns?' +
    mapParams({ world, face, processRef, ...bounds, stride, stamp: revisions.columns });
  const columns = useQuery({
    queryKey: [...mapScope(server), columnPath],
    queryFn: ({ signal }) => mapData<{ columns: [number, number][] }>(server, columnPath, signal),
    enabled:
      overview &&
      !tooWide &&
      !completeFootprint &&
      (!investigateFootprint || !!sample) &&
      size.width > 0,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const error =
    change.error ??
    (investigateFootprint ? footprint.error : null) ??
    (overview
      ? completeFootprint
        ? null
        : columns.error
      : tileQueries.find((q) => q.error)?.error);
  useEffect(() => {
    if (scopeLost(error)) onScopeError(error);
  }, [error, onScopeError]);
  const loading = overview
    ? !tooWide && (completeFootprint ? footprint.isPending : columns.isPending)
    : tileQueries.some((q) => q.isPending);
  useEffect(() => {
    const el = canvas.current,
      ctx = el?.getContext('2d');
    if (!el || !ctx || !size.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (el.width !== Math.round(size.width * dpr) || el.height !== Math.round(size.height * dpr)) {
      el.width = Math.round(size.width * dpr);
      el.height = Math.round(size.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (debugFrames.current !== null) debugFrames.current++;
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = false;
    const left = (x: number) => (x - minX) * px + (draftPan?.dx ?? 0);
    const top = (z: number) => (z - minZ) * px + (draftPan?.dy ?? 0);
    if (overview) {
      ctx.fillStyle = '#79aa94';
      for (const [i, j] of (completeFootprint ? sample : columns.data)?.columns ?? []) {
        ctx.fillRect(
          left(i * 16),
          top(j * 16),
          Math.max(3, 16 * stride * px),
          Math.max(3, 16 * stride * px),
        );
      }
    } else {
      tileQueries.forEach((q, idx) => {
        const tile = tiles[idx];
        if (tile && q.data && !q.error) {
          ctx.drawImage(
            surfaceImage(q.data),
            left(tile.ci * 16),
            top(tile.cj * 16),
            tileSize * px,
            tileSize * px,
          );
        }
      });
    }
  });
  function zoom(factor: number) {
    setManual({
      ...area,
      span: clamp(area.span * factor, Math.min(edge, 16), edge * 1.25 * Math.max(1, aspect)),
    });
  }
  function move(x: number, z: number) {
    setManual({ ...area, x: clamp(area.x + x, 0, edge), z: clamp(area.z + z, 0, edge) });
  }
  function keyboard(e: KeyboardEvent<HTMLCanvasElement>) {
    if (e.target !== e.currentTarget) return;
    const step = area.span / 4;
    switch (e.key) {
      case 'ArrowLeft':
        move(-step, 0);
        break;
      case 'ArrowRight':
        move(step, 0);
        break;
      case 'ArrowUp':
        move(0, -step);
        break;
      case 'ArrowDown':
        move(0, step);
        break;
      case '+':
      case '=':
        zoom(0.5);
        break;
      case '-':
        zoom(2);
        break;
      case 'Enter':
        if (!pick || !onCreate || area.x > checkpointEdge || area.z > checkpointEdge) return;
        setPick(false);
        onCreate({ face, x: area.x, z: area.z });
        break;
      case 'Escape':
        setPick(false);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
  function end(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    setDraftPan(null);
    const dx = e.clientX - d.x,
      dy = e.clientY - d.y;
    if (Math.hypot(dx, dy) > 4) {
      move(-dx / px, -dy / px);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const x = minX + (e.clientX - r.left) / px,
      z = minZ + (e.clientY - r.top) / px;
    if (!pick) {
      if (!overview || !sample) return;
      let nearest: MapPoint | undefined;
      let distance = 10;
      for (const [i, j] of sample.columns) {
        const cx = (i + 0.5) * columnSize,
          cz = (j + 0.5) * columnSize;
        const d = Math.hypot(cx - x, cz - z) * px;
        if (d < distance) {
          distance = d;
          nearest = { x: cx, z: cz, face };
        }
      }
      if (nearest) setManual({ x: nearest.x, z: nearest.z, span: Math.min(edge, 240) });
      return;
    }
    if (!onCreate || x < 0 || z < 0 || x > checkpointEdge || z > checkpointEdge) return;
    setPick(false);
    onCreate({ face, x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 });
  }
  const pin = (p: MapPoint) => {
    if (p.face !== face) return null;
    const x = (p.x - minX) * px + (draftPan?.dx ?? 0),
      y = (p.z - minZ) * px + (draftPan?.dy ?? 0);
    if (x < 0 || y < 0 || x > size.width || y > size.height) return null;
    return { left: x, top: y } as CSSProperties;
  };
  const speciesNames = useMemo(
    () => new Map(creatures?.species.map((s) => [s.id, s.name || s.key])),
    [creatures],
  );
  // Coincident positions for the same species share a single marker.
  const creaturePins = useMemo(() => {
    const pins = new Map<string, OpenworldCreatureLayer['markers'][number]>();
    for (const marker of creatures?.markers ?? []) {
      if (marker.face === face) pins.set(`${marker.species}/${marker.x}/${marker.z}`, marker);
    }
    return [...pins];
  }, [creatures, face]);
  const scale = 10 ** Math.floor(Math.log10(Math.max(1, area.span * 0.16)));
  const scaleBar =
    (area.span * 0.16) / scale >= 5
      ? 5 * scale
      : (area.span * 0.16) / scale >= 2
        ? 2 * scale
        : scale;
  return (
    <div className="ow-map-plot">
      <div className="ow-map-controls">
        <div className="ow-map-zoom">
          <button
            type="button"
            className="secondary"
            aria-label={t(k('zoomOut'))}
            onClick={() => zoom(2)}
          >
            −
          </button>
          <button
            type="button"
            className="secondary"
            aria-label={t(k('zoomIn'))}
            onClick={() => zoom(0.5)}
          >
            +
          </button>
          <button type="button" className="secondary" onClick={() => setManual(null)}>
            {t(k('recenter'))}
          </button>
          {core && (
            <button
              type="button"
              className="secondary"
              onClick={() => setManual(fit(edge, extent, aspect))}
            >
              {t(k('showAllTerrain'))}
            </button>
          )}
        </div>
        {onCreate && (
          <button
            type="button"
            className="secondary"
            aria-pressed={pick}
            onClick={() => setPick(!pick)}
          >
            {t(k('placePin'))}
          </button>
        )}
      </div>
      <div
        ref={host}
        className={`ow-map-stage${pick ? ' ow-map-picking' : ''}`}
        onPointerDown={(e) => {
          if (
            e.button !== 0 ||
            (e.target !== e.currentTarget &&
              e.target !== canvas.current &&
              !(
                e.target instanceof HTMLElement && e.target.classList.contains('ow-creature-pin')
              )) ||
            drag.current
          )
            return;
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d && e.pointerId === d.id) setDraftPan({ dx: e.clientX - d.x, dy: e.clientY - d.y });
        }}
        onPointerUp={end}
        onPointerCancel={() => {
          drag.current = null;
          setDraftPan(null);
        }}
      >
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-haspopup="menu"
          aria-keyshortcuts="Shift+F10"
          aria-label={t(k('stage'), { world, face })}
          aria-description={t(k('panHint'))}
          onKeyDown={keyboard}
        />
        {debug && <MapFps frames={debugFrames} />}
        <MapStatsMenu canvas={canvas} enabled={debug} onToggle={onToggleDebug} />
        {focus && pin(focus) && !selectedId && (
          <span
            role="img"
            className="ow-map-location"
            aria-label={t(k('selectedPosition'))}
            style={pin(focus) ?? undefined}
          />
        )}
        {creaturePins.map(([markerKey, m]) => {
          const style = pin(m);
          if (!style) return null;
          const name =
            speciesNames.get(m.species) || t(k('layers.unknownSpecies'), { id: m.species });
          const label = t(k('layers.creatureMarker'), { name });
          return (
            <span
              key={markerKey}
              className="ow-creature-pin"
              role="img"
              aria-label={label}
              title={label}
              style={style}
            />
          );
        })}
        {checkpoints.map((c) => {
          const style = pin(c.pos);
          return (
            style && (
              <button
                key={c.id}
                type="button"
                className={`ow-map-pin${c.id === selectedId ? ' selected' : ''}`}
                aria-label={c.name}
                title={c.name}
                onClick={() => onSelect(c)}
                style={{ ...style, '--pin': c.color } as CSSProperties}
              >
                <span>
                  <CheckpointGlyph icon={c.icon} />
                </span>
              </button>
            )
          );
        })}
        {players
          .filter((p) => p.world === world)
          .map((p) => {
            const style = pin(p);
            return (
              style && (
                <Link
                  className="ow-map-player"
                  key={p.id}
                  to={playerHref(server.serverId, p, processRef)}
                  title={p.name}
                  aria-label={t(k('openPlayer'), { name: p.name })}
                  style={style}
                >
                  {p.name}
                </Link>
              )
            );
          })}
        {!extent?.count && <span className="ow-map-status">{t(k('unexploredFace'))}</span>}
        {tooWide && <span className="ow-map-status">{t(k('zoomForTerrain'))}</span>}
        {loading && !error && (
          <span className="ow-map-status" role="status">
            {t('web.loading')}
          </span>
        )}
        <div className="ow-map-scale" aria-hidden="true">
          <b style={{ width: scaleBar * px }} />
          {scaleBar >= 1000 ? `${scaleBar / 1000} km` : `${scaleBar} m`}
        </div>
      </div>
      {error && !scopeLost(error) && (
        <ErrorNotice
          error={error}
          retry={() => {
            if (change.error) void change.refetch();
            if (footprint.error && investigateFootprint) void footprint.refetch();
            if (columns.error && overview && !completeFootprint) void columns.refetch();
            for (const q of tileQueries) if (q.error) void q.refetch();
          }}
        />
      )}
      <div className="ow-map-key">
        <span>
          <i />
          {t(k('unknown'))}
        </span>
        {overview && (
          <span>
            <i className="known" />
            {t(k('explored'))}
          </span>
        )}
        {creatures && (
          <span>
            <i className="ow-creature-dot" />
            {t(k('layers.markerLegend'))}
          </span>
        )}
        <span>{t(k(pick ? 'placeHint' : 'panHint'))}</span>
      </div>
    </div>
  );
}
