import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, Outlet, useSearchParams } from 'react-router';
import { api } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import { useSession, useWebConfig, type WebSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  ConfirmDialog,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Page,
  text,
} from '../components/ui.js';
import { AccountIcon } from './account-icons.js';
import { refreshAccount, useLinkedAccounts, useSecuritySetup } from './account-shared.js';
import { ProfilePhoto } from './profile-photo.js';
import './account-profile.css';

export { AccountSecurity } from './account-security.js';

export function AccountPage() {
  const t = useT();
  const session = useSession();
  if (session.isPending) return <Loading />;
  if (session.error && !session.data) return <ErrorNotice error={session.error} />;
  if (session.data?.context.sessionType !== 'regular')
    return (
      <Page title={t('web.settings')}>
        <Notice>
          {t('web.support')} — {t('web.exitSupport')}
        </Notice>
      </Page>
    );
  return <AccountSettingsLayout key={session.data.subject.id} />;
}

function AccountSettingsLayout() {
  const t = useT();
  const [params] = useSearchParams();
  const securitySetup = useSecuritySetup();
  return (
    <div className="account-settings-page">
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
    </div>
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
          nameControl={<ProfileName key={profile.id} profile={profile} />}
          username={profile.username}
        />
        <ProfileLanguage key={`language:${profile.id}`} profile={profile} />
      </section>
      <div className="account-access-surface">
        <ProfileEmail key={profile.id} profile={profile} />
        <ProfileMethods />
      </div>
    </div>
  );
}

function ProfileName({ profile }: { profile: WebSession['subject'] }) {
  const t = useT();
  const validationId = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  function edit() {
    cancelled.current = false;
    setName(profile.name);
    setError(undefined);
    setInvalid(false);
    setEditing(true);
  }
  async function save(returnFocus = false) {
    if (busy.current || cancelled.current) return;
    const nextName = name.trim();
    if (!nextName) {
      setInvalid(true);
      return;
    }
    if (nextName === profile.name) {
      setEditing(false);
      if (returnFocus) requestAnimationFrame(() => trigger.current?.focus());
      return;
    }
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await api('/api/auth/update-user', { body: { name: nextName } });
      await refreshAccount();
      setEditing(false);
      if (
        returnFocus &&
        (document.activeElement === input.current || document.activeElement === document.body)
      )
        requestAnimationFrame(() => trigger.current?.focus());
    } catch (cause) {
      setError(cause);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="profile-name-editor">
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(true);
          }}
          aria-busy={pending}
        >
          <input
            ref={input}
            aria-label={t('web.displayName')}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? validationId : undefined}
            value={name}
            maxLength={100}
            autoComplete="name"
            disabled={pending}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setInvalid(false);
            }}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !pending) {
                event.preventDefault();
                cancelled.current = true;
                setEditing(false);
                setError(undefined);
                setInvalid(false);
                requestAnimationFrame(() => trigger.current?.focus());
              }
            }}
          />
          {pending && (
            <span className="profile-name-saving" role="status" aria-label={t('web.pending')}>
              <span className="settings-spinner" />
            </span>
          )}
        </form>
      ) : (
        <h3 className="profile-photo-name" aria-label={profile.name}>
          <Tooltip content={t('web.profileEditName')}>
            <button
              ref={trigger}
              type="button"
              className="profile-name-trigger"
              aria-label={t('web.profileEditNameAction', { name: profile.name })}
              onClick={edit}
            >
              <span>{profile.name}</span>
              <AccountIcon name="edit" />
            </button>
          </Tooltip>
        </h3>
      )}
      {invalid && (
        <p id={validationId} className="field-error" role="alert">
          {t('web.profileNameRequired')}
        </p>
      )}
      {Boolean(error) && <ErrorNotice error={error} />}
    </div>
  );
}

function ProfileLanguage({ profile }: { profile: WebSession['subject'] }) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const busy = useRef(false);
  const group = useRef<HTMLFieldSetElement>(null);
  const selected = locale === 'pseudo' ? profile.locale : locale;
  async function change(next: 'en' | 'it') {
    if (busy.current || next === selected) return;
    const previous = locale;
    const restoreFocus = group.current?.contains(document.activeElement);
    busy.current = true;
    setPending(true);
    setError(undefined);
    setLocale(next);
    try {
      await api('/api/auth/update-user', { body: { locale: next } });
      await refreshAccount();
    } catch (cause) {
      setLocale(previous);
      setError(cause);
    } finally {
      busy.current = false;
      setPending(false);
      if (restoreFocus)
        requestAnimationFrame(() => {
          if (document.activeElement === document.body)
            group.current
              ?.querySelector<HTMLInputElement>('input:checked')
              ?.focus({ preventScroll: true });
        });
    }
  }
  return (
    <div className="account-language-row">
      <fieldset ref={group} className="account-language" disabled={pending} aria-busy={pending}>
        <legend>
          <AccountIcon name="globe" />
          {t('web.locale')}
        </legend>
        <div className="account-language-options">
          {(['en', 'it'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="locale"
                value={value}
                checked={selected === value}
                onChange={() => void change(value)}
              />
              <span>{value === 'en' ? 'English' : 'Italiano'}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <span className="account-language-progress" role="status">
        {pending && (
          <>
            <span className="settings-spinner" aria-hidden="true" />
            <span className="visually-hidden">{t('web.pending')}</span>
          </>
        )}
      </span>
      {Boolean(error) && <ErrorNotice error={error} />}
    </div>
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
        <span className="account-email-icon">
          <AccountIcon name="mail" />
        </span>
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
          <Tooltip content={t('web.changeEmail')}>
            <button
              ref={trigger}
              type="button"
              className="account-icon-action"
              aria-label={t('web.changeEmail')}
              aria-expanded={false}
              aria-controls={`${id}-edit`}
              onClick={() => setEditing(true)}
            >
              <AccountIcon name="edit" />
            </button>
          </Tooltip>
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
