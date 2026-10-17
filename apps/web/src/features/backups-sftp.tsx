import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { getPlatformJob } from '../../../../packages/server-management/src/platform-queries.js';
import { api, download, idempotencyKey } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useFormat, useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  Badge,
  Check,
  Dialog,
  ErrorNotice,
  Input,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { type Backup, serverPath, useServer, useTransfers } from './service-contracts.js';
import './backups.css';

type Job = Result<typeof getPlatformJob>;
type IconName =
  | 'archive'
  | 'plus'
  | 'refresh'
  | 'download'
  | 'restore'
  | 'delete'
  | 'lock'
  | 'unlock'
  | 'edit'
  | 'calendar';
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    archive: 'M3 3h18v5H3z M5 8v13h14V8 M10 12h4',
    plus: 'M12 5v14M5 12h14',
    refresh: 'M20 8a8 8 0 1 0 0 8 M20 3v5h-5',
    download: 'M12 3v12m-5-5 5 5 5-5 M4 16v5h16v-5',
    restore: 'M4 9a8 8 0 1 1 0 7 M4 3v6h6 M12 7v5l3 2',
    delete: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7M14 10v7',
    lock: 'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3',
    unlock: 'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0 M12 14v3',
    edit: 'm15 4 5 5 M3 21l5-1L21 7l-5-5L3 15z',
    calendar: 'M4 5h16v16H4z M8 3v4M16 3v4M4 10h16 M8 14h2M14 14h2',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
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
  label,
  icon,
  onClick,
  disabled = false,
  danger = false,
}: {
  label: string;
  icon: IconName;
  onClick(): void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`backup-icon${danger ? ' backup-danger' : ''}`}
        aria-label={label}
        onClick={() => {
          if (!disabled) onClick();
        }}
        aria-disabled={disabled}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}
