import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  maxOpenworldMapColumn,
  type OpenworldMapWorld,
} from '../../../../../games/openworld/src/world-map.js';
import { projectOpenworldPosition } from '../../../../../games/openworld/src/world-projection.js';
import { useFormat, useT } from '../../app/i18n.js';
import { Check, ErrorNotice, Loading, Select } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import type { AtlasCameraSnapshot, AtlasMode } from './atlas-types.js';
import { useFactoryConnection } from './factory-connection.js';
import type { MapPalette, SeedLegend } from './map-atlas-data.js';
import {
  CheckpointDialog,
  type CheckpointForm,
  CheckpointGlyph,
  faces,
  type MapCheckpoint,
  type MapPoint,
} from './map-checkpoints.js';
import { CreaturePopulation, useCreatureLayer } from './map-creatures.js';
import { factoryMapPoint, useFactoryData } from './map-factories.js';
import { mapFocusQuery, mapSearchCoordinates, useMapPlayers, zoneMapFocus } from './map-players.js';
import { mapKey as k, mapParams, scopeLost, useMapData } from './map-query.js';
import { SpaceView } from './map-space.js';
import { CreatureSpawning } from './map-spawning.js';
import { type MapFace, MapViewport } from './map-viewport.js';
import { type TelemetryViewProps, key as telemetryKey, withTelemetrySession } from './telemetry.js';
import './world-map.css';
import './map-layers.css';
import './map-explorer.css';

type MapPanel = 'checkpoints' | 'search' | 'layers' | 'creatures';
type TerrainBookmark = { world: string; face: number; camera: AtlasCameraSnapshot };

type WorldList = { processRef: string; worlds: OpenworldMapWorld[] };
type Index = { stamp: number; faces: MapFace[] };

