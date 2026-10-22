import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { focusWorkspace } from '../app/workspace-focus.js';
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
  | 'audit'
  | 'console'
  | 'files'
  | 'world'
  | 'package'
  | 'backups'
  | 'schedules'
  | 'network';

const icons: Record<SidebarIconName, ReactNode> = {
  console: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  files: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3Z" />,
  world: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  package: (
    <>
      <path d="m12 3 9 5v9l-9 5-9-5V8Zm0 10v9M3 8l9 5 9-5M8 5l9 5" />
    </>
  ),
  backups: (
    <>
      <path d="M4 7h16v14H4ZM3 3h18v4H3Zm6 8h6" />
    </>
  ),
  schedules: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M12 7v5H5v5m7-5h7v5" />
    </>
  ),
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

/** Native modality supplies focus containment and makes the rest of the page inert. */
function MobileNavigation({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const location = useLocation();
  const dialog = useRef<HTMLDialogElement>(null);
  const restoreScroll = useRef<(() => void) | null>(null);
  const openedPath = useRef(location.pathname);
  const backdropPointer = useRef(false);
  const finish = useEffectEvent(() => {
    dialog.current?.close();
    restoreScroll.current?.();
    restoreScroll.current = null;
    if (location.pathname !== openedPath.current) focusWorkspace();
  });

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      delete element.dataset.closing;
      if (element.open) return;
      openedPath.current = location.pathname;
      const { scrollX, scrollY } = window;
      const body = document.body;
      const root = document.documentElement;
      const scrollbarWidth = window.innerWidth - root.clientWidth;
      const previous = {
        position: body.style.position,
        top: body.style.top,
        left: body.style.left,
        width: body.style.width,
        overflow: root.style.overflow,
      };
      body.style.position = 'fixed';
      body.style.top = `${-scrollY}px`;
      body.style.left = `${-scrollX}px`;
      body.style.width = `calc(100% - ${scrollbarWidth}px)`;
      root.style.overflow = 'hidden';
      restoreScroll.current = () => {
        body.style.position = previous.position;
        body.style.top = previous.top;
        body.style.left = previous.left;
        body.style.width = previous.width;
        root.style.overflow = previous.overflow;
        window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      };
      element.showModal();
      element.querySelector<HTMLElement>('.sidebar-close')?.focus();
    } else if (element.open) {
      element.dataset.closing = 'true';
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finish();
      } else {
        const timer = window.setTimeout(() => finish(), 180);
        return () => window.clearTimeout(timer);
      }
    }
  }, [open, location.pathname]);

  useLayoutEffect(() => {
    const element = dialog.current;
    return () => {
      const wasOpen = element?.open;
      element?.close();
      restoreScroll.current?.();
      restoreScroll.current = null;
      // The mobile opener disappears at this breakpoint; use its desktop counterpart.
      if (wasOpen && isDesktop())
        queueMicrotask(() => {
          document.querySelector<HTMLElement>('.sidebar-toggle')?.focus({ preventScroll: true });
        });
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      id="mobile-navigation"
      className="mobile-navigation"
      aria-label={t('web.navigation')}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        backdropPointer.current = event.button === 0 && event.target === event.currentTarget;
      }}
      onPointerUp={(event) => {
        if (backdropPointer.current && event.target === event.currentTarget) onClose();
        backdropPointer.current = false;
      }}
    >
      {children}
    </dialog>
  );
}

export function Sidebar({
  open,
  collapsed,
  onToggle,
  onClose,
  instanceName,
  name,
  showHome,
  navigation,
  serverIdentity,
}: {
  open: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  instanceName: string;
  name: string;
  showHome: boolean;
  navigation: readonly {
    to: string;
    label: string;
    icon: SidebarIconName;
    group?: string;
    active?: boolean;
  }[];
  serverIdentity?: { name: string; detail: string };
}) {
  const t = useT();
  const location = useLocation();
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop, serverIsDesktop);
  const compact = desktop && collapsed;
  const toggleLabel = t(collapsed ? 'web.expandNavigation' : 'web.collapseNavigation');
  useEffect(() => {
    if (desktop && open) onClose();
  }, [desktop, open, onClose]);
  function closeAfterNavigation(event: MouseEvent<HTMLAnchorElement>) {
    if (
      !desktop &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    )
      onClose();
  }
  const content = (
    <aside
      className="sidebar"
      id="primary-navigation"
      data-collapsed={collapsed || undefined}
      onFocusCapture={(event) => {
        const target = event.target;
        const scrollport = desktop ? event.currentTarget : target.closest<HTMLElement>('.nav');
        if (!scrollport) return;
        const bounds = target.getBoundingClientRect();
        const top = scrollport.getBoundingClientRect().top + scrollport.clientTop;
        const bottom = top + scrollport.clientHeight;
        // Some browsers reveal only part of a focused link. Scroll this container
        // directly so the full control and its focus outline remain visible.
        if (bounds.top < top + 2) scrollport.scrollTop += bounds.top - top - 2;
        else if (bounds.bottom > bottom - 2) scrollport.scrollTop += bounds.bottom - bottom + 2;
      }}
    >
      <div className="sidebar-header">
        <Link
          className="brand"
          onClick={closeAfterNavigation}
          to="/"
          aria-label={instanceName}
          aria-hidden={compact || undefined}
          tabIndex={compact ? -1 : undefined}
        >
          <span className="brand-mark">{instanceName}</span>
        </Link>
        {!desktop && (
          <button
            type="button"
            className="sidebar-close"
            aria-label={t('web.close')}
            onClick={onClose}
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
              <path d="m6 6 12 12M6 18 18 6" />
            </svg>
          </button>
        )}
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
      {serverIdentity && (
        <div className="sidebar-server">
          <Tooltip content={compact ? t('serverNav.allServers') : ''}>
            <Link
              className="sidebar-link"
              to="/servers"
              onClick={closeAfterNavigation}
              aria-label={t('serverNav.allServers')}
            >
              <svg
                className="sidebar-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="m10 5-7 7 7 7M3 12h18" />
              </svg>
              <span className="sidebar-label">{t('serverNav.allServers')}</span>
            </Link>
          </Tooltip>
          <div className="sidebar-server-identity" aria-hidden={compact || undefined}>
            <strong title={serverIdentity.name}>{serverIdentity.name}</strong>
            <small>{serverIdentity.detail}</small>
          </div>
        </div>
      )}
      <nav className="nav" aria-label={t('web.navigation')}>
        {navigation.map(({ to, label, icon, group, active }, index) => (
          <div className="sidebar-entry" key={to}>
            {group && navigation[index - 1]?.group !== group && (
              <div className="sidebar-group" aria-hidden={compact || undefined}>
                {group}
              </div>
            )}
            <Tooltip content={compact ? label : ''}>
              <Link
                className="sidebar-link"
                aria-current={
                  (active ??
                  (location.pathname === to ||
                    (to !== '/' && to !== '/owner' && location.pathname.startsWith(`${to}/`))))
                    ? 'page'
                    : undefined
                }
                data-section-active={active || undefined}
                onClick={closeAfterNavigation}
                to={to}
                aria-label={label}
              >
                <SidebarIcon name={icon} />
                <span className="sidebar-label">{label}</span>
              </Link>
            </Tooltip>
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        {showHome && (
          <Tooltip content={compact ? t('web.home') : ''}>
            <Link
              className="sidebar-link"
              to="/"
              aria-label={t('web.home')}
              onClick={closeAfterNavigation}
            >
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
  return desktop ? (
    content
  ) : (
    <MobileNavigation open={open} onClose={onClose}>
      {content}
    </MobileNavigation>
  );
}
