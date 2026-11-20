import { skipToken, useQuery } from '@tanstack/react-query';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, apiError, consumeEvents, queryClient } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ConfirmDialog,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  Section,
  Time,
} from '../components/ui.js';
import { type ConsoleBuffer, consoleBufferWriter } from './console-buffer.js';
import {
  type DisplayResources,
  parseConsoleResources,
  rollingTelemetry,
  type TelemetrySample,
} from './console-resources.js';
import { ConsoleSummary } from './console-summary.js';
import { GameConsoleNotices } from './game-console-notices.js';
import {
  ProvisioningCompletion,
  ProvisioningPanel,
  provisioningLogLines,
  useProvisioning,
} from './provisioning.js';
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

const ConsoleOutput = memo(function ConsoleOutput({
  serverId,
  identity,
  setup,
  emptyLabel,
}: {
  serverId: string;
  identity?: string;
  setup?: Parameters<typeof provisioningLogLines>[0];
  emptyLabel?: string;
}) {
  const t = useT();
  const buffer = useQuery<ConsoleBuffer>({
    queryKey: ['console-buffer', identity, serverId],
    queryFn: skipToken,
    structuralSharing: false,
  });
  const text = useMemo(() => {
    const lines = provisioningLogLines(setup);
    if (identity && buffer.data)
      for (const line of buffer.data.lines)
        lines.push(line.type === 'status' ? t(`service.consoleStatus.${line.data}`) : line.data);
    return lines.length ? lines.join('\n') : (emptyLabel ?? t('service.noConsoleOutput'));
  }, [setup, identity, buffer.data, emptyLabel, t]);
  const output = useRef<HTMLElement>(null);
  const follow = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow only committed changes to the displayed output.
  useLayoutEffect(() => {
    if (follow.current && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [text]);
  return (
    <section
      ref={output}
      className="console"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must scroll the bounded console region.
      tabIndex={0}
      aria-label={t('service.consoleOutput')}
      onScroll={({ currentTarget }) => {
        follow.current =
          currentTarget.scrollHeight - currentTarget.clientHeight - currentTarget.scrollTop <= 2;
      }}
    >
      <pre role="log" aria-live="off">
        {text}
      </pre>
    </section>
  );
});

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

function transientFailure(error: unknown) {
  const failure = apiError(error);
  return (
    error instanceof TypeError ||
    ['integration_unavailable', 'internal_error', 'rate_limited'].includes(failure.code) ||
    failure.status >= 500
  );
}
function useLiveResources(serverId: string, streaming: boolean, enabled = true) {
  return useQuery({
    queryKey: ['resources', serverId],
    enabled,
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
  const expectedSetup = ['pending', 'installing', 'failed'].includes(
    server.data?.installationState ?? '',
  );
  const provisioning = useProvisioning(
    serverId,
    // Pack preparation has no provider job yet; read its durable progress on
    // entry too, so direct navigation and reload do not hide an Install intent.
    Boolean(server.data),
    server.data?.activeOperationId,
  );
  const setup =
    expectedSetup &&
    server.data?.activeOperationId &&
    provisioning.value?.jobId !== server.data.activeOperationId
      ? undefined
      : provisioning.value;
  const showSetup = Boolean(
    (setup &&
      setup.state !== 'completed' &&
      (setup.state !== 'start-denied' || server.data?.runtimeState === 'offline')) ||
      (!setup && expectedSetup),
  );
  const installing = showSetup && setup?.stage !== 'starting';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const [stats, setStats] = useState<{
    scope: string;
    at: number;
    resources: DisplayResources['resources'];
  }>();
  const [disk, setDisk] = useState<{ scope: string; bytes: number; at: number }>();
  const [state, setState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const session = useSession();
  const consoleDenied = Boolean(
    (server.data && !server.data.permissionKeys.includes('console.read')) ||
      (server.error && !transientFailure(server.error)),
  );
  const consoleAvailable = Boolean(
    !consoleDenied &&
      server.data?.capabilities?.console &&
      server.data.availableActions.console &&
      !installing,
  );
  const request = useRequestOperation(serverId);
  const [powerError, setPowerError] = useState<unknown>();
  const [powerBusy, setPowerBusy] = useState(false);
  const [restart, setRestart] = useState(false);
  const [killTarget, setKillTarget] = useState<string>();
  async function power(action: 'start' | 'stop' | 'restart' | 'kill', confirmation = false) {
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
      if (confirmation) throw failure;
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
  const scope = `${identity}:${serverId}`;
  const statsStale = useResourceStaleness(stats?.at ?? 0);
  const diskStale = useResourceStaleness(disk?.at ?? 0);
  const live = useLiveResources(
    serverId,
    state === 'connected' && stats?.scope === scope && !statsStale,
    !installing && Boolean(server.data?.availableActions.console),
  );
  const resourceStale = useResourceStaleness(live.dataUpdatedAt);
  const [error, setError] = useState<unknown>();
  const [runtime, setRuntime] = useState<{
    scope: string;
    value: Resources['current_state'];
    changedAt?: number;
  }>();
  const [connection, setConnection] = useState(0);
  const resourceState = !live.error && !resourceStale ? live.data?.current_state : undefined;
  const streamState = runtime?.scope === scope && state === 'connected' ? runtime : undefined;
  const powerState = streamState?.value ?? resourceState ?? server.data?.runtimeState;
  const freshStats =
    stats?.scope === scope && state === 'connected' && !statsStale ? stats : undefined;
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
    disk?.scope === scope && !diskStale
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
            uptime: confirmedState === 'running' ? measured.resources.uptime : undefined,
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
    if (!identity) return;
    const key = ['console-buffer', identity, serverId];
    if (!consoleAvailable) {
      if (consoleDenied) queryClient.removeQueries({ queryKey: key, exact: true });
      return;
    }
    const cache = queryClient.getQueryCache();
    const retained = cache.build<ConsoleBuffer>(queryClient, { queryKey: key });
    // Keep at most five server buffers in this tab, never persistent browser storage.
    const others = cache
      .findAll({ queryKey: ['console-buffer'] })
      .filter((entry) => entry !== retained);
    for (const entry of others
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
      .slice(4))
      cache.remove(entry);
    const writer = consoleBufferWriter(retained.state.data, (snapshot) => {
      // An identity reset may erase the cache before React tears down the old stream.
      if (cache.get(retained.queryHash) === retained) retained.setData(snapshot, { manual: true });
    });
    let observedStatus: string | undefined;
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
      let connected = false;
      setRuntime(undefined);
      setStats(undefined);
      observedStatus = undefined;
      setState('connecting');
      setError(undefined);
      try {
        await consumeEvents(
          `${serverPath(serverId)}/console${writer.hasHistory() ? '?history=0' : ''}`,
          {
            signal: controller.signal,
            onEvent: (event) => {
              if (controller.signal.aborted) return;
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
                writer.flush();
                connected = false;
                setStats(undefined);
                setState('disconnected');
                return;
              }
              if (!connected) {
                connected = true;
                setState('connected');
                attempts = 0;
              }
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
                if (type === 'status' && payload.data !== observedStatus) {
                  const changedAt = observedStatus !== undefined ? Date.now() : undefined;
                  setRuntime({
                    scope,
                    value: payload.data as Resources['current_state'],
                    changedAt,
                  });
                  setStats(undefined);
                  observedStatus = payload.data;
                  void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
                }
                // React escapes text. Strip terminal control sequences, never render HTML.
                const value = payload.data
                  .replace(terminalEscapes, '')
                  .replace(terminalControls, '');
                writer.append({ type, data: value.slice(-8192) });
              }
            },
          },
        );
        if (!controller.signal.aborted) {
          writer.flush();
          setState('disconnected');
          retry();
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure);
          setState('disconnected');
          if (transientFailure(failure)) {
            writer.flush();
            retry();
          } else {
            writer.discard();
            if (cache.get(retained.queryHash) === retained) {
              retained.setData({ lines: [] }, { manual: true });
              cache.remove(retained);
            }
          }
        }
      }
    }
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      writer.flush();
    };
  }, [serverId, identity, scope, connection, consoleAvailable, consoleDenied]);
  return (
    <>
      {Boolean(powerError) && <ErrorNotice error={powerError} />}
      {!showSetup && server.data?.firstStart && server.data.runtimeState === 'offline' && (
        <Notice>
          {t('platform.initialStartDenied')} <Time value={server.data.firstStart.occurredAt} />
        </Notice>
      )}
      {consoleAvailable && Boolean(error) && <ErrorNotice error={error} />}
      <ProvisioningCompletion key={serverId} value={setup} />
      {!showSetup && <GameConsoleNotices server={server.data} state={powerState} />}
      <div className={`console-workspace${showSetup ? ' is-provisioning' : ''}`}>
        <div className="console-heading">
          <h1 ref={heading} tabIndex={-1}>
            {server.data?.name}
          </h1>
          <Link className="console-details" to={`/servers/${serverId}/status`}>
            {t('web.details')}
          </Link>
        </div>
        <div className="console-actions">
          {(!showSetup || setup?.state === 'start-denied') &&
            server.data?.permissionKeys.includes('console.power') &&
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
          {consoleAvailable || showSetup ? (
            <div className="console-terminal">
              {showSetup && (
                <div className="provisioning-terminal-title">
                  <span>{t('provisioning.output')}</span>
                </div>
              )}
              {consoleAvailable && (
                <div className="console-connection-slot">
                  <Tooltip
                    content={t('service.connectionAction', { state: t(`service.${state}`) })}
                  >
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
              )}
              <ConsoleOutput
                key={`output:${scope}`}
                serverId={serverId}
                identity={consoleAvailable ? identity : undefined}
                setup={showSetup ? setup : undefined}
                emptyLabel={
                  showSetup
                    ? t(
                        setup?.logsAvailable === false
                          ? 'provisioning.outputUnavailable'
                          : 'provisioning.noOutput',
                      )
                    : undefined
                }
              />
              {!showSetup &&
                server.data?.permissionKeys.includes('console.command') &&
                identity && <ConsoleCommand key={scope} serverId={serverId} />}
            </div>
          ) : (
            <Notice>{t('web.unavailable')}</Notice>
          )}
        </div>
        {showSetup ? (
          <ProvisioningPanel
            serverId={serverId}
            name={server.data?.name ?? ''}
            value={setup}
            error={provisioning.error ?? provisioning.streamError}
            retry={provisioning.retry}
          />
        ) : (
          <ConsoleSummary
            serverId={serverId}
            resources={resources}
            observedAt={sampleAt}
            availability={resources ? 'ready' : live.isPending ? 'loading' : 'unavailable'}
          />
        )}
      </div>
      <ConfirmDialog
        open={restart}
        title={t('web.restart')}
        confirmLabel={t('web.restart')}
        onClose={() => setRestart(false)}
        onConfirm={() => power('restart', true)}
      >
        <p>{t('platform.restartWarning', { name: server.data?.name ?? '' })}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(killTarget)}
        title={t('service.killTitle')}
        confirmLabel={t('service.kill')}
        destructive
        onClose={() => setKillTarget(undefined)}
        onConfirm={async () => {
          if (!killAvailable || server.data?.activeOperationId !== killTarget)
            throw { messageKey: 'errors.conflict' };
          await power('kill', true);
        }}
      >
        <p>{t('service.killWarning')}</p>
      </ConfirmDialog>
      {!showSetup && (
        <Telemetry
          key={scope}
          serverId={serverId}
          live={live}
          resources={resources}
          sampleAt={sampleAt}
          stale={!measured && resourceStale}
        />
      )}
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
  // Both layers use the same continuous segments: missing samples must stay gaps.
  const segments = offline
    ? []
    : series
        .slice()
        .reverse()
        .flatMap((item) => {
          const continuous: Array<Array<[number, number]>> = [];
          let current: Array<[number, number]> = [];
          let previous = firstTime;
          for (const sample of item.values) {
            if (!Number.isFinite(sample.value)) {
              if (current.length) continuous.push(current);
              current = [];
              previous = sample.time;
              continue;
            }
            if (sample.time - previous > 2500) {
              if (current.length) continuous.push(current);
              current = [];
            }
            current.push([
              12 + ((sample.time - firstTime) / range) * 376,
              108 - (sample.value / maximum) * 92,
            ]);
            previous = sample.time;
          }
          if (current.length) continuous.push(current);
          return continuous.map((points, index) => ({
            key: `${item.label}-${index}`,
            points,
            color: item.color,
            direction: item.direction,
          }));
        });
  const lines = segments.filter((segment) => segment.points.length > 1);
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
        {lines.map(({ key, points, color, direction }) => (
          <polygon
            key={key}
            data-series={direction}
            points={`${points[0]?.[0]},108 ${points.map((point) => point.join(',')).join(' ')} ${points.at(-1)?.[0]},108`}
            fill={color}
            fillOpacity="0.12"
          />
        ))}
        {lines.map(({ key, points, color, direction }) => (
          <polyline
            key={key}
            data-series={direction}
            points={points.map((point) => point.join(',')).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth="2"
          />
        ))}
        {segments.map(({ key, points, color, direction }) =>
          points.length === 1 && points[0] ? (
            <circle
              key={key}
              data-series={direction}
              cx={points[0][0]}
              cy={points[0][1]}
              r="2"
              fill={color}
            />
          ) : null,
        )}
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
