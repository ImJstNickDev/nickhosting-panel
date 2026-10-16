import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { api, apiError, queryClient } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import { identityChanged, useSession, useWebConfig, type WebSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  Check,
  ConfirmDialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Page,
  Section,
  Select,
  Time,
  text,
} from '../components/ui.js';
import { AccountIcon } from './account-icons.js';
import { authClient } from './auth.js';
import { ProfilePhoto } from './profile-photo.js';
import './account-profile.css';

async function refreshAccount() {
  await queryClient.invalidateQueries({ queryKey: ['session'] });
  await queryClient.invalidateQueries({ queryKey: ['account'] });
}

function useLinkedAccounts() {
  const session = useSession();
  const ordinary = session.data?.context.sessionType === 'regular';
  return useQuery({
    queryKey: ['account', 'links'],
    queryFn: () => api<Array<{ id: string; providerId: string }>>('/api/auth/list-accounts'),
    enabled: ordinary,
  });
}

function useSecuritySetup() {
  const [codes, setCodes] = useState<string[]>([]);
  const [totpURI, setTotpURI] = useState<string>();
  return { codes, setCodes, totpURI, setTotpURI };
}

export function AccountPage() {
  const t = useT();
  const session = useSession();
  const [params] = useSearchParams();
  const securitySetup = useSecuritySetup();
  if (session.isPending) return <Loading />;
  if (session.error) return <ErrorNotice error={session.error} />;
  if (session.data?.context.sessionType !== 'regular')
    return (
      <Page title={t('web.settings')}>
        <Notice>
          {t('web.support')} — {t('web.exitSupport')}
        </Notice>
      </Page>
    );
  return (
    <Page title={t('web.settings')}>
      <nav className="tabs" aria-label={t('web.settings')}>
        <NavLink to="/settings" end>
          {t('web.profile')}
        </NavLink>
        <NavLink to="/settings/security">{t('web.securityTab')}</NavLink>
      </nav>
      {params.get('error') && <ErrorNotice error={{ code: params.get('error') }} />}
      <Outlet context={securitySetup} />
    </Page>
  );
}

export function AccountProfile() {
  const t = useT();
  const session = useSession();
  const profile = session.data?.subject;
  const titleId = useId();
  if (!profile) return null;
  return (
    <div className="account-profile">
      <section className="account-profile-details" aria-labelledby={titleId}>
        <h2 id={titleId} className="visually-hidden">
          {t('web.profile')}
        </h2>
        <ProfilePhoto
          key={`photo:${profile.id}`}
          userId={profile.id}
          avatarUrl={profile.avatarUrl}
          displayName={profile.name}
          username={profile.username}
        />
        <ProfileDetails key={`details:${profile.id}`} profile={profile} />
      </section>
      <ProfileEmail key={profile.id} profile={profile} />
      <ProfileMethods />
    </div>
  );
}

function ProfileDetails({ profile }: { profile: WebSession['subject'] }) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [name, setName] = useState(profile.name);
  const [language, setLanguage] = useState(profile.locale ?? locale);
  const dirty = name !== profile.name || language !== (profile.locale ?? locale);
  return (
    <ActionForm
      className="account-details-form"
      submitDisabled={!dirty}
      onSubmit={async (data) => {
        const nextName = text(data, 'name');
        const nextLocale = text(data, 'locale') as 'en' | 'it';
        await api('/api/auth/update-user', { body: { name: nextName, locale: nextLocale } });
        setName(nextName);
        setLocale(nextLocale);
        await refreshAccount();
      }}
    >
      <Input
        label={t('web.displayName')}
        name="name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        autoComplete="name"
        required
        maxLength={100}
      />
      <Select
        label={t('web.locale')}
        name="locale"
        value={language}
        onChange={(event) => setLanguage(event.currentTarget.value as 'en' | 'it')}
      >
        <option value="en">English</option>
        <option value="it">Italiano</option>
      </Select>
    </ActionForm>
  );
}

