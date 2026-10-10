import { passkeyClient } from '@better-auth/passkey/client';
import { useQuery } from '@tanstack/react-query';
import { createAuthClient } from 'better-auth/react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, apiError, queryClient } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import { identityChanged, useSession, useWebConfig } from '../app/session.js';
import {
  ActionForm,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Section,
  text,
} from '../components/ui.js';

export const authClient = createAuthClient({ plugins: [passkeyClient()] });

export function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const config = useWebConfig();
  const [exitError, setExitError] = useState<unknown>();
  return (
    <main className="auth-shell">
      <Link to="/" className="brand">
        <span className="brand-mark">NickHosting</span>
      </Link>
      {config.data?.supportSessionPresent && (
        <Notice>
          <p>{t('web.supportExpired')}</p>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              try {
                await api('/v1/web/support/exit', { body: {} });
                await identityChanged();
              } catch (error) {
                setExitError(error);
              }
            }}
          >
            {t('web.exitSupport')}
          </button>
        </Notice>
      )}
      {Boolean(exitError) && <ErrorNotice error={exitError} />}
      <Section>{children}</Section>
      <label className="field">
        {t('web.locale')}
        <select value={locale} onChange={(event) => setLocale(event.target.value as 'en' | 'it')}>
          <option value="en">English</option>
          <option value="it">Italiano</option>
        </select>
      </label>
    </main>
  );
}
export function Login() {
  const t = useT();
  const config = useWebConfig();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [challenge, setChallenge] = useState(params.has('two-factor'));
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<unknown>();
  async function completed() {
    await identityChanged();
    navigate('/');
  }
  return (
    <AuthLayout>
      <h1>{t(challenge ? 'web.twoFactor' : 'web.signIn')}</h1>
      {params.get('error') && <ErrorNotice error={{ code: params.get('error') }} />}
      {Boolean(error) && <ErrorNotice error={error} />}
      {challenge ? (
        <ActionForm
          submitLabel={t('web.verify')}
          success={false}
          onSubmit={async (data) => {
            await api(`/api/auth/two-factor/${recovery ? 'verify-backup-code' : 'verify-totp'}`, {
              body: { code: text(data, 'code') },
            });
            await completed();
          }}
        >
          <Input
            label={t(recovery ? 'web.recoveryCode' : 'web.code')}
            name="code"
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            required
          />
          <button type="button" className="secondary" onClick={() => setRecovery(!recovery)}>
            {t(recovery ? 'web.code' : 'web.useRecovery')}
          </button>
        </ActionForm>
      ) : (
        <>
          <ActionForm
            submitLabel={t('web.signIn')}
            success={false}
            onSubmit={async (data) => {
              const result = await api<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', {
                body: { email: text(data, 'email'), password: String(data.get('password')) },
              });
              if (result.twoFactorRedirect) setChallenge(true);
              else await completed();
            }}
          >
            <Input
              label={t('web.email')}
              name="email"
              type="email"
              autoComplete="username"
              required
            />
            <Input
              label={t('web.password')}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <Link to="/recover">{t('web.forgot')}</Link>
          </ActionForm>
          <hr />
          <div className="stack">
            {config.data?.auth.discord && (
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  try {
                    const result = await api<{ url: string }>('/api/auth/sign-in/social', {
                      body: {
                        provider: 'discord',
                        callbackURL: `${location.origin}/auth/callback`,
                        errorCallbackURL: `${location.origin}/login`,
                      },
                    });
                    location.assign(result.url);
                  } catch (failure) {
                    setError(failure);
                  }
                }}
              >
                {t('web.discord')}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  const result = await authClient.signIn.passkey();
                  if (result.error) throw apiError(result.error);
                  await completed();
                } catch (failure) {
                  setError(failure);
                }
              }}
            >
              {t('web.passkeySignIn')}
            </button>
            <Link to="/verify">{t('web.resend')}</Link>
          </div>
        </>
      )}
    </AuthLayout>
  );
}
export function Invite() {
  const { token = '' } = useParams();
  const t = useT();
  const config = useWebConfig();
  const { locale } = useLocale();
  const [registered, setRegistered] = useState(false);
  const [error, setError] = useState<unknown>();
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api(`/v1/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
  return (
    <AuthLayout>
      <h1>{t('web.register')}</h1>
      {invite.isPending ? (
        <Loading />
      ) : invite.error ? (
        <ErrorNotice error={invite.error} />
      ) : registered ? (
        <Notice>
          {t('web.checkEmail')} <Link to="/login">{t('web.signIn')}</Link>
        </Notice>
      ) : (
        <>
          {Boolean(error) && <ErrorNotice error={error} />}
          <ActionForm
            submitLabel={t('web.register')}
            success={false}
            onSubmit={async (data) => {
              await api('/api/auth/sign-up/email', {
                body: {
                  name: text(data, 'name'),
                  email: text(data, 'email'),
                  password: String(data.get('password')),
                  locale: locale === 'it' ? 'it' : 'en',
                  callbackURL: `${location.origin}/login`,
                },
                headers: { 'X-Invitation-Token': token },
              });
              setRegistered(true);
            }}
          >
            <Input label={t('web.name')} name="name" autoComplete="name" required maxLength={100} />
            <Input label={t('web.email')} name="email" type="email" autoComplete="email" required />
            <Input
              label={t('web.password')}
              hint={t('web.passwordHint')}
              name="password"
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </ActionForm>
          {config.data?.auth.discord && (
            <>
              <hr />
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  try {
                    const result = await api<{ url: string }>('/api/auth/sign-in/social', {
                      body: {
                        provider: 'discord',
                        callbackURL: `${location.origin}/auth/callback`,
                        errorCallbackURL: `${location.origin}/login`,
                      },
                      headers: { 'X-Invitation-Token': token },
                    });
                    location.assign(result.url);
                  } catch (failure) {
                    setError(failure);
                  }
                }}
              >
                {t('web.discord')}
              </button>
            </>
          )}
        </>
      )}
    </AuthLayout>
  );
}
export function Recovery({ mode }: { mode: 'reset' | 'request' | 'verify' | 'link' }) {
  const t = useT();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [done, setDone] = useState(false);
  const title =
    mode === 'request'
      ? 'web.reset'
      : mode === 'verify'
        ? 'web.verifyEmail'
        : mode === 'link'
          ? 'web.linkEmail'
          : 'web.reset';
  return (
    <AuthLayout>
      <h1>{t(title)}</h1>
      {done ? (
        <Notice>
          {t(
            mode === 'request'
              ? 'web.resetSent'
              : mode === 'verify'
                ? 'web.checkEmail'
                : 'web.saved',
          )}{' '}
          <Link to="/login">{t('web.signIn')}</Link>
        </Notice>
      ) : (
        <ActionForm
          submitLabel={t(
            mode === 'request'
              ? 'web.sendReset'
              : mode === 'verify'
                ? 'web.resend'
                : mode === 'link'
                  ? 'web.confirm'
                  : 'web.reset',
          )}
          success={false}
          onSubmit={async (data) => {
            if (mode === 'request')
              await api('/api/auth/request-password-reset', {
                body: {
                  email: text(data, 'email'),
                  redirectTo: `${location.origin}/reset-password`,
                },
              });
            if (mode === 'verify')
              await api('/api/auth/send-verification-email', {
                body: { email: text(data, 'email'), callbackURL: `${location.origin}/login` },
              });
            if (mode === 'reset')
              await api('/api/auth/reset-password', {
                body: { token: params.get('token'), newPassword: String(data.get('password')) },
              });
            if (mode === 'link') {
              await api('/v1/identity/confirm-email', { body: { token: params.get('token') } });
              await identityChanged();
              navigate('/settings');
              return;
            }
            setDone(true);
          }}
        >
          {mode === 'request' || mode === 'verify' ? (
            <Input label={t('web.email')} name="email" type="email" autoComplete="email" required />
          ) : mode === 'reset' ? (
            <Input
              label={t('web.newPassword')}
              hint={t('web.passwordHint')}
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          ) : (
            <Notice>{t('web.linkEmail')}</Notice>
          )}
        </ActionForm>
      )}
      <p>
        <Link to="/login">{t('web.signIn')}</Link>
      </p>
    </AuthLayout>
  );
}
export function Setup() {
  const t = useT();
  const { locale } = useLocale();
  const session = useSession();
  const navigate = useNavigate();
  const setup = useQuery({
    queryKey: ['setup'],
    queryFn: () => api<{ ownerClaimed: boolean; completed: boolean }>('/v1/setup'),
  });
  return (
    <AuthLayout>
      <h1>{t('web.setup')}</h1>
      {setup.isPending ? (
        <Loading />
      ) : setup.error ? (
        <ErrorNotice error={setup.error} />
      ) : setup.data?.completed ? (
        <Link to="/">{t('web.home')}</Link>
      ) : !setup.data?.ownerClaimed ? (
        <ActionForm
          submitLabel={t('web.claimOwner')}
          success={false}
          onSubmit={async (data) => {
            try {
              await api('/v1/setup/owner', {
                body: {
                  token: String(data.get('token')),
                  name: text(data, 'name'),
                  email: text(data, 'email'),
                  password: String(data.get('password')),
                  locale: locale === 'it' ? 'it' : 'en',
                },
              });
            } finally {
              await setup.refetch();
            }
          }}
        >
          <Input
            label={t('web.setupToken')}
            name="token"
            type="password"
            autoComplete="off"
            required
          />
          <Input label={t('web.name')} name="name" autoComplete="name" required />
          <Input label={t('web.email')} name="email" type="email" autoComplete="email" required />
          <Input
            label={t('web.password')}
            hint={t('web.passwordHint')}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </ActionForm>
      ) : session.data?.context.role === 'owner' ? (
        <ActionForm
          submitLabel={t('web.finishSetup')}
          success={false}
          onSubmit={async (data) => {
            await api('/v1/setup/complete', {
              body: {
                instanceName: text(data, 'instanceName'),
                pterodactylBaseURL: text(data, 'url'),
                pterodactylApplicationKey: String(data.get('applicationKey')),
                pterodactylClientKey: String(data.get('clientKey')) || undefined,
              },
            });
            await queryClient.invalidateQueries({ queryKey: ['setup'] });
            navigate('/owner');
          }}
        >
          <Input label={t('web.instanceName')} name="instanceName" required maxLength={100} />
          <Input label={t('web.pteroUrl')} name="url" type="url" required />
          <Input
            label={t('web.applicationKey')}
            name="applicationKey"
            type="password"
            autoComplete="off"
            required
          />
          <Input label={t('web.clientKey')} name="clientKey" type="password" autoComplete="off" />
        </ActionForm>
      ) : (
        <>
          <Notice>{t('web.setupClaimed')}</Notice>
          <div className="actions">
            <Link className="button" to="/login">
              {t('web.signIn')}
            </Link>
            <Link to="/verify">{t('web.resend')}</Link>
          </div>
        </>
      )}
    </AuthLayout>
  );
}