function BackupDialog({
  title,
  children,
  onClose,
  onSubmit,
  submitLabel,
  destructive = false,
  disabled = false,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  onSubmit(data: FormData): Promise<void>;
  submitLabel: string;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const pending = useRef(false),
    returnFocus = useRef(document.activeElement),
    [busy, setBusy] = useState(false);
  useEffect(
    () => () => {
      if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected)
        returnFocus.current.focus();
      else document.getElementById('backup-title')?.focus();
    },
    [],
  );
  const close = () => {
    if (!pending.current) onClose();
  };
  return (
    <Dialog
      open
      title={title}
      onClose={close}
      closeIcon
      closeDisabled={busy}
      className="confirmation-dialog backup-dialog"
      initialFocusSelector={destructive ? '[data-form-cancel]' : 'input:not([type=checkbox])'}
    >
      <ActionForm
        success={false}
        onCancel={close}
        submitLabel={submitLabel}
        destructive={destructive}
        submitDisabled={disabled}
        onSubmit={async (data) => {
          pending.current = true;
          setBusy(true);
          try {
            await onSubmit(data);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        {children}
      </ActionForm>
    </Dialog>
  );
}
function BackupJob({ id, onChange }: { id: string; onChange(): void }) {
  const t = useT();
  const job = useQuery({
    queryKey: ['job', id],
    queryFn: ({ signal }) => api<Job>(`/v1/platform/jobs/${encodeURIComponent(id)}`, { signal }),
    refetchInterval: (query) =>
      !query.state.data || ['queued', 'running'].includes(query.state.data.state) ? 3000 : false,
  });
  const state = job.data?.state,
    phase = job.data?.phase;
  useEffect(() => {
    if (state || phase) onChange();
  }, [state, phase, onChange]);
  if (job.data && !['backup', 'restore'].includes(job.data.action ?? '')) return null;
  const uncertain = job.data?.effectState === 'uncertain' || job.data?.effectState === 'prepared';
  const outcome = job.data?.backupResult;
  return (
    <div className="backup-job">
      <div role="status">
        <Icon name="archive" />
        <span>
          {t(job.data?.action === 'restore' ? 'backup.restoreOperation' : 'backup.createOperation')}
        </span>
        <Badge value={uncertain ? 'uncertain' : (state ?? 'queued')} />
      </div>
      <Link to={`/activity/${encodeURIComponent(id)}`}>{t('web.viewActivity')}</Link>
      {outcome &&
        (outcome.resume === 'failed' ||
          outcome.resume === 'suppressed' ||
          outcome.cleanupFailed ||
          outcome.retentionFailed) && (
          <div className="backup-job-detail" role="status">
            {outcome.state === 'succeeded' && <p>{t('backup.saved')}</p>}
            {outcome.resume === 'failed' && <p>{t('backup.resumeFailed')}</p>}
            {outcome.resume === 'suppressed' && <p>{t('backup.resumeSkipped')}</p>}
            {outcome.cleanupFailed && <p>{t('backup.cleanupFailed')}</p>}
            {outcome.retentionFailed && <p>{t('backup.retentionFailed')}</p>}
          </div>
        )}
      {job.error && <ErrorNotice error={job.error} retry={() => void job.refetch()} />}
    </div>
  );
}

export function BackupsPage({ serverId }: { serverId: string }) {
  // A separate instance prevents a dialog or queued operation from following navigation to another server.
  return <BackupWorkspace key={serverId} serverId={serverId} />;
}
function BackupWorkspace({ serverId }: { serverId: string }) {
  const t = useT(),
    format = useFormat(),
    client = useQueryClient(),
    server = useServer(serverId),
    transfers = useTransfers(serverId);
  const [streamConnected, setStreamConnected] = useState(false),
    [jobId, setJobId] = useState<string>(),
    [create, setCreate] = useState(false),
    [selected, setSelected] = useState<{
      backup: Backup;
      action: 'restore' | 'delete' | 'rename';
    }>(),
    [key, setKey] = useState(idempotencyKey),
    [error, setError] = useState<unknown>(),
    [busyId, setBusyId] = useState<string>();
  const [mode, setMode] = useState<'offline' | 'live'>('offline');
  const settings = transfers.data?.backups;
  const backups = useQuery({
    queryKey: ['backups', serverId],
    queryFn: ({ signal }) => api<Backup[]>(`${serverPath(serverId)}/backups`, { signal }),
    refetchInterval: streamConnected
      ? false
      : (query) => (query.state.data?.some((backup) => !backup.completed_at) ? 15000 : 60000),
  });
  const refreshRef = useRef(() => {});
  refreshRef.current = () => {
    for (const queryKey of [
      ['backups', serverId],
      ['server', serverId],
      ['transfers', serverId],
      ['job'],
    ])
      void client.invalidateQueries({ queryKey });
  };
  // A stable callback avoids a render/refetch loop when a job advances.
  const refresh = useRef(() => refreshRef.current()).current;
  useEffect(() => {
    if (!settings?.events) return;
    const events = new EventSource(`${serverPath(serverId)}/backups/events`, {
      withCredentials: true,
    });
    events.onopen = () => {
      setStreamConnected(true);
      refresh();
    };
    events.onerror = () => setStreamConnected(false);
    events.addEventListener('change', refresh);
    return () => {
      events.close();
      setStreamConnected(false);
    };
  }, [settings?.events, serverId, refresh]);
  const items = backups.data ?? [],
    manage = server.data?.permissions.manage === true,
    stopped = server.data?.runtimeState === 'offline';
  const used = items.filter((backup) => !backup.completed_at || backup.is_successful).length;
  const limit = settings?.limit,
    full = limit !== undefined && limit !== null && used >= limit;
  const activeJob = server.data?.activeOperationId ?? jobId;
  async function rowAction(backup: Backup, action: 'download' | 'lock') {
    setBusyId(backup.uuid);
    setError(undefined);
    try {
      if (action === 'download')
        await download(
          `${serverPath(serverId)}/backups/${encodeURIComponent(backup.uuid)}/download`,
        );
      else {
        await api(`${serverPath(serverId)}/backups/${encodeURIComponent(backup.uuid)}`, {
          method: 'PATCH',
          body: { isLocked: !backup.is_locked },
        });
        refresh();
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusyId(undefined);
    }
  }
  function backupName(backup: Backup) {
    return /^nickhosting-operation-[0-9a-f-]{36}$/i.test(backup.name)
      ? t('backup.defaultName', { date: format.date(backup.created_at) })
      : backup.name;
  }
  function openCreate() {
    setMode(settings?.policy?.offline === 'none' && !stopped ? 'live' : 'offline');
    setKey(idempotencyKey());
    setCreate(true);
  }
  return (
    <section className="backup-page" aria-labelledby="backup-title">
      <header className="backup-heading">
        <div className="backup-title">
          <h2 id="backup-title" tabIndex={-1}>
            {t('web.backups')}
          </h2>
          {backups.data && limit != null && (
            <span className="backup-quota">{t('backup.quota', { used, limit })}</span>
          )}
        </div>
        <div className="backup-tools">
          {manage && (
            <Tooltip content={t('web.schedules')}>
              <Link
                className="backup-icon"
                to={`/servers/${encodeURIComponent(serverId)}/automation?action=backup`}
                aria-label={t('web.schedules')}
              >
                <Icon name="calendar" />
              </Link>
            </Tooltip>
          )}
          <IconButton
            label={t('backup.refresh')}
            icon="refresh"
            disabled={backups.isFetching}
            onClick={refresh}
          />
          {manage && settings?.supported && (
            <Tooltip content={full ? t('backup.full') : t('service.createBackup')}>
              <button
                className="backup-create"
                type="button"
                disabled={
                  !settings.canCreate || full || backups.isPending || Boolean(backups.error)
                }
                onClick={openCreate}
              >
                <Icon name="plus" />
                {t('service.createBackup')}
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      {transfers.error && (
        <ErrorNotice error={transfers.error} retry={() => void transfers.refetch()} />
      )}
      {server.error && <ErrorNotice error={server.error} retry={() => void server.refetch()} />}
      {Boolean(error) && <ErrorNotice error={error} />}
      {backups.error && <ErrorNotice error={backups.error} retry={() => void backups.refetch()} />}
      {activeJob && <BackupJob id={activeJob} onChange={refresh} />}
      {backups.isPending ? (
        <div className="backup-skeleton" role="status" aria-label={t('web.loading')}>
          {[0, 1, 2].map((row) => (
            <div key={row}>
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      ) : (
        backups.data && (
          <div className="backup-list">
            {items.length === 0 ? (
              <div className="backup-empty">
                <Icon name="archive" />
                <h3>{t('service.noBackups')}</h3>
                <p>{t('backup.emptyHelp')}</p>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('web.name')}</th>
                    <th scope="col">{t('web.created')}</th>
                    <th scope="col">{t('web.size')}</th>
                    <th scope="col">{t('web.status')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('web.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((backup) => (
                    <tr key={backup.uuid}>
                      <td className="backup-name">
                        <div>
                          <Icon name="archive" />
                          <span>{backupName(backup)}</span>
                          {backup.is_locked && (
                            <Tooltip content={t('backup.locked')}>
                              <span
                                className="backup-locked"
                                role="img"
                                aria-label={t('backup.locked')}
                              >
                                <Icon name="lock" />
                              </span>
                            </Tooltip>
                          )}
                        </div>
                      </td>
                      <td className="backup-date">
                        <Time value={backup.created_at} />
                      </td>
                      <td className="backup-size">
                        {backup.completed_at && backup.is_successful
                          ? format.bytes(backup.bytes)
                          : '—'}
                      </td>
                      <td className="backup-status">
                        <Badge
                          value={
                            backup.completed_at
                              ? backup.is_successful
                                ? 'succeeded'
                                : 'failed'
                              : 'running'
                          }
                        />
                      </td>
                      <td className="backup-row-actions">
                        <div>
                          {manage && (
                            <IconButton
                              label={t('backup.rename', { name: backupName(backup) })}
                              icon="edit"
                              disabled={Boolean(busyId)}
                              onClick={() => setSelected({ backup, action: 'rename' })}
                            />
                          )}
                          {backup.completed_at && backup.is_successful && (
                            <>
                              <IconButton
                                label={t('backup.download', { name: backupName(backup) })}
                                icon="download"
                                disabled={Boolean(busyId)}
                                onClick={() => void rowAction(backup, 'download')}
                              />
                              {manage && (
                                <IconButton
                                  label={
                                    settings?.canRestore
                                      ? t('backup.restore', { name: backupName(backup) })
                                      : t(
                                          stopped
                                            ? 'backup.operationBusy'
                                            : 'service.stopForRestore',
                                        )
                                  }
                                  icon="restore"
                                  disabled={!settings?.canRestore || Boolean(busyId)}
                                  onClick={() => {
                                    setSelected({ backup, action: 'restore' });
                                    setKey(idempotencyKey());
                                  }}
                                />
                              )}
                            </>
                          )}
                          {manage && (
                            <>
                              <IconButton
                                label={t(backup.is_locked ? 'backup.unlock' : 'backup.lock', {
                                  name: backupName(backup),
                                })}
                                icon={backup.is_locked ? 'lock' : 'unlock'}
                                disabled={!backup.completed_at || Boolean(busyId)}
                                onClick={() => void rowAction(backup, 'lock')}
                              />
                              <IconButton
                                label={
                                  backup.is_locked
                                    ? t('backup.unlockToDelete')
                                    : t('backup.delete', { name: backupName(backup) })
                                }
                                icon="delete"
                                danger
                                disabled={
                                  backup.is_locked || !backup.completed_at || Boolean(busyId)
                                }
                                onClick={() => setSelected({ backup, action: 'delete' })}
                              />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      )}
      {full && manage && <p className="backup-footnote">{t('backup.full')}</p>}
      {create && (
        <BackupDialog
          title={t('service.createBackup')}
          submitLabel={t('service.createBackup')}
          onClose={() => setCreate(false)}
          disabled={!settings?.canCreate || full}
          onSubmit={async (data) => {
            const result = await api<{ jobId: string }>(`${serverPath(serverId)}/operations`, {
              body: {
                action: 'backup',
                idempotencyKey: key,
                name: text(data, 'name') || undefined,
                ignored: text(data, 'ignored') || undefined,
                isLocked: data.has('isLocked'),
                mode: stopped ? 'offline' : mode,
              },
            });
            setJobId(result.jobId);
            setCreate(false);
            refresh();
          }}
        >
          <Input
            name="name"
            label={t('backup.name')}
            maxLength={191}
            placeholder={t('backup.automaticName')}
          />
          {!stopped && (
            <fieldset className="backup-mode">
              <legend>{t('backup.serverDuring')}</legend>
              <label>
                <input
                  type="radio"
                  name="mode"
                  value="offline"
                  checked={mode === 'offline'}
                  onChange={() => setMode('offline')}
                />
                <span>
                  {t('backup.offline')}
                  <small>{t('backup.offlineHelp')}</small>
                </span>
              </label>
              {['none', 'recommended'].includes(settings?.policy?.offline ?? '') && (
                <label>
                  <input
                    type="radio"
                    name="mode"
                    value="live"
                    checked={mode === 'live'}
                    onChange={() => setMode('live')}
                  />
                  <span>
                    {t('backup.live')}
                    <small>{t('backup.liveHelp')}</small>
                  </span>
                </label>
              )}
            </fieldset>
          )}
          <Check name="isLocked" label={t('backup.protect')} />
          <details className="backup-advanced">
            <summary>{t('backup.advanced')}</summary>
            <Textarea name="ignored" label={t('backup.excluded')} rows={4} maxLength={10000} />
            <p className="backup-footnote">{t('backup.excludedHelp')}</p>
          </details>
        </BackupDialog>
      )}
      {selected && (
        <BackupDialog
          key={`${selected.action}:${selected.backup.uuid}`}
          title={t(
            selected.action === 'restore'
              ? 'service.restore'
              : selected.action === 'delete'
                ? 'backup.deleteTitle'
                : 'backup.renameTitle',
          )}
          submitLabel={t(
            selected.action === 'restore'
              ? 'backup.restoreAction'
              : selected.action === 'delete'
                ? 'web.delete'
                : 'web.save',
          )}
          destructive={selected.action !== 'rename'}
          onClose={() => setSelected(undefined)}
          disabled={selected.action === 'restore' && !settings?.canRestore}
          onSubmit={async (data) => {
            const path = `${serverPath(serverId)}/backups/${encodeURIComponent(selected.backup.uuid)}`;
            if (selected.action === 'restore') {
              const result = await api<{ jobId: string }>(`${serverPath(serverId)}/operations`, {
                body: {
                  action: 'restore',
                  idempotencyKey: key,
                  backupId: selected.backup.uuid,
                  confirm: true,
                  truncate: data.get('restoreMode') === 'replace',
                  backupBefore: data.has('backupBefore'),
                },
              });
              setJobId(result.jobId);
            } else if (selected.action === 'delete') {
              await api(path, { method: 'DELETE', body: { confirm: true } });
              client.setQueryData<Backup[]>(['backups', serverId], (current) =>
                current?.filter((backup) => backup.uuid !== selected.backup.uuid),
              );
            } else await api(path, { method: 'PATCH', body: { name: text(data, 'name') } });
            setSelected(undefined);
            refresh();
          }}
        >
          {selected.action === 'rename' ? (
            <Input
              name="name"
              required
              maxLength={191}
              pattern={'.*\\S.*'}
              defaultValue={backupName(selected.backup)}
              label={t('web.name')}
            />
          ) : (
            <>
              <p className="backup-confirm-name">{backupName(selected.backup)}</p>
              {selected.action === 'delete' ? (
                <p>{t('backup.deleteHelp')}</p>
              ) : (
                <>
                  <fieldset className="backup-mode">
                    <legend>{t('backup.restoreFiles')}</legend>
                    <label>
                      <input type="radio" name="restoreMode" value="replace" defaultChecked />
                      <span>
                        {t('backup.replace')}
                        <small>{t('backup.replaceHelp')}</small>
                      </span>
                    </label>
                    <label>
                      <input type="radio" name="restoreMode" value="preserve" />
                      <span>
                        {t('backup.preserve')}
                        <small>{t('backup.preserveHelp')}</small>
                      </span>
                    </label>
                  </fieldset>
                  <Check name="backupBefore" label={t('backup.beforeRestore')} disabled={full} />
                  {full && <p className="backup-footnote">{t('backup.beforeRestoreFull')}</p>}
                  <p className="backup-footnote">{t('backup.restoreStopped')}</p>
                </>
              )}
            </>
          )}
        </BackupDialog>
      )}
    </section>
  );
}

export { SftpPage } from './sftp.js';
