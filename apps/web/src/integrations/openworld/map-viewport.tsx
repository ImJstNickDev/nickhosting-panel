import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { apiError } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import type { AtlasTerrainStatus } from './atlas-backoff.js';
import { canCaptureFlightKeyboard } from './atlas-pointer-lock.js';
import { AtlasScene, AtlasUnsupported } from './atlas-scene.js';
import type {
  AtlasController,
  AtlasFlightLock,
  AtlasFrame,
  AtlasMode,
  AtlasPoint,
} from './atlas-types.js';
import {
  type MapPalette,
  readAtlasMeshes,
  readAtlasResource,
  type SeedLegend,
  useAtlasCoverage,
} from './map-atlas-data.js';
import { CheckpointGlyph } from './map-checkpoints.js';
import type { MapDebugRecorder } from './map-debug-recorder.js';
import { MapDebugStats } from './map-debug-stats.js';
import { type FeatureKind, useFeatureLayer } from './map-feature-layer.js';
import { fit, populatedExtent } from './map-framing.js';
import { type AtlasMarker, MapMarkerLayer } from './map-marker-layer.js';
import type { MapViewportProps } from './map-plan-fallback.js';
import { playerHref } from './map-players.js';
import { mapKey as k, mapBase, mapParams, scopeLost, useMapData } from './map-query.js';
import { MapStatsMenu } from './map-stats-menu.js';
import { ViewportTools } from './map-viewport-tools.js';

export type { MapFace } from './map-framing.js';

const Fallback = lazy(() =>
  import('./map-plan-fallback.js').then((m) => ({ default: m.MapPlanFallback })),
);
function cameraHint(
  mode: AtlasMode,
  lock: AtlasFlightLock,
  {
    mouseAvailable,
    inspect,
    placing,
    keyboardCaptured,
    canFlyFullscreen,
  }: {
    mouseAvailable: boolean;
    inspect: boolean;
    placing: boolean;
    keyboardCaptured: boolean;
    canFlyFullscreen: boolean;
  },
) {
  if (placing) return 'placeHint';
  if (mode !== 'fly') return 'atlas.panHint';
  if (lock === 'locked') return keyboardCaptured ? 'atlas.flyLocked' : 'atlas.flyLockedWindow';
  if (inspect) return 'atlas.inspectHint';
  if (!mouseAvailable || lock === 'unavailable') return 'atlas.flyDrag';
  return canFlyFullscreen ? 'atlas.flyHintFullscreen' : 'atlas.flyHint';
}

export type FactoryPin = { face: number; x: number; z: number; nodes?: number | null };
type ViewProps = MapViewportProps & {
  seed: boolean;
  biomes: boolean;
  legend?: SeedLegend;
  feature?: FeatureKind;
  tracking?: number;
  stopFollowing: () => void;
  factories: FactoryPin[];
  onCheckpointOpen: () => void;
  onFallback: () => void;
  mode: AtlasMode;
  onModeChange: (mode: AtlasMode) => void;
};
export function MapViewport(props: ViewProps) {
  const t = useT();
  const [fallback, setFallback] = useState(false);
  if (fallback)
    return (
      <>
        <p role="status" className="ow-map-layer-note">
          {t(k('atlas.fallback'))}
        </p>
        <Suspense fallback={<Loading />}>
          <Fallback
            {...props}
            onSelect={(c) => {
              props.onSelect(c);
              props.onCheckpointOpen();
            }}
          />
        </Suspense>
      </>
    );
  return (
    <AtlasViewport
      {...props}
      unavailable={() => {
        setFallback(true);
        props.onFallback();
      }}
    />
  );
}

