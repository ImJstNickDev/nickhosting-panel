import { useState } from 'react';
import type { OpenworldSpaceLayer } from '../../../../../games/openworld/src/map-layers.js';
import type { OpenworldMapWorld } from '../../../../../games/openworld/src/world-map.js';
import { useFormat, useT } from '../../app/i18n.js';
import { ErrorNotice, Loading, Select } from '../../components/ui.js';
import { Pagination } from '../../components/workspace-controls.js';
import { mapKey as k, mapParams, scopeLost, useMapData } from './map-query.js';
import type { TelemetryViewProps } from './telemetry.js';

type Body = OpenworldSpaceLayer['bodies'][number];
type Position = Body['position'];
const distance = (a: Position, b: Position) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function SpaceView({
  server,
  worlds,
  processRef,
  onTerrain,
  reloadWorlds,
}: {
  server: TelemetryViewProps;
  worlds: OpenworldMapWorld[];
  processRef: string;
  onTerrain: (world: string) => void;
  reloadWorlds: () => Promise<unknown>;
}) {
  const t = useT();
  const query = useMapData<OpenworldSpaceLayer>(
    server,
    `/space?${mapParams({ processRef })}`,
    true,
    15000,
  );
  if (query.error)
    return (
      <ErrorNotice
        error={query.error}
        retry={async () => {
          if (scopeLost(query.error)) await reloadWorlds();
          void query.refetch();
        }}
      />
    );
  if (!query.data) return <Loading />;
  if (!query.data.bodies.length) return <p className="ow-empty">{t(k('layers.noBodies'))}</p>;
  return (
    <OrbitalMap
      data={query.data}
      worlds={worlds}
      grants={server.permissionKeys}
      onTerrain={onTerrain}
    />
  );
}

