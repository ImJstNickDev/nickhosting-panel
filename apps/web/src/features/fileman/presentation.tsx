import type { ButtonHTMLAttributes, HTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';
import { useFormat, useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { Time } from '../../components/ui.js';
import { FileIcon } from '../file-icon.js';
import type { FileOrder } from '../file-manager-model.js';
import '../files.css';
import { FilemanSlot } from './host.js';

/** Presentation only: adapters retain navigation, selection, and mutation ownership. */
export interface FilemanEntry {
  name: string;
  size: number;
  is_file: boolean;
  is_symlink: boolean;
  modified_at: string | null;
}
export type FilemanView = 'list' | 'grid';

const filePlaceholders = Array.from({ length: 12 }, (_, index) => ({
  id: `file-placeholder-${index}`,
  width: `${40 + (index % 4) * 12}%`,
}));

export function FilemanListSkeleton({ view }: { view: 'list' | 'grid' }) {
  const t = useT();
  return (
    <>
      <div className={`fm-list fm-${view} fm-loading`} aria-busy="true">
        <div className="fm-columns" aria-hidden="true">
          <span className="fm-skeleton fm-skeleton-check" />
          <span className="fm-skeleton fm-skeleton-heading" />
          <span className="fm-skeleton fm-skeleton-heading" />
          <span className="fm-skeleton fm-skeleton-heading" />
        </div>
        <ul aria-hidden="true">
          {filePlaceholders.map(({ id, width }) => (
            <li className="fm-entry" key={id}>
              <span className="fm-skeleton fm-skeleton-check" />
              <span className="fm-filename">
                <span className="fm-skeleton fm-skeleton-icon" />
                <span className="fm-skeleton fm-skeleton-name" style={{ width }} />
              </span>
              <span className="fm-size">
                <span className="fm-skeleton" />
              </span>
              <span className="fm-date">
                <span className="fm-skeleton" />
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="fm-count" aria-hidden="true">
        <span className="fm-skeleton fm-skeleton-heading" />
      </div>
      <span className="sr-only" role="status">
        {t('web.loading')}
      </span>
    </>
  );
}

export function FilemanToolbarIcon({
  kind,
}: {
  kind:
    | 'extract'
    | 'folder'
    | 'file'
    | 'upload'
    | 'uploadFolder'
    | 'refresh'
    | 'path'
    | 'rename'
    | 'home'
    | 'save'
    | 'undo'
    | 'redo'
    | 'find'
    | 'download'
    | 'move'
    | 'copy'
    | 'delete'
    | 'clear';
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'extract' ? (
        <path d="M3 7h7l2 3h9v11H3ZM12 3v11m-4-4 4 4 4-4" />
      ) : kind === 'download' ? (
        <path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" />
      ) : kind === 'move' ? (
        <path d="M3 7V5h7l2 3h9v12H3V7Zm4 7h10m-3-3 3 3-3 3" />
      ) : kind === 'copy' ? (
        <path d="M9 8h12v13H9ZM5 16H3V3h12v2" />
      ) : kind === 'delete' ? (
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
      ) : kind === 'clear' ? (
        <path d="m6 6 12 12M6 18 18 6" />
      ) : kind === 'home' ? (
        <path d="m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10" />
      ) : kind === 'save' ? (
        <path d="M4 3h13l3 3v15H4ZM8 3v6h8V3M8 21v-8h8v8" />
      ) : kind === 'undo' ? (
        <path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12" />
      ) : kind === 'redo' ? (
        <path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12" />
      ) : kind === 'find' ? (
        <>
          <circle cx="10" cy="10" r="6" />
          <path d="m15 15 6 6" />
        </>
      ) : kind === 'path' ? (
        <path d="M3 6h7l2 3h9v11H3V6Zm5 9h8m-3-3 3 3-3 3" />
      ) : kind === 'rename' ? (
        <path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" />
      ) : kind === 'refresh' ? (
        <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" />
      ) : kind === 'upload' ? (
        <path d="M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5" />
      ) : kind === 'file' ? (
        <>
          <path d="M14 3H5v18h14V8l-5-5v5h5" />
          <path d="M12 12v6m-3-3h6" />
        </>
      ) : (
        <>
          <path d="M3 7V5h7l2 3h9v12H3V7Z" />
          {kind === 'folder' ? <path d="M12 11v6m-3-3h6" /> : <path d="M12 18v-7m-3 3 3-3 3 3" />}
        </>
      )}
    </svg>
  );
}
export function FilemanToolbar({
  editing = false,
  children,
}: {
  editing?: boolean;
  children: ReactNode;
}) {
  return (
    <FilemanSlot name="toolbar">
      <div className={`fm-toolbar ${editing ? 'fm-toolbar-editing' : ''}`}>{children}</div>
    </FilemanSlot>
  );
}

export function FilemanSearch({
  value,
  onChange,
  inputRef,
  onFocus,
  shortcut,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  onFocus?: () => void;
  shortcut?: string;
}) {
  const t = useT();
  return (
    <FilemanSlot name="search">
      <div className="fm-search">
        <input
          ref={inputRef}
          type="search"
          aria-label={t('file.search')}
          aria-keyshortcuts={shortcut ? 'Alt+K' : undefined}
          placeholder={t('file.searchLabel')}
          value={value}
          onFocus={onFocus}
          onChange={(event) => onChange(event.target.value)}
        />
        {shortcut && (
          <span aria-hidden="true">
            <kbd>{shortcut}</kbd>
          </span>
        )}
      </div>
    </FilemanSlot>
  );
}

export function FilemanViewToggle({
  view,
  onChange,
}: {
  view: FilemanView;
  onChange: (view: FilemanView) => void;
}) {
  const t = useT();
  return (
    <FilemanSlot name="view-toggle">
      <fieldset className="fm-view" aria-label={t('file.view')}>
        <button
          type="button"
          className="secondary fm-icon-button"
          aria-label={t('file.list')}
          aria-pressed={view === 'list'}
          onClick={() => onChange('list')}
        >
          ☰
        </button>
        <button
          type="button"
          className="secondary fm-icon-button"
          aria-label={t('file.grid')}
          aria-pressed={view === 'grid'}
          onClick={() => onChange('grid')}
        >
          ▦
        </button>
      </fieldset>
    </FilemanSlot>
  );
}

export function FilemanBreadcrumbs({
  parts,
  onNavigate,
  rootLabel,
  listRef,
  buttonProps,
  current = true,
  trailing,
  actions,
}: {
  parts: readonly { path: string; name: string }[];
  onNavigate: (path: string) => void;
  rootLabel?: string;
  listRef?: Ref<HTMLOListElement>;
  buttonProps?: (part: { path: string; name: string }) => ButtonHTMLAttributes<HTMLButtonElement>;
  current?: boolean;
  trailing?: ReactNode;
  actions?: ReactNode;
}) {
  const t = useT();
  return (
    <FilemanSlot name="breadcrumb">
      <nav aria-label={t('file.breadcrumb')} className="fm-breadcrumb">
        <ol ref={listRef}>
          {parts.map((part, index) => {
            const props = buttonProps?.(part);
            return (
              <li key={part.path}>
                <button
                  type="button"
                  {...props}
                  className={`text-button ${props?.className ?? ''}`}
                  aria-current={current && index === parts.length - 1 ? 'page' : undefined}
                  onClick={() => onNavigate(part.path)}
                >
                  {index === 0 ? (rootLabel ?? t('file.root')) : part.name}
                </button>
              </li>
            );
          })}
          {trailing}
        </ol>
        {actions}
      </nav>
    </FilemanSlot>
  );
}

export function FilemanSelectionBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <FilemanSlot name="selection">
      <section className="fm-selection" aria-label={t('file.selection')}>
        <span className="fm-selection-count">{t('file.selected', { count })}</span>
        <div className="fm-selection-actions">{children}</div>
        <Tooltip placement="cursor" content={t('file.clearSelection')}>
          <button
            type="button"
            className="fm-tool fm-selection-clear"
            aria-label={t('file.clearSelection')}
            onClick={onClear}
          >
            <FilemanToolbarIcon kind="clear" />
          </button>
        </Tooltip>
      </section>
    </FilemanSlot>
  );
}

export function FilemanParent(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { 'data-drag-hover'?: boolean },
) {
  const t = useT();
  return (
    <div className="fm-parent">
      <button
        type="button"
        className="text-button"
        aria-label={t('service.parentFolder')}
        {...props}
      >
        <FileIcon folder />
        ..
      </button>
    </div>
  );
}

export interface FilemanListingProps<T extends FilemanEntry> {
  entries: readonly T[];
  view: FilemanView;
  selected: ReadonlySet<string>;
  order: FileOrder;
  descending: boolean;
  onSort: (field: FileOrder) => void;
  onSelectAll: (checked: boolean) => void;
  onSelect: (entry: T, event: MouseEvent<HTMLInputElement>) => void;
  onOpen: (entry: T, event: MouseEvent<HTMLButtonElement>) => void;
  onMenu?: (entry: T, trigger: HTMLElement, x?: number, y?: number) => void;
  menuEntry?: string;
  busy?: boolean;
  fetching?: boolean;
  totalCount?: number;
  listRef?: Ref<HTMLDivElement>;
  gameId?: string;
  isArchive?: (name: string) => boolean;
  rowProps?: (entry: T) => HTMLAttributes<HTMLLIElement> & { 'data-directory-path'?: string };
  parent?: ReactNode;
  empty?: ReactNode;
}

export function FilemanListing<T extends FilemanEntry>({
  entries,
  view,
  selected,
  order,
  descending,
  onSort,
  onSelectAll,
  onSelect,
  onOpen,
  onMenu,
  menuEntry,
  busy = false,
  fetching,
  totalCount,
  listRef,
  gameId,
  isArchive,
  rowProps,
  parent,
  empty,
}: FilemanListingProps<T>) {
  const t = useT(),
    format = useFormat();
  const selectable = entries.filter((entry) => !entry.is_symlink);
  return (
    <FilemanSlot name="listing">
      <div className={`fm-list fm-${view}`} ref={listRef} aria-busy={fetching || undefined}>
        <div className="fm-columns">
          <input
            type="checkbox"
            aria-label={t('file.selectAll')}
            ref={(input) => {
              if (input)
                input.indeterminate =
                  selectable.some((entry) => selected.has(entry.name)) &&
                  !selectable.every((entry) => selected.has(entry.name));
            }}
            checked={selectable.length > 0 && selectable.every((entry) => selected.has(entry.name))}
            onChange={(event) => onSelectAll(event.target.checked)}
          />
          {(['name', 'size', 'date'] as const).map((field) => {
            const key = field === 'date' ? 'file.modified' : `web.${field}`;
            const active = order === field;
            const arrow = active && (order !== 'name' || descending);
            return (
              <Tooltip
                placement="cursor"
                key={field}
                content={
                  active
                    ? t(descending ? 'file.descending' : 'file.ascending')
                    : t('file.sortColumn', { name: t(key) })
                }
              >
                <button
                  type="button"
                  className="fm-column-button"
                  aria-label={t(key)}
                  aria-pressed={active}
                  onClick={() => onSort(field)}
                >
                  {t(key)}
                  {arrow && (
                    <svg
                      className="fm-sort-arrow"
                      data-order={descending ? 'descending' : 'ascending'}
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      aria-hidden="true"
                    >
                      <path d={descending ? 'M8 2v12m-4-4 4 4 4-4' : 'M8 14V2m-4 4 4-4 4 4'} />
                    </svg>
                  )}
                </button>
              </Tooltip>
            );
          })}
          <span className="sr-only">{t('web.actions')}</span>
        </div>
        {parent}
        <ul aria-label={t('file.entries')}>
          {entries.map((entry) => {
            const props = rowProps?.(entry);
            const entryContext = {
              entry: { name: entry.name, directory: !entry.is_file, size: entry.size },
            };
            return (
              <li
                key={entry.name}
                {...props}
                className={`fm-entry ${selected.has(entry.name) ? 'fm-selected' : ''} ${props?.className ?? ''}`}
                onContextMenu={
                  onMenu
                    ? (event) => {
                        event.preventDefault();
                        onMenu(
                          entry,
                          event.currentTarget.querySelector<HTMLButtonElement>(
                            '.fm-menu-trigger',
                          ) ?? event.currentTarget,
                          event.clientX,
                          event.clientY,
                        );
                      }
                    : props?.onContextMenu
                }
              >
                <input
                  type="checkbox"
                  aria-label={t('file.select', { name: entry.name })}
                  disabled={entry.is_symlink || busy}
                  checked={selected.has(entry.name)}
                  onChange={() => {}}
                  onClick={(event) => onSelect(entry, event)}
                />
                <button
                  type="button"
                  className="fm-filename"
                  data-file-name={entry.name}
                  disabled={entry.is_symlink || busy}
                  onClick={(event) => onOpen(entry, event)}
                  onKeyDown={
                    onMenu
                      ? (event) => {
                          if (
                            event.key === 'ContextMenu' ||
                            (event.shiftKey && event.key === 'F10')
                          ) {
                            event.preventDefault();
                            onMenu(entry, event.currentTarget);
                          }
                        }
                      : undefined
                  }
                >
                  <FilemanSlot name="entry.icon" context={entryContext}>
                    <FileIcon
                      folder={!entry.is_file}
                      name={entry.name}
                      gameId={gameId}
                      archive={isArchive?.(entry.name)}
                    />
                  </FilemanSlot>
                  <FilemanSlot name="entry.name" context={entryContext}>
                    <span>
                      {entry.name}
                      {entry.is_symlink && <small> · {t('service.symlink')}</small>}
                    </span>
                  </FilemanSlot>
                </button>
                <FilemanSlot name="entry.metadata" context={entryContext}>
                  <span className="fm-size">{entry.is_file ? format.bytes(entry.size) : '—'}</span>
                  <span className="fm-date">
                    <Time value={entry.modified_at} />
                  </span>
                </FilemanSlot>
                <FilemanSlot name="entry.actions" context={entryContext}>
                  {onMenu && (
                    <button
                      type="button"
                      className="secondary fm-icon-button fm-menu-trigger"
                      aria-haspopup="menu"
                      aria-expanded={menuEntry === entry.name}
                      aria-label={t('file.actionsFor', { name: entry.name })}
                      onClick={(event) => onMenu(entry, event.currentTarget)}
                    >
                      ⋯
                    </button>
                  )}
                </FilemanSlot>
              </li>
            );
          })}
        </ul>
        {!entries.length && empty}
      </div>
      <div className="fm-count">{t('file.items', { count: totalCount ?? entries.length })}</div>
    </FilemanSlot>
  );
}

export function FilemanContextMenu({
  label,
  left,
  top,
  onClose,
  ref,
  children,
}: {
  label: string;
  left: number;
  top: number;
  onClose: () => void;
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <FilemanSlot name="context-menu">
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        className="fm-menu"
        style={{ left, top }}
        onKeyDown={(event) => {
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            buttons[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
            ]?.focus();
          }
          if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        {children}
      </div>
    </FilemanSlot>
  );
}
