import { Children, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { MinecraftPlayerBody } from './player-body.js';
import type { MinecraftPlayerRow } from './players-model.js';

export function PlayerRoles({ row }: { row: MinecraftPlayerRow }) {
  const t = useT();
  const k = (name: string) => t(`games.minecraft.players.${name}`);
  return (
    <div className="minecraft-player-roles">
      {row.online && (
        <span className="minecraft-player-role minecraft-player-role--online">
          <i aria-hidden="true" />
          {k('online')}
        </span>
      )}
      {row.operator && (
        <span
          className="minecraft-player-role minecraft-player-role--operator"
          title={t('games.minecraft.players.operatorDetails', { level: row.operator.level })}
        >
          {k('operator')}
        </span>
      )}
      {row.whitelisted && <span className="minecraft-player-role">{k('whitelisted')}</span>}
      {row.banned && (
        <span
          className="minecraft-player-role minecraft-player-role--banned"
          title={row.banned.reason}
        >
          {k('bannedRole')}
        </span>
      )}
    </div>
  );
}

export function PlayerActionMenu({ name, children }: { name: string; children: ReactNode }) {
  const t = useT();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const position = useCallback(() => {
    if (!trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const menu = popup.current.getBoundingClientRect();
    const width = menu.width || Math.min(240, window.innerWidth - 16);
    const height = menu.height || 350;
    popup.current.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    popup.current.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - height - 8))}px`;
  }, []);
  useEffect(() => {
    if (!open) return;
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, position]);
  return (
    <div className="minecraft-player-menu">
      <button
        type="button"
        className="minecraft-player-menu-trigger secondary"
        ref={trigger}
        aria-label={t('games.minecraft.players.actionsFor', { name })}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={id}
        popoverTarget={id}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            popup.current?.showPopover();
            popup.current?.querySelector<HTMLElement>('a,button:not(:disabled)')?.focus();
          }
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      <div
        id={id}
        ref={popup}
        role="dialog"
        popover="auto"
        className="minecraft-player-menu-popover"
        aria-label={t('games.minecraft.players.actionsFor', { name })}
        onToggle={(event) => setOpen(event.newState === 'open')}
        onBeforeToggle={(event) => {
          if (event.newState === 'open') position();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            popup.current?.hidePopover();
            trigger.current?.focus();
          }
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a,button:not(:disabled)')) {
            trigger.current?.focus();
            popup.current?.hidePopover();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function PlayerCard({
  row,
  to,
  actions,
  quickActions,
  hasActions,
}: {
  row: MinecraftPlayerRow;
  to?: string;
  actions: ReactNode;
  quickActions?: ReactNode;
  hasActions: boolean;
}) {
  const t = useT();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const identity = (
    <>
      <MinecraftPlayerBody
        name={row.name}
        uuid={row.uuid}
        active={hovered || focused}
        variant="bust"
        className="minecraft-player-card-body"
      />
      <div className="minecraft-player-identity">
        <strong title={row.name}>{row.name}</strong>
        <PlayerRoles row={row} />
      </div>
    </>
  );
  return (
    <li
      className="minecraft-player"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {to ? (
        <Link
          className="minecraft-player-card-link"
          to={to}
          data-player-id={row.uuid}
          aria-label={t('games.minecraft.players.viewFor', { name: row.name })}
        >
          {identity}
        </Link>
      ) : (
        <div className="minecraft-player-card-link">{identity}</div>
      )}
      {(to || hasActions) && (
        <PlayerActionMenu name={row.name}>
          {to && (
            <div className="minecraft-player-menu-section">
              <Link to={to}>{t('games.minecraft.players.view')}</Link>
            </div>
          )}
          {Children.toArray(actions).length > 0 && (
            <div className="minecraft-player-menu-section">{actions}</div>
          )}
          {Children.toArray(quickActions).length > 0 && (
            <div className="minecraft-player-menu-section">{quickActions}</div>
          )}
        </PlayerActionMenu>
      )}
    </li>
  );
}
