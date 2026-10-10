import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import {
  ActionForm,
  Badge,
  Check,
  Details,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  number,
  Section,
  Select,
  Time,
  text,
} from '../components/ui.js';
import {
  type Outcomes,
  platformPath,
  type Schedules,
  type SleepPolicy,
  serverPath,
  useServer,
} from './service-contracts.js';
import {
  readSleepAccess,
  readSleepTimeout,
  SleepAccessField,
  SleepTimeoutField,
} from './sleep-timeout.js';

export function AutomationPage({ serverId }: { serverId: string }) {
  const t = useT(),
    format = useFormat(),
    server = useServer(serverId),
    session = useSession();
  const policy = useQuery({
    queryKey: ['sleep-policy', serverId],
    queryFn: () => api<SleepPolicy>(`${platformPath(serverId)}/sleep-policy`),
    refetchInterval: 10000,
  });
  const consent = useQuery({
    queryKey: ['automation-consent', serverId],
    queryFn: () =>
      api<{
        allowed: boolean;
        expectedIntent: string;
        gatewayConfigured: boolean;
        gatewayEnabled: boolean;
        grantBlockedReason: string | null;
      }>(`${serverPath(serverId)}/automation-consent`),
    refetchInterval: 10000,
  });
  const editable =
    server.data?.permissions.manage && session.data?.context.sessionType === 'regular';
  const isOwner = session.data?.context.role === 'owner';
  const sleepAccess = policy.data?.idleTimeout;
  const restrictPolicyControls = policy.data?.policyControlsEditable === false;
  return (
    <>
      <Section title={t('service.startConsent')}>
        {consent.isPending ? (
          <Loading />
        ) : consent.error ? (
          <ErrorNotice error={consent.error} />
        ) : editable ? (
          <ActionForm
            key={consent.data.expectedIntent}
            onSubmit={async (data) => {
              await api(`${serverPath(serverId)}/automation-consent`, {
                method: 'PUT',
                body: { allowed: data.has('allowed'), expectedIntent: consent.data.expectedIntent },
              });
              await Promise.all([consent.refetch(), policy.refetch(), server.refetch()]);
            }}
          >
            <Check
              name="allowed"
              label={t('service.allowAutomaticStarts')}
              defaultChecked={consent.data.allowed}
              disabled={!consent.data.allowed && Boolean(consent.data.grantBlockedReason)}
            />
            <p className="muted">{t('service.consentDescription')}</p>
            {consent.data.grantBlockedReason && (
              <Notice>{t(`service.consent.${consent.data.grantBlockedReason}`)}</Notice>
            )}
          </ActionForm>
        ) : (
          <Badge value={consent.data.allowed ? 'enabled' : 'disabled'} />
        )}
      </Section>
      <Section title={t('web.sleep')}>
        {policy.isPending ? (
          <Loading />
        ) : policy.error ? (
          <ErrorNotice error={policy.error} />
        ) : !policy.data.policy && policy.data.proposedPolicy && editable ? (
          <ActionForm
            submitLabel={t('service.configureSleep')}
            onSubmit={async () => {
              await api(`${serverPath(serverId)}/gateway`, {
                method: 'PUT',
                body: policy.data.proposedPolicy,
                headers: { 'If-None-Match': '*' },
              });
              await Promise.all([policy.refetch(), consent.refetch(), server.refetch()]);
            }}
          >
            <p>{t('service.configureSleepDescription')}</p>
          </ActionForm>
        ) : !policy.data.policy ? (
          <Notice>
            {t(
              server.data?.connectionMode === 'direct'
                ? 'service.directSleepUnavailable'
                : 'service.sleepUnavailable',
            )}
          </Notice>
        ) : (
          <>
            {policy.data.state && (
              <Details
                values={[
                  [t('web.status'), t(policy.data.state.messageKey)],
                  [
                    t('service.readyObserved'),
                    <Time key="ready" value={policy.data.state.readinessObservedAt} />,
                  ],
                  [
                    t('service.startupEstimate'),
                    policy.data.state.startupEstimate
                      ? t('service.startupSeconds', {
                          seconds: Math.ceil(policy.data.state.startupEstimate.p90Ms / 1000),
                        })
                      : t('service.estimateUnavailable'),
                  ],
                ]}
              />
            )}
            {editable &&
              (restrictPolicyControls && !sleepAccess ? (
                <>
                  <Check
                    label={t('service.autoWake')}
                    checked={policy.data.policy.enabled}
                    disabled
                  />
                  <Notice>{t('sleepTiming.ownerControlled')}</Notice>
                </>
              ) : (
                <ActionForm
                  key={JSON.stringify(policy.data.policy)}
                  onSubmit={async (data) => {
                    const idleTimeout = sleepAccess
                      ? readSleepTimeout(data, 'idleMinutes')
                      : undefined;
                    const {
                      idleTimeoutSeconds: _seconds,
                      idleTimeoutInherited: _inherited,
                      ...existingPolicy
                    } = policy.data!.policy!;
                    await api(`${serverPath(serverId)}/gateway`, {
                      method: 'PUT',
                      body: {
                        ...existingPolicy,
                        enabled: restrictPolicyControls
                          ? existingPolicy.enabled
                          : data.has('enabled'),
                        ...(idleTimeout === undefined
                          ? {}
                          : {
                              idleTimeoutInherited: idleTimeout === null,
                              idleTimeoutSeconds:
                                idleTimeout === null || idleTimeout === -1 ? null : idleTimeout,
                              ...(isOwner
                                ? {
                                    idleTimeoutUserAccess: readSleepAccess(
                                      data,
                                      'sleepServerAccess',
                                    ),
                                  }
                                : {}),
                            }),
                        mode: restrictPolicyControls ? existingPolicy.mode : text(data, 'mode'),
                      },
                    });
                    await policy.refetch();
                    await server.refetch();
                  }}
                >
                  <Check
                    name="enabled"
                    defaultChecked={policy.data.policy.enabled}
                    label={t('service.autoWake')}
                    disabled={restrictPolicyControls}
                  />
                  {sleepAccess && (
                    <SleepTimeoutField
                      name="idleMinutes"
                      value={sleepAccess.overrideSeconds}
                      inheritedSeconds={sleepAccess.inheritedSeconds}
                      allowDisable={
                        isOwner ||
                        sleepAccess.userAccess !== 'shorten-only' ||
                        sleepAccess.ownerBaselineSeconds === -1
                      }
                      maximumSeconds={
                        !isOwner &&
                        sleepAccess.userAccess === 'shorten-only' &&
                        sleepAccess.ownerBaselineSeconds !== -1
                          ? sleepAccess.ownerBaselineSeconds
                          : 604800
                      }
                    />
                  )}
                  {isOwner && sleepAccess && 'ownerUserAccessOverride' in sleepAccess && (
                    <SleepAccessField
                      name="sleepServerAccess"
                      value={sleepAccess.ownerUserAccessOverride ?? null}
                      inherited={sleepAccess.inheritedUserAccess ?? 'hidden'}
                    />
                  )}
                  {policy.data.idleTimeout && (
                    <p className="muted">
                      {t('sleepTiming.effective', {
                        value:
                          policy.data.idleTimeout.effectiveSeconds === -1
                            ? t('sleepTiming.disabled')
                            : t('sleepTiming.minutes', {
                                minutes: format.number(
                                  policy.data.idleTimeout.effectiveSeconds / 60,
                                  3,
                                ),
                              }),
                        source: t(`sleepTiming.source.${policy.data.idleTimeout.source}`),
                      })}
                    </p>
                  )}
                  <Select
                    label={t('service.automationMode')}
                    name="mode"
                    disabled={restrictPolicyControls}
                    defaultValue={policy.data.policy.mode}
                  >
                    <option value="auto">{t('service.automatic')}</option>
                    <option value="manually_stopped">{t('service.manuallyStopped')}</option>
                    <option value="maintenance">{t('service.maintenance')}</option>
                  </Select>
                  <p className="muted">
                    {t(
                      restrictPolicyControls
                        ? 'sleepTiming.ownerControlled'
                        : 'service.manualStopPolicy',
                    )}
                  </p>
                </ActionForm>
              ))}
          </>
        )}
      </Section>
      <SchedulesSection serverId={serverId} editable={Boolean(editable)} />
    </>
  );
}
function SchedulesSection({ serverId, editable }: { serverId: string; editable: boolean }) {
  const t = useT();
  const schedules = useQuery({
    queryKey: ['schedules', serverId],
    queryFn: () => api<Schedules>(`${serverPath(serverId)}/schedules`),
    refetchInterval: 15000,
  });
  const [editing, setEditing] = useState<Schedules[number] | 'new'>(),
    [outcomes, setOutcomes] = useState<Schedules[number]>();
  const [deleting, setDeleting] = useState<Schedules[number]>();
  return (
    <Section
      title={t('web.schedules')}
      actions={
        editable ? (
          <button type="button" onClick={() => setEditing('new')}>
            {t('service.addSchedule')}
          </button>
        ) : undefined
      }
    >
      <p className="muted">{t('service.scheduleSemantics')}</p>
      {schedules.isPending ? (
        <Loading />
      ) : schedules.error ? (
        <ErrorNotice error={schedules.error} />
      ) : !schedules.data.length ? (
        <Empty text={t('service.noSchedules')} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('web.name')}</th>
                <th>{t('service.action')}</th>
                <th>{t('web.status')}</th>
                <th>{t('service.nextRun')}</th>
                <th>{t('web.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {schedules.data.map((schedule) => (
                <tr key={schedule.id}>
                  <td>{schedule.name}</td>
                  <td>{t(`service.action.${schedule.action}`)}</td>
                  <td>
                    <Badge value={schedule.enabled ? 'enabled' : 'disabled'} />
                  </td>
                  <td>
                    <Time value={schedule.nextRunAt} />
                  </td>
                  <td>
                    <div className="actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setOutcomes(schedule)}
                      >
                        {t('service.outcomes')}
                      </button>
                      {editable && (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setEditing(schedule)}
                          >
                            {t('web.edit')}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setDeleting(schedule)}
                          >
                            {t('web.delete')}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={Boolean(editing)}
        title={t(editing === 'new' ? 'service.addSchedule' : 'web.edit')}
        onClose={() => setEditing(undefined)}
      >
        {editing && (
          <ScheduleForm
            key={editing === 'new' ? 'new' : editing.id}
            serverId={serverId}
            schedule={editing === 'new' ? undefined : editing}
            onSaved={async () => {
              setEditing(undefined);
              await schedules.refetch();
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={Boolean(deleting)}
        title={t('web.delete')}
        onClose={() => setDeleting(undefined)}
      >
        {deleting && (
          <ActionForm
            success={false}
            submitLabel={t('web.delete')}
            onSubmit={async () => {
              await api(`${serverPath(serverId)}/schedules/${deleting.id}`, {
                method: 'DELETE',
                body: { revision: deleting.revision },
              });
              setDeleting(undefined);
              await schedules.refetch();
            }}
          >
            <p>{t('service.deleteScheduleWarning')}</p>
            <Check label={t('web.confirm')} required />
          </ActionForm>
        )}
      </Dialog>
      <Dialog
        open={Boolean(outcomes)}
        title={outcomes?.name ?? t('service.outcomes')}
        onClose={() => setOutcomes(undefined)}
      >
        {outcomes && <ScheduleOutcomes serverId={serverId} scheduleId={outcomes.id} />}
      </Dialog>
    </Section>
  );
}
function localTime(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function ScheduleForm({
  serverId,
  schedule,
  onSaved,
}: {
  serverId: string;
  schedule?: Schedules[number];
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [kind, setKind] = useState(schedule?.timing.kind ?? 'once');
  const at = schedule
    ? schedule.timing.kind === 'once'
      ? schedule.timing.at
      : schedule.timing.firstAt
    : new Date(Date.now() + 3600000).toISOString();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <ActionForm
      onSubmit={async (data) => {
        const instant = new Date(text(data, 'at')).toISOString();
        const body = {
          name: text(data, 'name'),
          action: text(data, 'action'),
          enabled: data.has('enabled'),
          timeZone: zone,
          timing:
            kind === 'once'
              ? { kind, at: instant }
              : { kind, firstAt: instant, everySeconds: number(data, 'minutes') * 60 },
          ...(schedule ? { revision: schedule.revision } : {}),
        };
        await api(`${serverPath(serverId)}/schedules${schedule ? `/${schedule.id}` : ''}`, {
          method: schedule ? 'PUT' : 'POST',
          body,
        });
        await onSaved();
      }}
      success={false}
    >
      <Input
        label={t('web.name')}
        name="name"
        defaultValue={schedule?.name}
        required
        maxLength={80}
      />
      <Select label={t('service.action')} name="action" defaultValue={schedule?.action ?? 'backup'}>
        {['start', 'stop', 'restart', 'backup'].map((action) => (
          <option key={action} value={action}>
            {t(`service.action.${action}`)}
          </option>
        ))}
      </Select>
      <Select
        label={t('service.repeat')}
        value={kind}
        onChange={(event) => setKind(event.target.value as 'once' | 'interval')}
      >
        <option value="once">{t('service.once')}</option>
        <option value="interval">{t('service.interval')}</option>
      </Select>
      <Input
        label={t('service.firstRun', { zone })}
        type="datetime-local"
        name="at"
        defaultValue={localTime(at)}
        required
      />
      {kind === 'interval' && (
        <Input
          label={t('service.intervalMinutes')}
          name="minutes"
          type="number"
          min={5}
          max={525600}
          defaultValue={
            schedule?.timing.kind === 'interval' ? schedule.timing.everySeconds / 60 : 60
          }
          required
        />
      )}
      <Check name="enabled" defaultChecked={schedule?.enabled ?? true} label={t('web.enabled')} />
      <p className="muted">{t('service.scheduledStopWarning')}</p>
    </ActionForm>
  );
}
function ScheduleOutcomes({ serverId, scheduleId }: { serverId: string; scheduleId: string }) {
  const t = useT();
  const [before, setBefore] = useState<string>();
  const result = useQuery({
    queryKey: ['schedule-outcomes', serverId, scheduleId, before],
    queryFn: () =>
      api<Outcomes>(
        `${serverPath(serverId)}/schedules/${scheduleId}/outcomes${before ? `?before=${before}` : ''}`,
      ),
  });
  if (result.isPending) return <Loading />;
  if (result.error) return <ErrorNotice error={result.error} />;
  return result.data.items.length ? (
    <>
      <div className="stack">
        {result.data.items.map((item) => (
          <div key={item.id}>
            <Time value={item.dueAt} /> <Badge value={item.jobState ?? item.status} />
            {item.reason && <p>{t(`errors.${item.reason}`)}</p>}
            {item.jobId && <Link to={`/activity/${item.jobId}`}>{t('web.viewActivity')}</Link>}
            {item.missedCount > 0 && <p>{t('service.missedRuns', { count: item.missedCount })}</p>}
          </div>
        ))}
      </div>
      {result.data.nextCursor && (
        <button
          className="secondary"
          type="button"
          onClick={() => setBefore(result.data.nextCursor!)}
        >
          {t('web.next')}
        </button>
      )}
    </>
  ) : (
    <Empty />
  );
}
