import { type ReactNode, useId, useRef, useState } from 'react';
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
          className="minecraft-player-role"
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
  return (
    <div className="minecraft-player-menu">
      <button
        type="button"
        className="minecraft-player-menu-trigger secondary"
        ref={trigger}
        aria-label={t('games.minecraft.players.actionsFor', { name })}
        aria-expanded={open}
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
          if (event.newState !== 'open' || !trigger.current || !popup.current) return;
          const rect = trigger.current.getBoundingClientRect();
          popup.current.style.left = `${Math.max(8, Math.min(window.innerWidth - 250, rect.right - 240))}px`;
          popup.current.style.top = `${Math.max(8, Math.min(window.innerHeight - 360, rect.bottom + 6))}px`;
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
  hasActions,
}: {
  row: MinecraftPlayerRow;
  to?: string;
  actions: ReactNode;
  hasActions: boolean;
}) {
  const t = useT();
  const [active, setActive] = useState(false);
  const identity = (
    <>
      <MinecraftPlayerBody
        name={row.name}
        uuid={row.uuid}
        active={active}
        className="minecraft-player-card-body"
      />
      <div className="minecraft-player-identity">
        <strong>{row.name}</strong>
        <PlayerRoles row={row} />
      </div>
    </>
  );
  return (
    <li
      className="minecraft-player"
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setActive(false);
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
          {to && <Link to={to}>{t('games.minecraft.players.view')}</Link>}
          {actions}
        </PlayerActionMenu>
      )}
    </li>
  );
}