function AtlasViewport(props: ViewProps & { unavailable: () => void }) {
  const {
    server,
    world,
    face,
    edge,
    processRef,
    extent,
    checkpoints,
    creatures,
    factories,
    focus,
    mode,
    onModeChange,
  } = props;
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const debugFrames = useRef<number | null>(null);
  const recorder = useRef<MapDebugRecorder | null>(null);
  const debugMode = useRef(mode);
  debugMode.current = mode;
  const overlay = useRef<HTMLDivElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const scene = useRef<AtlasController | null>(null);
  const [frame, setFrame] = useState<AtlasFrame>();
  const { placing: pick, onPlacingChange: setPick } = props;
  const [inspect, setInspect] = useState(false);
  const [lockState, setLockState] = useState<AtlasFlightLock>('idle');
  const [keyboardCaptured, setKeyboardCaptured] = useState(false);
  const [canFlyFullscreen, setCanFlyFullscreen] = useState(false);
  const [mouseAvailable, setMouseAvailable] = useState(false);
  const locked = mode === 'fly' && lockState === 'locked';
  const flightHint = cameraHint(mode, lockState, {
    mouseAvailable,
    inspect,
    placing: pick,
    keyboardCaptured,
    canFlyFullscreen,
  });
  useEffect(() => {
    const mouse = window.matchMedia('(any-pointer: fine)');
    const update = () => {
      setMouseAvailable(mouse.matches && typeof canvas.current?.requestPointerLock === 'function');
      setCanFlyFullscreen(!!canvas.current && canCaptureFlightKeyboard(canvas.current));
    };
    update();
    mouse.addEventListener('change', update);
    return () => mouse.removeEventListener('change', update);
  }, []);
  const [point, setPoint] = useState<(AtlasPoint & { label?: string }) | null>(null);
  const [terrainStatus, setTerrainStatus] = useState<AtlasTerrainStatus>(null);
  const [streamError, setStreamError] = useState<unknown>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const moved = useRef(!!props.initialCamera);
  const coverage = useAtlasCoverage(
    server,
    world,
    face,
    processRef,
    props.stamp,
    extent,
    frame?.coverageBounds ?? frame?.bounds,
    scene,
    props.onRefreshIndex,
  );
  const query = mapParams({ world, processRef });
  const palette = useMapData<MapPalette>(server, `/palette?${query}`, true, undefined, Infinity);
  const legend = props.legend;
  const features = useFeatureLayer(
    server,
    world,
    processRef,
    face,
    frame,
    legend,
    props.feature,
    scene,
    coverage.data,
  );
  const core = useMemo(() => populatedExtent(extent, coverage.sample), [extent, coverage.sample]);
  const current = useRef({ props, coverage, pick, core });
  current.current = { props, coverage, pick, core };

  // Projection updates do not redraw terrain or enqueue a React render while the camera moves.
  const pins = useRef<
    { el: HTMLElement; x: number; z: number; y?: number; seed: boolean; px?: number; py?: number }[]
  >([]);
  const projectPins = useCallback(() => {
    const engine = scene.current;
    if (!engine) return;
    for (const p of pins.current) {
      const at = engine.project(p.x, p.z, p.y);
      const visible = at.visible && (!p.seed || engine.isSeedArea(p.x, p.z));
      if (p.el.hidden === visible) p.el.hidden = !visible;
      if (visible) {
        const x = Math.round(at.x * 10) / 10,
          y = Math.round(at.y * 10) / 10;
        if (x !== p.px || y !== p.py) {
          p.el.style.translate = `${x}px ${y}px`;
          p.px = x;
          p.py = y;
        }
      }
    }
  }, []);
  useLayoutEffect(() => {
    const scan = () => {
      pins.current = Array.from(
        overlay.current?.querySelectorAll<HTMLElement>(
          '[data-x]:not(.ow-map-cluster-list [data-x])',
        ) ?? [],
        (el) => ({
          el,
          seed: el.hasAttribute('data-seed'),
          x: Number(el.dataset.x),
          z: Number(el.dataset.z),
          y: el.dataset.y == null ? undefined : Number(el.dataset.y),
        }),
      );
      projectPins();
    };
    scan();
    const observer = new MutationObserver(scan);
    if (overlay.current)
      observer.observe(overlay.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-x', 'data-z', 'data-y'],
      });
    return () => observer.disconnect();
  }, [projectPins]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const { props: p, core: initialCore } = current.current;
    const initialView =
      p.initialCamera ??
      (p.focus
        ? { x: p.focus.x, z: p.focus.z, span: Math.min(edge, 240) }
        : fit(edge, initialCore ?? p.extent, el.clientWidth / Math.max(1, el.clientHeight)));
    let active = true;
    setTerrainStatus(null);
    const fail = (error: unknown) => {
      if (!active) return;
      if (scopeLost(error)) current.current.props.onScopeError(error);
      else setStreamError(error);
    };
    let engine: AtlasController;
    try {
      engine = new AtlasScene(el, {
        face,
        edge,
        initialView,
        load: (request, signal) =>
          readAtlasResource(
            server.serverId,
            world,
            processRef,
            face,
            current.current.coverage.stamp.current,
            request,
            signal,
            recorder.current,
          ),
        loadMeshes: (requests, signal) =>
          readAtlasMeshes(
            server.serverId,
            world,
            processRef,
            face,
            current.current.coverage.stamp.current,
            requests,
            signal,
            recorder.current,
          ),
        loadTexture: async (id, signal) => {
          const response = await fetch(
            `${mapBase(server.serverId)}/texture?${mapParams({ world, processRef, id })}`,
            { credentials: 'same-origin', redirect: 'error', signal },
          );
          if (!response.ok)
            throw apiError(
              await response.json().catch(() => ({})),
              response.status,
              response.headers.get('Retry-After'),
            );
          return response.status === 204 ? null : response.blob();
        },
        onCamera: (view) => {
          if (active) setFrame(view);
        },
        onFrame: (yaw) => {
          if (debugFrames.current !== null) debugFrames.current++;
          recorder.current?.draw(yaw);
          projectPins();
        },
        onFlightKeyboardLockChange: (captured) => {
          if (active) setKeyboardCaptured(captured);
        },
        onFlightLockChange: (state) => {
          if (!active) return;
          setLockState(state);
          if (state === 'locked') {
            setInspect(false);
            setPoint(null);
          }
        },
        onNavigate: () => {
          moved.current = true;
          const live = current.current.props;
          if (live.tracking !== undefined) live.stopFollowing();
        },
        onPick: (_px, _py, at) => {
          const { props: live, pick: placing } = current.current;
          if (
            placing &&
            live.onCreate &&
            at.x >= 0 &&
            at.z >= 0 &&
            at.x <= live.checkpointEdge &&
            at.z <= live.checkpointEdge
          ) {
            live.onPlacingChange(false);
            setPoint(null);
            live.onCreate({
              face,
              x: Math.round(at.x * 100) / 100,
              z: Math.round(at.z * 100) / 100,
              ...(at.source === 'live' && at.y != null ? { y: at.y } : {}),
            });
          } else {
            setPoint(at);
          }
        },
        onUnavailable: () => {
          if (active) current.current.props.unavailable();
        },
        onError: fail,
        onTerrainStatus: (status) => {
          if (active) setTerrainStatus(status);
        },
      });
      scene.current = engine;
      setFrame(engine.getView());
    } catch (error) {
      if (error instanceof AtlasUnsupported) current.current.props.unavailable();
      else setStreamError(error);
      return;
    }
    return () => {
      active = false;
      scene.current = null;
      p.onCameraLeave?.(engine.snapshot());
      engine.destroy();
    };
  }, [edge, face, world, processRef, server.serverId, projectPins]);

  useLayoutEffect(() => {
    scene.current?.setFlightInspection(pick || (mode === 'fly' && inspect));
  }, [pick, inspect, mode]);
  useEffect(() => {
    scene.current?.setMode(mode);
    if (mode !== 'fly') setInspect(false);
  }, [mode]);
  useEffect(() => {
    if (palette.data) scene.current?.setPalette(palette.data.materials, palette.data.voxelSize);
  }, [palette.data]);
  useEffect(() => {
    scene.current?.setSeed(
      props.seed && !!legend,
      props.biomes ? 'biomes' : 'surface',
      legend?.biomes,
      legend?.faceEdgeMeters,
      legend?.maxZoom,
    );
    setPoint((p) =>
      p?.source === 'seed' && (!props.seed || (p.label && p.label !== props.feature?.name))
        ? null
        : p,
    );
  }, [props.seed, props.biomes, props.feature?.name, legend]);
  useEffect(() => {
    const i0 = extent?.i0,
      i1 = extent?.i1,
      j0 = extent?.j0,
      j1 = extent?.j1;
    const full = coverage.oversized && i0 != null && i1 != null && j0 != null && j1 != null;
    scene.current?.setSurveyBounds(full ? { i0, i1, j0, j1 } : null);
  }, [coverage.oversized, extent]);
  useEffect(() => {
    if (coverage.data || coverage.empty)
      scene.current?.setCoverage(coverage.data?.columns ?? [], coverage.stride, coverage.audited);
  }, [coverage.data, coverage.stride, coverage.empty, coverage.audited]);
  useEffect(() => {
    if (!moved.current && !focus && core && canvas.current)
      scene.current?.setView(
        fit(edge, core, canvas.current.clientWidth / Math.max(1, canvas.current.clientHeight)),
      );
  }, [core, focus, edge]);
  const lastTracking = useRef<number>(undefined);
  const lastFocus = useRef<typeof focus>(props.initialCamera ? focus : null);
  useEffect(() => {
    const following = props.tracking !== undefined && lastTracking.current === props.tracking;
    lastTracking.current = props.tracking;
    if (lastFocus.current === focus) return;
    lastFocus.current = focus;
    if (focus?.face === face) {
      scene.current?.setView({
        x: focus.x,
        z: focus.z,
        span: following ? (scene.current?.getView().span ?? 240) : Math.min(edge, 240),
      });
      setPoint(null);
    }
  }, [focus, edge, face, props.tracking]);
  const canPlace = !!props.onCreate;
  useEffect(() => {
    if (!pick) return;
    if (!canPlace) setPick(false);
    else {
      setInspect(false);
      canvas.current?.focus({ preventScroll: true });
    }
  }, [pick, canPlace, setPick]);
  const errors = [palette.error, coverage.error, features.error, streamError];
  const error = errors.find(scopeLost) ?? errors.find(Boolean);
  useEffect(() => {
    if (scopeLost(error)) props.onScopeError(error);
  }, [error, props.onScopeError]);
  useEffect(() => {
    const onChange = () =>
      setFullscreen(
        !!document.fullscreenElement &&
          document.fullscreenElement === plot.current?.closest('.ow-panel'),
      );
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const speciesNames = useMemo(
    () => new Map(creatures?.species.map((s) => [s.id, s.name || s.key])),
    [creatures],
  );
  const creaturePins = useMemo(
    () =>
      Array.from(
        new Map(
          creatures?.markers
            .filter((m) => m.face === face)
            .map((m) => [`${m.species}-${m.x}-${m.z}`, m]),
        ).entries(),
      ),
    [creatures, face],
  );
  const checkpointPins = useMemo<AtlasMarker[]>(
    () =>
      checkpoints
        .filter((c) => c.pos.face === face)
        .map((c) => ({
          ...c.pos,
          id: c.id,
          name: c.name,
          selected: c.id === props.selectedId,
          element: (
            <button
              key={c.id}
              type="button"
              className={`ow-map-pin${c.id === props.selectedId ? ' selected' : ''}`}
              style={{ '--pin': c.color } as CSSProperties}
              aria-label={c.name}
              title={c.name}
              data-x={c.pos.x}
              data-z={c.pos.z}
              data-y={c.pos.y}
              onClick={() => {
                setPoint(null);
                props.onSelect(c);
                props.onCheckpointOpen();
              }}
            >
              <span>
                <CheckpointGlyph icon={c.icon} />
              </span>
            </button>
          ),
        })),
    [checkpoints, face, props.selectedId, props.onSelect, props.onCheckpointOpen],
  );
  const recenter = (all = false) => {
    if (props.tracking !== undefined) props.stopFollowing();
    const el = canvas.current;
    if (!el) return;
    moved.current = all;
    scene.current?.setView(
      fit(
        edge,
        all ? extent : (core ?? extent),
        el.clientWidth / Math.max(1, el.clientHeight),
        checkpoints.find((c) => c.pos.face === face)?.pos,
      ),
    );
  };
  const span = frame?.span ?? 1;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(0.01, span * 0.13)));
  const scale =
    magnitude * ((span * 0.13) / magnitude >= 5 ? 5 : (span * 0.13) / magnitude >= 2 ? 2 : 1);
  const pointBiome =
    point?.source === 'seed' ? legend?.biomes.find((b) => b.id === point.biome)?.name : null;
  return (
    <div
      ref={plot}
      className="ow-map-plot ow-atlas ow-walkable-map"
      data-flying={locked || undefined}
    >
      <div className="ow-map-controls">
        <fieldset aria-label={t(k('atlas.camera'))} className="ow-atlas-modes">
          {(['plan', 'iso', 'fly'] as const).map((m) => (
            <button
              type="button"
              className="secondary"
              aria-pressed={mode === m}
              key={m}
              onClick={() => {
                onModeChange(m);
                canvas.current?.focus({ preventScroll: true });
              }}
            >
              {t(k(`atlas.${m}`))}
            </button>
          ))}
        </fieldset>
        <ViewportTools
          zoom={(factor) => {
            moved.current = true;
            scene.current?.zoom(factor);
          }}
          center={() => recenter()}
          fit={core ? () => recenter(true) : undefined}
          fullscreen={fullscreen}
          toggleFullscreen={
            document.fullscreenEnabled
              ? () => {
                  (fullscreen
                    ? document.exitFullscreen()
                    : plot.current?.closest('.ow-panel')?.requestFullscreen()
                  )?.catch(setStreamError);
                }
              : undefined
          }
        >
          <span>
            <i />
            {t(k('unknown'))}
          </span>
          {props.seed && legend && (
            <span className="ow-atlas-seed-key">{t(k('atlas.source.seed'))}</span>
          )}
          <span>{t(k(flightHint))}</span>
        </ViewportTools>
      </div>
      <div
        className={`ow-map-stage${pick || (mode === 'fly' && inspect) ? ' ow-map-picking' : ''}`}
        onWheelCapture={() => {
          moved.current = true;
        }}
        onPointerDownCapture={() => {
          moved.current = true;
        }}
        onKeyDownCapture={(e) => {
          moved.current = true;
          if (e.key === 'Escape') {
            setPick(false);
            setInspect(false);
            setPoint(null);
          }
        }}
      >
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-haspopup="menu"
          aria-keyshortcuts="Shift+F10"
          aria-label={t(k('stage'), { world, face })}
          aria-description={t(k(flightHint))}
        />
        <div ref={overlay} className="ow-atlas-pins">
          {focus?.face === face && props.selectedId === null && (
            <span
              role="img"
              className="ow-map-location"
              aria-label={t(k('selectedPosition'))}
              data-x={focus.x}
              data-z={focus.z}
              data-y={focus.y}
            />
          )}
          <MapMarkerLayer
            markers={checkpointPins}
            frame={frame}
            scene={scene}
            stopFollowing={props.stopFollowing}
          />
          {props.players
            .filter((p) => p.face === face && p.world === world)
            .map((p) => (
              <Link
                key={p.id}
                className="ow-map-player"
                data-x={p.x}
                data-z={p.z}
                to={playerHref(server.serverId, p, processRef)}
                aria-label={t(k('openPlayer'), { name: p.name })}
              >
                {p.name}
              </Link>
            ))}
          {creaturePins.map(([id, m]) => {
            const name =
              speciesNames.get(m.species) || t(k('layers.unknownSpecies'), { id: m.species });
            return (
              <button
                key={id}
                type="button"
                data-x={m.x}
                data-z={m.z}
                className="ow-creature-pin"
                aria-label={t(k('layers.creatureMarker'), { name })}
                title={name}
                onClick={() => setPoint({ x: m.x, z: m.z, source: 'live', label: name })}
              />
            );
          })}
          {props.feature &&
            features.tile.features.map((f) => (
              <button
                key={`seed/${f.kind}/${f.x}/${f.y}/${f.z}`}
                className="ow-predicted-pin"
                type="button"
                data-seed=""
                data-x={f.x}
                data-z={f.z}
                aria-label={props.feature?.name}
                title={props.feature?.name}
                style={{ '--pin': props.feature?.color } as CSSProperties}
                onClick={() => setPoint({ ...f, source: 'seed', label: props.feature?.name })}
              >
                ◇
              </button>
            ))}
          {factories
            .filter((p) => p.face === face)
            .map((p) => (
              <button
                key={`${p.x},${p.z}`}
                className="ow-factory-pin"
                type="button"
                data-x={p.x}
                data-z={p.z}
                title={t(k('atlas.factory'))}
                aria-label={t(k('atlas.factory'))}
                onClick={() =>
                  setPoint({ x: p.x, z: p.z, source: 'live', label: t(k('atlas.factory')) })
                }
              >
                ◆
              </button>
            ))}
        </div>
        {!extent?.count && !props.seed && (
          <span className="ow-map-status">{t(k('unexploredFace'))}</span>
        )}
        {frame && (
          <div className="ow-map-scale" aria-hidden="true">
            <b style={{ width: (scale / span) * frame.width }} />
            {scale >= 1000 ? `${scale / 1000} km` : `${scale} m`}
          </div>
        )}
        {props.debug && (
          <MapDebugStats
            frames={debugFrames}
            recorder={recorder}
            scene={scene}
            mode={debugMode}
            serverId={server.serverId}
            face={face}
            world={world}
            processRef={processRef}
          />
        )}
        <MapStatsMenu canvas={canvas} enabled={props.debug} onToggle={props.onToggleDebug} />
        {locked && <span className="ow-atlas-reticle" aria-hidden="true" />}
        {mode !== 'plan' && !locked && (
          <div className="ow-atlas-motion">
            <button
              type="button"
              aria-label={t(k('atlas.turnLeft'))}
              onClick={() => scene.current?.rotate(-1)}
            >
              ↶
            </button>
            <button
              type="button"
              aria-label={t(k('atlas.turnRight'))}
              onClick={() => scene.current?.rotate(1)}
            >
              ↷
            </button>
            {mode === 'fly' &&
              (['forward', 'back', 'rise', 'descend'] as const).map((move, i) => (
                <button
                  type="button"
                  key={move}
                  aria-label={t(k(`atlas.${move}`))}
                  onClick={() => {
                    const step = Math.max(4, span * 0.1);
                    scene.current?.move(
                      0,
                      i === 0 ? step : i === 1 ? -step : 0,
                      i === 2 ? step : i === 3 ? -step : 0,
                    );
                  }}
                >
                  {['↑', '↓', '+', '−'][i]}
                </button>
              ))}
          </div>
        )}
        {point && (
          <div className="ow-atlas-point" role="status">
            <div>
              <strong>{(point.label ?? pointBiome) || t(k(`atlas.source.${point.source}`))}</strong>
              {point.source === 'seed' && (point.label || pointBiome) && (
                <small>{t(k('atlas.source.seed'))}</small>
              )}
              <small>
                X {Math.round(point.x)} · Z {Math.round(point.z)}
                {point.y != null && ` · ${Math.round(point.y)} m`}
              </small>
            </div>
            <button
              className="secondary"
              type="button"
              aria-label={t('web.close')}
              onClick={() => setPoint(null)}
            >
              ×
            </button>
          </div>
        )}
      </div>
      {(pick || locked || (mode === 'fly' && mouseAvailable)) && (
        <div className="ow-flight-controls">
          {pick && (
            <>
              <span role="status">{t(k('placeHint'))}</span>
              <button type="button" className="secondary" onClick={() => setPick(false)}>
                {t('web.cancel')}
              </button>
            </>
          )}
          {locked && <span role="status">{t(k(flightHint))}</span>}
          {mode === 'fly' && mouseAvailable && !locked && !pick && (
            <>
              <button
                type="button"
                className="secondary"
                onClick={(event) => {
                  setInspect(false);
                  setPick(false);
                  scene.current?.setFlightInspection(false);
                  scene.current?.requestFlightLock(event.detail ? event.nativeEvent : undefined);
                }}
              >
                {t(k('atlas.capture'))}
              </button>
              <button
                type="button"
                className="secondary"
                aria-pressed={inspect}
                onClick={() => {
                  setPick(false);
                  setInspect(!inspect);
                  canvas.current?.focus({ preventScroll: true });
                }}
              >
                {t(k('atlas.inspect'))}
              </button>
            </>
          )}
        </div>
      )}
      {props.feature && (features.wide || features.tile.truncated) && (
        <p role="status" className="ow-map-layer-note">
          {t(k(features.wide ? 'atlas.featureZoom' : 'atlas.featureSample'))}
        </p>
      )}
      {!error && terrainStatus && (
        <div className="ow-map-layer-note">
          <span role="status">
            {t(
              k(terrainStatus === 'retrying' ? 'atlas.terrainRetrying' : 'atlas.terrainIncomplete'),
            )}
          </span>{' '}
          {terrainStatus === 'incomplete' && (
            <button type="button" className="secondary" onClick={() => scene.current?.retry()}>
              {t('web.retry')}
            </button>
          )}
        </div>
      )}
      {error && !scopeLost(error) ? (
        <ErrorNotice
          error={error}
          retry={() => {
            setStreamError(null);
            coverage.retry();
            if (palette.error) void palette.refetch();
            if (features.error) features.retry();
            scene.current?.retry();
          }}
        />
      ) : null}
    </div>
  );
}
