import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, api } from '../api/client.js';
import { AccountMenu } from '../components/account-menu.js';
import { Sidebar, type SidebarIconName, useSidebarCollapsed } from '../components/sidebar.js';
import { Tooltip } from '../components/tooltip.js';
import { ErrorNotice, Loading, Time } from '../components/ui.js';
import { fileSaveScope } from '../features/file-background-save.js';
import { FileSaveNotices } from '../features/file-save-notices.js';
import { useLocale, useT } from './i18n.js';
import { identityChanged, isSignedOut, useSession, useWebConfig } from './session.js';

export function Shell() {
  const t = useT();
  const session = useSession();
  const config = useWebConfig();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const closeNavigation = useCallback(() => setOpen(false), []);
  const [collapsed, toggleSidebar] = useSidebarCollapsed();
  const [exitError, setExitError] = useState<unknown>();
  const { locale, setLocale } = useLocale();
  const setup = useQuery({
    queryKey: ['setup'],
    queryFn: () => api<{ ownerClaimed: boolean; completed: boolean }>('/v1/setup'),
  });
  const ownerArea = location.pathname.startsWith('/owner');
  // biome-ignore lint/correctness/useExhaustiveDependencies: close navigation and restore focus on each route transition.
  useEffect(() => {
    setOpen(false);
    // The modal finishes its exit before moving focus into the new page.
    if (!document.querySelector('dialog.mobile-navigation[open]'))
      document.querySelector<HTMLElement>('h1')?.focus();
  }, [location.pathname]);
  const applySessionLocale = useEffectEvent((value: 'en' | 'it') => {
    if (value && locale !== 'pseudo' && locale !== value) setLocale(value);
  });
  // Adopt a changed server preference/identity, not every local language preview
  // while its save is in flight. Failed saves restore the prior local preference.
  useEffect(() => {
    const value = session.data?.subject.locale;
    if (value && session.data?.subject.id) applySessionLocale(value);
  }, [session.data?.subject.id, session.data?.subject.locale]);
  async function exit() {
    try {
      await api('/v1/web/support/exit', { body: {} });
      await identityChanged();
      navigate('/owner/users');
    } catch (error) {
      setExitError(error);
    }
  }
  if (session.isPending || setup.isPending)
    return (
      <main>
        <Loading />
      </main>
    );
  if (setup.data && !setup.data.ownerClaimed) return <Navigate to="/setup" replace />;
  // A failed background refresh must not discard in-memory forms/recovery codes.
  // Authentication failures and support sessions still leave the authenticated shell.
  const transientSessionFailure =
    session.data?.context.sessionType === 'regular' &&
    ((session.error instanceof ApiError && session.error.status >= 500) ||
      session.error instanceof TypeError);
  if (session.error && !transientSessionFailure) {
    if (isSignedOut(session.error)) return <Navigate to="/login" replace />;
    return (
      <main>
        <ErrorNotice error={session.error} />
        <button type="button" onClick={exit}>
          {t('web.exitSupport')}
        </button>
        {Boolean(exitError) && <ErrorNotice error={exitError} />}
      </main>
    );
  }
  if (!session.data) return <Navigate to="/login" replace />;
  const current = session.data;
  const support = current.context.sessionType === 'support';
  const ordinaryOwner = current.context.role === 'owner' && !support;
  if (ordinaryOwner && setup.data && !setup.data.completed) return <Navigate to="/setup" replace />;
  const readOnlyAdmin = current.context.role === 'operator' && !support;
  if (
    ownerArea &&
    !ordinaryOwner &&
    !(readOnlyAdmin && ['/owner/audit', '/owner/settings'].includes(location.pathname))
  )
    return <Navigate to="/" replace />;
  const navigation: ReadonlyArray<readonly [string, string, SidebarIconName]> = ownerArea
    ? readOnlyAdmin
      ? [
          ['/owner/audit', 'web.audit', 'audit'],
          ['/owner/settings', 'web.settings', 'settings'],
        ]
      : [
          ['/owner', 'web.overview', 'overview'],
          ['/owner/users', 'web.users', 'users'],
          ['/owner/servers', 'web.servers', 'servers'],
          ['/owner/infrastructure', 'web.infrastructure', 'infrastructure'],
          ['/owner/integrations', 'web.integrations', 'integrations'],
          ['/owner/operations', 'web.operations', 'operations'],
          ['/owner/audit', 'web.audit', 'audit'],
          ['/owner/settings', 'web.settings', 'settings'],
        ]
    : [
        ['/', 'web.home', 'home'],
        ['/servers', 'web.servers', 'servers'],
        ['/activity', 'web.activity', 'activity'],
        ['/settings', 'web.settings', 'settings'],
      ];
  return (
    <>
      <a className="skip-link" href="#content">
        {t('web.skip')}
      </a>
      {support && (
        <div className="support-banner">
          <span>
            {t('web.supportBanner', { actor: current.actor.name, subject: current.subject.name })} ·{' '}
            {t('web.expires')}: <Time value={current.context.support?.expiresAt} />
          </span>
          <button type="button" className="secondary" onClick={exit}>
            {t('web.exitSupport')}
          </button>
        </div>
      )}
      {Boolean(exitError) && <ErrorNotice error={exitError} />}
      <div className="shell" data-sidebar-collapsed={collapsed || undefined}>
        <Sidebar
          open={open}
          collapsed={collapsed}
          onToggle={toggleSidebar}
          onClose={closeNavigation}
          instanceName={config.data?.instanceName ?? 'NickHosting'}
          name={current.subject.name}
          showHome={ownerArea && (ordinaryOwner || readOnlyAdmin)}
          navigation={navigation.map(([to, key, icon]) => ({ to, label: t(key), icon }))}
        />
        <div className="workspace">
          <header className="topbar">
            <button
              type="button"
              className="mobile-menu"
              aria-label={t('web.openMenu')}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls="mobile-navigation"
              onClick={() => setOpen(!open)}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span>
              {ownerArea
                ? t(ordinaryOwner ? 'web.owner' : 'web.administration')
                : (config.data?.instanceName ?? 'NickHosting')}
            </span>
            <div className="topbar-account-actions">
              {(ordinaryOwner || readOnlyAdmin) && (
                <Tooltip key={location.pathname} content={t('web.admin')}>
                  <Link
                    className="topbar-admin"
                    to={ordinaryOwner ? '/owner' : '/owner/audit'}
                    aria-label={t('web.admin')}
                    data-active={ownerArea || undefined}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 3v4m0 4v10M12 3v10m0 4v4M19 3v4m0 4v10" />
                      <rect x="3" y="7" width="4" height="4" rx="1" />
                      <rect x="10" y="13" width="4" height="4" rx="1" />
                      <rect x="17" y="7" width="4" height="4" rx="1" />
                    </svg>
                  </Link>
                </Tooltip>
              )}
              <AccountMenu
                key={`${location.pathname}:${current.subject.id}:${current.context.sessionType}`}
                name={current.subject.name}
                avatarUrl={current.subject.avatarUrl}
                support={support}
                onExitSupport={exit}
              />
            </div>
          </header>
          <main id="content">
            {session.error && transientSessionFailure && (
              <ErrorNotice error={session.error} retry={() => void session.refetch()} />
            )}
            <Outlet />
            <FileSaveNotices scope={fileSaveScope(current)} />
          </main>
        </div>
      </div>
    </>
  );
}

export function AuthCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const target = params.get('reauth') === 'security' ? '/settings/security' : '/';
  useEffect(() => {
    void identityChanged().then(() => navigate(target, { replace: true }));
  }, [navigate, target]);
  return <Loading />;
}
