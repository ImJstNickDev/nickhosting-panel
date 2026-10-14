import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, idempotencyKey } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { Badge, ConfirmDialog, ErrorNotice, Time } from '../components/ui.js';
import {
  type Credentials,
  type IssuedCredential,
  serverPath,
  useServer,
  useTransfers,
} from './service-contracts.js';
import './sftp.css';

type IconName = 'copy' | 'key' | 'rotate' | 'revoke' | 'eye' | 'close' | 'plus' | 'connection';
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    copy: 'M9 8h11v13H9z M5 16H3V3h11v2',
    key: 'M14 3a7 7 0 0 0-6 10L2 19v3h4v-3h3v-3l2-2a7 7 0 1 0 3-11Z M16 7h.01',
    rotate: 'M20 8a8 8 0 1 0 0 8 M20 3v5h-5',
    revoke: 'M4 4l16 16 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    close: 'm6 6 12 12M6 18 18 6',
    plus: 'M12 5v14M5 12h14',
    connection: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M8 12h8M12 8v8',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="19"
      height="19"
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
  danger = false,
  disabled = false,
}: {
  label: string;
  icon: IconName;
  onClick(): void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`sftp-icon${danger ? ' sftp-danger' : ''}`}
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}
function CopyValue({
  value,
  label,
  secret = false,
}: {
  value: string;
  label: string;
  secret?: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false),
    [shown, setShown] = useState(false);
  return (
    <div className="sftp-value-wrap">
      <div className="sftp-value">
        {secret ? (
          <input
            aria-label={t('web.password')}
            readOnly
            type={shown ? 'text' : 'password'}
            value={value}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          />
        ) : (
          <span>{value}</span>
        )}
        {secret && (
          <IconButton
            label={t(shown ? 'sftp.hidePassword' : 'sftp.showPassword')}
            icon="eye"
            onClick={() => setShown(!shown)}
          />
        )}
        <IconButton
          label={copied ? t('web.copied') : label}
          icon="copy"
          onClick={() => {
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(value))
              .then(
                () => {
                  setCopied(true);
                  setFailed(false);
                },
                () => {
                  setFailed(true);
                },
              );
          }}
        />
      </div>
      <span className="visually-hidden" role="status">
        {copied ? t('web.copied') : ''}
      </span>
      {failed && (
        <p role="alert" className="sftp-copy-error">
          {t('sftp.copyFailed')}
        </p>
      )}
    </div>
  );
}
export function SftpPage({ serverId }: { serverId: string }) {
  // Keyed identity also clears one-time passwords and in-flight UI state on server changes.
  return <SftpContent key={serverId} serverId={serverId} />;
}
function SftpContent({ serverId }: { serverId: string }) {
  const t = useT(),
    transfers = useTransfers(serverId),
    server = useServer(serverId);
  const credentials = useQuery({
    queryKey: ['sftp', serverId],
    queryFn: () => api<Credentials>(`${serverPath(serverId)}/sftp`),
    refetchInterval: 30000,
  });
  const [issued, setIssued] = useState<IssuedCredential>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const [action, setAction] = useState<{
    kind: 'rotate' | 'revoke';
    credential: Credentials[number];
    rotationId: string;
  }>();
  const createId = useRef(idempotencyKey()),
    pending = useRef(false),
    createButton = useRef<HTMLButtonElement>(null);
  const endpoint = transfers.data?.sftp.endpoint;
  const canIssue = transfers.data?.sftp.configured && transfers.data.sftp.canIssue;
  const dismiss = () => {
    setIssued(undefined);
    createButton.current?.focus();
  };
  async function create() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const value = await api<IssuedCredential>(`${serverPath(serverId)}/sftp`, {
        body: { credentialId: createId.current },
      });
      setIssued(value);
      createId.current = idempotencyKey();
      await credentials.refetch();
    } catch (e) {
      setError(e);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="sftp-page" aria-labelledby="sftp-title">
      <header className="sftp-heading">
        <h2 id="sftp-title">SFTP</h2>
        {canIssue && (
          <button ref={createButton} type="button" disabled={busy} onClick={() => void create()}>
            <Icon name="plus" />
            {t('service.createCredential')}
          </button>
        )}
      </header>
      {error !== undefined && <ErrorNotice error={error} />}
      {transfers.error && (
        <ErrorNotice error={transfers.error} retry={() => void transfers.refetch()} />
      )}
      {transfers.isPending ? (
        <div
          className="sftp-skeleton"
          role="status"
          aria-busy="true"
          aria-label={t('web.loading')}
        />
      ) : (
        !transfers.error && (
          <div className="sftp-connection">
            <div className="sftp-connection-title">
              <Icon name="connection" />
              <h3>{t('sftp.connection')}</h3>
              <span>SFTP</span>
            </div>
            {endpoint ? (
              <dl className="sftp-endpoint">
                <div>
                  <dt>{t('service.hostname')}</dt>
                  <dd>
                    <CopyValue value={endpoint.hostname} label={t('sftp.copyHost')} />
                  </dd>
                </div>
                <div>
                  <dt>{t('service.port')}</dt>
                  <dd>
                    <CopyValue value={String(endpoint.port)} label={t('sftp.copyPort')} />
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="sftp-muted">{t('service.sftpEndpointMissing')}</p>
            )}
            {!transfers.data?.sftp.configured && (
              <p className="sftp-muted">{t('web.unconfigured')}</p>
            )}
            {transfers.data?.sftp.configured && endpoint && !canIssue && (
              <p className="sftp-muted">{t('sftp.permission')}</p>
            )}
          </div>
        )
      )}
      {issued && (
        <section className="sftp-issued" aria-labelledby="sftp-issued-title">
          <header>
            <h3 id="sftp-issued-title">
              <Icon name="key" />
              {t('sftp.newPassword')}
            </h3>
            <IconButton label={t('web.close')} icon="close" onClick={dismiss} />
          </header>
          <p>{t(issued.password ? 'service.credentialOnce' : 'service.credentialLost')}</p>
          <dl className="sftp-endpoint">
            <div>
              <dt>{t('service.username')}</dt>
              <dd>
                <CopyValue value={issued.username ?? ''} label={t('sftp.copyUsername')} />
              </dd>
            </div>
            {issued.password && (
              <div>
                <dt>{t('web.password')}</dt>
                <dd>
                  <CopyValue
                    key={issued.password}
                    value={issued.password}
                    label={t('sftp.copyPassword')}
                    secret
                  />
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
      <div className="sftp-credentials">
        <h3>{t('sftp.credentials')}</h3>
        {credentials.isPending ? (
          <div
            className="sftp-skeleton"
            role="status"
            aria-busy="true"
            aria-label={t('web.loading')}
          />
        ) : credentials.error ? (
          <ErrorNotice error={credentials.error} retry={() => void credentials.refetch()} />
        ) : credentials.data.length === 0 ? (
          <p className="sftp-empty">{t('sftp.empty')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('service.username')}</th>
                <th>{t('web.status')}</th>
                <th>{t('web.expires')}</th>
                <th>
                  <span className="visually-hidden">{t('web.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {credentials.data.map((c) => (
                <tr key={c.id}>
                  <td data-label={t('service.username')}>
                    <CopyValue
                      value={c.username ?? t('web.pending')}
                      label={t('sftp.copyUsername')}
                    />
                  </td>
                  <td data-label={t('web.status')}>
                    <Badge value={c.state} />
                  </td>
                  <td data-label={t('web.expires')}>
                    <Time value={c.expiresAt} />
                  </td>
                  <td className="sftp-row-actions">
                    {c.state !== 'revoked' && (
                      <>
                        {canIssue && (
                          <IconButton
                            label={t('service.rotate')}
                            icon="rotate"
                            disabled={busy}
                            onClick={() =>
                              setAction({
                                kind: 'rotate',
                                credential: c,
                                rotationId: idempotencyKey(),
                              })
                            }
                          />
                        )}
                        {server.data?.permissions.manage && (
                          <IconButton
                            label={t('web.revoke')}
                            icon="revoke"
                            danger
                            disabled={busy}
                            onClick={() =>
                              setAction({
                                kind: 'revoke',
                                credential: c,
                                rotationId: idempotencyKey(),
                              })
                            }
                          />
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <details className="sftp-limitation">
        <summary>{t('sftp.limitation')}</summary>
        <p>{t('service.sftpLimitation')}</p>
      </details>
      <ConfirmDialog
        open={!!action}
        title={t(action?.kind === 'rotate' ? 'service.rotate' : 'web.revoke')}
        confirmLabel={t(action?.kind === 'rotate' ? 'service.rotate' : 'web.revoke')}
        destructive={action?.kind === 'revoke'}
        onClose={() => setAction(undefined)}
        onConfirm={async () => {
          if (!action) return;
          if (action.kind === 'rotate')
            setIssued(
              await api<IssuedCredential>(
                `${serverPath(serverId)}/sftp/${action.credential.id}/rotate`,
                { body: { rotationId: action.rotationId } },
              ),
            );
          else {
            await api(`${serverPath(serverId)}/sftp/${action.credential.id}`, {
              method: 'DELETE',
              body: {},
            });
            if (issued?.id === action.credential.id) setIssued(undefined);
          }
          setAction(undefined);
          await credentials.refetch();
          createButton.current?.focus();
        }}
      >
        <p className="sftp-confirm-user">{action?.credential.username}</p>
        <p>{t(action?.kind === 'rotate' ? 'sftp.rotateConfirm' : 'sftp.revokeConfirm')}</p>
      </ConfirmDialog>
    </section>
  );
}
