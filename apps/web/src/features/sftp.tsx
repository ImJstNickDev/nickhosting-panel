import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, idempotencyKey } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import { Badge, ConfirmDialog, ErrorNotice, Input, Time } from '../components/ui.js';
import { IconAction, Switch } from '../components/workspace-controls.js';
import {
  type Credentials,
  type IssuedCredential,
  serverPath,
  useTransfers,
} from './service-contracts.js';
import { SftpPassword, useSftpPassword } from './sftp-password.js';
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
    <IconAction label={label} destructive={danger} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </IconAction>
  );
}
function CopyValue({
  value,
  label,
  secret = false,
  initiallyShown = false,
}: {
  value: string;
  label: string;
  secret?: boolean;
  initiallyShown?: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false),
    [shown, setShown] = useState(initiallyShown);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="sftp-value-wrap">
      <div className="sftp-value">
        {secret ? (
          <input
            aria-label={t('web.password')}
            onClick={(event) => event.currentTarget.select()}
            onFocus={(event) => event.currentTarget.select()}
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
            setCopied(false);
            setFailed(false);
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
export function SftpPage({
  serverId,
  embedded = false,
  onBusyChange,
}: {
  serverId: string;
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const session = useSession();
  const context = session.data?.context;
  // Identity changes discard revealed secrets and pending requests, including support mode.
  const identity = session.error
    ? 'unavailable'
    : [
        context?.actorUserId,
        context?.subjectUserId,
        context?.sessionType,
        context?.support?.id,
      ].join(':');
  return (
    <SftpContent
      key={`${serverId}:${identity}`}
      serverId={serverId}
      embedded={embedded}
      onBusyChange={onBusyChange}
    />
  );
}
function SftpContent({
  serverId,
  embedded,
  onBusyChange,
}: {
  serverId: string;
  embedded: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useT(),
    transfers = useTransfers(serverId);
  const credentials = useQuery({
    queryKey: ['sftp', serverId],
    queryFn: () => api<Credentials>(`${serverPath(serverId)}/sftp`),
    refetchInterval: (query) => {
      const primary = query.state.data?.find((c) => c.kind === 'primary' && c.state !== 'revoked');
      return transfers.data?.sftp.configured &&
        transfers.data.sftp.canIssue &&
        (!primary || primary.state === 'pending')
        ? 2000
        : 30000;
    },
  });
  const [issued, setIssued] = useState<IssuedCredential>(),
    [recovered, setRecovered] = useState(false),
    [passwordRevision, setPasswordRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const [action, setAction] = useState<{
    kind: 'rotate' | 'revoke';
    credential: Credentials[number];
    rotationId: string;
  }>();
  const [adding, setAdding] = useState(false),
    [label, setLabel] = useState(''),
    [showRevoked, setShowRevoked] = useState(false);
  const createIds = useRef(idempotencyKey()),
    pending = useRef(false),
    createButton = useRef<HTMLButtonElement>(null);
  const passwordRequest = useSftpPassword(serverId);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const endpoint = transfers.data?.sftp.endpoint;
  const canIssue = transfers.data?.sftp.configured && transfers.data.sftp.canIssue;
  const primary = credentials.data?.find((c) => c.kind === 'primary' && c.state !== 'revoked');
  const auxiliary = credentials.data?.filter((c) => c.kind !== 'primary') ?? [];
  const visibleAuxiliary = auxiliary.filter((c) => showRevoked || c.state !== 'revoked');
  const limit = transfers.data?.sftp.auxiliaryLimit ?? 0;
  const activeCount = auxiliary.filter((c) => c.state !== 'revoked').length;
  const dismiss = () => {
    passwordRequest.cancel();
    setIssued(undefined);
    createButton.current?.focus();
  };
  async function create() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const value = await api<IssuedCredential>(`${serverPath(serverId)}/sftp`, {
        body: {
          credentialId: createIds.current,
          kind: 'auxiliary',
          label: label.trim(),
        },
      });
      setRecovered(false);
      setIssued(value);
      createIds.current = idempotencyKey();
      await credentials.refetch();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function reveal(credential: Credentials[number]) {
    setError(undefined);
    setIssued(undefined);
    try {
      const result = await passwordRequest.load(credential.id);
      if (result) {
        setRecovered(true);
        setIssued(result.credential);
      }
    } catch (failure) {
      setError(failure);
    }
  }
  // Clear displayed secrets if the refreshed access record or permission no longer allows it.
  useEffect(() => {
    const current = credentials.data?.find((c) => c.id === issued?.id);
    if (
      !canIssue ||
      (current &&
        (current.state !== 'active' ||
          (current.expiresAt && Date.parse(current.expiresAt) <= Date.now())))
    ) {
      passwordRequest.cancel();
      setIssued(undefined);
    }
  }, [canIssue, credentials.data, issued, passwordRequest.cancel]);
  const rotate = (credential: Credentials[number]) =>
    setAction({ kind: 'rotate', credential, rotationId: idempotencyKey() });
  return (
    <section className="sftp-page" aria-label={t('web.sftp')}>
      {!embedded && (
        <header className="sftp-heading">
          <h2 id="sftp-title">SFTP</h2>
        </header>
      )}
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
              <h3>{t('sftp.connection')}</h3>
            </div>
            {endpoint ? (
              <dl className="sftp-endpoint">
                <div>
                  <dt>{t('service.hostname')}</dt>
                  <dd>
                    <CopyValue
                      value={`sftp://${endpoint.hostname.includes(':') ? `[${endpoint.hostname}]` : endpoint.hostname}`}
                      label={t('sftp.copyHost')}
                    />
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
            {primary && (
              <div className="sftp-primary">
                <dl className="sftp-endpoint">
                  <div>
                    <dt>{t('service.username')}</dt>
                    <dd>
                      <CopyValue
                        value={primary.username ?? t('web.pending')}
                        label={t('sftp.copyUsername')}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>{t('web.password')}</dt>
                    <dd className="sftp-primary-password">
                      {primary.state === 'active' && canIssue ? (
                        <SftpPassword
                          key={`${primary.id}:${passwordRevision}`}
                          serverId={serverId}
                          credentialId={primary.id}
                          disabled={busy || !!action}
                        />
                      ) : (
                        <span>
                          {t(
                            primary.state === 'active'
                              ? 'sftp.passwordGenerated'
                              : primary.state === 'pending'
                                ? 'sftp.primaryPending'
                                : primary.state === 'uncertain'
                                  ? 'web.uncertain'
                                  : 'web.pending',
                          )}
                        </span>
                      )}
                      {canIssue && primary.state === 'active' && (
                        <Tooltip content={t('service.rotate')}>
                          <button
                            ref={createButton}
                            type="button"
                            className="sftp-icon"
                            aria-label={t('service.rotate')}
                            disabled={busy}
                            onClick={() => rotate(primary)}
                          >
                            <Icon name="rotate" />
                          </button>
                        </Tooltip>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
            )}
            {!primary && canIssue && !credentials.isPending && !credentials.error && (
              <p className="sftp-muted" role="status">
                {t('sftp.primaryPending')}
              </p>
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
          {!issued.password && <p>{t('sftp.retrieveAgain')}</p>}
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
                    initiallyShown={recovered}
                  />
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
      {credentials.error && (
        <ErrorNotice error={credentials.error} retry={() => void credentials.refetch()} />
      )}
      {credentials.isPending ? (
        <div
          className="sftp-skeleton"
          role="status"
          aria-busy="true"
          aria-label={t('web.loading')}
        />
      ) : (
        !credentials.error && (
          <section className="sftp-additional" aria-labelledby="sftp-additional-title">
            <header className="sftp-table-toolbar">
              <div className="sftp-table-title">
                <h3 id="sftp-additional-title">{t('sftp.additional')}</h3>
                <span className="sftp-count">
                  {activeCount} / {limit}
                </span>
              </div>
              <div className="sftp-tools">
                <Switch
                  label={t('sftp.showRevoked')}
                  checked={showRevoked}
                  onChange={setShowRevoked}
                />
                {canIssue && (
                  <IconButton
                    label={t('sftp.addAccess')}
                    icon="plus"
                    disabled={busy || activeCount >= limit}
                    onClick={() => {
                      setLabel('');
                      setAdding(true);
                    }}
                  />
                )}
              </div>
            </header>
            <div className="sftp-credentials">
              <table aria-labelledby="sftp-additional-title">
                <thead>
                  <tr>
                    <th scope="col">{t('web.name')}</th>
                    <th scope="col">{t('service.username')}</th>
                    <th scope="col">{t('web.status')}</th>
                    <th scope="col">{t('web.expires')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('web.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleAuxiliary.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="sftp-empty">
                        {t('sftp.noAdditional')}
                      </td>
                    </tr>
                  ) : (
                    visibleAuxiliary.map((c) => (
                      <tr key={c.id} data-revoked={c.state === 'revoked'}>
                        <td className="sftp-access-label">{c.label ?? t('sftp.legacyAccess')}</td>
                        <td className="sftp-access-username">
                          <CopyValue
                            value={c.username ?? t('web.pending')}
                            label={t('sftp.copyUsername')}
                          />
                        </td>
                        <td className="sftp-access-status">
                          <Badge value={c.state} />
                        </td>
                        <td className="sftp-access-expiry">
                          <Time value={c.expiresAt} />
                        </td>
                        <td className="sftp-row-actions">
                          {c.state !== 'revoked' && canIssue && (
                            <>
                              {c.state === 'active' &&
                                (!c.expiresAt || Date.parse(c.expiresAt) > Date.now()) && (
                                  <IconButton
                                    label={t('sftp.showPassword')}
                                    icon="eye"
                                    disabled={busy || passwordRequest.pending}
                                    onClick={() => void reveal(c)}
                                  />
                                )}
                              {c.state === 'active' && (
                                <IconButton
                                  label={t('service.rotate')}
                                  icon="rotate"
                                  disabled={busy}
                                  onClick={() => rotate(c)}
                                />
                              )}
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
                            </>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )
      )}
      <details className="sftp-limitation">
        <summary>{t('sftp.limitation')}</summary>
        <p>{t('service.sftpLimitation')}</p>
      </details>
      <ConfirmDialog
        open={adding}
        title={t('sftp.addAccess')}
        confirmLabel={t('sftp.addAccess')}
        onClose={() => setAdding(false)}
        onConfirm={async () => {
          await create();
          setAdding(false);
        }}
      >
        <Input
          label={t('web.name')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          maxLength={80}
          placeholder={t('sftp.accessExample')}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={!!action}
        title={t(action?.kind === 'rotate' ? 'service.rotate' : 'web.revoke')}
        confirmLabel={t(action?.kind === 'rotate' ? 'service.rotate' : 'web.revoke')}
        destructive={action?.kind === 'revoke'}
        onClose={() => setAction(undefined)}
        onConfirm={async () => {
          if (!action) return;
          passwordRequest.cancel();
          setPasswordRevision((v) => v + 1);
          setIssued(undefined);
          setRecovered(false);
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
