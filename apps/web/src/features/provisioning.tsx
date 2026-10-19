import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, apiError, consumeEvents, queryClient } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { ConfirmDialog } from '../components/ui.js';
import { useRequestOperation } from './servers.js';
import { serverPath } from './service-contracts.js';
import './provisioning.css';

import type { ProvisioningSnapshot, ProvisioningStage } from './provisioning.api.js';

type Envelope = { provisioning: ProvisioningSnapshot | null };
function accessLost(error: unknown) {
  return ['forbidden', 'unauthenticated', 'not_found'].includes(apiError(error).code);
}
export function provisioningInProgress(value?: ProvisioningSnapshot | null) {
  return value?.state === 'active' || value?.state === 'uncertain';
}

/** One resumable, identity-scoped stream. Database snapshots recover missed events. */
export function useProvisioning(serverId: string, enabled: boolean, operationId?: string | null) {
  const session = useSession();
  const context = session.data?.context;
  const identity =
    context && !session.error
      ? JSON.stringify([
          context.actorUserId,
          context.subjectUserId,
          context.sessionType,
          context.support?.id,
        ])
      : undefined;
  const key = ['provisioning', identity, serverId] as const;
  // A server refresh can clear activeOperationId before the final progress frame arrives.
  // Keep this known journey subscribed until its own authoritative terminal snapshot.
  const observing =
    enabled || provisioningInProgress(queryClient.getQueryData<Envelope>(key)?.provisioning);
  const [connection, setConnection] = useState(0);
  const [streamError, setStreamError] = useState<unknown>();
  const [connected, setConnected] = useState(false);
  const streamRevision = useRef(0);
  const query = useQuery({
    queryKey: key,
    enabled: observing && Boolean(identity),
    queryFn: async ({ signal }) => {
      const revision = streamRevision.current;
      const result = await api<Envelope>(`${serverPath(serverId)}/provisioning`, { signal });
      // Cache-only log batches do not advance the job timestamp. An accepted stream
      // frame supersedes any GET which began before it, even with equal updatedAt.
      return streamRevision.current !== revision
        ? (queryClient.getQueryData<Envelope>(key) ?? result)
        : result;
    },
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    refetchInterval: (current) =>
      !connected && provisioningInProgress(current.state.data?.provisioning) ? 5000 : false,
  });
  const previousOperation = useRef<{ scope: string; id: string | null } | undefined>(undefined);
  const refetch = query.refetch;
  useEffect(() => {
    if (!identity || operationId === undefined) return;
    const scope = `${identity}:${serverId}`;
    const previous = previousOperation.current;
    previousOperation.current = { scope, id: operationId };
    // Server metadata also notices operations started from another tab. Refresh on
    // completion as well: a successful manual start resolves a previous start denial.
    if (previous?.scope === scope && previous.id !== operationId) void refetch();
  }, [identity, serverId, operationId, refetch]);
  const value = accessLost(query.error ?? streamError) ? undefined : query.data?.provisioning;
  const active = provisioningInProgress(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity/server scope and explicit reconnect own the stream; snapshots do not reconnect it.
  useEffect(() => {
    if (!observing || !identity || !active) return;
    setStreamError(undefined);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastPhase = `${value?.jobId}:${value?.stage}:${value?.state}`;
    async function connect() {
      try {
        await consumeEvents(`${serverPath(serverId)}/provisioning/stream`, {
          signal: controller.signal,
          maxFrameCharacters: 1048576,
          onEvent(event) {
            if (event.type === 'error') {
              const detail = JSON.parse(event.data) as { code?: string; error?: { code?: string } };
              throw new ApiError(
                detail.code ?? detail.error?.code ?? 'integration_unavailable',
                'provisioning.refreshFailed',
              );
            }
            if (event.type !== 'provisioning') return;
            const next = JSON.parse(event.data) as Envelope;
            const current = queryClient.getQueryData<Envelope>(key)?.provisioning;
            if (
              next.provisioning &&
              current &&
              next.provisioning.jobId === current.jobId &&
              Date.parse(next.provisioning.updatedAt) < Date.parse(current.updatedAt)
            )
              return;
            streamRevision.current += 1;
            queryClient.setQueryData(key, next);
            setConnected(true);
            setStreamError(undefined);
            attempt = 0;
            const phase = `${next.provisioning?.jobId}:${next.provisioning?.stage}:${next.provisioning?.state}`;
            if (phase !== lastPhase) {
              lastPhase = phase;
              void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
              void queryClient.invalidateQueries({ queryKey: ['servers'] });
            }
          },
        });
        if (!controller.signal.aborted)
          throw new ApiError('integration_unavailable', 'provisioning.refreshFailed');
      } catch (error) {
        if (controller.signal.aborted) return;
        setConnected(false);
        setStreamError(error);
        if (accessLost(error)) {
          streamRevision.current += 1;
          queryClient.setQueryData(key, { provisioning: null });
          return;
        }
        timer = setTimeout(
          () => void connect(),
          Math.min(1000 * 2 ** Math.min(attempt++, 4), 15000),
        );
      }
    }
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      setConnected(false);
    };
  }, [serverId, identity, active, observing, connection]);
  return {
    ...query,
    value,
    streamError,
    retry() {
      setConnection((n) => n + 1);
      void query.refetch();
    },
  };
}

