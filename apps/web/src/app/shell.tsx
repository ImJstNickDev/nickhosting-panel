import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api, queryClient } from '../api/client.js';
import { ErrorNotice, Loading, Time } from '../components/ui.js';
import { useLocale, useT } from './i18n.js';
import { identityChanged, isSignedOut, useSession, useWebConfig } from './session.js';

export function Shell() {
  const t = useT();
  const session = useSession();
  const config = useWebConfig();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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
    document.querySelector<HTMLElement>('h1')?.focus();
  }, [location.pathname]);
  useEffect(() => {
    const value = session.data?.subject.locale;
    if (value && locale !== 'pseudo' && locale !== value) setLocale(value);
  }, [session.data?.subject.locale, locale, setLocale]);
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
  if (session.error) {
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
  const navigation = ownerArea
    ? readOnlyAdmin
      ? [
          ['/owner/audit', 'web.audit'],
          ['/owner/settings', 'web.settings'],
        ]
      : [
          ['/owner', 'web.overview'],
          ['/owner/users', 'web.users'],
          ['/owner/servers', 'web.servers'],
          ['/owner/infrastructure', 'web.infrastructure'],
          ['/owner/integrations', 'web.integrations'],
          ['/owner/operations', 'web.operations'],
          ['/owner/audit', 'web.audit'],
          ['/owner/settings', 'web.settings'],
        ]
    : [
        ['/', 'web.home'],
        ['/servers', 'web.servers'],
        ['/activity', 'web.activity'],
        ['/settings', 'web.settings'],
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
      <div className="shell">
        <aside className={`sidebar${open ? ' open' : ''}`} id="primary-navigation">
          <Link className="brand" to="/">
            <span className="brand-mark">{config.data?.instanceName ?? 'NickHosting'}</span>
          </Link>
          <nav className="nav" aria-label={t('web.navigation')}>
            {navigation.map(([to, key]) => (
              <NavLink key={to} to={to!} end={to === '/' || to === '/owner'}>
                {t(key!)}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-bottom">
            {(ordinaryOwner || readOnlyAdmin) && (
              <Link to={ownerArea ? '/' : ordinaryOwner ? '/owner' : '/owner/audit'}>
                {t(ownerArea ? 'web.home' : ordinaryOwner ? 'web.owner' : 'web.administration')}
              </Link>
            )}
            <small>{current.subject.name}</small>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <button
              type="button"
              className="mobile-menu secondary"
              aria-expanded={open}
              aria-controls="primary-navigation"
              onClick={() => setOpen(!open)}
            >
              {t('web.openMenu')}
            </button>
            <span>
              {ownerArea
                ? t(ordinaryOwner ? 'web.owner' : 'web.administration')
                : (config.data?.instanceName ?? 'NickHosting')}
            </span>
            <Link to="/settings">{current.subject.name}</Link>
          </header>
          <main id="content">
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}

export function AuthCallback() {
  const navigate = useNavigate();
  useEffect(() => {
    void identityChanged().then(() => navigate('/', { replace: true }));
  }, [navigate]);
  return <Loading />;
}
