import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type {
  getPlatformJob,
  listPlatformActivity,
} from '../../../../packages/server-management/src/platform-queries.js';
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
  JobNotice,
  Loading,
  Notice,
  Page,
  Section,
  Select,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { CursorControls, TableRegion } from './servers.js';

type Activity = Result<typeof listPlatformActivity>;
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
export function ActivityPage({ serverId }: { serverId?: string } = {}) {
  const t = useT(),
    [state, setState] = useState(''),
    [action, setAction] = useState(''),
    [cursors, setCursors] = useState<string[]>([]);
  const params = new URLSearchParams({
    limit: '30',
    ...(serverId ? { serverId } : {}),
    ...(state ? { state } : {}),
    ...(action ? { action } : {}),
    ...(cursors.length ? { cursor: cursors.at(-1) ?? '' } : {}),
  });
  const activity = useQuery({
    queryKey: ['activity', params.toString()],
    queryFn: () => api<Activity>(`/v1/platform/activity?${params}`),
    refetchInterval: 10000,
  });
  return (
    <Page title={t('web.activity')}>
      <div className="toolbar">
        <Select
          label={t('web.status')}
          value={state}
          onChange={(event) => {
            setState(event.target.value);
            setCursors([]);
          }}
        >
          <option value="">{t('web.all')}</option>
          {['queued', 'running', 'succeeded', 'failed'].map((value) => (
            <option value={value} key={value}>
              {t(`web.${value}`)}
            </option>
          ))}
        </Select>
        <Select
          label={t('platform.action')}
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
            setCursors([]);
          }}
        >
          <option value="">{t('web.all')}</option>
          {[
            'provision',
            'start',
            'stop',
            'restart',
            'backup',
            'restore',
            'configure',
            'reinstall',
            'wipe',
            'delete',
            'minecraft-content',
          ].map((value) => (
            <option value={value} key={value}>
              {t(actionKey(value))}
            </option>
          ))}
        </Select>
      </div>
      {activity.isPending ? (
        <Loading />
      ) : activity.error ? (
        <ErrorNotice error={activity.error} retry={() => void activity.refetch()} />
      ) : !activity.data?.items.length ? (
        <Empty text={t('platform.noActivity')} />
      ) : (
        <Section>
          <TableRegion label={t('web.activity')}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('platform.operation')}</th>
                  <th scope="col">{t('web.servers')}</th>
                  <th scope="col">{t('web.status')}</th>
                  <th scope="col">{t('web.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {activity.data.items.map((job) => (
                  <tr key={job.id}>
                    <th scope="row">
                      <Link to={`/activity/${job.id}`}>{t(actionKey(job.action))}</Link>
                    </th>
                    <td>
                      {job.serverId ? (
                        <Link to={`/servers/${job.serverId}`}>{job.serverName}</Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <Badge
                        value={
                          acknowledgedFailure(job)
                            ? 'failed'
                            : job.effectState === 'uncertain'
                              ? 'uncertain'
                              : job.state
                        }
                      />
                    </td>
                    <td>
                      <Time value={job.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        </Section>
      )}
      <CursorControls
        next={activity.data?.nextCursor}
        previous={cursors.length > 0}
        onNext={(next) => setCursors([...cursors, next])}
        onPrevious={() => setCursors(cursors.slice(0, -1))}
      />
    </Page>
  );
}
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
  const uncertain = data.effectState === 'uncertain' || data.effectState === 'prepared';
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
              <Badge
                key="state"
                value={acknowledged ? 'failed' : uncertain ? 'uncertain' : data.state}
              />,
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
        {data.errorCode && !acknowledged && <Notice>{t(`errors.${data.errorCode}`)}</Notice>}
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
        <JobNotice jobId={newJob} />
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
