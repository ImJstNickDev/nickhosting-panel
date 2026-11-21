import { useCallback, useEffect, useState } from 'react';
import {
  maxOpenworldMapColumn,
  type OpenworldMapWorld,
} from '../../../../../games/openworld/src/world-map.js';
import { useFormat, useT } from '../../app/i18n.js';
import { Check, ErrorNotice, Loading, Select } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import {
  CheckpointDialog,
  type CheckpointForm,
  CheckpointGlyph,
  faces,
  type MapCheckpoint,
  type MapPoint,
} from './map-checkpoints.js';
import { CreaturePopulation, useCreatureLayer } from './map-creatures.js';
import { mapFocusQuery, useMapPlayers } from './map-players.js';
import { mapKey as k, mapParams, scopeLost, useMapData } from './map-query.js';
import { SpaceView } from './map-space.js';
import { type MapFace, MapViewport } from './map-viewport.js';
import { type TelemetryViewProps, key as telemetryKey, withTelemetrySession } from './telemetry.js';
import './world-map.css';
import './map-layers.css';

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
            ])}
            showCreatures={view === 'creatures'}
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
  playerFocus,
  server,
  world,
  processRef,
  entry,
  reloadWorlds,
}: {
  showCreatures: boolean;
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
  const index = useMapData<Index>(server, `/index?${query}`),
    checkpoints = useMapData<{ checkpoints: MapCheckpoint[] }>(
      server,
      `/checkpoints?${query}`,
      !showCreatures,
      20000,
    );
  const [scopeError, setScopeError] = useState<unknown>(null);
  const [withCreatures, setWithCreatures] = useState(false);
  const creatures = useCreatureLayer(
    server,
    world.key,
    processRef,
    showCreatures && !scopeError,
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
    setSelected(c.id);
    setNotice('');
    if (center) {
      setFocus({ ...c.pos });
      setFace(c.pos.face);
    }
  }
  const readingError =
    (scopeLost(index.error) && index.error) ||
    (!showCreatures && scopeLost(checkpoints.error) && checkpoints.error) ||
    (showCreatures && scopeLost(creatures.error) && creatures.error) ||
    scopeError;
  if (readingError)
    return (
      <ErrorNotice
        error={readingError}
        retry={async () => {
          await reloadWorlds();
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
            <Select
              label={t(k('face'))}
              value={face}
              onChange={(e) => {
                setFace(Number(e.target.value));
                setFocus(null);
                setSelected(null);
              }}
            >
              {faces.map((n) => (
                <option key={n} value={n}>
                  {t(k('faceNumber'), { face: n })}
                </option>
              ))}
            </Select>
            {showCreatures && (
              <Check
                label={t(k('layers.markers'))}
                checked={withCreatures}
                onChange={(e) => setWithCreatures(e.target.checked)}
              />
            )}
            {canTrack && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={withPlayers}
                  onChange={(e) => togglePlayers(e.target.checked)}
                />
                {t(k('playerMarkers'))}
              </label>
            )}
          </div>
          {index.error && <ErrorNotice error={index.error} retry={() => void index.refetch()} />}
          {!index.data ? (
            index.error ? null : (
              <Loading />
            )
          ) : (
            <MapViewport
              key={`${face}/${viewportRevision}`}
              server={server}
              world={world.key}
              edge={terrainEdge}
              checkpointEdge={checkpointEdge}
              face={face}
              extent={extent}
              stamp={index.data.stamp}
              processRef={processRef}
              checkpoints={!showCreatures && !checkpoints.error ? data : []}
              creatures={
                showCreatures && withCreatures && !creatures.error ? creatures.data : undefined
              }
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
                !showCreatures && canManage && !checkpoints.error && checkpoints.data
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
          {canTrack && withPlayers && playerFeed.error && (
            <ErrorNotice error={playerFeed.error} retry={() => void playerFeed.refetch()} />
          )}
        </section>
        <aside className="ow-map-side">
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
                {canManage && checkpoints.data && !checkpoints.error && (
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
              ) : !checkpoints.data ? (
                <Loading />
              ) : (
                <>
                  {data.length > 0 && (
                    <SearchField
                      label={t(k('search'))}
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setPage(1);
                      }}
                    />
                  )}
                  {!matches.length ? (
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
