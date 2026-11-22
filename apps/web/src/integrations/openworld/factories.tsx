import { Link } from 'react-router';
import type { OpenworldFactoriesSnapshot } from '../../../../../games/openworld/src/factories.js';
import { ApiError } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import { factoryMapPoint, useFactoryData } from './map-factories.js';
import { mapHref } from './map-players.js';
import {
  Metrics,
  type TelemetryViewProps,
  useMetricsFormat,
  withTelemetrySession,
} from './telemetry.js';
import './factories.css';

const key = (name: string) => `games.openworld.factories.${name}`;
type Props = { data: OpenworldFactoriesSnapshot; serverId: string; canViewMap: boolean };

function FactoryColumns({ data, serverId, canViewMap }: Props) {
  const t = useT();
  const { metric } = useMetricsFormat();
  const columns = data.topColumns;
  return (
    <section className="ow-panel">
      <header className="ow-heading">
        <h3>{t(key('columns'))}</h3>
      </header>
      {columns?.length ? (
        <ol className="ow-factory-columns">
          {columns.map((c) => {
            const point = factoryMapPoint(c);
            const location =
              c.i != null && c.j != null && c.face != null
                ? t(key('coords'), { face: c.face, i: c.i, j: c.j })
                : point
                  ? t(key('position'), point)
                  : null;
            return (
              <li key={`${c.world}:${c.face}:${c.i}:${c.j}:${c.x}:${c.z}`}>
                <div>
                  <strong>{c.world ?? t(key('missing'))}</strong>
                  {location && <small>{location}</small>}
                  {canViewMap && point && (
                    <Link to={`${mapHref(serverId, point)}&origin=factories`}>{t(key('map'))}</Link>
                  )}
                </div>
                <Metrics
                  items={[
                    [t(key('cost')), metric(c.usPerS, 'µs/s', 2)],
                    [t(key('share')), metric(c.share == null ? null : c.share * 100, '%')],
                    [t(key('nodes')), metric(c.nodes)],
                    [t(key('nets')), metric(c.nets)],
                  ]}
                />
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="ow-empty">{t(key(columns == null ? 'missing' : 'noColumns'))}</p>
      )}
    </section>
  );
}

function FactoryMetrics({ data, ...access }: Props) {
  const t = useT();
  const { metric } = useMetricsFormat();
  const wh = (joules?: number | null) => metric(joules == null ? null : joules / 3600, 'Wh', 2);
  return (
    <div className="ow-workspace">
      <section className="ow-panel">
        <header className="ow-heading">
          <h2>{t(key('simulation'))}</h2>
          <span className="ow-stamp">
            {data.paused && <strong>{t(key('paused'))}</strong>}
            {data.scope && t(key(data.scope))}
          </span>
        </header>
        {data.counts?.nodes === 0 && <p className="ow-empty">{t(key('empty'))}</p>}
        <div className="ow-factory-measures">
          <Metrics
            items={[
              [t(key('frequency')), metric(data.hz, 'Hz', 2)],
              [t(key('target')), metric(data.targetHz, 'Hz', 2)],
              [t(key('p95')), metric(data.stepMs?.p95, 'ms', 3)],
            ]}
          />
          <Metrics
            items={[
              [t(key('nodes')), metric(data.counts?.nodes)],
              [t(key('nets')), metric(data.counts?.nets)],
              [t(key('pieces')), metric(data.counts?.pieces)],
            ]}
          />
        </div>
      </section>
      <div className="ow-factory-flows">
        <section className="ow-panel">
          <header className="ow-heading">
            <h3>{t(key('power'))}</h3>
          </header>
          <Metrics
            items={[
              [t(key('produced')), metric(data.power?.producedW, 'W')],
              [t(key('used')), metric(data.power?.usedW, 'W')],
              [t(key('stored')), wh(data.power?.storedJ)],
              [t(key('capacity')), wh(data.power?.capacityJ)],
            ]}
          />
        </section>
        <section className="ow-panel">
          <header className="ow-heading">
            <h3>{t(key('transit'))}</h3>
          </header>
          <Metrics
            items={[
              [t(key('items')), metric(data.transit?.items)],
              [t(key('fluids')), metric(data.transit?.fluidVoxels)],
            ]}
          />
        </section>
      </div>
      <FactoryColumns {...access} data={data} />
    </div>
  );
}

function Factories(props: TelemetryViewProps) {
  const t = useT();
  const canRead = props.permissionKeys.includes('game.openworld.performance.read');
  const online = props.runtimeState === 'running';
  const query = useFactoryData(props, true);
  if (!canRead) return <ErrorNotice error={new ApiError('forbidden', 'errors.forbidden')} />;
  if (online && query.error)
    return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  if (online && query.isPending) return <Loading />;
  const warming = query.data?.steps === 0 && query.data.hz == null && query.data.counts == null;
  if (online && query.data?.enabled && !warming)
    return (
      <FactoryMetrics
        data={query.data}
        serverId={props.serverId}
        canViewMap={props.permissionKeys.includes('game.openworld.map.read')}
      />
    );
  const state = !online ? 'offline' : query.data?.enabled === false ? 'disabled' : 'waiting';
  return (
    <section className="ow-workspace ow-panel">
      <header className="ow-heading">
        <h2>{t(key('simulation'))}</h2>
      </header>
      <p className="ow-empty">{t(key(state))}</p>
    </section>
  );
}

export const OpenworldFactories = withTelemetrySession(Factories);
