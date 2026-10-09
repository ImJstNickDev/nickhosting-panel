import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, download, idempotencyKey } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import {
  ActionForm,
  Badge,
  Check,
  Details,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  JobNotice,
  Loading,
  Notice,
  Section,
  Time,
} from '../components/ui.js';
import {
  type Backup,
  type Credentials,
  type IssuedCredential,
  serverPath,
  useServer,
  useTransfers,
} from './service-contracts.js';

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
  const [jobId, setJobId] = useState<string>();
  const [key, setKey] = useState(idempotencyKey);
  return (
    <Section title={t('web.backups')}>
      <JobNotice jobId={jobId} />
      {transfers.error && <ErrorNotice error={transfers.error} />}
      {transfers.data?.backups.canCreate && (
        <ActionForm
          submitLabel={t('service.createBackup')}
          success={false}
          onSubmit={async () => {
            const result = await api<{ jobId: string }>(`${serverPath(serverId)}/operations`, {
              body: { action: 'backup', idempotencyKey: key },
            });
            setJobId(result.jobId);
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
                const result = await api<{ jobId: string }>(`${serverPath(serverId)}/operations`, {
                  body: {
                    action: 'restore',
                    idempotencyKey: key,
                    backupId: selected.backup.uuid,
                    confirm: true,
                    truncate: data.has('truncate'),
                  },
                });
                setJobId(result.jobId);
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

export function SftpPage({ serverId }: { serverId: string }) {
  const t = useT(),
    transfers = useTransfers(serverId),
    server = useServer(serverId);
  const credentials = useQuery({
    queryKey: ['sftp', serverId],
    queryFn: () => api<Credentials>(`${serverPath(serverId)}/sftp`),
    refetchInterval: 30000,
  });
  const [issued, setIssued] = useState<IssuedCredential>();
  const [credentialId, setCredentialId] = useState(idempotencyKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time credentials must clear when switching server identity.
  useEffect(() => {
    setIssued(undefined);
  }, [serverId]);
  return (
    <Section title="SFTP">
      <Notice>{t('service.sftpLimitation')}</Notice>
      {transfers.isPending ? (
        <Loading />
      ) : transfers.error ? (
        <ErrorNotice error={transfers.error} />
      ) : (
        <>
          {!transfers.data?.sftp.configured && <Notice>{t('web.unconfigured')}</Notice>}
          {transfers.data?.sftp.endpoint ? (
            <Details
              values={[
                [t('service.hostname'), transfers.data.sftp.endpoint.hostname],
                [t('service.port'), transfers.data.sftp.endpoint.port],
              ]}
            />
          ) : (
            <Notice>{t('service.sftpEndpointMissing')}</Notice>
          )}
          {transfers.data?.sftp.configured && transfers.data.sftp.canIssue && (
            <ActionForm
              submitLabel={t('service.createCredential')}
              success={false}
              onSubmit={async () => {
                setIssued(
                  await api<IssuedCredential>(`${serverPath(serverId)}/sftp`, {
                    body: { credentialId },
                  }),
                );
                setCredentialId(idempotencyKey());
                await credentials.refetch();
              }}
            >
              <span />
            </ActionForm>
          )}
        </>
      )}
      {issued && (
        <div className="notice">
          <p>{t(issued.password ? 'service.credentialOnce' : 'service.credentialLost')}</p>
          <Input
            label={t('service.username')}
            value={issued.username ?? ''}
            readOnly
            autoComplete="off"
          />
          {issued.password && (
            <Input label={t('web.password')} value={issued.password} readOnly autoComplete="off" />
          )}
          <p>
            <Time value={issued.expiresAt} />
          </p>
          <button type="button" className="secondary" onClick={() => setIssued(undefined)}>
            {t('web.close')}
          </button>
        </div>
      )}
      {credentials.isPending ? (
        <Loading />
      ) : credentials.error ? (
        <ErrorNotice error={credentials.error} />
      ) : credentials.data.length === 0 ? (
        <Empty />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('service.username')}</th>
                <th>{t('web.status')}</th>
                <th>{t('web.expires')}</th>
                <th>{t('web.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {credentials.data.map((credential) => (
                <tr key={credential.id}>
                  <td>{credential.username ?? t('web.pending')}</td>
                  <td>
                    <Badge value={credential.state} />
                  </td>
                  <td>
                    <Time value={credential.expiresAt} />
                  </td>
                  <td>
                    {credential.state !== 'revoked' && (
                      <div className="stack">
                        {transfers.data?.sftp.canIssue && (
                          <RotateCredential
                            serverId={serverId}
                            credentialId={credential.id}
                            onIssued={async (value) => {
                              setIssued(value);
                              await credentials.refetch();
                            }}
                          />
                        )}
                        {server.data?.permissions.manage && (
                          <ActionForm
                            submitLabel={t('web.revoke')}
                            success={false}
                            onSubmit={async () => {
                              await api(`${serverPath(serverId)}/sftp/${credential.id}`, {
                                method: 'DELETE',
                                body: {},
                              });
                              setIssued(undefined);
                              await credentials.refetch();
                            }}
                          >
                            <Check required label={t('web.confirm')} />
                          </ActionForm>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
function RotateCredential({
  serverId,
  credentialId,
  onIssued,
}: {
  serverId: string;
  credentialId: string;
  onIssued: (value: IssuedCredential) => Promise<void>;
}) {
  const t = useT();
  const [rotationId, setRotationId] = useState(idempotencyKey);
  return (
    <ActionForm
      submitLabel={t('service.rotate')}
      success={false}
      onSubmit={async () => {
        const value = await api<IssuedCredential>(
          `${serverPath(serverId)}/sftp/${credentialId}/rotate`,
          { body: { rotationId } },
        );
        setRotationId(idempotencyKey());
        await onIssued(value);
      }}
    >
      <Check required label={t('service.rotateWarning')} />
    </ActionForm>
  );
}
