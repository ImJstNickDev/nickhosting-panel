import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router';
import { api, apiError } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { identityChanged, useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  ConfirmDialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Time,
  text,
} from '../components/ui.js';
import { AccountIcon as SecurityIcon } from './account-icons.js';
import { refreshAccount, useLinkedAccounts, type useSecuritySetup } from './account-shared.js';
import { authClient } from './auth.js';
import './account-security.css';

type Passkey = { id: string; name?: string; createdAt: string };
type BrowserSession = {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  userAgent?: string;
  ipAddress?: string;
};

/** Only recognized values from the actual session UA; never infer a device from screen size. */
function browserLabel(agent: string | undefined) {
  if (!agent) return undefined;
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /(?:Firefox|FxiOS)\//.test(agent)
      ? 'Firefox'
      : /(?:Chrome|CriOS)\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : undefined;
  const system = /Android/.test(agent)
    ? 'Android'
    : /(?:iPhone|iPad)/.test(agent)
      ? 'iOS'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Macintosh/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : undefined;
  return browser ? [browser, system].filter(Boolean).join(' · ') : undefined;
}

function SecuritySection({
  title,
  icon,
  status,
  actions,
  children,
}: {
  title: string;
  icon: Parameters<typeof SecurityIcon>[0]['name'];
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="account-security-section" aria-labelledby={id}>
      <div className="account-security-heading">
        <span className="account-security-symbol">
          <SecurityIcon name={icon} />
        </span>
        <div className="account-security-heading-text">
          <h2 id={id}>{title}</h2>
          {status}
        </div>
        {actions && <div className="account-security-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function SecurityDrawer({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input:not([readonly])')?.focus();
  }, []);
  return (
    <div ref={ref} className="account-security-drawer">
      {children}
    </div>
  );
}

function PasswordSettings() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <SecuritySection
      title={t('web.password')}
      icon="lock"
      status={
        saved && (
          <span role="status" className="account-security-state">
            {t('web.saved')}
          </span>
        )
      }
      actions={
        !open && (
          <button
            type="button"
            className="account-security-action"
            ref={trigger}
            onClick={() => {
              setSaved(false);
              setOpen(true);
            }}
          >
            <SecurityIcon name="edit" />
            {t('web.changePassword')}
          </button>
        )
      }
    >
      {open && (
        <SecurityDrawer>
          <ActionForm
            submitLabel={t('web.changePassword')}
            success={false}
            onCancel={close}
            onSubmit={async (data) => {
              await api('/api/auth/change-password', {
                body: {
                  currentPassword: String(data.get('currentPassword')),
                  newPassword: String(data.get('newPassword')),
                  revokeOtherSessions: true,
                },
              });
              await refreshAccount();
              setSaved(true);
              close();
            }}
          >
            <Input
              label={t('web.currentPassword')}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
            <Input
              label={t('web.newPassword')}
              hint={t('web.passwordHint')}
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
            <p className="account-security-hint">{t('accountSecurity.passwordSessions')}</p>
          </ActionForm>
        </SecurityDrawer>
      )}
    </SecuritySection>
  );
}

