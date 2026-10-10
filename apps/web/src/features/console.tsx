import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, consumeEvents } from '../api/client.js';
import { useFormat, useLocale, useT } from '../app/i18n.js';
import {
  ActionForm,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Section,
  Select,
  Time,
  text,
} from '../components/ui.js';
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

export function ConsolePage({ serverId }: { serverId: string }) {
  const t = useT();
  const server = useServer(serverId);
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<unknown>();
  const [connection, setConnection] = useState(0);
  const [follow, setFollow] = useState(true);
  const output = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an explicit reconnect restarts this stream.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function connect() {
      setState('connecting');
      setError(undefined);
      try {
        await consumeEvents(`${serverPath(serverId)}/console`, {
          signal: controller.signal,
          onEvent: (event) => {
            const payload = JSON.parse(event.data) as {
              type: string;
              data?: unknown;
              code?: string;
            };
            if (payload.type === 'error')
              throw { code: payload.code, messageKey: 'errors.integration_unavailable' };
            if (payload.type === 'closed') {
              setState('disconnected');
              return;
            }
            setState('connected');
            if (payload.type === 'console' && typeof payload.data === 'string') {
              // React escapes text. Strip terminal control sequences, never render HTML.
              const value = payload.data.replace(terminalEscapes, '').replace(terminalControls, '');
              setLines((previous) => [...previous, value.slice(-8192)].slice(-300));
            }
          },
        });
        if (!controller.signal.aborted) {
          setState('disconnected');
          timer = setTimeout(() => void connect(), 5000);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure);
          setState('disconnected');
        }
      }
    }
    setLines([]);
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [serverId, connection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll after each new bounded batch of output.
  useEffect(() => {
    if (follow && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [lines, follow]);
  return (
    <>
      <Section
        title={t('web.console')}
        actions={
          <div className="actions">
            <span role="status">{t(`service.${state}`)}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => setConnection((value) => value + 1)}
            >
              {t('service.reconnect')}
            </button>
          </div>
        }
      >
        {Boolean(error) && <ErrorNotice error={error} />}
        <ConsoleOutput output={output} lines={lines} />
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
      </Section>
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
    retry: false,
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
      {live.error && <ErrorNotice error={live.error} retry={() => void live.refetch()} />}
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
