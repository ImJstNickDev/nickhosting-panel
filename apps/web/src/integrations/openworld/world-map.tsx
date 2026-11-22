import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  maxOpenworldMapColumn,
  type OpenworldMapWorld,
} from '../../../../../games/openworld/src/world-map.js';
import { useFormat, useT } from '../../app/i18n.js';
import { Check, ErrorNotice, Loading, Select } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import type { AtlasMode } from './atlas-types.js';
import type { SeedLegend } from './map-atlas-data.js';
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
import { mapFocusQuery, useMapPlayers } from './map-players.js';
import { mapKey as k, mapParams, scopeLost, useMapData } from './map-query.js';
import { SpaceView } from './map-space.js';
import { type MapFace, MapViewport } from './map-viewport.js';
import { type TelemetryViewProps, key as telemetryKey, withTelemetrySession } from './telemetry.js';
import './world-map.css';
import './map-layers.css';
import './map-explorer.css';

type MapView = 'terrain' | 'creatures' | 'space';

type WorldList = { processRef: string; worlds: OpenworldMapWorld[] };
type Index = { stamp: number; faces: MapFace[] };

function MapSection(props: TelemetryViewProps) {
  const t = useT();
  const canRead = props.permissionKeys.includes('game.openworld.map.read');
  const running = props.runtimeState === 'running';
  const worlds = useMapData<WorldList>(props, '', running && canRead);
  const [initial] = useState(() => ({
    point: mapFocusQuery(),
    factory: new URLSearchParams(window.location.hash.slice(1)).get('origin') === 'factories',
  }));
  const inspect =
    props.permissionKeys.includes('game.openworld.players.read') &&
    props.permissionKeys.includes('game.openworld.players.inspect');
  const entry = initial.factory || inspect ? initial.point : null;
  const [view, setView] = useState<MapView>('terrain');
  const [selection, setSelection] = useState(entry?.world ?? '');
  const selected = worlds.data?.worlds.find((w) => w.key === selection) ?? worlds.data?.worlds[0];
  return (
    <section className="ow-workspace ow-map">
      <div className="ow-panel">
        <header className="ow-heading">
          <h2>{t(k('title'))}</h2>
          {view !== 'space' && canRead && running && !worlds.error && selected && worlds.data && (
            <Select
              label={t(k('world'))}
              value={selected.key}
              onChange={(e) => setSelection(e.target.value)}
            >
              {worlds.data.worlds.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.name || w.key}
                </option>
              ))}
            </Select>
          )}
        </header>
        {canRead && running && !worlds.error && worlds.data && (
          <fieldset className="ow-map-views" aria-label={t(k('layers.view'))}>
            {(['terrain', 'creatures', 'space'] as const).map((mode) => (
              <button
                className="secondary"
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
              >
                {t(k(`layers.${mode}`))}
              </button>
            ))}
          </fieldset>
        )}
        {!canRead ? (
          <p className="ow-empty">{t('errors.forbidden')}</p>
        ) : !running ? (
          <p className="ow-empty">
            {t(telemetryKey(props.runtimeState === 'offline' ? 'offline' : 'not_ready'))}
          </p>
        ) : worlds.error ? (
          <ErrorNotice error={worlds.error} retry={() => void worlds.refetch()} />
        ) : !worlds.data ? (
          <Loading />
        ) : view === 'space' ? (
          <SpaceView
            key={worlds.data.processRef}
            server={props}
            worlds={worlds.data.worlds}
            processRef={worlds.data.processRef}
            onTerrain={(world) => {
              setSelection(world);
              setView('terrain');
            }}
            reloadWorlds={() => worlds.refetch()}
          />
        ) : !selected ? (
          <p className="ow-empty">{t(k('noWorlds'))}</p>
        ) : (
          <MapWorld
            key={JSON.stringify([
              worlds.data.processRef,
              selected.key,
              inspect,
              props.permissionKeys.includes('game.openworld.checkpoints.manage'),
              props.permissionKeys.includes('game.openworld.seed.inspect'),
              props.permissionKeys.includes('game.openworld.performance.read'),
            ])}
            showCreatures={view === 'creatures'}
            showDirectory={() => setView('terrain')}
            playerFocus={!initial.factory && !!entry && entry.world === selected.key}
            server={props}
            world={selected}
            processRef={worlds.data.processRef}
            entry={entry?.world === selected.key ? entry : null}
            reloadWorlds={() => worlds.refetch()}
          />
        )}
      </div>
    </section>
  );
}
export const OpenworldMap = withTelemetrySession(MapSection);

