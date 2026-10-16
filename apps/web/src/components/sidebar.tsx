import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Link, NavLink } from 'react-router';
import { useT } from '../app/i18n.js';
import { Tooltip } from './tooltip.js';
import './sidebar.css';

export type SidebarIconName =
  | 'home'
  | 'servers'
  | 'activity'
  | 'settings'
  | 'overview'
  | 'users'
  | 'infrastructure'
  | 'integrations'
  | 'operations'
  | 'audit';

const icons: Record<SidebarIconName, ReactNode> = {
  home: <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />,
  servers: (
    <>
      <rect x="3" y="3" width="18" height="7" rx="2" />
      <rect x="3" y="14" width="18" height="7" rx="2" />
      <path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  settings: (
    <>
      <path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="9" cy="18" r="2" />
    </>
  ),
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3" />
    </>
  ),
  infrastructure: (
    <>
      <rect x="8" y="3" width="8" height="6" rx="1.5" />
      <rect x="2" y="15" width="7" height="6" rx="1.5" />
      <rect x="15" y="15" width="7" height="6" rx="1.5" />
      <path d="M12 9v3M5.5 15v-3h13v3" />
    </>
  ),
  integrations: (
    <>
      <path d="m9 15 6-6m-8 4-2 2a4.25 4.25 0 0 0 6 6l3-3a4.25 4.25 0 0 0 0-6m3-1 2-2a4.25 4.25 0 0 0-6-6l-3 3a4.25 4.25 0 0 0 0 6" />
    </>
  ),
  operations: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5.1 8a7.5 7.5 0 0 1 12.3-3L20 8m-1.1 8a7.5 7.5 0 0 1-12.3 3L4 16" />
    </>
  ),
  audit: (
    <>
      <path d="M9 4H6a2 2 0 0 0-2 2v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a2 2 0 0 0-2-2h-3" />
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="m8 12 1 1 2-2m3 1h2m-8 5 1 1 2-2m3 1h2" />
    </>
  ),
};

function SidebarIcon({ name }: { name: SidebarIconName }) {
  return (
    <svg
      className="sidebar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icons[name]}
    </svg>
  );
}

const storageKey = 'nh.sidebar.collapsed';
const desktopQuery = '(min-width: 761px)';

export function useSidebarCollapsed(): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(collapsed));
    } catch {
      // A blocked or full store must not prevent this local display preference.
    }
  }, [collapsed]);
  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  return [collapsed, toggle];
}

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const isDesktop = () => window.matchMedia(desktopQuery).matches;
const serverIsDesktop = () => false;

export function Sidebar({
  open,
  collapsed,
  onToggle,
  instanceName,
  name,
  showHome,
  navigation,
}: {
  open: boolean;
  collapsed: boolean;
  onToggle: () => void;
  instanceName: string;
  name: string;
  showHome: boolean;
  navigation: readonly { to: string; label: string; icon: SidebarIconName }[];
}) {
  const t = useT();
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop, serverIsDesktop);
  const compact = desktop && collapsed;
  const toggleLabel = t(collapsed ? 'web.expandNavigation' : 'web.collapseNavigation');
  return (
    <aside
      className={`sidebar${open ? ' open' : ''}`}
      id="primary-navigation"
      data-collapsed={collapsed || undefined}
    >
      <div className="sidebar-header">
        <Link
          className="brand"
          to="/"
          aria-label={instanceName}
          aria-hidden={compact || undefined}
          tabIndex={compact ? -1 : undefined}
        >
          <span className="brand-mark">{instanceName}</span>
        </Link>
        <Tooltip content={desktop ? toggleLabel : ''}>
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            aria-controls="primary-navigation"
            onClick={onToggle}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
              <path className="sidebar-toggle-arrow" d="m15 9-3 3 3 3" />
            </svg>
          </button>
        </Tooltip>
      </div>
      <nav className="nav" aria-label={t('web.navigation')}>
        {navigation.map(({ to, label, icon }) => (
          <Tooltip key={to} content={compact ? label : ''}>
            <NavLink
              className="sidebar-link"
              to={to}
              end={to === '/' || to === '/owner'}
              aria-label={label}
            >
              <SidebarIcon name={icon} />
              <span className="sidebar-label">{label}</span>
            </NavLink>
          </Tooltip>
        ))}
      </nav>
      <div className="sidebar-bottom">
        {showHome && (
          <Tooltip content={compact ? t('web.home') : ''}>
            <Link className="sidebar-link" to="/" aria-label={t('web.home')}>
              <SidebarIcon name="home" />
              <span className="sidebar-label">{t('web.home')}</span>
            </Link>
          </Tooltip>
        )}
        <small className="sidebar-user" aria-hidden={compact || undefined}>
          {name}
        </small>
      </div>
    </aside>
  );
}
