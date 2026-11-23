import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { OpenworldFactoriesSnapshot } from '../../../../../games/openworld/src/factories.js';
import { ApiError } from '../../api/client.js';
import { useLocale, useT } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import {
  FactoryDevices,
  FactoryHistory,
  FactoryMemory,
  FactoryNetworks,
  FactoryPhases,
  factoryKey as key,
} from './factory-breakdowns.js';
import {
  type FactoryConnection as Connection,
  useFactoryConnection,
} from './factory-connection.js';
import { FactoryPower, FactorySystems, FactoryTransit } from './factory-flows.js';
import { factoryMapPoint, useFactoryData } from './map-factories.js';
import { mapHref } from './map-players.js';
import {
  Metrics,
  numeric,
  type TelemetryViewProps,
  useMetricsFormat,
  withTelemetrySession,
} from './telemetry.js';
import './factories.css';

type Props = { data: OpenworldFactoriesSnapshot; serverId: string; canViewMap: boolean };
const stampFormats = {
  en: new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium' }),
  it: new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'medium' }),
};

function ConnectionNotice({ connection }: { connection: Connection }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <p className="ow-factory-connection" role="status">
      {t(key(connection.paused ? 'connectionPaused' : 'resuming'))}
      {connection.receivedAt > 0 && (
        <>
          {' '}
          {t(key('lastReading'))} ·{' '}
          <time dateTime={new Date(connection.receivedAt).toISOString()}>
            {stampFormats[locale === 'it' ? 'it' : 'en'].format(connection.receivedAt)}
          </time>
        </>
      )}
    </p>
  );
}

