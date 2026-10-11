import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, apiError, consumeEvents, queryClient } from '../api/client.js';
import { useFormat, useLocale, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import {
  ActionForm,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  JobNotice,
  Loading,
  Notice,
  Section,
  Select,
  Time,
  text,
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
}: {
  output: React.RefObject<HTMLElement | null>;
  lines: string[];
}) {
  const t = useT(),
    label = t('service.consoleOutput');
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must scroll the bounded console region.
    <section ref={output} className="console" tabIndex={0} aria-label={label}>
      <pre role="log" aria-live="off">
        {lines.length ? lines.join('\n') : t('service.noConsoleOutput')}
      </pre>
    </section>
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
  const [retained, setRetained] = useState(false);
  const [follow, setFollow] = useState(true);
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
    setRetained(current.length > 0);
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
          setRetained(current.length > 0);
          retry();
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure);
          setState('disconnected');
          if (transientFailure(failure)) {
            setRetained(current.length > 0);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll after each new bounded batch of output.
  useEffect(() => {
    if (follow && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [lines, follow]);
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
                <span role="status">{t(`service.${state}`)}</span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setConnection((value) => value + 1)}
                >
                  {t('service.reconnect')}
                </button>
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
            <ConsoleOutput output={output} lines={lines} />
            {retained && <p className="muted">{t('service.consoleRetained')}</p>}
            <label className="check">
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              {t('service.followConsole')}
            </label>
            {server.data?.permissions.manage && (
              <ActionForm
                submitLabel={t('web.send')}
                success={false}
                onSubmit={async (data) => {
                  await api(`${serverPath(serverId)}/console`, {
                    body: { command: text(data, 'command') },
                  });
                }}
              >
                <Input
                  label={t('web.command')}
                  name="command"
                  autoComplete="off"
                  maxLength={4096}
                  required
                />
              </ActionForm>
            )}
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

function Chart({
  title,
  values,
  unit,
}: {
  title: string;
  values: Array<{ time: number; value: number }>;
  unit: string;
}) {
  const t = useT(),
    format = useFormat(),
    { locale } = useLocale();
  const first = values[0],
    last = values.at(-1);
  if (!first || !last)
    return (
      <div>
        <h3>{title}</h3>
        <Empty text={t('service.noTelemetry')} />
      </div>
    );
  const maximum = Math.max(...values.map((value) => value.value), 1);
  const range = Math.max(last.time - first.time, 1);
  const segments: string[] = [];
  let current = '';
  let previous = first.time;
  for (const sample of values) {
    if (sample.time - previous > 120000) {
      if (current) segments.push(current);
      current = '';
    }
    current += `${current ? ' ' : ''}${12 + ((sample.time - first.time) / range) * 376},${108 - (sample.value / maximum) * 92}`;
    previous = sample.time;
  }
  if (current) segments.push(current);
  return (
    <figure className="metric-chart">
      <figcaption>
        <h3>{title}</h3>
        <span>
          {format.number(last.value)} {unit}
        </span>
      </figcaption>
      <svg
        viewBox="0 0 400 135"
        role="img"
        aria-label={t('service.chartLabel', {
          name: title,
          value: format.number(last.value),
          unit,
          time: format.date(new Date(last.time)),
        })}
      >
        <path d="M12 10V109H390" fill="none" stroke="#8494a0" />
        {segments.map((points) => (
          <polyline key={points} points={points} fill="none" stroke="#164cb1" strokeWidth="2" />
        ))}
        <text x="16" y="22" fill="#536372" fontSize="10">
          {format.number(maximum)} {unit}
        </text>
        <text x="12" y="130" fill="#536372" fontSize="10">
          {new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          }).format(first.time)}
        </text>
        <text x="389" y="130" textAnchor="end" fill="#536372" fontSize="10">
          {new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          }).format(last.time)}
        </text>
      </svg>
    </figure>
  );
}
export function Telemetry({ serverId }: { serverId: string }) {
  const t = useT(),
    format = useFormat();
  const [hours, setHours] = useState(1),
    [before, setBefore] = useState<string>();
  const live = useQuery({
    queryKey: ['resources', serverId],
    queryFn: () => api<Resources>(`${serverPath(serverId)}/resources`),
    refetchInterval: 10000,
    retry: (attempt, error) => attempt < 2 && transientFailure(error),
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
  const history = useQuery({
    queryKey: ['metrics', serverId, hours, before],
    queryFn: () => {
      const query = new URLSearchParams({
        limit: '100',
        from: new Date(Date.now() - hours * 3600000).toISOString(),
      });
      if (before) query.set('before', before);
      return api<Metrics>(`${platformPath(serverId)}/metrics?${query}`);
    },
    refetchInterval: before ? false : 30000,
  });
  const rows = (history.data?.items ?? []).slice().reverse();
  const samples = rows.map((row) => ({
    time: Date.parse(row.observed_at),
    memory: Number(row.memory_bytes) / 1048576,
    cpu: row.cpu_percent,
    rx: Number(row.network_rx_bytes) / 1048576,
    tx: Number(row.network_tx_bytes) / 1048576,
  }));
  if (!before && live.data && !live.error) {
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
      <div className="toolbar">
        <Select
          label={t('service.period')}
          value={hours}
          onChange={(event) => {
            setHours(Number(event.target.value));
            setBefore(undefined);
          }}
        >
          {[1, 6, 24, 168].map((value) => (
            <option value={value} key={value}>
              {t('service.hours', { count: value })}
            </option>
          ))}
        </Select>
        {before && (
          <button type="button" className="secondary" onClick={() => setBefore(undefined)}>
            {t('service.latest')}
          </button>
        )}
      </div>
      {history.isPending ? (
        <Loading />
      ) : history.error ? (
        <ErrorNotice error={history.error} />
      ) : (
        <>
          <div className="columns">
            <Chart
              title={t('web.memory')}
              unit="MiB"
              values={samples.map((s) => ({ time: s.time, value: s.memory }))}
            />
            <Chart
              title={t('web.cpu')}
              unit="%"
              values={samples.map((s) => ({ time: s.time, value: s.cpu }))}
            />
            <Chart
              title={t('service.received')}
              unit="MiB"
              values={samples.map((s) => ({ time: s.time, value: s.rx }))}
            />
            <Chart
              title={t('service.sent')}
              unit="MiB"
              values={samples.map((s) => ({ time: s.time, value: s.tx }))}
            />
          </div>
          <p className="muted">{t('service.networkCounters')}</p>
          {live.dataUpdatedAt > 0 && (
            <p>
              <Time value={new Date(live.dataUpdatedAt).toISOString()} />
            </p>
          )}
          <details>
            <summary>{t('service.measurements')}</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t('web.updated')}</th>
                    <th>{t('web.memory')}</th>
                    <th>{t('web.cpu')}</th>
                    <th>{t('service.received')}</th>
                    <th>{t('service.sent')}</th>
                  </tr>
                </thead>
                <tbody>
                  {samples
                    .slice()
                    .reverse()
                    .map((row) => (
                      <tr key={row.time}>
                        <td>
                          <Time value={new Date(row.time).toISOString()} />
                        </td>
                        <td>{format.number(row.memory)} MiB</td>
                        <td>{format.number(row.cpu)}%</td>
                        <td>{format.number(row.rx)} MiB</td>
                        <td>{format.number(row.tx)} MiB</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
          {history.data?.nextBefore && (
            <button
              type="button"
              className="secondary"
              onClick={() => setBefore(history.data.nextBefore!)}
            >
              {t('service.olderMeasurements')}
            </button>
          )}
        </>
      )}
    </Section>
  );
}
