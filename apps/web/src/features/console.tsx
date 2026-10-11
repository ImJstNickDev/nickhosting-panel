import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, apiError, consumeEvents, queryClient } from '../api/client.js';
import { useFormat, useLocale, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import {
  Dialog,
  Empty,
  ErrorNotice,
  JobNotice,
  Loading,
  Notice,
  Section,
  Time,
} from '../components/ui.js';
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
export function ConsolePage({ serverId }: { serverId: string }) {
  const t = useT();
  const server = useServer(serverId);
  const session = useSession();
  const consoleAvailable = Boolean(server.data?.capabilities?.console);
  const request = useRequestOperation(serverId);
  const [powerError, setPowerError] = useState<unknown>();
  const [powerBusy, setPowerBusy] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const [restart, setRestart] = useState(false);
  async function power(action: 'start' | 'stop' | 'restart') {
    if (powerBusy) return;
    setPowerBusy(true);
    setPowerError(undefined);
    try {
      const job = await request({ action });
      setJobId(job.jobId);
      setRestart(false);
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
  const lines =
    buffer.scope === scope && identity
      ? buffer.lines.map((line) =>
          line.type === 'status' ? t(`service.consoleStatus.${line.data}`) : line.data,
        )
      : [];
  const [state, setState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<unknown>();
  const [connection, setConnection] = useState(0);
  const follow = useRef(true);
  const output = useRef<HTMLElement>(null);
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
                setState('disconnected');
                return;
              }
              setState('connected');
              attempts = 0;
              if ((type === 'console' || type === 'status') && typeof payload.data === 'string') {
                if (
                  type === 'status' &&
                  !['offline', 'starting', 'running', 'stopping'].includes(payload.data)
                )
                  return;
                // Status snapshots recur on provider stats/reconnects. Preserve transitions,
                // including across navigation or after the original status scrolls out.
                if (type === 'status') {
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
      <Section
        title={t('web.console')}
        actions={
          <div className="actions console-actions">
            {server.data?.permissions.operate &&
              (['start', 'stop', 'restart'] as const).map((action) => (
                <button
                  type="button"
                  key={action}
                  className={action === 'start' ? '' : 'secondary'}
                  disabled={powerBusy || !server.data.availableActions[action]}
                  onClick={() => (action === 'restart' ? setRestart(true) : void power(action))}
                >
                  {t(`web.${action}`)}
                </button>
              ))}
            {consoleAvailable && (
              <>
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
              </>
            )}
          </div>
        }
      >
        {Boolean(powerError) && <ErrorNotice error={powerError} />}
        <JobNotice jobId={jobId} />
        {server.data?.activeOperationId && (
          <Notice>
            <Link to={`/activity/${server.data.activeOperationId}`}>
              {t('platform.operationBlocksActions')}
            </Link>
          </Notice>
        )}
        {server.data?.firstStart && server.data.runtimeState === 'offline' && (
          <Notice>
            {t('platform.initialStartDenied')} <Time value={server.data.firstStart.occurredAt} />
          </Notice>
        )}
        {consoleAvailable ? (
          <>
            {Boolean(error) && <ErrorNotice error={error} />}
            <div className="console-terminal">
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
          </>
        ) : (
          <Notice>{t('web.unavailable')}</Notice>
        )}
      </Section>
      <Dialog open={restart} title={t('web.restart')} onClose={() => setRestart(false)}>
        <p>{t('platform.restartWarning', { name: server.data?.name ?? '' })}</p>
        <button type="button" disabled={powerBusy} onClick={() => void power('restart')}>
          {t('web.restart')}
        </button>
      </Dialog>
      <Telemetry serverId={serverId} />
    </>
  );
}

type ChartSeries = {
  label: string;
  values: Array<{ time: number; value: number }>;
  color: string;
  direction?: 'inbound' | 'outbound';
};
function Chart({ title, series, unit }: { title: string; series: ChartSeries[]; unit: string }) {
  const t = useT(),
    format = useFormat(),
    { locale } = useLocale();
  const values = series.flatMap((item) => item.values);
  if (!values.length)
    return (
      <div>
        <h3>{title}</h3>
        <Empty text={t('service.noTelemetry')} />
      </div>
    );
  const firstTime = Math.min(...values.map((value) => value.time));
  const lastTime = Math.max(...values.map((value) => value.time));
  const maximum = Math.max(...values.map((value) => value.value), 1);
  const range = Math.max(lastTime - firstTime, 1);
  const network = series.some((item) => item.direction);
  const summary = series
    .map((item) => {
      const last = item.values.at(-1);
      return last
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
        {network ? (
          <div className="network-legend">
            {series.map((item) => {
              const last = item.values.at(-1);
              return (
                <Tooltip
                  key={item.label}
                  content={`${item.label}: ${last ? `${format.number(last.value)} ${unit}` : t('service.noTelemetry')}`}
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
        ) : (
          <span>
            {format.number(series[0]?.values.at(-1)?.value ?? 0)} {unit}
          </span>
        )}
      </figcaption>
      <svg viewBox="0 0 400 135" role="img" aria-label={summary}>
        <path d="M12 10V109H390" fill="none" stroke="#8494a0" />
        {series
          .slice()
          .reverse()
          .map((item) => {
            const segments: string[] = [];
            let current = '';
            let previous = firstTime;
            for (const sample of item.values) {
              if (sample.time - previous > 120000) {
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
        <text x="12" y="130" fill="#536372" fontSize="10">
          {new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          }).format(firstTime)}
        </text>
        <text x="389" y="130" textAnchor="end" fill="#536372" fontSize="10">
          {new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          }).format(lastTime)}
        </text>
      </svg>
    </figure>
  );
}
export function Telemetry({ serverId }: { serverId: string }) {
  const t = useT();
  const live = useQuery({
    queryKey: ['resources', serverId],
    queryFn: () => api<Resources>(`${serverPath(serverId)}/resources`),
    refetchInterval: 10000,
    retry: (attempt, error) => attempt < 2 && transientFailure(error),
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
  const history = useQuery({
    queryKey: ['metrics', serverId, 1],
    queryFn: () => {
      const query = new URLSearchParams({
        limit: '100',
        from: new Date(Date.now() - 3600000).toISOString(),
      });
      return api<Metrics>(`${platformPath(serverId)}/metrics?${query}`);
    },
    refetchInterval: 30000,
  });
  const rows = (history.data?.items ?? []).slice().reverse();
  const samples = rows.map((row) => ({
    time: Date.parse(row.observed_at),
    memory: Number(row.memory_bytes) / 1048576,
    cpu: row.cpu_percent,
    rx: Number(row.network_rx_bytes) / 1048576,
    tx: Number(row.network_tx_bytes) / 1048576,
  }));
  if (live.data && !live.error) {
    const r = live.data.resources;
    samples.push({
      time: live.dataUpdatedAt,
      memory: r.memory_bytes / 1048576,
      cpu: r.cpu_absolute,
      rx: r.network_rx_bytes / 1048576,
      tx: r.network_tx_bytes / 1048576,
    });
  }
  const stale = live.dataUpdatedAt && Date.now() - live.dataUpdatedAt > 30000;
  return (
    <Section title={t('service.telemetry')}>
      {live.error && (
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
      {history.isPending ? (
        <Loading />
      ) : history.error ? (
        <ErrorNotice error={history.error} />
      ) : (
        <div className="columns resource-charts">
          <Chart
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
