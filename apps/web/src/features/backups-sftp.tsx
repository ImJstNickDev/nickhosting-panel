import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download, idempotencyKey } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import {
  ActionForm,
  Badge,
  Check,
  Dialog,
  Empty,
  ErrorNotice,
  Loading,
  Section,
  Time,
} from '../components/ui.js';
import { type Backup, serverPath, useServer, useTransfers } from './service-contracts.js';

export function BackupsPage({ serverId }: { serverId: string }) {
  const t = useT(),
    format = useFormat(),
    server = useServer(serverId),
    transfers = useTransfers(serverId);
  const backups = useQuery({
    queryKey: ['backups', serverId],
    queryFn: () => api<Backup[]>(`${serverPath(serverId)}/backups`),
    refetchInterval: 15000,
  });
  const [selected, setSelected] = useState<{ backup: Backup; action: 'restore' | 'delete' }>();
  const [key, setKey] = useState(idempotencyKey);
  return (
    <Section title={t('web.backups')}>
      {transfers.error && <ErrorNotice error={transfers.error} />}
      {transfers.data?.backups.canCreate && (
        <ActionForm
          submitLabel={t('service.createBackup')}
          success={false}
          onSubmit={async () => {
            await api<{ jobId: string }>(`${serverPath(serverId)}/operations`, {
              body: { action: 'backup', idempotencyKey: key },
            });
            setKey(idempotencyKey());
            await server.refetch();
          }}
        >
          <span />
        </ActionForm>
      )}
      {backups.isPending ? (
        <Loading />
      ) : backups.error ? (
        <ErrorNotice error={backups.error} retry={() => void backups.refetch()} />
      ) : backups.data.length === 0 ? (
        <Empty text={t('service.noBackups')} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('web.name')}</th>
                <th>{t('web.created')}</th>
                <th>{t('web.size')}</th>
                <th>{t('web.status')}</th>
                <th>{t('web.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {backups.data.map((backup) => (
                <tr key={backup.uuid}>
                  <td>{backup.name}</td>
                  <td>
                    <Time value={backup.created_at} />
                  </td>
                  <td>{format.bytes(backup.bytes)}</td>
                  <td>
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
                  <td>
                    <div className="actions">
                      {backup.completed_at && backup.is_successful && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            download(`${serverPath(serverId)}/backups/${backup.uuid}/download`)
                          }
                        >
                          {t('web.download')}
                        </button>
                      )}
                      {transfers.data?.backups.canRestore &&
                        backup.is_successful &&
                        backup.completed_at && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setSelected({ backup, action: 'restore' });
                              setKey(idempotencyKey());
                            }}
                          >
                            {t('service.restore')}
                          </button>
                        )}
                      {server.data?.permissions.manage && !backup.is_locked && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setSelected({ backup, action: 'delete' })}
                        >
                          {t('web.delete')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {server.data?.runtimeState !== 'offline' && (
        <p className="muted">{t('service.stopForRestore')}</p>
      )}
      <Dialog
        open={Boolean(selected)}
        title={t(selected?.action === 'restore' ? 'service.restore' : 'web.delete')}
        onClose={() => setSelected(undefined)}
      >
        {selected && (
          <ActionForm
            success={false}
            submitLabel={t(selected.action === 'restore' ? 'service.restore' : 'web.delete')}
            onSubmit={async (data) => {
              if (selected.action === 'restore') {
                await api<{ jobId: string }>(`${serverPath(serverId)}/operations`, {
                  body: {
                    action: 'restore',
                    idempotencyKey: key,
                    backupId: selected.backup.uuid,
                    confirm: true,
                    truncate: data.has('truncate'),
                  },
                });
              } else
                await api(`${serverPath(serverId)}/backups/${selected.backup.uuid}`, {
                  method: 'DELETE',
                  body: { confirm: true },
                });
              setSelected(undefined);
              await Promise.all([backups.refetch(), server.refetch()]);
            }}
          >
            <p>
              {t(
                selected.action === 'restore'
                  ? 'service.restoreWarning'
                  : 'service.deleteBackupWarning',
                { name: selected.backup.name },
              )}
            </p>
            {selected.action === 'restore' && (
              <Check name="truncate" defaultChecked label={t('service.truncate')} />
            )}
            <Check required label={t('web.confirm')} />
          </ActionForm>
        )}
      </Dialog>
    </Section>
  );
}

export { SftpPage } from './sftp.js';