function FactoryColumns({ data, serverId, canViewMap }: Props) {
  const t = useT();
  const { metric } = useMetricsFormat();
  const columns = data.topColumns;
  const measured = columns?.flatMap((column) => column.share ?? []) ?? [];
  const total = measured.reduce((sum, share) => sum + share, 0);
  const headers = ['location', 'cost', 'share', 'nodes', 'nets'];
  return (
    <section className="ow-panel ow-factory-hotspots">
      <header className="ow-heading">
        <h3>{t(key('columns'))}</h3>
      </header>
      {columns?.length ? (
        <>
          {measured.length === columns.length && (
            <p className="ow-factory-caption">
              {t(key('columnsShare'), {
                count: metric(columns.length),
                share: metric(total * 100, '%'),
              })}
            </p>
          )}
          <table className="ow-table ow-factory-table" aria-label={t(key('columns'))}>
            <thead>
              <tr>
                {headers.map((id) => (
                  <th key={id} scope="col">
                    {t(key(id))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => {
                const point = factoryMapPoint(column);
                const hasIndex = column.i != null && column.j != null;
                const centerX = column.x ?? (column.i != null ? column.i * 16 + 8 : null);
                const centerZ = column.z ?? (column.j != null ? column.j * 16 + 8 : null);
                return (
                  <tr
                    key={`${column.world}:${column.face}:${column.i}:${column.j}:${column.x}:${column.z}`}
                  >
                    <th scope="row">
                      <strong>{column.world ?? t(key('missing'))}</strong>
                      <small>
                        {[
                          column.face != null && t(key('face'), { value: column.face }),
                          hasIndex &&
                            t(key('columnIndex'), { i: metric(column.i), j: metric(column.j) }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                      {centerX !== null && centerZ !== null && (
                        <small>
                          {t(key('center'), { x: metric(centerX), z: metric(centerZ) })}
                        </small>
                      )}
                      {canViewMap && point && (
                        <Link to={`${mapHref(serverId, point)}&origin=factories`}>
                          {t(key('map'))}
                          <span className="visually-hidden">
                            {' '}
                            · {point.world} · {point.x}, {point.z}
                          </span>
                        </Link>
                      )}
                    </th>
                    <td data-label={t(key('cost'))}>{metric(column.usPerS, 'µs/s', 2)}</td>
                    <td data-label={t(key('share'))}>
                      {metric(column.share == null ? null : column.share * 100, '%')}
                      {numeric(column.share) && (
                        <span className="ow-factory-track" aria-hidden="true">
                          <i style={{ width: `${100 * column.share}%` }} />
                        </span>
                      )}
                    </td>
                    <td data-label={t(key('nodes'))}>{metric(column.nodes)}</td>
                    <td data-label={t(key('nets'))}>{metric(column.nets)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <p className="ow-empty">{t(key(columns == null ? 'missing' : 'noColumns'))}</p>
      )}
    </section>
  );
}

function Headline({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <div className="ow-factory-headline">
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {children}
      </dd>
    </div>
  );
}

function FactoryOverview({
  data,
  connection,
}: {
  data: OpenworldFactoriesSnapshot;
  connection: Connection;
}) {
  const t = useT();
  const { metric, duration } = useMetricsFormat();
  const budget = numeric(data.targetHz) && data.targetHz > 0 ? 1000 / data.targetHz : null;
  const speed =
    data.speed ??
    (numeric(data.hz) && numeric(data.targetHz) && data.targetHz > 0
      ? data.hz / data.targetHz
      : null);
  const scheduling = [
    [t(key('cap')), metric(data.cappedHz, 'Hz')],
    [t(key('cpuTime')), metric(data.cpuMs, 'ms', 4)],
    [t(key('late')), metric(data.lateMsP95, 'ms', 3)],
    [t(key('debt')), metric(data.debtMs, 'ms', 3)],
    [t(key('dropped')), metric(data.droppedPerSecond, '/s', 2)],
    [t(key('duty')), metric(numeric(data.duty) ? 100 * data.duty : null, '%', 2)],
    [t(key('priority')), metric(data.priority)],
    [t(key('qos')), data.qos ?? '—'],
    [t(key('loadedColumns')), metric(data.loadedColumns)],
    [t(key('uptime')), duration(data.uptimeSeconds)],
  ] satisfies [string, string][];
  return (
    <section className="ow-panel">
      <header className="ow-heading">
        <h2>{t(key('simulation'))}</h2>
        <span className="ow-stamp">
          {connection.cached ? (
            <strong className="ow-snapshot">{t(key('lastReading'))}</strong>
          ) : (
            data.paused != null && (
              <strong className={data.paused ? 'ow-snapshot' : 'ow-live'}>
                {t(key(data.paused ? 'paused' : 'active'))}
              </strong>
            )
          )}
          {data.scope && t(key(data.scope))}
        </span>
      </header>
      {connection.cached && <ConnectionNotice connection={connection} />}
      <dl className="ow-factory-headlines">
        <Headline label={t(key('frequency'))} value={metric(data.hz, 'Hz', 2)}>
          <span>
            {t(key('target'))} <b>{metric(data.targetHz, 'Hz', 2)}</b>
          </span>
          {numeric(speed) && (
            <span>{t(key('targetShare'), { percent: metric(speed * 100, '%') })}</span>
          )}
        </Headline>
        <Headline label={t(key('meanStep'))} value={metric(data.stepMs?.mean, 'ms', 4)}>
          <span>
            {t(key('p95'))} <b>{metric(data.stepMs?.p95, 'ms', 3)}</b>
          </span>
          {numeric(data.stepMs?.max) && (
            <span>
              {t(key('maxStep'))} <b>{metric(data.stepMs.max, 'ms', 3)}</b>
            </span>
          )}
          {numeric(budget) && (
            <span>
              {t(key('stepBudget'))} <b>{metric(budget, 'ms', 2)}</b>
            </span>
          )}
        </Headline>
        <Headline label={t(key('nodes'))} value={metric(data.counts?.nodes)}>
          <span>
            {t(key('nets'))} <b>{metric(data.counts?.nets)}</b>
          </span>
          <span>
            {t(key('pieces'))} <b>{metric(data.counts?.pieces)}</b>
          </span>
        </Headline>
        <Headline label={t(key('simTime'))} value={duration(data.simSeconds)}>
          <span>
            {t(key('steps'))} <b>{metric(data.steps)}</b>
          </span>
          {numeric(data.simSeconds) && numeric(data.uptimeSeconds) && data.uptimeSeconds > 0 && (
            <span>
              {t(key('uptimeShare'), {
                percent: metric((100 * data.simSeconds) / data.uptimeSeconds, '%'),
              })}
            </span>
          )}
        </Headline>
      </dl>
      {data.counts?.nodes === 0 && <p className="ow-empty">{t(key('empty'))}</p>}
      {scheduling.some(([, value]) => value !== '—') && (
        <details className="ow-disclosure">
          <summary>{t(key('timingDetails'))}</summary>
          <Metrics items={scheduling} />
        </details>
      )}
    </section>
  );
}

function FactoryMetrics({ data, connection, ...access }: Props & { connection: Connection }) {
  return (
    <div className="ow-workspace ow-factories">
      <FactoryOverview data={data} connection={connection} />
      {data.counts && (
        <div className="ow-factory-flows">
          <FactoryDevices counts={data.counts} />
          <FactoryNetworks counts={data.counts} />
        </div>
      )}
      {(data.power || data.transit) && (
        <div className="ow-factory-flows">
          {data.power && <FactoryPower power={data.power} />}
          {data.transit && <FactoryTransit transit={data.transit} />}
        </div>
      )}
      {(data.rotation || data.radio || data.pumps) && <FactorySystems data={data} />}
      {data.memory && <FactoryMemory memory={data.memory} />}
      {data.history && (
        <FactoryHistory rows={data.history} isLive={!connection.cached} targetHz={data.targetHz} />
      )}
      {data.phasesMs && <FactoryPhases phases={data.phasesMs} targetHz={data.targetHz} />}
      <FactoryColumns {...access} data={data} />
    </div>
  );
}

function Factories(props: TelemetryViewProps) {
  const t = useT();
  const canRead = props.permissionKeys.includes('game.openworld.performance.read');
  const online = props.runtimeState === 'running';
  const query = useFactoryData(props, true);
  const connection = useFactoryConnection(query);
  const { paused } = connection;
  if (!canRead) return <ErrorNotice error={new ApiError('forbidden', 'errors.forbidden')} />;
  if (online && query.error)
    return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  if (online && query.isPending && !paused) return <Loading />;
  const warming =
    query.data?.steps === 0 &&
    !query.data.paused &&
    !Object.entries(query.data).some(
      ([field, value]) =>
        value != null && !['enabled', 'paused', 'scope', 'steps', 'targetHz'].includes(field),
    );
  if (online && query.data?.enabled && !warming)
    return (
      <FactoryMetrics
        data={query.data}
        connection={connection}
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
      {online && connection.cached && <ConnectionNotice connection={connection} />}
      {(!online || !paused || query.data) && <p className="ow-empty">{t(key(state))}</p>}
    </section>
  );
}

export const OpenworldFactories = withTelemetrySession(Factories);
