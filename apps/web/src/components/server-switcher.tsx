import { useQuery } from '@tanstack/react-query';
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import type { listPlatformServers } from '../../../../packages/server-management/src/platform-queries.js';
import { api } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from './tooltip.js';
import { ErrorNotice } from './ui.js';
import './server-switcher.css';

export function ServerSwitcher({
  server,
  compact,
  active,
  onNavigate,
}: {
  server: { id: string; name: string };
  compact: boolean;
  active: boolean;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const t = useT();
  const session = useSession();
  const identity = session.data
    ? `${session.data.context.actorUserId}:${session.data.context.subjectUserId}:${session.data.context.sessionType}:${session.data.context.support?.id ?? ''}`
    : '';
  const previousIdentity = useRef(identity);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const servers = useQuery({
    queryKey: ['server-switcher', identity],
    queryFn: ({ signal }) =>
      api<Result<typeof listPlatformServers>>('/v1/platform/servers?limit=8', { signal }),
    enabled: open && active && Boolean(identity),
    retry: false,
    staleTime: 0,
  });

  const position = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    const element = popup.current;
    if (!anchor || !element) return;
    const width = Math.min(Math.max(260, anchor.width), window.innerWidth - 24);
    const left = Math.max(
      12,
      Math.min(compact ? anchor.right + 8 : anchor.left, window.innerWidth - width - 12),
    );
    const top = Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - 180));
    element.style.width = `${width}px`;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.maxHeight = `${window.innerHeight - top - 12}px`;
  }, [compact]);

  useEffect(() => {
    if (!active) popup.current?.hidePopover();
  }, [active]);
  useEffect(() => {
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity;
      popup.current?.hidePopover();
    }
  }, [identity]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = (event?: Event) => {
      if (event?.target instanceof Node && popup.current?.contains(event.target)) return;
      position();
    };
    position();
    const observer = new ResizeObserver(() => position());
    if (trigger.current) observer.observe(trigger.current);
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [open, position]);

  async function retry() {
    const focused = document.activeElement;
    const result = await servers.refetch();
    if (result.error) return;
    requestAnimationFrame(() => {
      if (
        popup.current?.matches(':popover-open') &&
        (document.activeElement === document.body || document.activeElement === focused)
      )
        popup.current.querySelector<HTMLElement>('a')?.focus();
    });
  }

  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    popup.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
    onNavigate(event);
  }

  return (
    <div className="server-switcher" data-compact={compact || undefined}>
      <Tooltip content={compact && !open ? server.name : ''}>
        <button
          ref={trigger}
          type="button"
          className="server-switcher-trigger"
          aria-label={t('serverNav.managingName', { name: server.name })}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={id}
          popoverTarget={id}
          onClick={position}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && popup.current?.matches(':popover-open')) {
              event.preventDefault();
              event.stopPropagation();
              popup.current.hidePopover();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              position();
              popup.current?.showPopover();
              popup.current?.querySelector<HTMLElement>('a,button')?.focus();
            }
          }}
        >
          <span className="server-switcher-label">{t('serverNav.managing')}</span>
          <strong className="server-switcher-name" title={server.name}>
            {server.name}
          </strong>
          <svg
            className="server-switcher-symbol"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="7" rx="2" />
            <rect x="3" y="14" width="18" height="7" rx="2" />
            <path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5" />
          </svg>
          <svg
            className="server-switcher-chevron"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="m4 7 6 6 6-6" />
          </svg>
        </button>
      </Tooltip>
      <div
        id={id}
        ref={popup}
        popover="auto"
        role="dialog"
        aria-label={t('serverNav.switch')}
        className="server-switcher-popover"
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (
            next instanceof Node &&
            next !== trigger.current &&
            !event.currentTarget.contains(next)
          )
            popup.current?.hidePopover();
        }}
        onToggle={(event) => {
          const visible = event.newState === 'open';
          setOpen(visible);
          if (visible) popup.current?.querySelector<HTMLElement>('a,button')?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          popup.current?.hidePopover();
          trigger.current?.focus({ preventScroll: true });
        }}
      >
        {servers.isPending && (
          <p className="server-switcher-status" role="status">
            {t('web.loading')}
          </p>
        )}
        {servers.error && <ErrorNotice error={servers.error} retry={() => void retry()} />}
        {!servers.isPending && !servers.error && servers.data?.items.length === 0 && (
          <p className="server-switcher-status">{t('serverNav.empty')}</p>
        )}
        {!servers.error && servers.data && (
          <nav aria-label={t('web.servers')}>
            {servers.data.items.map((item) => (
              <Link
                key={item.id}
                to={`/servers/${encodeURIComponent(item.id)}`}
                onClick={navigate}
                aria-current={item.id === server.id ? 'true' : undefined}
                className="server-switcher-option"
              >
                <span>{item.name}</span>
                {item.id === server.id && (
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                  >
                    <path d="m4 10 4 4 8-8" />
                  </svg>
                )}
              </Link>
            ))}
          </nav>
        )}
        {servers.data?.nextCursor && !servers.error && (
          <p className="server-switcher-status">{t('serverNav.moreServers')}</p>
        )}
        <Link
          to="/servers"
          onClick={navigate}
          className="server-switcher-option server-switcher-all"
        >
          <span>{t('serverNav.allServers')}</span>
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M3 10h14m-5-5 5 5-5 5" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