function ProfileEmail({ profile }: { profile: WebSession['subject'] }) {
  const t = useT();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const email = profile.email.endsWith('.invalid') ? '' : profile.email;
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  function close() {
    setEditing(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  return (
    <section className="account-email-section" aria-labelledby={id}>
      <div className="account-setting-row">
        <h2 id={id}>{t('web.email')}</h2>
        <div className="account-email-value">
          <span>{email || t('web.accountNotSet')}</span>
          {email && (
            <span className={`account-email-state${profile.emailVerified ? ' verified' : ''}`}>
              {profile.emailVerified && <AccountIcon name="check" />}
              {t(profile.emailVerified ? 'web.accountEmailVerified' : 'web.accountEmailUnverified')}
            </span>
          )}
        </div>
        {email && !editing && (
          <button
            ref={trigger}
            type="button"
            className="account-quiet-action"
            aria-expanded={false}
            aria-controls={`${id}-edit`}
            onClick={() => setEditing(true)}
          >
            <AccountIcon name="edit" />
            {t('web.changeEmail')}
          </button>
        )}
      </div>
      {editing && (
        <div id={`${id}-edit`} className="account-inline-edit">
          <ActionForm
            submitLabel={t('web.changeEmail')}
            success={t('web.checkEmail')}
            onCancel={close}
            onSubmit={async (data) => {
              await api('/api/auth/change-email', {
                body: { newEmail: text(data, 'email'), callbackURL: `${location.origin}/settings` },
              });
            }}
          >
            <Input
              ref={input}
              label={t('web.email')}
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={email}
              required
            />
          </ActionForm>
        </div>
      )}
    </section>
  );
}

function ProfileMethods() {
  const t = useT();
  const config = useWebConfig();
  const accounts = useLinkedAccounts();
  const id = useId();
  const [unlink, setUnlink] = useState<{ id: string; provider: string }>();
  const [linkEmail, setLinkEmail] = useState(false);
  const linkEmailInput = useRef<HTMLInputElement>(null);
  const linkEmailTrigger = useRef<HTMLButtonElement>(null);
  const methodsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (linkEmail) linkEmailInput.current?.focus();
  }, [linkEmail]);
  const hasEmail = accounts.data?.some((account) => account.providerId === 'credential');
  const hasDiscord = accounts.data?.some((account) => account.providerId === 'discord');
  return (
    <section className="account-methods" aria-labelledby={id}>
      <h2 id={id} ref={methodsHeading} tabIndex={-1}>
        {t('web.linkedAccounts')}
      </h2>
      {accounts.isPending ? (
        <div className="account-method-loading" role="status" aria-label={t('web.loading')}>
          <span />
          <span />
        </div>
      ) : accounts.error ? (
        <ErrorNotice error={accounts.error} retry={() => void accounts.refetch()} />
      ) : (
        <div className="account-method-list">
          {accounts.data?.map((account) => {
            const provider = account.providerId === 'credential' ? t('web.email') : 'Discord';
            return (
              <div className="account-method" key={account.id}>
                <span
                  className={`account-method-icon ${account.providerId === 'discord' ? 'discord' : ''}`}
                >
                  <AccountIcon name={account.providerId === 'credential' ? 'mail' : 'discord'} />
                </span>
                <span className="account-method-name">{provider}</span>
                <span className="account-method-state">{t('web.accountConnected')}</span>
                {accounts.data.length > 1 && (
                  <Tooltip content={t('web.unlink')}>
                    <button
                      type="button"
                      className="account-icon-action account-unlink"
                      aria-label={t('web.accountUnlinkAction', { provider })}
                      onClick={() => setUnlink({ id: account.id, provider })}
                    >
                      <AccountIcon name="unlink" />
                    </button>
                  </Tooltip>
                )}
              </div>
            );
          })}
          {accounts.isSuccess && config.data?.auth.discord && !hasDiscord && (
            <div className="account-method">
              <span className="account-method-icon discord">
                <AccountIcon name="discord" />
              </span>
              <span className="account-method-name">Discord</span>
              <ActionForm
                className="account-link-action"
                submitLabel={t('web.linkDiscord')}
                success={false}
                onSubmit={async () => {
                  const result = await api<{ url: string }>('/api/auth/link-social', {
                    body: {
                      provider: 'discord',
                      callbackURL: `${location.origin}/settings`,
                      errorCallbackURL: `${location.origin}/settings`,
                    },
                  });
                  location.assign(result.url);
                }}
              >
                <span className="visually-hidden">Discord</span>
              </ActionForm>
            </div>
          )}
          {accounts.isSuccess && !hasEmail && (
            <>
              <div className="account-method">
                <span className="account-method-icon">
                  <AccountIcon name="mail" />
                </span>
                <span className="account-method-name">{t('web.email')}</span>
                {!linkEmail && (
                  <button
                    ref={linkEmailTrigger}
                    type="button"
                    className="account-quiet-action"
                    onClick={() => setLinkEmail(true)}
                  >
                    {t('web.linkEmail')}
                  </button>
                )}
              </div>
              {linkEmail && (
                <div className="account-inline-edit">
                  <ActionForm
                    submitLabel={t('web.linkEmail')}
                    success={t('web.linkEmailSent')}
                    onCancel={() => {
                      setLinkEmail(false);
                      requestAnimationFrame(() => linkEmailTrigger.current?.focus());
                    }}
                    onSubmit={async (data) => {
                      await api('/v1/identity/link-email', {
                        body: {
                          email: text(data, 'email'),
                          password: String(data.get('password')),
                        },
                      });
                    }}
                  >
                    <Input
                      ref={linkEmailInput}
                      label={t('web.email')}
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                    />
                    <Input
                      label={t('web.newPassword')}
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={128}
                      required
                    />
                  </ActionForm>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {config.error && <ErrorNotice error={config.error} retry={() => void config.refetch()} />}
      <ConfirmDialog
        open={Boolean(unlink)}
        title={t('web.accountUnlinkTitle', { provider: unlink?.provider ?? '' })}
        onClose={() => setUnlink(undefined)}
        confirmLabel={t('web.unlink')}
        destructive
        onConfirm={async () => {
          if (!unlink) return;
          await api('/api/auth/unlink-account', { body: { accountId: unlink.id } });
          await refreshAccount();
          setUnlink(undefined);
          requestAnimationFrame(() => methodsHeading.current?.focus());
        }}
      >
        <p>{t('web.accountUnlinkHint', { provider: unlink?.provider ?? '' })}</p>
      </ConfirmDialog>
    </section>
  );
}

export function AccountSecurity() {
  const t = useT();
  const session = useSession();
  const navigate = useNavigate();
  const { codes, setCodes, totpURI, setTotpURI } =
    useOutletContext<ReturnType<typeof useSecuritySetup>>();
  const [passkeyError, setPasskeyError] = useState<unknown>();
  const ordinary = session.data?.context.sessionType === 'regular';
  const accounts = useLinkedAccounts();
  const sessions = useQuery({
    queryKey: ['account', 'sessions'],
    queryFn: () =>
      api<
        Array<{
          id: string;
          token: string;
          createdAt: string;
          expiresAt: string;
          userAgent?: string;
          ipAddress?: string;
        }>
      >('/api/auth/list-sessions'),
    enabled: ordinary,
  });
  const passkeys = useQuery({
    queryKey: ['account', 'passkeys'],
    queryFn: () =>
      api<Array<{ id: string; name?: string; createdAt: string }>>(
        '/api/auth/passkey/list-user-passkeys',
      ),
    enabled: ordinary,
  });
  const hasPassword =
    accounts.data?.some((account) => account.providerId === 'credential') === true;
  const passwordBody = (data: FormData) =>
    hasPassword ? { password: String(data.get('password')) } : {};
  const profile = session.data?.subject;
  return (
    <>
      <div className="columns">
        <div>
          {hasPassword && (
            <Section title={t('web.changePassword')}>
              <ActionForm
                onSubmit={async (data) => {
                  await api('/api/auth/change-password', {
                    body: {
                      currentPassword: String(data.get('currentPassword')),
                      newPassword: String(data.get('newPassword')),
                      revokeOtherSessions: true,
                    },
                  });
                  await refreshAccount();
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
              </ActionForm>
            </Section>
          )}
          <Section title={t('web.passkeys')}>
            {Boolean(passkeyError) && <ErrorNotice error={passkeyError} />}
            {passkeys.error && <ErrorNotice error={passkeys.error} />}
            {passkeys.data?.map((passkey) => (
              <div className="stack" key={passkey.id}>
                <ActionForm
                  onSubmit={async (data) => {
                    await api('/api/auth/passkey/update-passkey', {
                      body: { id: passkey.id, name: text(data, 'name') },
                    });
                    await refreshAccount();
                  }}
                >
                  <Input
                    label={t('web.name')}
                    name="name"
                    defaultValue={passkey.name ?? ''}
                    required
                    maxLength={100}
                  />
                </ActionForm>
                <ActionForm
                  submitLabel={t('web.remove')}
                  onSubmit={async () => {
                    await api('/api/auth/passkey/delete-passkey', { body: { id: passkey.id } });
                    await refreshAccount();
                  }}
                >
                  <Check label={t('web.confirm')} required />
                </ActionForm>
                <hr />
              </div>
            ))}
            <ActionForm
              submitLabel={t('web.addPasskey')}
              onSubmit={async (data) => {
                setPasskeyError(undefined);
                const result = await authClient.passkey.addPasskey({ name: text(data, 'name') });
                if (result.error) throw apiError(result.error);
                await refreshAccount();
              }}
            >
              <Input label={t('web.name')} name="name" required maxLength={100} />
            </ActionForm>
          </Section>
        </div>
        <div>
          <Section title={t('web.twoFactor')}>
            {accounts.isPending && <Loading />}
            {accounts.error && <ErrorNotice error={accounts.error} />}
            <fieldset disabled={accounts.isPending || Boolean(accounts.error)}>
              {!profile?.twoFactorEnabled && !totpURI && (
                <ActionForm
                  submitLabel={t('web.enable')}
                  success={false}
                  onSubmit={async (data) => {
                    const result = await api<{ totpURI: string; backupCodes: string[] }>(
                      '/api/auth/two-factor/enable',
                      { body: passwordBody(data) },
                    );
                    setTotpURI(result.totpURI);
                    setCodes(result.backupCodes);
                  }}
                >
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
              )}
              {totpURI && (
                <>
                  <p>{t('web.authenticatorHelp')}</p>
                  <Input
                    label={t('web.authenticatorKey')}
                    value={new URL(totpURI).searchParams.get('secret') ?? ''}
                    readOnly
                    autoComplete="off"
                  />
                  <ActionForm
                    submitLabel={t('web.verify')}
                    onSubmit={async (data) => {
                      await api('/api/auth/two-factor/verify-totp', {
                        body: { code: text(data, 'code') },
                      });
                      setTotpURI(undefined);
                      await refreshAccount();
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
                </>
              )}
              {profile?.twoFactorEnabled && (
                <>
                  <Notice>{t('web.enabled')}</Notice>
                  <ActionForm
                    submitLabel={t('web.newRecoveryCodes')}
                    success={false}
                    onSubmit={async (data) => {
                      const result = await api<{ backupCodes: string[] }>(
                        '/api/auth/two-factor/generate-backup-codes',
                        { body: passwordBody(data) },
                      );
                      setCodes(result.backupCodes);
                    }}
                  >
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
                  <hr />
                  <ActionForm
                    submitLabel={t('web.disable')}
                    onSubmit={async (data) => {
                      await api('/api/auth/two-factor/disable', { body: passwordBody(data) });
                      setCodes([]);
                      await refreshAccount();
                    }}
                  >
                    {hasPassword && (
                      <Input
                        label={t('web.currentPassword')}
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                      />
                    )}
                    <Check name="confirm" label={t('web.confirm')} required />
                  </ActionForm>
                </>
              )}
              {codes.length > 0 && (
                <div className="notice">
                  <h3>{t('web.recoveryCodes')}</h3>
                  <p>{t('web.recoveryWarning')}</p>
                  <ul>
                    {codes.map((code) => (
                      <li key={code}>
                        <code>{code}</code>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="secondary" onClick={() => setCodes([])}>
                    {t('web.close')}
                  </button>
                </div>
              )}
            </fieldset>
          </Section>
        </div>
      </div>
      <Section title={t('web.sessions')}>
        {sessions.isPending ? (
          <Loading />
        ) : sessions.error ? (
          <ErrorNotice error={sessions.error} />
        ) : !sessions.data?.length ? (
          <Empty />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('web.created')}</th>
                  <th>{t('web.expires')}</th>
                  <th>{t('web.details')}</th>
                  <th>{t('web.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <Time value={session.createdAt} />
                    </td>
                    <td>
                      <Time value={session.expiresAt} />
                    </td>
                    <td>
                      <details>
                        <summary>{t('web.browserSession')}</summary>
                        <p className="session-agent">{session.userAgent ?? t('web.unknown')}</p>
                      </details>
                    </td>
                    <td>
                      <ActionForm
                        submitLabel={t('web.revoke')}
                        success={false}
                        onSubmit={async () => {
                          await api('/api/auth/revoke-session', { body: { token: session.token } });
                          await refreshAccount();
                        }}
                      >
                        <span />
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <hr />
        <ActionForm
          submitLabel={t('web.revokeOthers')}
          onSubmit={async () => {
            await api('/api/auth/revoke-other-sessions', { body: {} });
            await refreshAccount();
          }}
        >
          <span />
        </ActionForm>
      </Section>
      <ActionForm
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
    </>
  );
}