function PasskeySettings() {
  const t = useT();
  const passkeys = useQuery({
    queryKey: ['account', 'passkeys'],
    queryFn: () => api<Passkey[]>('/api/auth/passkey/list-user-passkeys'),
  });
  const [editing, setEditing] = useState<string>();
  const [removing, setRemoving] = useState<Passkey>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const renameTriggers = useRef(new Map<string, HTMLButtonElement>());
  const mutate = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await operation();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setEditing(undefined);
    requestAnimationFrame(() =>
      (editing
        ? (renameTriggers.current.get(editing) ?? trigger.current)
        : trigger.current
      )?.focus(),
    );
  };
  const cancel = () => {
    if (!pending.current) close();
  };
  return (
    <SecuritySection
      title={t('web.passkeys')}
      icon="key"
      actions={
        editing !== 'new' && (
          <button
            ref={trigger}
            type="button"
            className="account-security-action"
            disabled={busy || passkeys.isPending || Boolean(passkeys.error)}
            onClick={() => {
              if (!pending.current) setEditing('new');
            }}
          >
            <SecurityIcon name="add" />
            {t('web.addPasskey')}
          </button>
        )
      }
    >
      {passkeys.isPending ? (
        <Loading />
      ) : passkeys.error ? (
        <ErrorNotice error={passkeys.error} retry={() => void passkeys.refetch()} />
      ) : (
        <>
          {!passkeys.data?.length && editing !== 'new' && (
            <p className="account-security-empty">{t('accountSecurity.noPasskeys')}</p>
          )}
          {passkeys.data?.map((passkey) => {
            const name = passkey.name || t('accountSecurity.passkeyFallback');
            return (
              <div key={passkey.id} className="account-passkey">
                {editing === passkey.id ? (
                  <SecurityDrawer>
                    <ActionForm
                      onCancel={cancel}
                      success={false}
                      onSubmit={(data) =>
                        mutate(async () => {
                          await api('/api/auth/passkey/update-passkey', {
                            body: { id: passkey.id, name: text(data, 'name') },
                          });
                          await refreshAccount();
                          close();
                        })
                      }
                    >
                      <Input
                        label={t('web.name')}
                        name="name"
                        defaultValue={name}
                        required
                        maxLength={100}
                      />
                    </ActionForm>
                  </SecurityDrawer>
                ) : (
                  <div className="account-security-item">
                    <span className="account-security-item-icon">
                      <SecurityIcon name="key" />
                    </span>
                    <div className="account-security-item-label">
                      <strong>{name}</strong>
                      <small>
                        <Time value={passkey.createdAt} />
                      </small>
                    </div>
                    <div className="account-security-actions">
                      <Tooltip content={t('accountSecurity.renamePasskey', { name })}>
                        <button
                          type="button"
                          className="account-security-icon"
                          aria-label={t('accountSecurity.renamePasskey', { name })}
                          ref={(element) => {
                            if (element) renameTriggers.current.set(passkey.id, element);
                            else renameTriggers.current.delete(passkey.id);
                          }}
                          disabled={busy}
                          onClick={() => {
                            if (!pending.current) setEditing(passkey.id);
                          }}
                        >
                          <SecurityIcon name="edit" />
                        </button>
                      </Tooltip>
                      <Tooltip content={t('accountSecurity.removePasskey', { name })}>
                        <button
                          type="button"
                          className="account-security-icon account-security-destructive"
                          aria-label={t('accountSecurity.removePasskey', { name })}
                          disabled={busy}
                          onClick={() => {
                            if (!pending.current) setRemoving(passkey);
                          }}
                        >
                          <SecurityIcon name="remove" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
      {editing === 'new' && (
        <SecurityDrawer>
          <ActionForm
            submitLabel={t('web.addPasskey')}
            success={false}
            onCancel={cancel}
            onSubmit={(data) =>
              mutate(async () => {
                const result = await authClient.passkey.addPasskey({ name: text(data, 'name') });
                if (result.error) throw apiError(result.error);
                await refreshAccount();
                close();
              })
            }
          >
            <Input label={t('web.name')} name="name" required maxLength={100} />
          </ActionForm>
        </SecurityDrawer>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title={t('accountSecurity.removePasskeyTitle')}
        confirmLabel={t('web.remove')}
        destructive
        busy={busy}
        onClose={() => {
          if (!pending.current) setRemoving(undefined);
        }}
        onConfirm={() =>
          mutate(async () => {
            if (!removing) return;
            await api('/api/auth/passkey/delete-passkey', { body: { id: removing.id } });
            await refreshAccount();
            setRemoving(undefined);
            requestAnimationFrame(() => trigger.current?.focus());
          })
        }
      >
        <p>
          {t('accountSecurity.removePasskeyHint', {
            name: removing?.name || t('accountSecurity.passkeyFallback'),
          })}
        </p>
      </ConfirmDialog>
    </SecuritySection>
  );
}

function TwoFactorSettings({
  hasPassword,
  unavailable,
}: {
  hasPassword: boolean;
  unavailable: boolean;
}) {
  const t = useT();
  const profile = useSession().data?.subject;
  const { codes, setCodes, totpURI, setTotpURI } =
    useOutletContext<ReturnType<typeof useSecuritySetup>>();
  const [action, setAction] = useState<'enable' | 'disable' | 'codes'>();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<unknown>();
  const heading = useRef<HTMLDivElement>(null);
  const close = () => {
    setAction(undefined);
    requestAnimationFrame(() =>
      heading.current?.querySelector<HTMLButtonElement>('button')?.focus(),
    );
  };
  const passwordBody = (data: FormData) =>
    hasPassword ? { password: String(data.get('password')) } : {};
  return (
    <div ref={heading}>
      <SecuritySection
        title={t('web.twoFactor')}
        icon="shield"
        status={
          <span className={`account-security-state${profile?.twoFactorEnabled ? ' enabled' : ''}`}>
            {profile?.twoFactorEnabled ? t('web.enabled') : t('web.disabled')}
          </span>
        }
        actions={
          !totpURI &&
          !action &&
          (profile?.twoFactorEnabled ? (
            <>
              <button
                type="button"
                className="account-security-action"
                disabled={unavailable}
                onClick={() => setAction('codes')}
              >
                {t('web.recoveryCodes')}
              </button>
              <Tooltip content={t('accountSecurity.disableTotp')}>
                <button
                  type="button"
                  className="account-security-icon account-security-destructive"
                  aria-label={t('accountSecurity.disableTotp')}
                  disabled={unavailable}
                  onClick={() => setAction('disable')}
                >
                  <SecurityIcon name="remove" />
                </button>
              </Tooltip>
            </>
          ) : (
            <button
              type="button"
              className="account-security-action"
              disabled={unavailable}
              onClick={() => setAction('enable')}
            >
              {t('web.enable')}
            </button>
          ))
        }
      >
        {action && (
          <SecurityDrawer>
            <ActionForm
              key={action}
              success={false}
              disabled={unavailable}
              destructive={action === 'disable'}
              submitLabel={t(
                action === 'enable'
                  ? 'web.enable'
                  : action === 'disable'
                    ? 'web.disable'
                    : 'web.newRecoveryCodes',
              )}
              onCancel={close}
              onSubmit={async (data) => {
                if (action === 'enable') {
                  const result = await api<{ totpURI: string; backupCodes: string[] }>(
                    '/api/auth/two-factor/enable',
                    { body: passwordBody(data) },
                  );
                  setTotpURI(result.totpURI);
                  setCodes(result.backupCodes);
                  setAction(undefined);
                } else if (action === 'disable') {
                  await api('/api/auth/two-factor/disable', { body: passwordBody(data) });
                  setCodes([]);
                  await refreshAccount();
                  close();
                } else {
                  const result = await api<{ backupCodes: string[] }>(
                    '/api/auth/two-factor/generate-backup-codes',
                    { body: passwordBody(data) },
                  );
                  setCodes(result.backupCodes);
                  close();
                }
                setCopied(false);
                setCopyError(undefined);
              }}
            >
              {action !== 'enable' && (
                <p className="account-security-hint">
                  {t(
                    action === 'disable'
                      ? 'accountSecurity.disableTotpHint'
                      : 'accountSecurity.replaceCodesHint',
                  )}
                </p>
              )}
              {hasPassword && (
                <Input
                  label={t('web.currentPassword')}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              )}
            </ActionForm>
          </SecurityDrawer>
        )}
        {totpURI && (
          <SecurityDrawer>
            <p className="account-security-hint">{t('web.authenticatorHelp')}</p>
            <Input
              label={t('web.authenticatorKey')}
              value={new URL(totpURI).searchParams.get('secret') ?? ''}
              readOnly
              autoComplete="off"
            />
            <ActionForm
              submitLabel={t('web.verify')}
              success={false}
              disabled={unavailable}
              onSubmit={async (data) => {
                await api('/api/auth/two-factor/verify-totp', {
                  body: { code: text(data, 'code') },
                });
                setTotpURI(undefined);
                await refreshAccount();
                requestAnimationFrame(() =>
                  heading.current?.querySelector<HTMLButtonElement>('button')?.focus(),
                );
              }}
            >
              <Input
                label={t('web.code')}
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                required
              />
            </ActionForm>
          </SecurityDrawer>
        )}
        {codes.length > 0 && (
          <div className="account-recovery-codes">
            <div className="account-recovery-heading">
              <h3>{t('web.recoveryCodes')}</h3>
              <Tooltip content={copied ? t('web.copied') : t('accountSecurity.copyCodes')}>
                <button
                  type="button"
                  className="account-security-icon"
                  aria-label={t('accountSecurity.copyCodes')}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(codes.join('\n'));
                      setCopied(true);
                      setCopyError(undefined);
                    } catch (error) {
                      setCopyError(error);
                    }
                  }}
                >
                  <SecurityIcon name={copied ? 'check' : 'copy'} />
                </button>
              </Tooltip>
            </div>
            <p className="account-security-hint">{t('web.recoveryWarning')}</p>
            <ul>
              {codes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
            {Boolean(copyError) && <ErrorNotice error={copyError} />}
            <span className="visually-hidden" role="status">
              {copied ? t('web.copied') : ''}
            </span>
            <button
              type="button"
              className="account-security-action"
              onClick={() => {
                setCodes([]);
                setCopied(false);
                requestAnimationFrame(() =>
                  heading.current?.querySelector<HTMLButtonElement>('button')?.focus(),
                );
              }}
            >
              {t('web.close')}
            </button>
          </div>
        )}
      </SecuritySection>
    </div>
  );
}

function SessionSettings() {
  const t = useT();
  const sessions = useQuery({
    queryKey: ['account', 'sessions'],
    queryFn: () => api<BrowserSession[]>('/api/auth/list-sessions'),
  });
  const [revoking, setRevoking] = useState<BrowserSession | 'others'>();
  const heading = useRef<HTMLDivElement>(null);
  return (
    <div ref={heading}>
      <SecuritySection
        title={t('web.sessions')}
        icon="screen"
        actions={
          <button
            type="button"
            className="account-security-action"
            disabled={
              sessions.isPending || Boolean(sessions.error) || (sessions.data?.length ?? 0) <= 1
            }
            onClick={() => setRevoking('others')}
          >
            {t('web.revokeOthers')}
          </button>
        }
      >
        {sessions.isPending ? (
          <Loading />
        ) : sessions.error ? (
          <ErrorNotice error={sessions.error} retry={() => void sessions.refetch()} />
        ) : !sessions.data?.length ? (
          <Empty />
        ) : (
          sessions.data.map((session) => (
            <div className="account-security-item account-session" key={session.id}>
              <span className="account-security-item-icon">
                <SecurityIcon name="screen" />
              </span>
              <div className="account-security-item-label">
                <strong>{browserLabel(session.userAgent) ?? t('web.browserSession')}</strong>
                <small>
                  {t('accountSecurity.sessionDates')} <Time value={session.createdAt} />
                </small>
                <details>
                  <summary>{t('accountSecurity.sessionDetails')}</summary>
                  <div>
                    <span className="session-agent">{session.userAgent ?? t('web.unknown')}</span>
                    <small>
                      {t('web.expires')} <Time value={session.expiresAt} />
                    </small>
                  </div>
                </details>
              </div>
              <Tooltip content={t('web.revoke')}>
                <button
                  type="button"
                  className="account-security-icon account-security-destructive"
                  aria-label={t('web.revoke')}
                  onClick={() => setRevoking(session)}
                >
                  <SecurityIcon name="exit" />
                </button>
              </Tooltip>
            </div>
          ))
        )}
        <ConfirmDialog
          open={Boolean(revoking)}
          title={t(
            revoking === 'others'
              ? 'accountSecurity.revokeOthersTitle'
              : 'accountSecurity.revokeSessionTitle',
          )}
          confirmLabel={t(revoking === 'others' ? 'web.revokeOthers' : 'web.revoke')}
          destructive
          onClose={() => setRevoking(undefined)}
          onConfirm={async () => {
            if (!revoking) return;
            await api(
              revoking === 'others'
                ? '/api/auth/revoke-other-sessions'
                : '/api/auth/revoke-session',
              { body: revoking === 'others' ? {} : { token: revoking.token } },
            );
            await refreshAccount();
            setRevoking(undefined);
            requestAnimationFrame(() =>
              heading.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),
            );
          }}
        >
          <p>
            {t(
              revoking === 'others'
                ? 'accountSecurity.revokeOthersHint'
                : 'accountSecurity.revokeSessionHint',
            )}
          </p>
        </ConfirmDialog>
      </SecuritySection>
    </div>
  );
}

export function AccountSecurity() {
  const t = useT();
  const navigate = useNavigate();
  const accounts = useLinkedAccounts();
  const hasPassword =
    accounts.data?.some((account) => account.providerId === 'credential') === true;
  return (
    <div className="account-security">
      {accounts.isPending ? (
        <Loading />
      ) : accounts.error ? (
        <ErrorNotice error={accounts.error} retry={() => void accounts.refetch()} />
      ) : (
        hasPassword && <PasswordSettings />
      )}
      <TwoFactorSettings
        hasPassword={hasPassword}
        unavailable={accounts.isPending || Boolean(accounts.error)}
      />
      <PasskeySettings />
      <SessionSettings />
      <ActionForm
        className="account-security-signout"
        submitLabel={t('web.signOut')}
        success={false}
        onSubmit={async () => {
          await api('/api/auth/sign-out', { body: {} });
          await identityChanged();
          navigate('/login');
        }}
      >
        <span />
      </ActionForm>
    </div>
  );
}
