import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, idempotencyKey } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  Badge,
  Check,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  number,
  Select,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { AutomationSwitch } from './automation-controls.js';
import {
  type Outcomes,
  type Schedules,
  serverPath,
  useServer,
  useTransfers,
} from './service-contracts.js';

function scheduleReason(reason: string) {
  return ['schedule_late', 'manual_stop_suppressed'].includes(reason)
    ? `automation.reason.${reason}`
    : `errors.${reason}`;
}
type Schedule = Schedules[number];
type FormSchedule = Omit<Schedule, 'id'> & { id?: string };
type IconName = 'plus' | 'edit' | 'copy' | 'delete' | 'play' | 'history' | 'refresh';
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    plus: 'M12 5v14M5 12h14',
    edit: 'm15 4 5 5 M3 21l5-1L21 7l-5-5L3 15z',
    copy: 'M9 9h12v12H9z M5 15H3V3h12v2',
    delete: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7M14 10v7',
    play: 'm8 4 12 8-12 8z',
    history: 'M4 9a8 8 0 1 1 0 7 M4 3v6h6 M12 7v5l3 2',
    refresh: 'M20 8a8 8 0 1 0 0 8 M20 3v5h-5',
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
function IconButton({
  name,
  label,
  onClick,
  disabled = false,
}: {
  name: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        className={`automation-icon ${name === 'delete' ? 'automation-danger' : ''}`}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon name={name} />
      </button>
    </Tooltip>
  );
}
function scheduleBody(schedule: Schedule) {
  return {
    name: schedule.name,
    action: schedule.action,
    timing: schedule.timing,
    timeZone: schedule.timeZone,
    enabled: schedule.enabled,
    ...(schedule.action === 'backup'
      ? { backupOptions: schedule.backupOptions, retention: schedule.retention }
      : {}),
    revision: schedule.revision,
  };
}
export function SchedulesSection({ serverId, editable }: { serverId: string; editable: boolean }) {
  const queryClient = useQueryClient();
  const t = useT(),
    [search, setSearch] = useSearchParams();
  const filter = search.get('action');
  const result = useQuery({
    queryKey: ['schedules', serverId],
    queryFn: () => api<Schedules>(`${serverPath(serverId)}/schedules`),
    refetchInterval: 15000,
  });
  const [editing, setEditing] = useState<FormSchedule | 'new'>(),
    [expanded, setExpanded] = useState<string>(),
    [deleting, setDeleting] = useState<Schedule>(),
    [running, setRunning] = useState<{ schedule: Schedule; key: string }>(),
    [runResult, setRunResult] = useState<{ jobId: string | null; reason: string | null }>();
  const reload = async () => {
    await result.refetch();
  };
  return (
    <section className="automation-schedules">
      <header className="automation-heading">
        <h2>{t('web.schedules')}</h2>
        <div className="automation-tools">
          {filter === 'backup' && (
            <button type="button" className="automation-token" onClick={() => setSearch({})}>
              {t('automation.allSchedules')}
            </button>
          )}
          <IconButton
            name="refresh"
            label={t('activity.refresh')}
            disabled={result.isFetching}
            onClick={() => {
              void result.refetch();
            }}
          />
          {editable && (
            <button type="button" className="automation-create" onClick={() => setEditing('new')}>
              <Icon name="plus" />
              {t('service.addSchedule')}
            </button>
          )}
        </div>
      </header>
      {result.error && <ErrorNotice error={result.error} />}{' '}
      {runResult?.reason && (
        <div className="automation-run-result" role="status">
          {t(scheduleReason(runResult.reason))}
        </div>
      )}
      {result.isPending ? (
        <div
          role="status"
          className="automation-skeleton"
          aria-busy="true"
          aria-label={t('web.loading')}
        />
      ) : result.data && !result.data.length ? (
        <Empty text={t('service.noSchedules')} />
      ) : (
        result.data && (
          <div className="automation-table table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('web.name')}</th>
                  <th>{t('service.repeat')}</th>
                  <th>{t('service.nextRun')}</th>
                  <th>{t('automation.lastRun')}</th>
                  <th>{t('automation.authorizer')}</th>
                  <th>{t('web.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {result.data
                  .filter((item) => filter !== 'backup' || item.action === 'backup')
                  .map((schedule) => (
                    <Fragment key={schedule.id}>
                      <tr>
                        <td>
                          <div className="automation-name">
                            <AutomationSwitch
                              checked={schedule.enabled && schedule.status !== 'completed'}
                              label={t('automation.toggle', { name: schedule.name })}
                              disabled={!editable || schedule.status === 'completed'}
                              onChange={async (enabled) => {
                                await api(`${serverPath(serverId)}/schedules/${schedule.id}`, {
                                  method: 'PUT',
                                  body: { ...scheduleBody(schedule), enabled },
                                });
                                await reload();
                              }}
                            />
                            <div>
                              <strong>{schedule.name}</strong>
                              <span>{t(`service.action.${schedule.action}`)}</span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <ScheduleFrequency schedule={schedule} />
                        </td>
                        <td>
                          {schedule.status === 'completed' ? (
                            <span className="muted">{t('automation.completed')}</span>
                          ) : !schedule.enabled ? (
                            <span className="muted">{t('automation.paused')}</span>
                          ) : (
                            <Time value={schedule.nextRunAt} />
                          )}
                        </td>
                        <td>
                          {schedule.lastOutcome ? (
                            <>
                              <Badge
                                value={schedule.lastOutcome.jobState ?? schedule.lastOutcome.status}
                              />
                              <small>
                                <Time value={schedule.lastOutcome.dueAt} />
                              </small>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>{schedule.authorizerName ?? t('activity.unknownActor')}</td>
                        <td>
                          <div className="automation-tools">
                            <IconButton
                              name="history"
                              label={t('service.outcomes')}
                              onClick={() =>
                                setExpanded(expanded === schedule.id ? undefined : schedule.id)
                              }
                            />
                            {editable && (
                              <>
                                <IconButton
                                  name="play"
                                  label={t('automation.runNow')}
                                  onClick={() => setRunning({ schedule, key: idempotencyKey() })}
                                />
                                <IconButton
                                  name="edit"
                                  label={t('web.edit')}
                                  onClick={() => setEditing(schedule)}
                                />
                                <IconButton
                                  name="copy"
                                  label={t('automation.duplicate')}
                                  onClick={() =>
                                    setEditing({
                                      ...schedule,
                                      id: undefined,
                                      name: t('automation.copyName', { name: schedule.name }),
                                      enabled: false,
                                    })
                                  }
                                />
                                <IconButton
                                  name="delete"
                                  label={t('web.delete')}
                                  onClick={() => setDeleting(schedule)}
                                />
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expanded === schedule.id && (
                        <tr className="automation-history-row">
                          <td colSpan={6}>
                            <ScheduleOutcomes serverId={serverId} scheduleId={schedule.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
              </tbody>
            </table>
          </div>
        )
      )}
      <Dialog
        open={!!editing}
        closeIcon
        title={t(editing === 'new' || !editing?.id ? 'service.addSchedule' : 'web.edit')}
        onClose={() => setEditing(undefined)}
        className="automation-dialog"
      >
        {editing && (
          <ScheduleForm
            key={editing === 'new' ? 'new' : (editing.id ?? 'copy')}
            serverId={serverId}
            schedule={editing === 'new' ? undefined : editing}
            onSaved={async () => {
              setEditing(undefined);
              await reload();
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={!!deleting}
        closeIcon
        title={t('automation.deleteTitle')}
        onClose={() => setDeleting(undefined)}
        className="automation-dialog automation-confirm"
        initialFocusSelector="[data-form-cancel]"
      >
        {deleting && (
          <ActionForm
            success={false}
            destructive
            arrowActionNavigation
            onCancel={() => setDeleting(undefined)}
            submitLabel={t('web.delete')}
            onSubmit={async () => {
              await api(`${serverPath(serverId)}/schedules/${deleting.id}`, {
                method: 'DELETE',
                body: { revision: deleting.revision },
              });
              setDeleting(undefined);
              await reload();
            }}
          >
            <p>
              <strong>{deleting.name}</strong>
            </p>
            <p>{t('automation.deleteHint')}</p>
          </ActionForm>
        )}
      </Dialog>
      <Dialog
        open={!!running}
        closeIcon
        title={t('automation.runNow')}
        onClose={() => setRunning(undefined)}
        className="automation-dialog automation-confirm"
        initialFocusSelector="[data-form-cancel]"
      >
        {running && (
          <ActionForm
            success={false}
            onCancel={() => setRunning(undefined)}
            submitLabel={t(`service.action.${running.schedule.action}`)}
            onSubmit={async () => {
              const response = await api<{ jobId: string | null; reason: string | null }>(
                `${serverPath(serverId)}/schedules/${running.schedule.id}/run`,
                {
                  method: 'POST',
                  body: { revision: running.schedule.revision, idempotencyKey: running.key },
                },
              );
              await queryClient.invalidateQueries({
                queryKey: ['schedule-outcomes', serverId, running.schedule.id],
              });
              setRunResult(response);
              setRunning(undefined);
              setExpanded(running.schedule.id);
              await reload();
            }}
          >
            <p>
              <strong>{running.schedule.name}</strong>
            </p>
            <p>{t(`automation.runHint.${running.schedule.action}`)}</p>
          </ActionForm>
        )}
      </Dialog>
    </section>
  );
}
function ScheduleFrequency({ schedule }: { schedule: Schedule }) {
  const t = useT(),
    { locale } = useLocale();
  const value = schedule.timing;
  return (
    <span className="automation-frequency">
      {value.kind === 'once' ? (
        t('service.once')
      ) : value.kind === 'interval' ? (
        t('automation.everyMinutes', { minutes: value.everySeconds / 60 })
      ) : (
        <>
          {value.kind === 'daily'
            ? t('automation.daily')
            : value.weekdays
                .map((day) =>
                  new Intl.DateTimeFormat(locale === 'it' ? 'it' : 'en', {
                    weekday: 'short',
                    timeZone: 'UTC',
                  }).format(new Date(Date.UTC(2024, 0, day))),
                )
                .join(', ')}{' '}
          · {value.localTime}
        </>
      )}
      <small>{schedule.timeZone}</small>
    </span>
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
  schedule?: FormSchedule;
  onSaved: () => Promise<void>;
}) {
  const t = useT(),
    { locale } = useLocale();
  const server = useServer(serverId),
    transfers = useTransfers(serverId);
  const [kind, setKind] = useState(schedule?.timing.kind ?? 'daily'),
    [action, setAction] = useState(
      schedule?.action ?? (server.data?.capabilities?.backups ? 'backup' : 'start'),
    ),
    [retention, setRetention] = useState(schedule?.retention?.enabled ?? false),
    [zone, setZone] = useState(
      schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [at, setAt] = useState(
      localTime(
        schedule?.timing.kind === 'once'
          ? schedule.timing.at
          : schedule?.timing.kind === 'interval'
            ? schedule.timing.firstAt
            : new Date(Date.now() + 3600000).toISOString(),
      ),
    ),
    [time, setTime] = useState(
      schedule?.timing.kind === 'daily' || schedule?.timing.kind === 'weekly'
        ? schedule.timing.localTime
        : '03:00',
    ),
    [days, setDays] = useState<number[]>(
      schedule?.timing.kind === 'weekly' ? schedule.timing.weekdays : [1],
    ),
    [minutes, setMinutes] = useState(
      schedule?.timing.kind === 'interval' ? schedule.timing.everySeconds / 60 : 60,
    );
  const max = Math.max(0, (transfers.data?.backups.limit ?? 0) - 1);
  const offline = transfers.data?.backups.policy.offline ?? 'required';
  const instant = Number.isNaN(new Date(at).getTime()) ? null : new Date(at).toISOString();
  const timing =
    kind === 'daily'
      ? { kind, localTime: time }
      : kind === 'weekly'
        ? { kind, localTime: time, weekdays: days }
        : kind === 'once'
          ? { kind, at: instant }
          : { kind, firstAt: instant, everySeconds: minutes * 60 };
  const serialized = JSON.stringify({ timing, timeZone: zone });
  const [previewInput, setPreviewInput] = useState(serialized);
  useEffect(() => {
    const id = setTimeout(() => setPreviewInput(serialized), 400);
    return () => clearTimeout(id);
  }, [serialized]);
  const preview = useQuery({
    queryKey: ['schedule-preview', serverId, previewInput],
    queryFn: () =>
      api<{ nextRuns: string[] }>(`${serverPath(serverId)}/schedules/preview`, {
        method: 'POST',
        body: JSON.parse(previewInput),
      }),
    retry: false,
    staleTime: 60000,
  });
  const capabilityActions = [
    'start',
    'stop',
    'restart',
    ...(server.data?.capabilities?.backups || schedule?.action === 'backup' ? ['backup'] : []),
  ];
  return (
    <ActionForm
      success={false}
      onSubmit={async (data) => {
        await api(`${serverPath(serverId)}/schedules${schedule?.id ? `/${schedule.id}` : ''}`, {
          method: schedule?.id ? 'PUT' : 'POST',
          body: {
            name: text(data, 'name'),
            action,
            enabled: data.has('enabled'),
            timeZone: zone,
            timing,
            ...(schedule?.id ? { revision: schedule.revision } : {}),
            ...(action === 'backup'
              ? {
                  backupOptions: {
                    mode: text(data, 'backupMode') || 'auto',
                    ...(text(data, 'backupName') ? { name: text(data, 'backupName') } : {}),
                    ignored: text(data, 'ignored'),
                    isLocked: data.has('isLocked'),
                  },
                  retention: {
                    enabled: retention,
                    keepLast: retention ? number(data, 'keepLast') : 7,
                  },
                }
              : {}),
          },
        });
        await onSaved();
      }}
    >
      <Input
        label={t('web.name')}
        name="name"
        required
        maxLength={80}
        defaultValue={schedule?.name}
      />
      <div className="automation-form-row">
        <Select
          label={t('service.action')}
          value={action}
          onChange={(event) => setAction(event.target.value as Schedule['action'])}
        >
          {capabilityActions.map((value) => (
            <option key={value} value={value}>
              {t(`service.action.${value}`)}
            </option>
          ))}
        </Select>
        <Select
          label={t('service.repeat')}
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          {['once', 'daily', 'weekly', 'interval'].map((value) => (
            <option key={value} value={value}>
              {t(
                value === 'once' || value === 'interval'
                  ? `service.${value}`
                  : `automation.${value}`,
              )}
            </option>
          ))}
        </Select>
      </div>
      <div className="automation-form-row">
        {kind === 'daily' || kind === 'weekly' ? (
          <Input
            label={t('automation.time')}
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            required
          />
        ) : (
          <Input
            label={t('automation.firstRunLocal')}
            type="datetime-local"
            value={at}
            onChange={(event) => setAt(event.target.value)}
            required
          />
        )}
        <Input
          label={t(
            kind === 'once' || kind === 'interval'
              ? 'automation.displayTimeZone'
              : 'automation.timeZone',
          )}
          value={zone}
          onChange={(event) => setZone(event.target.value)}
          required
          list="automation-timezones"
        />
        <datalist id="automation-timezones">
          {Intl.supportedValuesOf('timeZone').map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </div>
      {kind === 'weekly' && (
        <fieldset className="automation-weekdays">
          <legend>{t('automation.weekdays')}</legend>
          {[1, 2, 3, 4, 5, 6, 7].map((day) => (
            <button
              type="button"
              key={day}
              aria-pressed={days.includes(day)}
              onClick={() =>
                setDays((previous) =>
                  previous.includes(day)
                    ? previous.filter((value) => value !== day)
                    : [...previous, day].sort(),
                )
              }
            >
              {new Intl.DateTimeFormat(locale === 'it' ? 'it' : 'en', {
                weekday: 'short',
                timeZone: 'UTC',
              }).format(new Date(Date.UTC(2024, 0, day)))}
            </button>
          ))}
        </fieldset>
      )}
      {kind === 'interval' && (
        <Input
          label={t('service.intervalMinutes')}
          type="number"
          min={5}
          max={525600}
          value={minutes}
          onChange={(event) => setMinutes(event.target.valueAsNumber)}
          required
        />
      )}
      <div className="automation-preview-runs">
        <span>{t('automation.nextRuns')}</span>
        {serialized !== previewInput ? (
          <span
            role="status"
            className="automation-inline-skeleton"
            aria-label={t('web.loading')}
          />
        ) : preview.error ? (
          <span className="muted">{t('automation.previewInvalid')}</span>
        ) : preview.data ? (
          <ol>
            {preview.data.nextRuns.slice(0, 3).map((value) => (
              <li key={value}>
                {new Intl.DateTimeFormat(locale === 'it' ? 'it' : 'en', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone: JSON.parse(previewInput).timeZone,
                }).format(new Date(value))}
              </li>
            ))}
          </ol>
        ) : (
          <span
            role="status"
            className="automation-inline-skeleton"
            aria-label={t('web.loading')}
          />
        )}
      </div>
      {action === 'backup' && (
        <>
          <Select
            name="backupMode"
            label={t('backup.serverDuring')}
            defaultValue={schedule?.backupOptions?.mode ?? 'auto'}
          >
            <option value="auto">{t('backup.integrationDefault')}</option>
            <option value="offline">{t('backup.offline')}</option>
            {offline !== 'required' && <option value="live">{t('backup.live')}</option>}
          </Select>
          <p className="muted">{t('backup.scheduleStopWarning')}</p>
          <details>
            <summary>{t('backup.advanced')}</summary>
            <Input
              name="backupName"
              label={t('backup.name')}
              defaultValue={schedule?.backupOptions?.name}
              maxLength={191}
            />
            <Textarea
              name="ignored"
              label={t('backup.excluded')}
              defaultValue={schedule?.backupOptions?.ignored}
            />
            <Check
              name="isLocked"
              label={t('backup.protect')}
              defaultChecked={schedule?.backupOptions?.isLocked}
            />
            <Check
              label={t('backup.retention')}
              checked={retention}
              disabled={max < 1 && !retention}
              onChange={(event) => setRetention(event.target.checked)}
            />
            {retention && (
              <>
                <Input
                  name="keepLast"
                  label={t('backup.keepLast')}
                  type="number"
                  min={1}
                  max={max}
                  required
                  defaultValue={schedule?.retention?.keepLast ?? Math.min(7, max)}
                />
                <p className="muted">{t('backup.retentionHelp')}</p>
              </>
            )}
          </details>
        </>
      )}
      <Check name="enabled" label={t('web.enabled')} defaultChecked={schedule?.enabled ?? true} />
      {action === 'stop' && <p className="muted">{t('automation.scheduledStopHint')}</p>}
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
        `${serverPath(serverId)}/schedules/${scheduleId}/outcomes${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      ),
    refetchInterval: 10000,
  });
  if (!result.data)
    return result.error ? (
      <ErrorNotice error={result.error} />
    ) : (
      <div
        role="status"
        className="automation-skeleton automation-skeleton-small"
        aria-label={t('web.loading')}
      />
    );
  return (
    <div className="automation-history">
      {result.error && <ErrorNotice error={result.error} />}
      <h3>{t('service.outcomes')}</h3>
      {!result.data.items.length ? (
        <Empty text={t('automation.noRuns')} />
      ) : (
        result.data.items.map((item) => (
          <div className="automation-history-item" key={item.id}>
            <Time value={item.dueAt} />
            <Badge value={item.jobState ?? item.status} />
            <span>
              {t(item.trigger === 'manual' ? 'automation.manualRun' : 'automation.scheduledRun')}
            </span>
            {item.reason && <span>{t(scheduleReason(item.reason))}</span>}
            {item.backupResult?.resume === 'failed' && <span>{t('backup.resumeFailed')}</span>}
            {item.backupResult?.cleanupFailed && <span>{t('backup.cleanupFailed')}</span>}
            {item.backupResult?.retentionFailed && <span>{t('backup.retentionFailed')}</span>}
            {item.jobId && <Link to={`/activity/${item.jobId}`}>{t('web.viewActivity')}</Link>}
            {item.missedCount > 0 && (
              <span>{t('service.missedRuns', { count: item.missedCount })}</span>
            )}
          </div>
        ))
      )}
      <div className="automation-tools">
        {before && (
          <button type="button" className="secondary" onClick={() => setBefore(undefined)}>
            {t('automation.latestRuns')}
          </button>
        )}
        {result.data.nextCursor && (
          <button
            type="button"
            className="secondary"
            onClick={() => setBefore(result.data.nextCursor ?? undefined)}
          >
            {t('web.next')}
          </button>
        )}
      </div>
    </div>
  );
}