function MapGlyph({ name }: { name: 'space' | 'checkpoints' | 'layers' }) {
  const paths = {
    space:
      'M18 12a6 6 0 1 1-12 0 6 6 0 1 1 12 0ZM7 9c-3.7 2.5-6 5.1-5.1 6.5 1 1.7 6.3.8 12.1-2.1S23.4 7.6 22.4 6c-.6-1-2.6-1-5.3-.4',
    checkpoints: 'M5 21V4m0 1c4-4 8 3 14-1v10c-6 4-10-3-14 1',
    layers: 'm12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5',
  };
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function MapSection(props: TelemetryViewProps) {
  const t = useT();
  const canRead = props.permissionKeys.includes('game.openworld.map.read');
  const running = props.runtimeState === 'running';
  const worlds = useMapData<WorldList>(props, '', running && canRead);
  const [initial] = useState(() => ({
    point: mapFocusQuery(),
    zone: zoneMapFocus(),
    factory: new URLSearchParams(window.location.hash.slice(1)).get('origin') === 'factories',
  }));
  const inspect =
    props.permissionKeys.includes('game.openworld.players.read') &&
    props.permissionKeys.includes('game.openworld.players.inspect');
  const zone =
    canRead && props.permissionKeys.includes('game.openworld.rules.view') ? initial.zone : null;
  const zoneWorld = worlds.data?.worlds.find((w) => w.key === zone?.world);
  const needsEdge = !!(zone && zoneWorld && !zoneWorld.faceEdgeMeters);
  const palette = useMapData<MapPalette>(
    props,
    `/palette?${mapParams({ world: zoneWorld?.key ?? '', processRef: worlds.data?.processRef ?? '' })}`,
    needsEdge && running,
    undefined,
    Infinity,
  );
  const zonePoint =
    zone &&
    zoneWorld &&
    projectOpenworldPosition(
      zone.lon,
      zone.lat,
      zoneWorld.faceEdgeMeters ?? palette.data?.faceEdgeMeters ?? 0,
    );
  const entry =
    zonePoint && zone
      ? { world: zone.world, ...zonePoint }
      : initial.factory || inspect
        ? initial.point
        : null;
  return (
    <section className="ow-workspace ow-map" aria-label={t(k('title'))}>
      <div className="ow-panel">
        <h2 className="visually-hidden">{t(k('title'))}</h2>
        {!canRead ? (
          <p className="ow-empty">{t('errors.forbidden')}</p>
        ) : !running ? (
          <p className="ow-empty">
            {t(telemetryKey(props.runtimeState === 'offline' ? 'offline' : 'not_ready'))}
          </p>
        ) : worlds.error ? (
          <ErrorNotice error={worlds.error} retry={() => void worlds.refetch()} />
        ) : needsEdge && palette.error ? (
          <ErrorNotice error={palette.error} retry={() => void palette.refetch()} />
        ) : !worlds.data || (needsEdge && !palette.data) ? (
          <Loading />
        ) : (
          <WorldBrowser
            key={JSON.stringify([
              worlds.data.processRef,
              inspect,
              props.permissionKeys.includes('game.openworld.checkpoints.manage'),
              props.permissionKeys.includes('game.openworld.seed.inspect'),
              props.permissionKeys.includes('game.openworld.performance.read'),
            ])}
            server={props}
            data={worlds.data}
            entry={entry}
            fromPlayer={!zone && !initial.factory && !!entry}
            reloadWorlds={worlds.refetch}
          />
        )}
      </div>
    </section>
  );
}
export const OpenworldMap = withTelemetrySession(MapSection);

function WorldBrowser({
  server,
  data,
  entry,
  fromPlayer,
  reloadWorlds,
}: {
  server: TelemetryViewProps;
  data: WorldList;
  entry: ReturnType<typeof mapFocusQuery>;
  fromPlayer: boolean;
  reloadWorlds: () => Promise<unknown>;
}) {
  const t = useT();
  const [space, setSpace] = useState(false);
  const [selection, setSelection] = useState(entry?.world ?? '');
  const selected = data.worlds.find((w) => w.key === selection) ?? data.worlds[0];
  const bookmark = useRef<TerrainBookmark | null>(null);
  const leavingTerrain = useRef(false);
  function openSpace() {
    leavingTerrain.current = true;
    setSpace(true);
  }
  function openWorld(world?: string) {
    leavingTerrain.current = false;
    if (world && world !== selected?.key) {
      bookmark.current = null;
      setSelection(world);
    }
    setSpace(false);
  }
  if (space || !selected)
    return (
      <>
        <header className="ow-space-heading">
          <h3>{t(k(space ? 'layers.space' : 'layers.terrain'))}</h3>
          {space && (
            <button type="button" className="secondary" onClick={() => openWorld()}>
              {t(k('layers.terrain'))}
            </button>
          )}
          {!space && (
            <button type="button" className="secondary" onClick={openSpace}>
              {t(k('layers.space'))}
            </button>
          )}
        </header>
        {space ? (
          <SpaceView
            server={server}
            worlds={data.worlds}
            processRef={data.processRef}
            onTerrain={openWorld}
            reloadWorlds={reloadWorlds}
          />
        ) : (
          <p className="ow-empty">{t(k('noWorlds'))}</p>
        )}
      </>
    );
  const saved = bookmark.current?.world === selected.key ? bookmark.current : null;
  const worldControl =
    data.worlds.length === 1 ? (
      <strong className="ow-current-world" title={selected.name || selected.key}>
        {selected.name || selected.key}
      </strong>
    ) : (
      <select
        aria-label={t(k('world'))}
        value={selected.key}
        onChange={(e) => openWorld(e.target.value)}
      >
        {data.worlds.map((w) => (
          <option key={w.key} value={w.key}>
            {w.name || w.key}
          </option>
        ))}
      </select>
    );
  return (
    <MapWorld
      key={selected.key}
      worldControl={worldControl}
      openSpace={openSpace}
      saved={saved}
      remember={(face, camera) => {
        if (leavingTerrain.current) bookmark.current = { world: selected.key, face, camera };
      }}
      playerFocus={!saved && fromPlayer && entry?.world === selected.key}
      server={server}
      world={selected}
      processRef={data.processRef}
      entry={!saved && entry?.world === selected.key ? entry : null}
      reloadWorlds={reloadWorlds}
    />
  );
}

function MapWorld({
  worldControl,
  openSpace,
  saved,
  remember,
  playerFocus,
  server,
  world,
  processRef,
  entry,
  reloadWorlds,
}: {
  worldControl: ReactNode;
  openSpace: () => void;
  saved: TerrainBookmark | null;
  remember: (face: number, camera: AtlasCameraSnapshot) => void;
  playerFocus: boolean;
  server: TelemetryViewProps;
  world: OpenworldMapWorld;
  processRef: string;
  entry: MapPoint | null;
  reloadWorlds: () => Promise<unknown>;
}) {
  const t = useT(),
    format = useFormat(),
    query = mapParams({ world: world.key, processRef });
  const [withCheckpoints, setWithCheckpoints] = useState(true);
  const [debug, setDebug] = useState(false);
  const toggleDebug = useCallback(() => setDebug((enabled) => !enabled), []);
  const [withSeed, setWithSeed] = useState(false);
  const [biomes, setBiomes] = useState(false);
  const [feature, setFeature] = useState('');
  const legend = useMapData<SeedLegend>(server, `/seed-legend?${query}`, withSeed);
  const kind =
    withSeed && !legend.error
      ? legend.data?.featureKinds?.find((k) => k.key === feature)
      : undefined;
  const [withFactories, setWithFactories] = useState(false);
  const [hasAtlas, setHasAtlas] = useState(true);
  const [mode, setMode] = useState<AtlasMode>(saved?.camera.mode ?? 'plan');
  const [panel, setPanel] = useState<MapPanel | null>(null);
  const [placing, setPlacing] = useState(false);
  const panelId = useId();
  const restore = useRef(saved);
  const workspace = useRef<HTMLDivElement>(null);
  function focusTerrain() {
    requestAnimationFrame(() =>
      workspace.current
        ?.querySelector<HTMLElement>('.ow-map-stage canvas')
        ?.focus({ preventScroll: true }),
    );
  }
  const aside = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const restoringFocus = useRef(false);
  const showCreatures = panel === 'creatures';
  function openPanel(next: MapPanel, opener?: HTMLElement) {
    if (opener) trigger.current = opener;
    setPlacing(false);
    setFollowFailure(null);
    setPanel(next);
  }
  const closePanel = useCallback((restoreFocus = true) => {
    setPanel(null);
    if (restoreFocus && trigger.current?.isConnected) {
      restoringFocus.current = true;
      trigger.current.focus({ preventScroll: true });
      restoringFocus.current = false;
    }
  }, []);
  useEffect(() => {
    if (panel && panel !== 'search') aside.current?.focus({ preventScroll: true });
  }, [panel]);
  const [species, setSpecies] = useState('');
  const [followFailure, setFollowFailure] = useState<unknown>(null);
  const [following, setFollowing] = useState<{ id: number; joinedAt: number; name: string } | null>(
    null,
  );
  const factoryFeed = useFactoryData(server, withFactories, 10_000);
  const { cached: cachedFactories } = useFactoryConnection(factoryFeed);
  const factoryPins = useMemo(
    () =>
      withFactories && !factoryFeed.error && !cachedFactories
        ? (factoryFeed.data?.topColumns ?? []).flatMap((c) => {
            const p = factoryMapPoint(c);
            return p && p.world === world.key ? [{ ...p, nodes: c.nodes }] : [];
          })
        : [],
    [withFactories, factoryFeed.data, factoryFeed.error, cachedFactories, world.key],
  );
  const index = useMapData<Index>(server, `/index?${query}`),
    checkpoints = useMapData<{ checkpoints: MapCheckpoint[] }>(
      server,
      `/checkpoints?${query}`,
      withCheckpoints,
      20000,
    );
  const [scopeError, setScopeError] = useState<unknown>(null);
  const [withCreatures, setWithCreatures] = useState(false);
  const creatures = useCreatureLayer(
    server,
    world.key,
    processRef,
    (showCreatures || withCreatures) && !scopeError,
    withCreatures,
  );
  const [search, setSearch] = useState(''),
    [chosenFace, setFace] = useState<number | null>(saved?.face ?? entry?.face ?? null);
  const [focus, setFocus] = useState<MapPoint | null>(entry),
    [selected, setSelected] = useState<number | null>(null);
  const [form, setForm] = useState<CheckpointForm | null>(null),
    [notice, setNotice] = useState('');
  const [withPlayers, togglePlayers] = useState(playerFocus);
  const grants = server.permissionKeys,
    canManage = grants.includes('game.openworld.checkpoints.manage');
  const canTrack =
    grants.includes('game.openworld.players.read') &&
    grants.includes('game.openworld.players.inspect');
  const playerFeed = useMapPlayers(server, processRef, {
    allowed: canTrack && !scopeError,
    live: withPlayers || !!following,
    search: panel === 'search' ? search : '',
  });
  const tracked =
    canTrack && following && playerFeed.data?.processRef === processRef && !playerFeed.error
      ? playerFeed.data.players.find(
          (p) =>
            p.id === following.id &&
            p.name === following.name &&
            Math.abs(p.joinedAt - following.joinedAt) < 5000 &&
            p.world === world.key,
        )
      : undefined;
  useEffect(() => {
    if (tracked) {
      setFace(tracked.face);
      setFocus((previous) =>
        previous?.face === tracked.face && previous.x === tracked.x && previous.z === tracked.z
          ? previous
          : { face: tracked.face, x: tracked.x, z: tracked.z },
      );
    } else if (following && scopeLost(playerFeed.error)) {
      setFollowFailure(playerFeed.error);
      setFollowing(null);
      setFocus(null);
    } else if (following && !playerFeed.error && playerFeed.data) {
      setFollowing(null);
    }
  }, [tracked, following, playerFeed.data, playerFeed.error]);
  const data =
      checkpoints.data?.checkpoints.filter((c) => canManage || c.visibility === 'players') ?? [],
    current = data.find((c) => c.id === selected);
  const missingForm =
    !!form && form.kind !== 'create' && !data.some((c) => c.id === form.checkpoint.id);
  const lostSelection = selected !== null && !current;
  const [viewportRevision, setViewportRevision] = useState(0);
  useEffect(() => {
    if (missingForm) setForm(null);
    if (lostSelection) {
      setFocus(null);
      setSelected(null);
      setViewportRevision((n) => n + 1);
    }
  }, [missingForm, lostSelection]);
  const [page, setPage] = useState(1);
  const term = panel === 'search' ? search.trim() : '';
  const matches = data.filter((c) => c.name.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
  const availablePlayers =
    canTrack && !playerFeed.error && playerFeed.data?.processRef === processRef
      ? playerFeed.data.players
      : [];
  const location = mapSearchCoordinates(term);
  const located = location
    ? { face: chosenFace ?? index.data?.faces.find((f) => f.count > 0)?.face ?? 0, ...location }
    : null;
  const canCenter =
    located != null &&
    located.x <= (world.faceEdgeMeters ?? 0x7fffffff) &&
    located.z <= (world.faceEdgeMeters ?? 0x7fffffff);
  const matchingPlayers = term
    ? availablePlayers.filter(
        (p) =>
          p.world === world.key && p.name.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
      )
    : [];
  const visibleCreatures = useMemo(() => {
    if (!withCreatures || creatures.error || !creatures.data) return undefined;
    return species
      ? {
          ...creatures.data,
          markers: creatures.data.markers.filter((m) => m.species === Number(species)),
        }
      : creatures.data;
  }, [creatures.data, creatures.error, withCreatures, species]);
  const pages = Math.max(1, Math.ceil(matches.length / 30)),
    currentPage = Math.min(page, pages);
  const face = chosenFace ?? index.data?.faces.find((f) => f.count > 0)?.face ?? 0;
  const extent = index.data?.faces.find((f) => f.face === face);
  const checkpointEdge = world.faceEdgeMeters ?? 0x7fffffff;
  const terrainEdge =
    world.faceEdgeMeters == null
      ? 16 * (maxOpenworldMapColumn + 1)
      : Math.max(world.faceEdgeMeters, 16 * (1 + Math.max(extent?.i1 ?? 0, extent?.j1 ?? 0)));
  const refreshIndex = useCallback(() => {
    void index.refetch();
  }, [index.refetch]);
  function select(c: MapCheckpoint, center: boolean) {
    setFollowing(null);
    setSelected(c.id);
    setNotice('');
    if (center) {
      setFocus({ ...c.pos });
      setFace(c.pos.face);
    }
  }
  const readingError =
    (scopeLost(index.error) && index.error) ||
    (withSeed && scopeLost(legend.error) && legend.error) ||
    (withCheckpoints && scopeLost(checkpoints.error) && checkpoints.error) ||
    ((showCreatures || withCreatures) && scopeLost(creatures.error) && creatures.error) ||
    scopeError;
  useEffect(() => {
    const root = workspace.current;
    if (!panel || form || readingError || !root) return;
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        closePanel();
      }
    }
    root.addEventListener('keydown', dismissOnEscape);
    return () => root.removeEventListener('keydown', dismissOnEscape);
  }, [panel, form, readingError, closePanel]);
  if (readingError)
    return (
      <ErrorNotice
        error={readingError}
        retry={async () => {
          await reloadWorlds();
          if (withSeed && legend.error) void legend.refetch();
          setScopeError(null);
          void index.refetch();
          if (showCreatures) void creatures.refetch();
          else void checkpoints.refetch();
        }}
      />
    );
  return (
    <>
      <div className="ow-map-layout ow-terrain-workspace" ref={workspace}>
        <header className="ow-map-toolbar">
          <div className="ow-map-world-nav">
            {worldControl}
            <select
              aria-label={t(k('face'))}
              value={face}
              onChange={(e) => {
                setFace(Number(e.target.value));
                setFocus(null);
                setSelected(null);
                setFollowing(null);
                setPlacing(false);
              }}
            >
              {faces.map((n) => (
                <option key={n} value={n}>
                  {t(k('faceNumber'), { face: n })}
                </option>
              ))}
            </select>
            <button type="button" className="ow-map-command secondary" onClick={openSpace}>
              <MapGlyph name="space" /> {t(k('layers.space'))}
            </button>
          </div>
          <div className="ow-map-search-nav">
            <SearchField
              label={t(k(canTrack ? 'atlas.search' : 'atlas.searchPlaces'))}
              placeholder={t(k('atlas.searchShort'))}
              value={search}
              aria-controls={panel === 'search' ? panelId : undefined}
              onClick={(e) => openPanel('search', e.currentTarget)}
              onFocus={(e) => {
                if (!restoringFocus.current) openPanel('search', e.currentTarget);
              }}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
                openPanel('search', e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  aside.current
                    ?.querySelector<HTMLElement>(
                      '.ow-map-found button, .ow-search-coordinate, .ow-map-list button',
                    )
                    ?.focus();
                }
              }}
            />
            {(['checkpoints', 'layers'] as const).map((name) => {
              const label = t(k(name === 'layers' ? 'atlas.layers' : 'checkpoints'));
              const active = panel === name || (name === 'layers' && showCreatures);
              return (
                <button
                  key={name}
                  type="button"
                  className="ow-map-command secondary"
                  aria-label={label}
                  aria-expanded={active}
                  aria-controls={active ? panelId : undefined}
                  title={label}
                  onClick={(e) => {
                    if (active) closePanel();
                    else {
                      setPage(1);
                      openPanel(name, e.currentTarget);
                    }
                  }}
                >
                  <MapGlyph name={name} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </header>
        <div className="ow-map-frame">
          <section className="ow-map-terrain" aria-label={t(k('layers.terrain'))}>
            {withSeed && legend.error && (
              <ErrorNotice error={legend.error} retry={() => void legend.refetch()} />
            )}
            {following && (
              <button
                type="button"
                className="secondary ow-follow-active"
                onClick={() => setFollowing(null)}
              >
                {t(k('atlas.stopFollow'), { name: following.name })}
              </button>
            )}
            {index.error && <ErrorNotice error={index.error} retry={() => void index.refetch()} />}
            {!index.data ? (
              index.error ? null : (
                <Loading />
              )
            ) : (
              <MapViewport
                key={`${face}/${terrainEdge}/${viewportRevision}`}
                initialCamera={restore.current?.face === face ? restore.current.camera : undefined}
                onCameraLeave={(camera) => {
                  restore.current = null;
                  remember(face, camera);
                }}
                placing={placing}
                onPlacingChange={setPlacing}
                debug={debug}
                onToggleDebug={toggleDebug}
                server={server}
                world={world.key}
                edge={terrainEdge}
                checkpointEdge={checkpointEdge}
                face={face}
                extent={extent}
                stamp={index.data.stamp}
                processRef={processRef}
                seed={withSeed}
                biomes={biomes}
                legend={withSeed && !legend.error ? legend.data : undefined}
                feature={kind}
                tracking={following?.id}
                stopFollowing={() => setFollowing(null)}
                mode={mode}
                onModeChange={setMode}
                onFallback={() => {
                  setHasAtlas(false);
                  setWithSeed(false);
                  setWithFactories(false);
                  setMode('plan');
                }}
                factories={factoryPins}
                onCheckpointOpen={() => {
                  openPanel(
                    'checkpoints',
                    document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : undefined,
                  );
                }}
                checkpoints={withCheckpoints && !checkpoints.error ? data : []}
                creatures={visibleCreatures}
                players={
                  canTrack &&
                  withPlayers &&
                  !playerFeed.error &&
                  playerFeed.data?.processRef === processRef
                    ? playerFeed.data.players
                    : []
                }
                focus={focus}
                selectedId={selected}
                onSelect={(c) => select(c, false)}
                onCreate={
                  withCheckpoints && canManage && !checkpoints.error && checkpoints.data
                    ? (p) => setForm({ kind: 'create', point: p })
                    : undefined
                }
                onScopeError={setScopeError}
                onRefreshIndex={refreshIndex}
              />
            )}
            {withFactories && factoryFeed.error && (
              <ErrorNotice error={factoryFeed.error} retry={() => void factoryFeed.refetch()} />
            )}
            {!showCreatures && withCreatures && creatures.error && (
              <ErrorNotice error={creatures.error} retry={() => void creatures.refetch()} />
            )}
            {followFailure != null && !withPlayers && (
              <div className="ow-map-follow-failure">
                <ErrorNotice error={followFailure} />
                <button type="button" className="secondary" onClick={() => setFollowFailure(null)}>
                  {t('web.close')}
                </button>
              </div>
            )}
            {canTrack && (withPlayers || following) && panel !== 'search' && playerFeed.error && (
              <ErrorNotice error={playerFeed.error} retry={() => void playerFeed.refetch()} />
            )}
          </section>
          {panel && (
            <aside
              className="ow-map-side ow-atlas-directory"
              ref={aside}
              tabIndex={-1}
              id={panelId}
              aria-labelledby={`${panelId}-title`}
            >
              <header className="ow-drawer-heading">
                {showCreatures && (
                  <button
                    type="button"
                    className="secondary ow-panel-back"
                    aria-label={t(k('atlas.layers'))}
                    onClick={() => openPanel('layers')}
                  >
                    ‹
                  </button>
                )}
                <h3 id={`${panelId}-title`}>
                  {t(
                    k(
                      panel === 'search'
                        ? 'atlas.results'
                        : panel === 'layers'
                          ? 'atlas.layers'
                          : showCreatures
                            ? 'layers.creatures'
                            : 'checkpoints',
                    ),
                  )}
                </h3>
                <button
                  type="button"
                  className="secondary ow-directory-close"
                  aria-label={t('web.close')}
                  onClick={() => closePanel()}
                >
                  ×
                </button>
              </header>
              {panel === 'layers' && (
                <div className="ow-atlas-layers">
                  <Check
                    label={t(k('checkpoints'))}
                    checked={withCheckpoints}
                    onChange={(e) => {
                      setWithCheckpoints(e.target.checked);
                      if (!e.target.checked) {
                        setSelected(null);
                        setForm(null);
                        setPlacing(false);
                      }
                    }}
                  />
                  {canTrack && (
                    <Check
                      label={t(k('playerMarkers'))}
                      checked={withPlayers}
                      onChange={(e) => {
                        togglePlayers(e.target.checked);
                      }}
                    />
                  )}
                  {hasAtlas && grants.includes('game.openworld.performance.read') && (
                    <Check
                      label={t(k('atlas.factories'))}
                      checked={withFactories}
                      onChange={(e) => setWithFactories(e.target.checked)}
                    />
                  )}
                  {hasAtlas && grants.includes('game.openworld.seed.inspect') && (
                    <Check
                      label={t(k('atlas.seed'))}
                      checked={withSeed}
                      onChange={(e) => {
                        setWithSeed(e.target.checked);
                        if (!e.target.checked) setFeature('');
                      }}
                    />
                  )}
                  {withSeed && (
                    <Check
                      label={t(k('atlas.biomes'))}
                      checked={biomes}
                      onChange={(e) => setBiomes(e.target.checked)}
                    />
                  )}
                  {withSeed && legend.data?.featureKinds?.length && !legend.error ? (
                    <Select
                      label={t(k('atlas.feature'))}
                      value={feature}
                      onChange={(e) => setFeature(e.target.value)}
                    >
                      <option value="">{t(k('atlas.featureOff'))}</option>
                      {legend.data.featureKinds.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.name || f.key}
                        </option>
                      ))}
                    </Select>
                  ) : null}

                  <button
                    type="button"
                    className="ow-layer-creatures secondary"
                    onClick={() => openPanel('creatures')}
                  >
                    {t(k('layers.creatures'))}
                    <span aria-hidden="true">›</span>
                  </button>
                </div>
              )}
              {showCreatures && (
                <>
                  <div className="ow-atlas-layers">
                    <Check
                      label={t(k('layers.markers'))}
                      checked={withCreatures}
                      onChange={(e) => setWithCreatures(e.target.checked)}
                    />
                    {withCreatures && creatures.data && !creatures.error && (
                      <Select
                        label={t(k('layers.species'))}
                        value={species}
                        onChange={(e) => setSpecies(e.target.value)}
                      >
                        <option value="">{t(k('atlas.allSpecies'))}</option>
                        {creatures.data.species.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name || s.key}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                  {grants.includes('game.openworld.rules.view') &&
                    grants.includes('game.openworld.territory.manage') && (
                      <CreatureSpawning key={processRef} server={server} processRef={processRef} />
                    )}
                  <CreaturePopulation
                    query={creatures}
                    worldName={world.name || world.key}
                    markers={withCreatures}
                  />
                </>
              )}
              {(panel === 'search' || panel === 'checkpoints') && (
                <>
                  {panel === 'search' && canTrack && playerFeed.isEnabled && playerFeed.error && (
                    <ErrorNotice error={playerFeed.error} retry={() => void playerFeed.refetch()} />
                  )}
                  {panel === 'search' && playerFeed.isFetching && !playerFeed.data && <Loading />}
                  {canCenter && located && (
                    <button
                      type="button"
                      className="secondary ow-search-coordinate"
                      onClick={() => {
                        setFollowing(null);
                        setSelected(null);
                        setFace(located.face);
                        setFocus({ ...located });
                        closePanel(false);
                        focusTerrain();
                      }}
                    >
                      {t(k('atlas.goTo'), { x: located.x, z: located.z })}
                    </button>
                  )}
                  {matchingPlayers.map((p) => (
                    <div className="ow-map-found" key={p.id}>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setSelected(null);
                          setFollowing(null);
                          setFace(p.face);
                          setFocus({ face: p.face, x: p.x, z: p.z });
                          closePanel(false);
                          focusTerrain();
                        }}
                      >
                        {p.name}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setSelected(null);
                          setFollowFailure(null);
                          setFace(p.face);
                          setFocus({ face: p.face, x: p.x, z: p.z });
                          setFollowing({ id: p.id, name: p.name, joinedAt: p.joinedAt });
                          closePanel(false);
                          focusTerrain();
                        }}
                      >
                        {t(k('atlas.follow'))}
                      </button>
                    </div>
                  ))}

                  {panel === 'checkpoints' &&
                    canManage &&
                    withCheckpoints &&
                    checkpoints.data &&
                    !checkpoints.error && (
                      <div className="ow-map-actions ow-checkpoint-create">
                        {entry && focus === entry && selected === null && face === entry.face && (
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => setForm({ kind: 'create', point: entry })}
                          >
                            {t(k('createAtPosition'))}
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          disabled={!index.data}
                          onClick={() => {
                            closePanel(false);
                            setPlacing(true);
                          }}
                        >
                          {t(k('placePin'))}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setForm({ kind: 'create' })}
                        >
                          {t(k('new'))}
                        </button>
                      </div>
                    )}
                  {checkpoints.error ? (
                    <ErrorNotice
                      error={checkpoints.error}
                      retry={() => void checkpoints.refetch()}
                    />
                  ) : !withCheckpoints ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setWithCheckpoints(true)}
                    >
                      {t(k('atlas.showCheckpoints'))}
                    </button>
                  ) : !checkpoints.data ? (
                    <Loading />
                  ) : (
                    <>
                      {!matches.length &&
                      !matchingPlayers.length &&
                      !canCenter &&
                      !(panel === 'search' && (playerFeed.isFetching || playerFeed.error)) ? (
                        <p className="ow-empty">{t(k(term ? 'atlas.noResults' : 'empty'))}</p>
                      ) : (
                        <ul className="ow-map-list">
                          {matches.slice((currentPage - 1) * 30, currentPage * 30).map((c) => (
                            <li key={c.id}>
                              <button
                                type="button"
                                aria-pressed={selected === c.id}
                                onClick={() => {
                                  select(c, true);
                                  if (panel === 'search') openPanel('checkpoints');
                                }}
                              >
                                <i style={{ backgroundColor: c.color }} aria-hidden="true">
                                  <CheckpointGlyph icon={c.icon} />
                                </i>
                                <span>
                                  <strong>{c.name}</strong>
                                  <small>
                                    {t(k('faceNumber'), { face: c.pos.face })} ·{' '}
                                    {t(k(c.visibility))}
                                  </small>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {pages > 1 && (
                        <Pagination
                          label={t(k('checkpoints'))}
                          previousLabel={t('web.previous')}
                          nextLabel={t('web.next')}
                          summary={t(telemetryKey('pageNumber'), {
                            page: currentPage,
                            total: pages,
                          })}
                          canPrevious={currentPage > 1}
                          canNext={currentPage < pages}
                          onPrevious={() => setPage(currentPage - 1)}
                          onNext={() => setPage(currentPage + 1)}
                        />
                      )}
                      {panel === 'checkpoints' && current && (
                        <section className="ow-map-checkpoint-detail">
                          <h4>{current.name}</h4>
                          {canManage && current.note && (
                            <p className="ow-map-note">{current.note}</p>
                          )}
                          <dl>
                            <div>
                              <dt>{t('games.openworld.telemetry.latitude')}</dt>
                              <dd>{format.number(current.geo.lat, 4)}°</dd>
                            </div>
                            <div>
                              <dt>{t('games.openworld.telemetry.longitude')}</dt>
                              <dd>{format.number(current.geo.lon, 4)}°</dd>
                            </div>
                          </dl>
                          <div className="ow-map-actions">
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                select(current, true);
                                closePanel(false);
                                focusTerrain();
                              }}
                            >
                              {t(k('showOnMap'))}
                            </button>
                            {canManage && (
                              <>
                                <button
                                  type="button"
                                  className="secondary"
                                  onClick={() => setForm({ kind: 'update', checkpoint: current })}
                                >
                                  {t(k('edit'))}
                                </button>
                                <button
                                  type="button"
                                  className="secondary danger-text"
                                  onClick={() => setForm({ kind: 'delete', checkpoint: current })}
                                >
                                  {t(k('delete'))}
                                </button>
                              </>
                            )}
                          </div>
                        </section>
                      )}
                    </>
                  )}
                  {notice && (
                    <p role="status" className="ow-map-notice">
                      {notice}
                    </p>
                  )}
                </>
              )}
            </aside>
          )}
        </div>
      </div>
      {canManage && form && !missingForm && !checkpoints.error && (
        <CheckpointDialog
          form={form}
          world={world.key}
          edge={checkpointEdge}
          serverId={server.serverId}
          processRef={processRef}
          onClose={() => setForm(null)}
          onSaved={() => {
            setNotice(t(k('accepted')));
            setForm(null);
            void checkpoints.refetch();
          }}
        />
      )}
    </>
  );
}
