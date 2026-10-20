import type { ReactNode } from 'react';
import type {
  MinecraftModMetadata,
  ModCatalogProject,
} from '../../../../../games/minecraft/src/ui/mods-controller.js';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';

export const modsKey = (name: string) => `games.minecraft.mods.${name}`;
const translatedTags = new Set([
  'technology',
  'worldgen',
  'optimization',
  'library',
  'utility',
  'adventure',
]);
export function modTagLabel(tag: { id: string; label: string }, t: (key: string) => string) {
  return translatedTags.has(tag.id) ? t(modsKey(`tag.${tag.id}`)) : tag.label;
}
export type ModsIconName =
  | 'mod'
  | 'search'
  | 'close'
  | 'back'
  | 'next'
  | 'check'
  | 'chevron'
  | 'download'
  | 'refresh'
  | 'external'
  | 'server'
  | 'client'
  | 'both'
  | 'disable'
  | 'enable'
  | 'delete'
  | 'version'
  | 'warning'
  | 'queue'
  | 'filter';
export function ModsIcon({ name }: { name: ModsIconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'mod' && (
        <path d="M8 3h4v3a2 2 0 0 0 4 0V3h5v6h-3a2 2 0 0 0 0 4h3v8h-7v-3a2 2 0 0 0-4 0v3H3v-7h3a2 2 0 0 0 0-4H3V3z" />
      )}
      {name === 'search' && (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" />
        </>
      )}
      {name === 'close' && <path d="m6 6 12 12M6 18 18 6" />}
      {name === 'back' && <path d="m14 5-7 7 7 7M7 12h14" />}
      {name === 'next' && <path d="m10 5 7 7-7 7M17 12H3" />}
      {name === 'check' && <path d="m5 12 4 4L19 6" />}
      {name === 'chevron' && <path d="m6 9 6 6 6-6" />}
      {name === 'download' && <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />}
      {name === 'refresh' && (
        <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
      )}
      {name === 'external' && <path d="M14 3h7v7m0-7L10 14M10 5H4v15h15v-6" />}
      {name === 'server' && (
        <>
          <rect x="4" y="3" width="16" height="7" rx="2" />
          <rect x="4" y="14" width="16" height="7" rx="2" />
          <path d="M8 6.5h.01M8 17.5h.01m4-11h4m-4 11h4" />
        </>
      )}
      {name === 'client' && (
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8m-4-4v4" />
        </>
      )}
      {name === 'both' && (
        <>
          <rect x="3" y="4" width="13" height="10" rx="2" />
          <rect x="10" y="10" width="11" height="10" rx="2" />
          <path d="M7 18H4m15-4h-2m2 3h-2" />
        </>
      )}
      {name === 'disable' && <path d="M8 5v14M16 5v14" />}
      {name === 'enable' && <path d="m7 4 13 8-13 8z" />}
      {name === 'delete' && <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />}
      {name === 'version' && <path d="M4 4h16v6l-8 10-8-10zm4 4h.01" />}
      {name === 'warning' && <path d="m12 3 10 18H2zM12 9v5m0 3v.1" />}
      {name === 'queue' && <path d="M4 5h12M4 12h9M4 19h7m5-6 5 5-5 5m5-5h-8" />}
      {name === 'filter' && <path d="M3 6h18M7 12h10m-6 6h2" />}
    </svg>
  );
}
export function ModsAction({
  icon,
  label,
  onClick,
  disabled,
  destructive = false,
}: {
  icon: ModsIconName;
  label: string;
  onClick(): void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`mods-icon-action${destructive ? ' destructive' : ''}`}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        <ModsIcon name={icon} />
      </button>
    </Tooltip>
  );
}
export function ModsCheckbox({
  label,
  checked,
  onChange,
  disabled = false,
  compact = false,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <label className={`mods-checkbox${compact ? ' compact' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={compact ? label : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="mods-checkbox-mark" aria-hidden="true">
        <ModsIcon name="check" />
      </span>
      {!compact && <span>{label}</span>}
    </label>
  );
}
export function ModsArtwork({ image, name }: { image?: string; name: string }) {
  const safe = image?.startsWith('https://') ? image : undefined;
  return (
    <span className="mods-artwork" aria-hidden="true">
      {safe ? (
        <img
          src={safe}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
      <span>{name.slice(0, 1).toUpperCase()}</span>
    </span>
  );
}
export function ModsTags({
  side,
  tags = [],
  compact = false,
}: {
  side: MinecraftModMetadata['side'];
  tags?: { id: string; label: string }[];
  compact?: boolean;
}) {
  const t = useT();
  return (
    <div className="mods-tags">
      <span className="mods-side" data-side={side}>
        {side !== 'unknown' && <ModsIcon name={side} />}
        {t(modsKey(`side.${side}`))}
      </span>
      {(compact ? tags.slice(0, 2) : tags).map((tag) => (
        <span key={tag.id}>{modTagLabel(tag, t)}</span>
      ))}
    </div>
  );
}
export function ModsChannel({ channel }: { channel: 'release' | 'beta' | 'alpha' }) {
  return channel === 'release' ? null : (
    <span className="mods-channel">{channel.toUpperCase()}</span>
  );
}
export function ModsEmpty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mods-empty">
      <ModsIcon name="mod" />
      <p>{children}</p>
      {action}
    </div>
  );
}
export function ModsSkeleton({ rows = 5 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="mods-skeleton" role="status" aria-label={t(modsKey('loading'))}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i.toString()} aria-hidden="true">
          <i />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
export function ModsPagination({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange(offset: number): void;
}) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / 20));
  return (
    <div className="mods-pagination">
      <ModsAction
        icon="back"
        label={t(modsKey('previous'))}
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - 20))}
      />
      <span>{t(modsKey('page'), { page: Math.floor(offset / 20) + 1, pages })}</span>
      <ModsAction
        icon="next"
        label={t(modsKey('next'))}
        disabled={offset + 20 >= total || offset >= 9980}
        onClick={() => onChange(offset + 20)}
      />
    </div>
  );
}
export function projectIdentity(project: Pick<ModCatalogProject, 'provider' | 'id'>) {
  return `${project.provider}:${project.id}`;
}
