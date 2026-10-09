import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, apiError, queryClient } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import { identityChanged, useSession, useWebConfig } from '../app/session.js';
import {
  ActionForm,
  Check,
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
import { authClient } from './auth.js';

export function AccountPage() {
  const t = useT();
  const session = useSession();
  const config = useWebConfig();
  const { locale, setLocale } = useLocale();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [codes, setCodes] = useState<string[]>([]);
  const [totpURI, setTotpURI] = useState<string>();
  const [passkeyError, setPasskeyError] = useState<unknown>();
  const ordinary = session.data?.context.sessionType === 'regular';
  const accounts = useQuery({
    queryKey: ['account', 'links'],
    queryFn: () => api<Array<{ id: string; providerId: string }>>('/api/auth/list-accounts'),
    enabled: ordinary,
  });
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
  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['session'] });
    await queryClient.invalidateQueries({ queryKey: ['account'] });
  }
  if (session.isPending) return <Loading />;
  if (session.error) return <ErrorNotice error={session.error} />;
  if (!ordinary)
    return (
      <Page title={t('web.settings')}>
        <Notice>
          {t('web.support')} — {t('web.exitSupport')}
        </Notice>
      </Page>
    );
  const profile = session.data?.subject;
  return (
    <Page title={t('web.settings')}>
      {params.get('error') && <ErrorNotice error={{ code: params.get('error') }} />}
      <div className="columns">
        <div>
          <Section title={t('web.profile')}>
            <ActionForm
              onSubmit={async (data) => {
                const nextLocale = text(data, 'locale') as 'en' | 'it';
                await api('/api/auth/update-user', {
                  body: { name: text(data, 'name'), locale: nextLocale },
                });
                setLocale(nextLocale);
                await refresh();
              }}
            >
              <Input
                label={t('web.name')}
                name="name"
                defaultValue={profile?.name}
                required
                maxLength={100}
              />
              <Select
                label={t('web.locale')}
                name="locale"
                defaultValue={profile?.locale ?? locale}
              >
                <option value="en">English</option>
                <option value="it">Italiano</option>
              </Select>
            </ActionForm>
            <hr />
            <ActionForm
              submitLabel={t('web.changeEmail')}
              success={t('web.checkEmail')}
              onSubmit={async (data) => {
                await api('/api/auth/change-email', {
                  body: {
                    newEmail: text(data, 'email'),
                    callbackURL: `${location.origin}/settings`,
                  },
                });
              }}
            >
              <Input
                label={t('web.email')}
                name="email"
                type="email"
                autoComplete="email"
                defaultValue={profile?.email.endsWith('.invalid') ? '' : profile?.email}
                required
              />
            </ActionForm>
          </Section>
          <Section title={t('web.linkedAccounts')}>
            {accounts.isPending ? (
              <Loading />
            ) : accounts.error ? (
              <ErrorNotice error={accounts.error} />
            ) : (
              <div className="stack">
                {accounts.data?.map((account) => (
                  <div className="section-heading" key={account.id}>
                    <span>{account.providerId === 'credential' ? t('web.email') : 'Discord'}</span>
                    {accounts.data.length > 1 && (
                      <ActionForm
                        submitLabel={t('web.unlink')}
                        onSubmit={async () => {
                          await api('/api/auth/unlink-account', {
                            body: { accountId: account.id },
                          });
                          await refresh();
                        }}
                      >
                        <Check name="confirm" required label={t('web.confirm')} />
                      </ActionForm>
                    )}
                  </div>
                ))}
              </div>
            )}
            {config.data?.auth.discord &&
              !accounts.data?.some((a) => a.providerId === 'discord') && (
                <ActionForm
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
                  <span />
                </ActionForm>
              )}
            {!accounts.data?.some((a) => a.providerId === 'credential') && (
              <ActionForm
                submitLabel={t('web.linkEmail')}
                success={t('web.linkEmailSent')}
                onSubmit={async (data) => {
                  await api('/v1/identity/link-email', {
                    body: { email: text(data, 'email'), password: String(data.get('password')) },
                  });
                }}
              >
                <Input
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
            )}
          </Section>
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
                  await refresh();
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
                      await refresh();
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
                      await refresh();
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
                    await refresh();
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
                    await refresh();
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
                await refresh();
              }}
            >
              <Input label={t('web.name')} name="name" required maxLength={100} />
            </ActionForm>
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
                          await refresh();
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
            await refresh();
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
    </Page>
  );
}
