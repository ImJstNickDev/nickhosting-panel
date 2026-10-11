import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, api, apiError, consumeEvents, queryClient } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import { Dialog, Empty, ErrorNotice, Loading, Notice, Section, Time } from '../components/ui.js';
import {
  type DisplayResources,
  parseConsoleResources,
  rollingTelemetry,
  type TelemetrySample,
} from './console-resources.js';
import { ConsoleSummary } from './console-summary.js';
import { useRequestOperation } from './servers.js';
import {
  type Metrics,
  platformPath,
  type Resources,
  serverPath,
  useServer,
} from './service-contracts.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strip ANSI escapes from provider console text.
const terminalEscapes = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: controls must not render inside plain console output.
const terminalControls = /[\x00-\x08\x0b-\x1f\x7f]/g;

function ConsoleOutput({
  output,
  lines,
  onScroll,
}: {
  output: React.RefObject<HTMLElement | null>;
  lines: string[];
  onScroll: React.UIEventHandler<HTMLElement>;
}) {
  const t = useT(),
    label = t('service.consoleOutput');
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must scroll the bounded console region.
    <section ref={output} className="console" tabIndex={0} aria-label={label} onScroll={onScroll}>
      <pre role="log" aria-live="off">
        {lines.length ? lines.join('\n') : t('service.noConsoleOutput')}
      </pre>
    </section>
  );
}