function OrbitalMap({
  data,
  worlds,
  grants,
  onTerrain,
}: {
  data: OpenworldSpaceLayer;
  worlds: OpenworldMapWorld[];
  grants: readonly string[];
  onTerrain: (world: string) => void;
}) {
  const t = useT(),
    format = useFormat();
  const [selected, select] = useState<number | null>(null);
  const center =
    data.bodies.find((b) => b.index === selected) ??
    data.bodies.find((b) => b.isLight && b.parent === null) ??
    data.bodies.find((b) => b.parent === null) ??
    data.bodies[0];
  if (!center) return null;
  const parent = data.bodies.find((b) => b.index === center.parent);
  const isSystem = center.parent === null && center.isLight;
  const bodies = isSystem
    ? data.bodies
    : data.bodies.filter((b) => b.index === center.index || b.parent === center.index);
  const canTrack =
    grants.includes('game.openworld.players.read') &&
    grants.includes('game.openworld.players.inspect');
  const canManage = grants.includes('game.openworld.checkpoints.manage');
  const localWorlds = new Set(bodies.map((b) => b.world));
  const checkpoints = data.checkpoints.filter(
    (p) => (p.visibility === 'players' || canManage) && (isSystem || localWorlds.has(p.world)),
  );
  const players = canTrack ? data.players : [];
  // Keep satellites and the selected body's surface in frame even when a traveler is far away.
  const extent = Math.max(
    1,
    center.radiusMeters * 3,
    ...bodies.map((b) =>
      Math.hypot(b.position[0] - center.position[0], b.position[2] - center.position[2]),
    ),
    ...(isSystem
      ? players.map((p) =>
          Math.hypot(p.position[0] - center.position[0], p.position[2] - center.position[2]),
        )
      : []),
  );
  const scale = 85 / extent;
  const project = (pos: Position) => ({
    x: (pos[0] - center.position[0]) * scale,
    y: -(pos[2] - center.position[2]) * scale,
  });
  // Locations indistinguishable at this scale share a plot symbol. The list retains each entry.
  function plotted<T extends { position: Position }>(items: T[]) {
    const cells = new Set<string>();
    return items.flatMap((item) => {
      const { x, y } = project(item.position);
      const cell = `${Math.round(x / 3)},${Math.round(y / 3)}`;
      if (Math.abs(x) > 128 || Math.abs(y) > 92 || cells.has(cell)) return [];
      cells.add(cell);
      return [{ item, x, y }];
    });
  }
  const visiblePlayers = plotted(players);
  const visiblePins = plotted(checkpoints);
  const point = (pos: Position) => {
    const { x, y } = project(pos);
    return { left: `${50 + x / 2.7}%`, top: `${50 + y / 2}%` };
  };
  const length = (n: number) =>
    n < 1000 ? `${format.number(n)} m` : `${format.number(n / 1000, 1)} km`;
  const terrain = worlds.find((w) => w.key === center.world);
  return (
    <div className="ow-map-layout ow-space">
      <section className="ow-space-plot">
        <div className="ow-space-select">
          <Select
            label={t(k('layers.body'))}
            value={center.index}
            onChange={(e) => select(Number(e.target.value))}
          >
            {data.bodies.map((b) => (
              <option key={b.index} value={b.index}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="ow-space-stage">
          <svg
            viewBox="-135 -100 270 200"
            role="img"
            aria-label={t(k('layers.orbitalMap'), { body: center.name })}
          >
            <title>{t(k('layers.orbitalMap'), { body: center.name })}</title>
            <path className="ow-orbit-axis" d="M-135 0H135 M0 -100V100" />
            {bodies
              .filter((b) => b.parent === center.index)
              .map((b) => {
                const { x, y } = project(b.position);
                return <circle className="ow-orbit-ring" key={b.index} r={Math.hypot(x, y)} />;
              })}
            {visiblePins.map(({ item: p, x, y }) => (
              <path
                key={p.id}
                className="ow-orbit-checkpoint"
                transform={`translate(${x} ${y})`}
                d="M0 0 L4 -4 V-9 H9 L7 -7 L9 -5 H4"
                fill={p.color}
              >
                <title>{p.name}</title>
              </path>
            ))}
            {visiblePlayers.map(({ item: p, x, y }) => (
              <path
                key={p.id}
                className="ow-orbit-traveler"
                transform={`translate(${x} ${y})`}
                d="M0 0 L-6 -2 L-2 -6 Z"
              >
                <title>{p.name}</title>
              </path>
            ))}
          </svg>
          {bodies.map((b) => (
            <button
              key={b.index}
              type="button"
              className={`ow-orbit-body${b.isLight ? ' ow-orbit-light' : ''}`}
              style={point(b.position)}
              aria-label={t(k('layers.centerBody'), { name: b.name })}
              title={b.name}
              aria-pressed={b.index === center.index}
              onClick={() => select(b.index)}
            >
              <i aria-hidden="true" />
              <span aria-hidden="true">{b.name}</span>
            </button>
          ))}
        </div>
        <div className="ow-map-key ow-space-key">
          {checkpoints.length > 0 && (
            <span>
              <i className="ow-key-checkpoint" />
              {t(k('checkpoints'))}
            </span>
          )}
          {visiblePlayers.length > 0 && (
            <span>
              <i className="ow-key-traveler" />
              {t(k('layers.travelers'))}
            </span>
          )}
          <span>{t(k('layers.orbitScale'))}</span>
        </div>
      </section>
      <aside className="ow-map-side ow-orbit-details">
        <div className="ow-map-side-head">
          <h3>{center.name}</h3>
        </div>
        <dl className="ow-orbit-facts">
          <div>
            <dt>{t(k('layers.radius'))}</dt>
            <dd>{length(center.radiusMeters)}</dd>
          </div>
          {parent && (
            <>
              <div>
                <dt>{t(k('layers.parent'))}</dt>
                <dd>
                  <button
                    type="button"
                    className="ow-orbit-link"
                    onClick={() => select(parent.index)}
                  >
                    {parent.name}
                  </button>
                </dd>
              </div>
              <div>
                <dt>{t(k('layers.separation'), { name: parent.name })}</dt>
                <dd>{length(distance(center.position, parent.position))}</dd>
              </div>
            </>
          )}
        </dl>
        {terrain && (
          <button className="secondary" type="button" onClick={() => onTerrain(terrain.key)}>
            {t(k('layers.openTerrain'))}
          </button>
        )}
        {canTrack && (
          <OrbitalRoster
            key={`travelers-${center.index}`}
            title={t(k('layers.travelers'))}
            items={players}
            detail={(p) => length(distance(p.position, center.position))}
            empty={t(k('layers.noTravelers'))}
          />
        )}
        <OrbitalRoster
          key={`checkpoints-${center.index}`}
          title={t(k('checkpoints'))}
          items={checkpoints}
          detail={(p) => worlds.find((w) => w.key === p.world)?.name || p.world}
          empty={t(k('layers.noPins'))}
        />
      </aside>
    </div>
  );
}

function OrbitalRoster<T extends { id: number; name: string }>({
  title,
  items,
  detail,
  empty,
}: {
  title: string;
  items: T[];
  detail: (item: T) => string;
  empty: string;
}) {
  const t = useT();
  const [current, setCurrent] = useState(1);
  const total = Math.max(1, Math.ceil(items.length / 30)),
    page = Math.min(current, total);
  return (
    <section className="ow-orbit-roster">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.slice((page - 1) * 30, page * 30).map((item) => (
            <li key={item.id}>
              <span>{item.name}</span>
              <small>{detail(item)}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ow-empty">{empty}</p>
      )}
      {total > 1 && (
        <Pagination
          label={title}
          previousLabel={t('web.previous')}
          nextLabel={t('web.next')}
          summary={t('games.openworld.telemetry.pageNumber', { page, total })}
          canPrevious={page > 1}
          canNext={page < total}
          onPrevious={() => setCurrent(page - 1)}
          onNext={() => setCurrent(page + 1)}
        />
      )}
    </section>
  );
}