function StageIcon({ stage, complete }: { stage: ProvisioningStage; complete: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {complete ? (
        <path d="m5 12 4 4L19 6" />
      ) : stage === 'preparing' ? (
        <>
          <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" />
          <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
        </>
      ) : stage === 'installing' ? (
        <path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" />
      ) : stage === 'configuring' ? (
        <path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6" />
      ) : stage === 'starting' ? (
        <path d="M12 3v9M6 6a8 8 0 1 0 12 0" />
      ) : (
        <path d="m5 12 4 4L19 6" />
      )}
    </svg>
  );
}

export function ProvisioningPanel({
  serverId,
  name,
  value,
  error,
  retry,
}: {
  serverId: string;
  name: string;
  value?: ProvisioningSnapshot | null;
  error?: unknown;
  retry(): void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [now, setNow] = useState(Date.now);
  const [reinstall, setReinstall] = useState(false);
  const request = useRequestOperation(serverId);
  const active = provisioningInProgress(value);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const elapsed = value
    ? Math.max(
        0,
        Math.floor(
          ((value.completedAt ? Date.parse(value.completedAt) : now) -
            Date.parse(value.startedAt)) /
            1000,
        ),
      )
    : 0;
  const number = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
    minimumIntegerDigits: 2,
    useGrouping: false,
  });
  const clock = `${number.format(Math.floor(elapsed / 60))}:${number.format(elapsed % 60)}`;
  const phase = value?.stage ?? 'preparing';
  const title =
    !value && error
      ? 'unavailable'
      : !value
        ? 'loading'
        : value?.state === 'failed'
          ? 'failed'
          : value?.state === 'uncertain'
            ? 'uncertain'
            : value?.state === 'start-denied'
              ? 'startDenied'
              : value?.state === 'completed'
                ? 'complete'
                : phase;
  return (
    <aside
      className="provisioning-panel"
      data-state={value?.state ?? 'loading'}
      aria-label={t('provisioning.title')}
    >
      <div className="provisioning-mark" aria-hidden="true">
        <span className="provisioning-mark-unit">
          <i />
          <i />
          <i />
        </span>
        <span className="provisioning-mark-unit">
          <i />
          <i />
          <i />
        </span>
        <span className="provisioning-mark-signal">
          <StageIcon stage={phase} complete={value?.state === 'completed'} />
        </span>
      </div>
      <div className="provisioning-current">
        <span className="provisioning-eyebrow">
          {t(value?.action === 'reinstall' ? 'provisioning.reinstall' : 'provisioning.title')}
        </span>
        <h2 aria-live="polite" aria-atomic="true" key={title}>
          {title === 'loading' ? (
            <>
              <span className="provisioning-skeleton" aria-hidden="true" />
              <span className="visually-hidden">{t('provisioning.loading')}</span>
            </>
          ) : (
            t(`provisioning.${title}`)
          )}
        </h2>
        {value && (
          <span
            className="provisioning-clock"
            role="timer"
            aria-label={t('provisioning.elapsed', { time: clock })}
          >
            {clock}
          </span>
        )}
      </div>
      {value && (
        <ol className="provisioning-stages" aria-label={t('provisioning.steps')}>
          {value.stages.map((stage) => (
            <li
              key={stage.id}
              data-state={stage.state}
              aria-current={stage.state === 'active' ? 'step' : undefined}
            >
              <span className="provisioning-stage-icon">
                <StageIcon stage={stage.id} complete={stage.state === 'completed'} />
              </span>
              <span>{t(`provisioning.step.${stage.id}`)}</span>
              <span className="visually-hidden">{t(`provisioning.stage.${stage.state}`)}</span>
            </li>
          ))}
        </ol>
      )}
      {value?.state === 'uncertain' && (
        <p className="provisioning-context">{t('provisioning.uncertainHint')}</p>
      )}
      {value?.state === 'start-denied' && (
        <p className="provisioning-context">{t('provisioning.startDeniedHint')}</p>
      )}
      {value?.state === 'failed' && value.errorCode && (
        <p className="provisioning-context">
          {t(
            value.errorCode === 'integration_unavailable'
              ? 'provisioning.checkOutput'
              : `errors.${value.errorCode}`,
          )}
        </p>
      )}
      {Boolean(error) && (
        <div className="provisioning-recovery">
          <span>
            {t(accessLost(error) ? `errors.${apiError(error).code}` : 'provisioning.refreshFailed')}
          </span>
          <button type="button" className="secondary" onClick={retry}>
            {t('web.retry')}
          </button>
        </div>
      )}
      <div className="provisioning-links">
        {value?.canReinstall && value.state === 'failed' && (
          <button type="button" onClick={() => setReinstall(true)}>
            {t('platform.reinstall')}
          </button>
        )}
        {value && (
          <Link to={`/activity/${value.jobId}`}>
            {t('web.details')} <span aria-hidden="true">↗</span>
          </Link>
        )}
      </div>
      <ConfirmDialog
        open={reinstall}
        title={t('platform.reinstall')}
        confirmLabel={t('platform.reinstall')}
        destructive
        onClose={() => setReinstall(false)}
        onConfirm={async () => {
          await request({ action: 'reinstall', confirm: true, backupBefore: false });
          setReinstall(false);
          retry();
        }}
      >
        <p>{t('platform.reinstallWarning', { name })}</p>
      </ConfirmDialog>
    </aside>
  );
}