function MapWorld({
  showCreatures,
  showDirectory,
  playerFocus,
  server,
  world,
  processRef,
  entry,
  reloadWorlds,
}: {
  showCreatures: boolean;
  showDirectory: () => void;
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
  const [mode, setMode] = useState<AtlasMode>('plan');
  const [directory, setDirectory] = useState(false);
  const [layerPanel, setLayerPanel] = useState(false);
  const [species, setSpecies] = useState('');
  const [following, setFollowing] = useState<{ id: number; joinedAt: number; name: string } | null>(
    null,
  );
  const factoryFeed = useFactoryData(server, withFactories);
  const factoryPins = useMemo(
    () =>
      withFactories && !factoryFeed.error
        ? (factoryFeed.data?.topColumns ?? []).flatMap((c) => {
            const p = factoryMapPoint(c);
            return p && p.world === world.key ? [{ ...p, nodes: c.nodes }] : [];
          })
        : [],
    [withFactories, factoryFeed.data, factoryFeed.error, world.key],
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
    [chosenFace, setFace] = useState<number | null>(entry?.face ?? null);
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
  const playerFeed = useMapPlayers(server, canTrack && withPlayers && !scopeError, processRef);
  const tracked =
    canTrack && withPlayers && playerFeed.data?.processRef === processRef && !playerFeed.error
      ? playerFeed.data.players.find(
          (p) =>
            following &&
            p.id === following.id &&
            p.name === following.name &&
            Math.abs(p.joinedAt - following.joinedAt) < 5000 &&
            p.world === world.key,
        )
      : undefined;
  useEffect(() => {
    if (tracked) {
      setFace(tracked.face);
      setFocus({ face: tracked.face, x: tracked.x, z: tracked.z });
    } else if (following && (playerFeed.data || playerFeed.error || !withPlayers))
      setFollowing(null);
  }, [tracked, following, playerFeed.data, playerFeed.error, withPlayers]);
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
  const matches = data.filter((c) =>
    c.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const availablePlayers =
    canTrack && withPlayers && !playerFeed.error && playerFeed.data?.processRef === processRef
      ? playerFeed.data.players
      : [];
  const location = /^\s*(\d+(?:\.\d+)?)\s*[,; ]\s*(\d+(?:\.\d+)?)\s*$/.exec(search);
  const located = location
    ? {
        face: chosenFace ?? index.data?.faces.find((f) => f.count > 0)?.face ?? 0,
        x: Number(location[1]),
        z: Number(location[2]),
      }
    : null;
  const canCenter =
    located != null &&
    located.x <= (world.faceEdgeMeters ?? 0x7fffffff) &&
    located.z <= (world.faceEdgeMeters ?? 0x7fffffff);
  const matchingPlayers = search.trim()
    ? availablePlayers.filter(
        (p) =>
          p.world === world.key &&
          p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
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
      <div className="ow-map-layout">
        <section className="ow-map-terrain">
          <div className="ow-map-filters">
            <SearchField
              label={t(k('atlas.search'))}
              value={search}
              onFocus={() => {
                setDirectory(true);
                setLayerPanel(false);
              }}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
                setDirectory(true);
              }}
            />
            <button
              className="secondary"
              type="button"
              aria-pressed={directory && !showCreatures}
              onClick={() => {
                setDirectory(showCreatures || !directory);
                if (showCreatures) showDirectory();
                setLayerPanel(false);
              }}
            >
              {t(k('checkpoints'))}
            </button>
            <button
              className="secondary"
              type="button"
              aria-expanded={layerPanel}
              onClick={() => {
                setLayerPanel(!layerPanel);
                if (!layerPanel) setDirectory(false);
              }}
            >
              {t(k('atlas.layers'))}
            </button>
          </div>
          {layerPanel && (
            <div className="ow-atlas-layers">
              <Select
                label={t(k('face'))}
                value={face}
                onChange={(e) => {
                  setFace(Number(e.target.value));
                  setFocus(null);
                  setSelected(null);
                  setFollowing(null);
                }}
              >
                {faces.map((n) => (
                  <option key={n} value={n}>
                    {t(k('faceNumber'), { face: n })}
                  </option>
                ))}
              </Select>
              <Check
                label={t(k('checkpoints'))}
                checked={withCheckpoints}
                onChange={(e) => {
                  setWithCheckpoints(e.target.checked);
                  if (!e.target.checked) {
                    setSelected(null);
                    setForm(null);
                  }
                }}
              />
              {canTrack && (
                <Check
                  label={t(k('playerMarkers'))}
                  checked={withPlayers}
                  onChange={(e) => {
                    togglePlayers(e.target.checked);
                    setFollowing(null);
                  }}
                />
              )}
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
            </div>
          )}
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
                showDirectory();
                setDirectory(true);
                setLayerPanel(false);
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
                !showCreatures &&
                withCheckpoints &&
                canManage &&
                !checkpoints.error &&
                checkpoints.data
                  ? (p) => setForm({ kind: 'create', point: p })
                  : undefined
              }
              onScopeError={setScopeError}
              onRefreshIndex={refreshIndex}
            />
          )}
          {!showCreatures &&
            entry &&
            focus === entry &&
            selected === null &&
            face === entry.face &&
            canManage &&
            withCheckpoints &&
            checkpoints.data &&
            !checkpoints.error && (
              <button
                className="secondary ow-map-place-from-player"
                type="button"
                onClick={() => setForm({ kind: 'create', point: entry })}
              >
                {t(k('createAtPosition'))}
              </button>
            )}
          {withFactories && factoryFeed.error && (
            <ErrorNotice error={factoryFeed.error} retry={() => void factoryFeed.refetch()} />
          )}
          {!showCreatures && withCreatures && creatures.error && (
            <ErrorNotice error={creatures.error} retry={() => void creatures.refetch()} />
          )}
          {canTrack && withPlayers && playerFeed.error && (
            <ErrorNotice error={playerFeed.error} retry={() => void playerFeed.refetch()} />
          )}
        </section>
        {(directory || showCreatures) && (
          <aside className="ow-map-side ow-atlas-directory">
            <button
              type="button"
              className="secondary ow-directory-close"
              aria-label={t('web.close')}
              onClick={() => {
                setDirectory(false);
                if (showCreatures) showDirectory();
              }}
            >
              ×
            </button>
            {canCenter && located && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setFollowing(null);
                  setSelected(null);
                  setFace(located.face);
                  setFocus({ ...located });
                  setDirectory(false);
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
                  }}
                >
                  {p.name}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setSelected(null);
                    setFollowing({ id: p.id, name: p.name, joinedAt: p.joinedAt });
                    setDirectory(false);
                  }}
                >
                  {t(k('atlas.follow'))}
                </button>
              </div>
            ))}

            {showCreatures ? (
              <CreaturePopulation
                query={creatures}
                worldName={world.name || world.key}
                markers={withCreatures}
              />
            ) : (
              <>
                <div className="ow-map-side-head">
                  <h3>{t(k('checkpoints'))}</h3>
                  {canManage && withCheckpoints && checkpoints.data && !checkpoints.error && (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setForm({ kind: 'create' })}
                    >
                      {t(k('new'))}
                    </button>
                  )}
                </div>
                {checkpoints.error ? (
                  <ErrorNotice error={checkpoints.error} retry={() => void checkpoints.refetch()} />
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
                    {!matches.length && !matchingPlayers.length && !canCenter ? (
                      <p className="ow-empty">{t(k(data.length ? 'noMatches' : 'empty'))}</p>
                    ) : (
                      <ul className="ow-map-list">
                        {matches.slice((currentPage - 1) * 30, currentPage * 30).map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              aria-pressed={selected === c.id}
                              onClick={() => select(c, true)}
                            >
                              <i style={{ backgroundColor: c.color }} aria-hidden="true">
                                <CheckpointGlyph icon={c.icon} />
                              </i>
                              <span>
                                <strong>{c.name}</strong>
                                <small>
                                  {t(k('faceNumber'), { face: c.pos.face })} · {t(k(c.visibility))}
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
                        summary={t(telemetryKey('pageNumber'), { page: currentPage, total: pages })}
                        canPrevious={currentPage > 1}
                        canNext={currentPage < pages}
                        onPrevious={() => setPage(currentPage - 1)}
                        onNext={() => setPage(currentPage + 1)}
                      />
                    )}
                    {current && (
                      <section className="ow-map-checkpoint-detail">
                        <h4>{current.name}</h4>
                        {canManage && current.note && <p className="ow-map-note">{current.note}</p>}
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
                            onClick={() => select(current, true)}
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
      {!showCreatures && canManage && form && !missingForm && !checkpoints.error && (
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
