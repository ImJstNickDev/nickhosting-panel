import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import type { ComponentType, ReactNode } from 'react';
import type {
  OpenworldObservation,
  OpenworldTelemetryData,
} from '../../../../../games/openworld/src/telemetry.js';
import { ApiError, api } from '../../api/client.js';
import { useFormat, useLocale, useT } from '../../app/i18n.js';
import { useSession, webSessionScope } from '../../app/session.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import './telemetry.css';

export type TelemetryViewProps = GameSectionViewProps & {
  viewerScope: ReturnType<typeof webSessionScope>;
};
export type ServerView = Pick<TelemetryViewProps, 'serverId' | 'runtimeState' | 'viewerScope'>;
export function withTelemetrySession(View: ComponentType<TelemetryViewProps>) {
  return function TelemetrySession(props: GameSectionViewProps) {
    const session = useSession();
    if (session.error)
      return <ErrorNotice error={session.error} retry={() => void session.refetch()} />;
    if (!session.data) return <Loading />;
    const scope = webSessionScope(session.data);
    return <View key={JSON.stringify([props.serverId, ...scope])} {...props} viewerScope={scope} />;
  };
}
export type Resource = keyof OpenworldTelemetryData;
type Result<K extends Resource> = OpenworldObservation<K>;
export type Observation<K extends Resource> = UseQueryResult<Result<K>, Error>;
export const key = (name: string) => `games.openworld.telemetry.${name}`;
export const base = (id: string) => `/v1/servers/${encodeURIComponent(id)}/openworld/telemetry`;

const intervals: Record<Resource, number> = {
  status: 5000,
  history: 15000,
  chunks: 15000,
  storage: 30000,
  players: 5000,
  player: 5000,
};
export function useTelemetry<K extends Resource>(
  server: ServerView,
  resource: K,
  path: string = resource,
  enabled = true,
) {
  return useQuery<Result<K>>({
    queryKey: [
      'openworld-telemetry',
      ...server.viewerScope,
      server.serverId,
      server.runtimeState,
      resource,
      path,
    ],
    queryFn: ({ signal }) => api<Result<K>>(`${base(server.serverId)}/${path}`, { signal }),
    enabled,
    staleTime: resource === 'player' ? 0 : Math.min(intervals[resource], 5000),
    gcTime: resource === 'player' ? 0 : 60000,
    refetchInterval: (query) =>
      server.runtimeState === 'running' &&
      !(
        query.state.error instanceof ApiError &&
        [401, 403, 404].includes(query.state.error.status ?? 0)
      )
        ? intervals[resource]
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export function useMetricsFormat() {
  const format = useFormat();
  const number = (value: unknown, unit = '', decimals = 1) =>
    numeric(value) ? `${format.number(value, decimals)}${unit ? ` ${unit}` : ''}` : '—';
  const bitrate = (value: unknown) =>
    numeric(value) && Math.abs(value) >= 1000
      ? number(value / 1000, 'Mb/s', 2)
      : number(value, 'kb/s');
  const duration = (value: unknown) => {
    if (!numeric(value)) return '—';
    const seconds = Math.max(0, Math.floor(value));
    const days = Math.floor(seconds / 86400),
      hours = Math.floor(seconds / 3600) % 24,
      mins = Math.floor(seconds / 60) % 60;
    if (days) return `${format.number(days)} d ${hours} h`;
    if (hours) return `${hours} h ${mins} min`;
    return mins ? `${mins} min` : `${seconds} s`;
  };
  return { ...format, metric: number, duration, bitrate };
}

const observationFormats = {
  en: new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium' }),
  it: new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'medium' }),
};
export function ObservationStamp({
  value,
}: {
  value?: Pick<Result<Resource>, 'source' | 'observedAt'>;
}) {
  const t = useT(),
    { locale } = useLocale();
  if (!value || value.source === 'unavailable') return null;
  const time = value.observedAt ? new Date(value.observedAt) : null;
  return (
    <div className="ow-stamp">
      <span className={value.source === 'live' ? 'ow-live' : 'ow-snapshot'}>
        {t(key(value.source))}
      </span>
      {time && Number.isFinite(time.getTime()) && (
        <time dateTime={time.toISOString()}>
          {observationFormats[locale === 'it' ? 'it' : 'en'].format(time)}
        </time>
      )}
    </div>
  );
}

export function TelemetryPanel<K extends Resource>({
  title,
  query,
  children,
  secondary = false,
}: {
  title: string;
  query: Observation<K>;
  children: (value: OpenworldTelemetryData[K], observation: Result<K>) => ReactNode;
  secondary?: boolean;
}) {
  const t = useT(),
    observation = query.data;
  const Header = secondary ? 'h3' : 'h2';
  const reason = observation?.reason ?? 'unavailable';
  return (
    <section className="ow-panel">
      <header className="ow-heading">
        <Header>{title}</Header>
        {!query.error && <ObservationStamp value={observation} />}
      </header>
      {query.error ? (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      ) : query.isPending ? (
        <Loading />
      ) : !observation?.data ? (
        <p className="ow-empty">
          {t(key(reason))}
          {reason !== 'unavailable' && <> {t(key('unavailable'))}</>}
        </p>
      ) : (
        <>
          {observation.source === 'snapshot' && observation.reason && (
            <p className="ow-observation-reason">{t(key(reason))}</p>
          )}
          {children(observation.data, observation)}
        </>
      )}
    </section>
  );
}

export function Metrics({
  items,
  large = false,
}: {
  items: [string, ReactNode][];
  large?: boolean;
}) {
  return (
    <dl className={large ? 'ow-metrics ow-big' : 'ow-metrics'}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
