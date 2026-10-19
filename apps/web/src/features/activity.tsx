import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { getPlatformJob } from '../../../../packages/server-management/src/platform-queries.js';
import { ApiError, api, idempotencyKey, queryClient } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useFormat, useT } from '../app/i18n.js';
import {
  ActionForm,
  Badge,
  Check,
  Details,
  Dialog,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  Page,
  Section,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { activityStatus } from './activity-labels.js';

type Job = Result<typeof getPlatformJob>;
function acknowledgedFailure(job: Pick<Job, 'state' | 'phase'>) {
  return job.state === 'failed' && job.phase === 'owner_resolved_failed';
}
function actionKey(action: string | null) {
  return action
    ? ['start', 'stop', 'restart', 'delete'].includes(action)
      ? `web.${action}`
      : `platform.${action}`
    : 'platform.operation';
}

export { ActivityTimeline as ActivityPage } from './activity-timeline.js';
export function JobPage({ jobId: explicitId }: { jobId?: string } = {}) {
  const params = useParams(),
    jobId = explicitId ?? params.jobId ?? params.id ?? '',
    t = useT(),
    format = useFormat(),
    key = useRef(idempotencyKey()),
    [newJob, setNewJob] = useState<string>(),
    [resolve, setResolve] = useState(false);
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api<Job>(`/v1/platform/jobs/${encodeURIComponent(jobId)}`),
    refetchInterval: (query) =>
      query.state.data && ['queued', 'running'].includes(query.state.data.state) ? 3000 : false,
  });
  if (job.isPending) return <Loading />;
  if (job.error) return <ErrorNotice error={job.error} retry={() => void job.refetch()} />;
  const data = job.data;
  if (!data) return null;
  const acknowledged = acknowledgedFailure(data);
  const uncertain = data.provisioning
    ? data.provisioning.state === 'uncertain'
    : data.effectState === 'uncertain' || data.effectState === 'prepared';
  const presented = activityStatus({ ...data, outcome: data.state });
  return (
    <Page
      title={t('platform.jobDetails')}
      actions={<Link to="/activity">{t('web.activity')}</Link>}
    >
      <Section title={t(actionKey(data.action))}>
        {data.serverId && (
          <p>
            <Link to={`/servers/${data.serverId}`}>{data.serverName}</Link>
          </p>
        )}
        <Details
          values={[
            [
              t('web.status'),
              <Badge key="state" value={presented.value} label={t(presented.labelKey)} />,
            ],
            [t('web.created'), <Time key="created" value={data.createdAt} />],
            [t('web.updated'), <Time key="updated" value={data.updatedAt} />],
            [
              t('platform.completed'),
              data.completedAt ? (
                <Time key="completed" value={data.completedAt} />
              ) : (
                t('platform.pending')
              ),
            ],
            [t('platform.attempts'), format.number(data.attempts)],
            [
              t('platform.effect'),
              acknowledged
                ? t('web.unknown')
                : data.effectState
                  ? t(`platform.${data.effectState}`)
                  : '—',
            ],
          ]}
        />
        {data.errorCode && !acknowledged && data.provisioning?.state !== 'active' && (
          <Notice>
            {t(
              data.provisioning && data.errorCode === 'integration_unavailable'
                ? 'provisioning.checkOutput'
                : `errors.${data.errorCode}`,
            )}
          </Notice>
        )}
        {acknowledged && <Notice>{t('platform.failureAcknowledged')}</Notice>}
        {uncertain && !acknowledged && <Notice>{t('platform.uncertainHelp')}</Notice>}
        {data.ownerRecovery && (
          <div className="stack">
            {!data.ownerRecovery.available && (
              <Notice>
                {t('platform.recoveryWait')} <Time value={data.ownerRecovery.availableAt} />
              </Notice>
            )}
            <button
              type="button"
              className="secondary"
              disabled={!data.ownerRecovery.available}
              onClick={() => setResolve(true)}
            >
              {t('platform.reviewUncertainty')}
            </button>
          </div>
        )}
        {data.state === 'failed' && !data.retry.allowed && !uncertain && (
          <Notice>{t('platform.noRetry')}</Notice>
        )}
        {newJob && <Link to={`/activity/${newJob}`}>{t('web.viewActivity')}</Link>}
        {data.retry.allowed && !newJob && (
          <ActionForm
            submitLabel={t('platform.retryOperation')}
            success={false}
            onSubmit={async () => {
              const result = await api<{ jobId: string }>(
                `/v1/platform/jobs/${encodeURIComponent(jobId)}/retry`,
                { body: { idempotencyKey: key.current } },
              );
              setNewJob(result.jobId);
              await queryClient.invalidateQueries({ queryKey: ['activity'] });
            }}
          >
            <p>{t('platform.retryWarning')}</p>
          </ActionForm>
        )}
      </Section>
      <Dialog
        open={resolve}
        title={t('platform.reviewUncertainty')}
        onClose={() => setResolve(false)}
      >
        <ActionForm
          success={false}
          submitLabel={t('platform.acknowledgeFailure')}
          onSubmit={async (form) => {
            const result = await api<'resolved' | 'deferred'>(
              `/v1/owner/servers/${encodeURIComponent(data.serverId ?? '')}/resolve`,
              { body: { jobId: data.id, confirm: true, reason: text(form, 'reason') } },
            );
            if (result === 'deferred') throw new ApiError('conflict', 'platform.recoveryDeferred');
            setResolve(false);
            await job.refetch();
            await queryClient.invalidateQueries({ queryKey: ['server'] });
            await queryClient.invalidateQueries({ queryKey: ['activity'] });
          }}
        >
          <p>{t('platform.resolutionWarning')}</p>
          <Textarea name="reason" label={t('web.reason')} required minLength={12} maxLength={500} />
          <Check required label={t('platform.resolutionConfirm')} />
        </ActionForm>
      </Dialog>
      <Section title={t('platform.events')}>
        {!data.events.length ? (
          <Empty text={t('platform.noEvents')} />
        ) : (
          <ol className="operation-events">
            {data.events
              .slice()
              .reverse()
              .map((event) => (
                <li key={event.id}>
                  <span>{t(event.message_key, eventParameters(event.data))}</span>{' '}
                  <Time value={event.created_at} />
                </li>
              ))}
          </ol>
        )}
      </Section>
    </Page>
  );
}
function eventParameters(data: Record<string, unknown>): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(data).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number',
    ),
  );
}