function ConsoleCommand({ serverId }: { serverId: string }) {
  const t = useT();
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submitting = useRef(false);
  return (
    <>
      <form
        className="console-prompt"
        aria-busy={busy}
        onSubmit={async (event) => {
          event.preventDefault();
          const value = command.trim();
          if (!value || submitting.current) return;
          submitting.current = true;
          setBusy(true);
          setError(undefined);
          try {
            await api(`${serverPath(serverId)}/console`, { body: { command: value } });
            setCommand('');
          } catch (failure) {
            setError(failure);
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <span aria-hidden="true">»</span>
        <input
          aria-label={t('web.command')}
          placeholder={t('service.commandPlaceholder')}
          name="console-command"
          type="text"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          readOnly={busy}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          maxLength={4096}
        />
      </form>
      {Boolean(error) && (
        <div className="console-command-error">
          <ErrorNotice error={error} />
        </div>
      )}
    </>
  );
}

type ConsoleLine = { type: 'console' | 'status'; data: string };
type ConsoleBuffer = { lines: ConsoleLine[]; lastStatus?: string };
function transientFailure(error: unknown) {
  const failure = apiError(error);
  return (
    error instanceof TypeError ||
    ['integration_unavailable', 'internal_error', 'rate_limited'].includes(failure.code) ||
    failure.status >= 500
  );
}
function useLiveResources(serverId: string, streaming: boolean) {
  return useQuery({
    queryKey: ['resources', serverId],
    queryFn: () => api<Resources>(`${serverPath(serverId)}/resources`),
    refetchInterval: streaming ? false : 10000,
    retry: (attempt, error) => attempt < 2 && transientFailure(error),
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

function useResourceStaleness(updatedAt: number) {
  const [expiredSnapshot, setExpiredSnapshot] = useState(0);
  useEffect(() => {
    if (!updatedAt) return;
    const timer = setTimeout(
      () => setExpiredSnapshot(updatedAt),
      Math.max(0, updatedAt + 30000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [updatedAt]);
  return updatedAt > 0 && (expiredSnapshot === updatedAt || Date.now() - updatedAt >= 30000);
}

export function ConsolePage({ serverId }: { serverId: string }) {
  const t = useT();
  const server = useServer(serverId);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [stats, setStats] = useState<{
    scope: string;
    at: number;
    resources: DisplayResources['resources'];
  }>();
  const [disk, setDisk] = useState<{ scope: string; bytes: number; at: number }>();
  const [state, setState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const session = useSession();
  const consoleAvailable = Boolean(server.data?.capabilities?.console);
  const request = useRequestOperation(serverId);
  const [powerError, setPowerError] = useState<unknown>();
  const [powerBusy, setPowerBusy] = useState(false);
  const [restart, setRestart] = useState(false);
  const [killTarget, setKillTarget] = useState<string>();
  async function power(action: 'start' | 'stop' | 'restart' | 'kill') {
    if (powerBusy) return;
    setPowerBusy(true);
    setPowerError(undefined);
    try {
      await request(
        action === 'kill' ? { action, confirm: true, operationId: killTarget } : { action },
      );
      setRestart(false);
      setKillTarget(undefined);
    } catch (failure) {
      setPowerError(failure);
    } finally {
      setPowerBusy(false);
    }
  }
  const context = session.data?.context;
  const identity =
    !session.error && context
      ? JSON.stringify([
          context.actorUserId,
          context.subjectUserId,
          context.sessionType,
          context.support?.id,
        ])
      : undefined;
  const [buffer, setBuffer] = useState<{ scope: string; lines: ConsoleLine[] }>({
    scope: '',
    lines: [],
  });
  const scope = `${identity}:${serverId}`;
  const live = useLiveResources(
    serverId,
    state === 'connected' && Boolean(stats?.scope === scope && now - stats.at < 30000),
  );
  const resourceStale = useResourceStaleness(live.dataUpdatedAt);
  const lines =
    buffer.scope === scope && identity
      ? buffer.lines.map((line) =>
          line.type === 'status' ? t(`service.consoleStatus.${line.data}`) : line.data,
        )
      : [];
  const [error, setError] = useState<unknown>();
  const [runtime, setRuntime] = useState<{
    scope: string;
    value: Resources['current_state'];
    at: number;
    changedAt?: number;
  }>();
  const [connection, setConnection] = useState(0);
  const follow = useRef(true);
  const output = useRef<HTMLElement>(null);
  const resourceState = !live.error && !resourceStale ? live.data?.current_state : undefined;
  const streamState = runtime?.scope === scope && state === 'connected' ? runtime : undefined;
  const powerState = streamState?.value ?? resourceState ?? server.data?.runtimeState;
  const freshStats =
    stats?.scope === scope && state === 'connected' && now - stats.at < 30000 ? stats : undefined;
  // REST resources can be provider-cached. A later HTTP response cannot prove a
  // new process baseline after a stream transition, even if its state matches.
  const transitionAt = runtime?.scope === scope ? runtime.changedAt : undefined;
  const freshRest =
    !live.error &&
    !resourceStale &&
    (!streamState || live.data?.current_state === streamState.value) &&
    (!transitionAt || live.dataUpdatedAt > transitionAt + 30000)
      ? live.data
      : undefined;
  const measured =
    freshStats ??
    (freshRest ? { resources: freshRest.resources, at: live.dataUpdatedAt } : undefined);
  const diskBytes =
    disk?.scope === scope && now - disk.at < 30000
      ? disk.bytes
      : !live.error && !resourceStale
        ? live.data?.resources.disk_bytes
        : undefined;
  const confirmedState = streamState?.value ?? resourceState;
  const resources: DisplayResources | undefined =
    measured && powerState
      ? {
          current_state: confirmedState ?? 'unknown',
          resources: {
            ...measured.resources,
            disk_bytes: diskBytes,
            uptime:
              confirmedState === 'running' && measured.resources.uptime !== undefined
                ? measured.resources.uptime + Math.max(0, now - measured.at)
                : undefined,
          },
        }
      : powerState && streamState
        ? { current_state: powerState, resources: { disk_bytes: diskBytes } }
        : undefined;
  const sampleAt = measured?.at ?? 0;
  const killAvailable = Boolean(server.data?.availableActions.kill && powerState === 'stopping');
  useEffect(() => {
    if (powerState !== 'stopping' || server.data?.activeOperationId !== killTarget)
      setKillTarget(undefined);
  }, [powerState, server.data?.activeOperationId, killTarget]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit reconnect and authenticated identity delimit the stream.
  useEffect(() => {
    if (!identity || !consoleAvailable) return;
    const key = ['console-buffer', identity, serverId];
    // These inactive query entries are erased by the existing sign-out/support identity reset.
    // Keep at most five server buffers in this tab, never persistent browser storage.
    const caches = queryClient.getQueryCache().findAll({ queryKey: ['console-buffer'] });
    for (const cache of caches
      .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)
      .slice(0, Math.max(0, caches.length - 4))) {
      if (JSON.stringify(cache.queryKey) !== JSON.stringify(key))
        queryClient.removeQueries({ queryKey: cache.queryKey, exact: true });
    }
    const cached = queryClient.getQueryData<ConsoleBuffer>(key);
    let current = cached?.lines ?? [];
    let lastStatus = cached?.lastStatus;
    let observedStatus: string | undefined;
    setBuffer({ scope, lines: current });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const retry = () => {
      timer = setTimeout(
        () => void connect(),
        Math.min(1000 * 2 ** Math.min(attempts++, 5), 30000),
      );
    };
    async function connect() {
      setRuntime(undefined);
      setStats(undefined);
      observedStatus = undefined;
      setState('connecting');
      setError(undefined);
      try {
        await consumeEvents(
          `${serverPath(serverId)}/console${current.length ? '?history=0' : ''}`,
          {
            signal: controller.signal,
            onEvent: (event) => {
              const payload = JSON.parse(event.data) as {
                type?: string;
                data?: unknown;
                code?: string;
              };
              const type = payload.type ?? event.type;
              if (type === 'error')
                throw new ApiError(
                  payload.code ?? 'integration_unavailable',
                  payload.code === 'forbidden' ? 'errors.forbidden' : 'service.consoleUnavailable',
                );
              if (type === 'closed') {
                setStats(undefined);
                setState('disconnected');
                return;
              }
              setState('connected');
              attempts = 0;
              if (type === 'stats') {
                const resources = parseConsoleResources(payload.data);
                if (resources) {
                  const at = Date.now();
                  setStats({ scope, at, resources });
                  if (resources.disk_bytes !== undefined)
                    setDisk({ scope, at, bytes: resources.disk_bytes });
                }
              }
              if ((type === 'console' || type === 'status') && typeof payload.data === 'string') {
                if (
                  type === 'status' &&
                  !['offline', 'starting', 'running', 'stopping'].includes(payload.data)
                )
                  return;
                // Status snapshots recur on provider stats/reconnects. Preserve transitions,
                // including across navigation or after the original status scrolls out.
                if (type === 'status') {
                  const at = Date.now();
                  const changedAt =
                    observedStatus !== undefined && payload.data !== observedStatus
                      ? at
                      : undefined;
                  setRuntime((previous) => ({
                    scope,
                    value: payload.data as Resources['current_state'],
                    at,
                    changedAt:
                      changedAt ?? (previous?.scope === scope ? previous.changedAt : undefined),
                  }));
                  if (payload.data !== observedStatus) {
                    setStats(undefined);
                    observedStatus = payload.data;
                    void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
                  }
                  if (payload.data === lastStatus) return;
                  lastStatus = payload.data;
                }
                // React escapes text. Strip terminal control sequences, never render HTML.
                const value = payload.data
                  .replace(terminalEscapes, '')
                  .replace(terminalControls, '');
                const line: ConsoleLine = { type, data: value.slice(-8192) };
                current = [...current, line].slice(-300);
                queryClient.setQueryData<ConsoleBuffer>(key, { lines: current, lastStatus });
                setBuffer({ scope, lines: current });
              }
            },
          },
        );
        if (!controller.signal.aborted) {
          setState('disconnected');
          retry();
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure);
          setState('disconnected');
          if (transientFailure(failure)) {
            retry();
          } else {
            current = [];
            queryClient.removeQueries({ queryKey: key, exact: true });
            setBuffer({ scope, lines: [] });
          }
        }
      }
    }
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [serverId, identity, scope, connection, consoleAvailable]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different server/session starts at the end of its own output.
  useLayoutEffect(() => {
    follow.current = true;
  }, [scope]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow appended output only while the user remains at the bottom.
  useLayoutEffect(() => {
    if (follow.current && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [lines]);
  return (
    <>
      {Boolean(powerError) && <ErrorNotice error={powerError} />}
      {server.data?.firstStart && server.data.runtimeState === 'offline' && (
        <Notice>
          {t('platform.initialStartDenied')} <Time value={server.data.firstStart.occurredAt} />
        </Notice>
      )}
      {consoleAvailable && Boolean(error) && <ErrorNotice error={error} />}
      <div className="console-workspace">
        <div className="console-heading">
          <h1 ref={heading} tabIndex={-1}>
            {server.data?.name}
          </h1>
        </div>
        <div className="console-actions">
          {server.data?.permissions.operate &&
            (['start', 'restart', powerState === 'stopping' ? 'kill' : 'stop'] as const).map(
              (action) => (
                <button
                  type="button"
                  key={action}
                  className={action === 'start' ? '' : 'secondary'}
                  disabled={
                    powerBusy ||
                    !server.data.availableActions[action] ||
                    (action === 'stop' && powerState === 'offline') ||
                    (action === 'kill' && !killAvailable)
                  }
                  onClick={() => {
                    if (action === 'restart') setRestart(true);
                    else if (action === 'kill')
                      setKillTarget(server.data?.activeOperationId ?? undefined);
                    else void power(action);
                  }}
                >
                  {t(action === 'kill' ? 'service.kill' : `web.${action}`)}
                </button>
              ),
            )}
        </div>
        <div className="console-terminal-slot">
          {consoleAvailable ? (
            <div className="console-terminal">
              <div className="console-connection-slot">
                <Tooltip content={t('service.connectionAction', { state: t(`service.${state}`) })}>
                  <button
                    type="button"
                    className="console-connection"
                    data-state={state}
                    aria-label={t('service.connectionAction', { state: t(`service.${state}`) })}
                    onClick={() => setConnection((value) => value + 1)}
                  >
                    <span className="console-connection-dot" aria-hidden="true" />
                  </button>
                </Tooltip>
                <span className="visually-hidden" role="status">
                  {t(`service.${state}`)}
                </span>
              </div>
              <ConsoleOutput
                output={output}
                lines={lines}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  follow.current =
                    element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
                }}
              />
              {server.data?.permissions.manage && identity && (
                <ConsoleCommand key={scope} serverId={serverId} />
              )}
            </div>
          ) : (
            <Notice>{t('web.unavailable')}</Notice>
          )}
        </div>
        <ConsoleSummary
          serverId={serverId}
          resources={resources}
          availability={resources ? 'ready' : live.isPending ? 'loading' : 'unavailable'}
        />
      </div>
      <Dialog open={restart} title={t('web.restart')} onClose={() => setRestart(false)}>
        <p>{t('platform.restartWarning', { name: server.data?.name ?? '' })}</p>
        <button type="button" disabled={powerBusy} onClick={() => void power('restart')}>
          {t('web.restart')}
        </button>
      </Dialog>
      <Dialog
        open={Boolean(killTarget)}
        title={t('service.killTitle')}
        onClose={() => setKillTarget(undefined)}
      >
        <p>{t('service.killWarning')}</p>
        <button
          type="button"
          disabled={powerBusy || !killAvailable || server.data?.activeOperationId !== killTarget}
          onClick={() => void power('kill')}
        >
          {t('service.kill')}
        </button>
      </Dialog>
      <Telemetry
        key={scope}
        serverId={serverId}
        live={live}
        resources={resources}
        sampleAt={sampleAt}
        stale={!measured && resourceStale}
      />
    </>
  );
}

type ChartSeries = {
  label: string;
  values: Array<{ time: number; value: number }>;
  color: string;
  direction?: 'inbound' | 'outbound';
};
function Chart({
  title,
  series,
  unit,
  end,
  offline,
}: {
  title: string;
  series: ChartSeries[];
  unit: string;
  end: number;
  offline: boolean;
}) {
  const t = useT(),
    format = useFormat();
  const values = series
    .flatMap((item) => item.values)
    .filter((sample) => Number.isFinite(sample.value));
  if (!values.length && !offline)
    return (
      <div>
        <h3>{title}</h3>
        <Empty text={t('service.noTelemetry')} />
      </div>
    );
  const firstTime = end - 30000;
  const lastTime = end;
  const maximum = Math.max(...values.map((value) => value.value), 1);
  const range = Math.max(lastTime - firstTime, 1);
  const network = series.some((item) => item.direction);
  const summary = offline
    ? t('web.offline')
    : series
        .map((item) => {
          const last = item.values.at(-1);
          return last && Number.isFinite(last.value)
            ? t('service.chartLabel', {
                name: item.label,
                value: format.number(last.value),
                unit,
                time: format.date(new Date(last.time)),
              })
            : `${item.label}: ${t('service.noTelemetry')}`;
        })
        .join('; ');
  return (
    <figure className={`metric-chart${network ? ' network-chart' : ''}`}>
      <figcaption>
        <h3>{title}</h3>
        {network && (
          <div className="network-legend">
            {series.map((item) => {
              const last = item.values.at(-1);
              return (
                <Tooltip
                  key={item.label}
                  content={`${item.label}: ${last && Number.isFinite(last.value) ? `${format.number(last.value)} ${unit}` : t('service.noTelemetry')}`}
                >
                  <button type="button" aria-label={item.label} style={{ color: item.color }}>
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path
                        d={
                          item.direction === 'inbound'
                            ? 'M12 3v12m-4-4 4 4 4-4'
                            : 'M12 15V3m-4 4 4-4 4 4'
                        }
                      />
                      <path d="M4 16v5h16v-5" />
                    </svg>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}
      </figcaption>
      <svg viewBox="0 0 400 115" role="img" aria-label={summary}>
        <path d="M12 10V109H390" fill="none" stroke="#8494a0" />
        {offline && (
          <polyline
            data-offline="true"
            points="12,108 388,108"
            fill="none"
            stroke={series[0]?.color}
            strokeWidth="2"
          />
        )}
        {!offline &&
          series
            .slice()
            .reverse()
            .map((item) => {
              const segments: string[] = [];
              let current = '';
              let previous = firstTime;
              for (const sample of item.values) {
                if (!Number.isFinite(sample.value)) {
                  if (current) segments.push(current);
                  current = '';
                  previous = sample.time;
                  continue;
                }
                if (sample.time - previous > 2500) {
                  if (current) segments.push(current);
                  current = '';
                }
                current += `${current ? ' ' : ''}${12 + ((sample.time - firstTime) / range) * 376},${108 - (sample.value / maximum) * 92}`;
                previous = sample.time;
              }
              if (current) segments.push(current);
              return segments.map((points) => (
                <polyline
                  key={`${item.label}-${points}`}
                  data-series={item.direction}
                  points={points}
                  fill="none"
                  stroke={item.color}
                  strokeWidth="2"
                />
              ));
            })}
        <text x="16" y="22" fill="#536372" fontSize="10">
          {format.number(maximum)} {unit}
        </text>
      </svg>
    </figure>
  );
}
function Telemetry({
  serverId,
  live,
  stale,
  resources,
  sampleAt,
}: {
  serverId: string;
  live: ReturnType<typeof useLiveResources>;
  stale: boolean;
  resources?: DisplayResources;
  sampleAt: number;
}) {
  const t = useT();
  const history = useQuery({
    queryKey: ['metrics', serverId, '30s'],
    queryFn: () => {
      const query = new URLSearchParams({
        limit: '100',
        from: new Date(Date.now() - 30000).toISOString(),
      });
      return api<Metrics>(`${platformPath(serverId)}/metrics?${query}`);
    },
    refetchInterval: 30000,
  });
  const offline = resources?.current_state === 'offline';
  const [processBoundary, setProcessBoundary] = useState(0);
  const [observations, setObservations] = useState<TelemetrySample[]>([]);
  const cpu = resources?.resources.cpu_absolute;
  const memory = resources?.resources.memory_bytes;
  const rx = resources?.resources.network_rx_bytes;
  const tx = resources?.resources.network_tx_bytes;
  useEffect(() => {
    if (offline) {
      setObservations([]);
      setProcessBoundary(Date.now());
      return;
    }
    if (!sampleAt || stale) return;
    setObservations((previous) =>
      rollingTelemetry(
        [
          ...previous,
          {
            time: sampleAt,
            cpu: cpu ?? NaN,
            memory: memory === undefined ? NaN : memory / 1048576,
            rx: rx === undefined ? NaN : rx / 1048576,
            tx: tx === undefined ? NaN : tx / 1048576,
          },
        ],
        Date.now(),
      ),
    );
  }, [sampleAt, stale, cpu, memory, rx, tx, offline]);
  const now = Date.now();
  const rows = (history.data?.items ?? []).slice().reverse();
  // Render the incoming sample and its time domain together, before the effect
  // retains it. The uptime clock must not advance the graph ahead of Wings.
  const candidates = [
    ...rows.map((row) => ({
      time: Date.parse(row.observed_at),
      memory: Number(row.memory_bytes) / 1048576,
      cpu: row.cpu_percent,
      rx: Number(row.network_rx_bytes) / 1048576,
      tx: Number(row.network_tx_bytes) / 1048576,
    })),
    ...observations,
    ...(sampleAt && !stale
      ? [
          {
            time: sampleAt,
            cpu: cpu ?? NaN,
            memory: memory === undefined ? NaN : memory / 1048576,
            rx: rx === undefined ? NaN : rx / 1048576,
            tx: tx === undefined ? NaN : tx / 1048576,
          },
        ]
      : []),
  ].filter((sample) => sample.time > processBoundary && sample.time <= now);
  const end = candidates.length ? Math.max(...candidates.map((sample) => sample.time)) : now;
  const samples = offline || now - end >= 30000 ? [] : rollingTelemetry(candidates, end);
  return (
    <Section title={t('service.telemetry')}>
      {live.error && !sampleAt && (
        <ErrorNotice
          error={
            transientFailure(live.error)
              ? new ApiError('integration_unavailable', 'service.telemetryUnavailable')
              : live.error
          }
          retry={() => void live.refetch()}
        />
      )}
      {Boolean(stale) && <Notice>{t('service.staleTelemetry')}</Notice>}
      {history.isPending && !samples.length && !offline ? (
        <Loading />
      ) : history.error && !samples.length && !offline ? (
        <ErrorNotice error={history.error} />
      ) : (
        <div className="columns resource-charts">
          <Chart
            offline={offline}
            end={end}
            title={t('web.cpu')}
            unit="%"
            series={[
              {
                label: t('web.cpu'),
                color: '#164cb1',
                values: samples.map((s) => ({ time: s.time, value: s.cpu })),
              },
            ]}
          />
          <Chart
            offline={offline}
            end={end}
            title={t('web.memory')}
            unit="MiB"
            series={[
              {
                label: t('web.memory'),
                color: '#164cb1',
                values: samples.map((s) => ({ time: s.time, value: s.memory })),
              },
            ]}
          />
          <Chart
            offline={offline}
            end={end}
            title={t('service.networkTraffic')}
            unit="MiB"
            series={[
              {
                label: t('service.received'),
                color: '#164cb1',
                direction: 'inbound',
                values: samples.map((s) => ({ time: s.time, value: s.rx })),
              },
              {
                label: t('service.sent'),
                color: '#a34b08',
                direction: 'outbound',
                values: samples.map((s) => ({ time: s.time, value: s.tx })),
              },
            ]}
          />
        </div>
      )}
    </Section>
  );
}
