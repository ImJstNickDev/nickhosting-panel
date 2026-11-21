import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { OpenworldSeedView } from '../../../../../games/openworld/src/seed-inspector.js';
import { ApiError, readApi } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { ErrorNotice, Loading, Select } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import { Metrics, type TelemetryViewProps, withTelemetrySession } from './telemetry.js';
import './seed-inspector.css';

const key = (s: string) => `games.openworld.seed.${s}`;
const groups = ['planets', 'biomes', 'materials', 'featureKinds', 'treeSpecies'] as const;
type Group = (typeof groups)[number];

function SeedCatalog({ data }: { data: OpenworldSeedView }) {
  const t = useT(),
    format = useFormat();
  const [group, setGroup] = useState<Group>('biomes'),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1);
  const needle = search.trim().toLowerCase();
  const rows = data[group].filter(
    (r) => r.key.toLowerCase().includes(needle) || r.name?.toLowerCase().includes(needle),
  );
  const pages = Math.max(1, Math.ceil(rows.length / 18)),
    current = Math.min(page, pages);
  return (
    <section className="ow-panel ow-seed-catalog">
      <h3>{t(key('catalog'))}</h3>
      <div className="ow-seed-controls">
        <Select
          label={t(key('group'))}
          value={group}
          onChange={(e) => {
            setGroup(e.target.value as Group);
            setSearch('');
            setPage(1);
          }}
        >
          {groups.map((g) => (
            <option key={g} value={g}>
              {t(key(g))} ({format.number(data[g].length)})
            </option>
          ))}
        </Select>
        <SearchField
          label={t(key('search'))}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {rows.length ? (
        <ul>
          {rows.slice((current - 1) * 18, current * 18).map((row) => (
            <li key={row.key}>
              {row.color && <i aria-hidden="true" style={{ backgroundColor: row.color }} />}
              <span>{row.name || row.key}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ow-empty">{t(key('empty'))}</p>
      )}
      {pages > 1 && (
        <Pagination
          label={t(key('catalog'))}
          previousLabel={t('web.previous')}
          nextLabel={t('web.next')}
          summary={t('games.openworld.telemetry.pageNumber', { page: current, total: pages })}
          canPrevious={current > 1}
          canNext={current < pages}
          onPrevious={() => setPage(current - 1)}
          onNext={() => setPage(current + 1)}
        />
      )}
    </section>
  );
}

function Inspector(props: TelemetryViewProps) {
  const t = useT(),
    f = useFormat();
  const canRead = props.permissionKeys.includes('game.openworld.seed.inspect'),
    running = props.runtimeState === 'running';
  const query = useQuery({
    queryKey: ['openworld-seed', ...props.viewerScope, props.serverId, running, canRead],
    queryFn: ({ signal }) =>
      readApi<OpenworldSeedView>(
        `/v1/servers/${encodeURIComponent(props.serverId)}/openworld/seed`,
        signal,
      ),
    enabled: canRead && running,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.error instanceof ApiError && [401, 403, 404].includes(query.state.error.status)
        ? false
        : 30000,
    refetchIntervalInBackground: false,
  });
  if (!canRead) return <ErrorNotice error={new ApiError('forbidden', 'errors.forbidden')} />;
  if (!running) return <p className="ow-empty">{t(key('offline'))}</p>;
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <Loading />;
  const data = query.data;
  const planet = data.planets.find((p) => p.key === data.planet);
  return (
    <div className="ow-workspace ow-seed">
      <section className="ow-panel">
        <header className="ow-heading">
          <h2>{planet?.name || data.planet}</h2>
          {data.inspectorUrl && (
            <a
              className="secondary"
              href={data.inspectorUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t(key('open'))}
            </a>
          )}
        </header>
        <dl className="ow-seed-value">
          <dt>{t(key('seed'))}</dt>
          <dd>
            <code>{data.seed}</code>
          </dd>
          {data.seedText && data.seedText !== data.seed && (
            <>
              <dt>{t(key('original'))}</dt>
              <dd>
                <code>{data.seedText}</code>
              </dd>
            </>
          )}
        </dl>
        <Metrics
          items={[
            [t(key('radius')), `${f.number(data.planetRadiusMeters / 1000, 1)} km`],
            [t(key('faceSize')), `${f.number(data.faceEdgeMeters / 1000, 1)} km`],
            [t(key('voxel')), `${f.number(data.voxelSize, 3)} m`],
            [
              t(key('spawn')),
              t(key('position'), {
                face: data.spawn.face,
                x: f.number(data.spawn.x, 1),
                z: f.number(data.spawn.z, 1),
              }),
            ],
          ]}
        />
        {!data.inspectorUrl && (
          <p className="ow-empty">
            {t(key(data.inspectorPublished ? 'restricted' : 'unpublished'))}
          </p>
        )}
      </section>
      <SeedCatalog data={data} />
    </div>
  );
}
export const OpenworldSeedInspector = withTelemetrySession(Inspector);
