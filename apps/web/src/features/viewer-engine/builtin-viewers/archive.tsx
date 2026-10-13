import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api, download } from '../../../api/client.js';
import { useFormat, useT } from '../../../app/i18n.js';
import { Tooltip } from '../../../components/tooltip.js';
import { ErrorNotice } from '../../../components/ui.js';
import { FileIcon } from '../../file-icon.js';
import { serverPath } from '../../service-contracts.js';
import { viewerPath } from '../core/access.js';
import { trimArchivePages } from '../core/archive-memory.js';
import type { ViewerProps } from '../core/types.js';
import { ViewerLoading } from '../loading.js';

interface ArchiveEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
  modifiedAt?: string | null;
}
interface ArchivePage {
  directory: string;
  offset: number;
  limit: number;
  total: number;
  entries: ArchiveEntry[];
}
type Sort = 'name' | 'size' | 'modifiedAt';
const pageSize = 200;
export default function ArchiveViewer({
  serverId,
  source,
  identity,
  onOpen,
  archiveDirectory = '',
  onArchiveDirectory,
  onArchiveBack,
  onExtract,
}: ViewerProps) {
  const t = useT();
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
  }, []);
  const macKeyboard = /Mac|iPhone|iPad/.test(navigator.platform);
  const format = useFormat();
  const cache = useQueryClient();
  const directory = archiveDirectory;
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [sortTouched, setSortTouched] = useState(false);
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [selected, setSelected] = useState<Map<string, ArchiveEntry>>(new Map());
  const anchor = useRef<string | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ entry: ArchiveEntry; x: number; y: number }>();
  const prefetchingFolder = useRef(false);
  const archivesKey = JSON.stringify(source.archives ?? []);
  const options = useCallback(
    (folder: string, start: number, filter = query) => {
      const params = new URLSearchParams({
        path: source.path,
        directory: folder,
        offset: String(start),
        limit: String(pageSize),
        query: filter,
        sort,
        direction,
        archives: archivesKey,
      });
      return {
        queryKey: [
          'viewer-archive',
          identity,
          serverId,
          source.path,
          archivesKey,
          folder,
          filter,
          sort,
          direction,
          start,
        ],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api<ArchivePage>(`${serverPath(serverId)}/files/viewer/archive?${params}`, { signal }),
        gcTime: 2 * 60_000,
        staleTime: 15_000,
      };
    },
    [identity, serverId, source.path, archivesKey, query, sort, direction],
  );
  const page = useQuery({
    ...options(directory, offset),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const accessLost = page.error instanceof ApiError && [401, 403, 404].includes(page.error.status);
  const entries = accessLost ? [] : (page.data?.entries ?? []);
  useEffect(() => {
    if (query === search.trim()) return;
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
      setSelected(new Map());
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search, query]);
  useEffect(() => {
    if (!page.dataUpdatedAt) return;
    trimArchivePages(options(directory, offset).queryKey);
    if (!page.error && page.data && offset + pageSize < page.data.total) {
      const next = options(directory, offset + pageSize);
      void cache
        .prefetchQuery(next)
        .then(() => trimArchivePages(options(directory, offset).queryKey));
    }
  }, [page.dataUpdatedAt, page.data, page.error, directory, offset, options, cache]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset scroll when the displayed page changes.
  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 });
  }, [directory, offset, query, sort, direction]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.code === 'KeyK' &&
        !event.isComposing &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function outside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined);
    }
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [menu]);
  function navigate(folder: string) {
    onArchiveDirectory?.(folder);
  }
  function open(entry: ArchiveEntry) {
    setMenu(undefined);
    if (entry.directory) navigate(entry.path);
    else onOpen({ ...source, name: entry.name, size: entry.size, entry: entry.path });
  }
  function select(
    entry: ArchiveEntry,
    modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
    toggle = false,
  ) {
    setSelected((previous) => {
      const next =
        modifiers.ctrlKey || modifiers.metaKey || toggle
          ? new Map(previous)
          : new Map<string, ArchiveEntry>();
      const start = entries.findIndex((item) => item.path === anchor.current);
      const end = entries.findIndex((item) => item.path === entry.path);
      if (modifiers.shiftKey && start >= 0 && end >= 0) {
        for (const item of entries.slice(Math.min(start, end), Math.max(start, end) + 1))
          next.set(item.path, item);
      } else if (next.has(entry.path)) next.delete(entry.path);
      else next.set(entry.path, entry);
      return next;
    });
    if (!modifiers.shiftKey) anchor.current = entry.path;
  }
  function downloadEntries(items: ArchiveEntry[]) {
    if (items.length === 1 && items[0] && !items[0].directory) {
      download(`${viewerPath(serverId, { ...source, entry: items[0].path })}&download=true`);
    } else {
      const params = new URLSearchParams({ path: source.path, archives: archivesKey });
      download(`${serverPath(serverId)}/files/viewer/archive/download?${params}`, {
        directory,
        entries: JSON.stringify(items.map((entry) => entry.path)),
      });
    }
    if (menu) menuTrigger.current?.focus();
    setMenu(undefined);
  }
  function extract(items: ArchiveEntry[]) {
    if (menu) menuTrigger.current?.focus();
    onExtract?.({ entries: items.map((item) => item.path), archives: source.archives });
    setMenu(undefined);
  }
  function showMenu(
    entry: ArchiveEntry,
    trigger: HTMLElement,
    coordinates?: { x: number; y: number },
  ) {
    menuTrigger.current = trigger;
    const rect = trigger.getBoundingClientRect();
    setMenu({
      entry,
      x: Math.max(8, Math.min(coordinates?.x ?? rect.right - 190, window.innerWidth - 208)),
      y: Math.max(8, Math.min(coordinates?.y ?? rect.bottom, window.innerHeight - 160)),
    });
  }
  const menuItems =
    menu && selected.has(menu.entry.path) ? [...selected.values()] : menu ? [menu.entry] : [];
  const busy = page.isFetching || query !== search.trim();
  return (
    <section
      className="ve-archive"
      ref={region}
      tabIndex={-1}
      aria-label={t('viewer.name.archive')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selected.size && !event.defaultPrevented) {
          event.preventDefault();
          setSelected(new Map());
        }
        if (
          !event.defaultPrevented &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'a' &&
          !(event.target as HTMLElement).closest('input,select,[role=menu]')
        ) {
          event.preventDefault();
          setSelected(new Map(entries.map((entry) => [entry.path, entry])));
        }
        if (event.target === event.currentTarget && event.key === 'ArrowDown') {
          event.preventDefault();
          scroll.current?.querySelector<HTMLButtonElement>('.ve-entry')?.focus();
        }
      }}
    >
      <div className="ve-archive-tools">
        <div className="fm-tools">
          <Tooltip placement="cursor" content={t('service.parentFolder')}>
            <button
              type="button"
              className="fm-tool"
              aria-label={t('service.parentFolder')}
              disabled={!directory && !onArchiveBack}
              onClick={() =>
                directory
                  ? navigate(directory.split('/').slice(0, -1).join('/'))
                  : onArchiveBack?.()
              }
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path d="m7 10 5-5 5 5M12 5v14" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip placement="cursor" content={t('file.refresh')}>
            <button
              type="button"
              className="fm-tool"
              aria-label={t('file.refresh')}
              disabled={page.isFetching}
              onClick={() => void page.refetch()}
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" />
              </svg>
            </button>
          </Tooltip>
          <span className="ve-archive-status" role="status">
            {page.data
              ? t('file.items', { count: page.data.total })
              : page.isPending
                ? t('web.loading')
                : ''}
          </span>
        </div>
        <div className="ve-archive-mobile-sort">
          <select
            aria-label={t('file.sort')}
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as Sort);
              setSortTouched(true);
              setOffset(0);
            }}
          >
            <option value="name">{t('web.name')}</option>
            <option value="size">{t('web.size')}</option>
            <option value="modifiedAt">{t('file.modified')}</option>
          </select>
          <Tooltip
            placement="cursor"
            content={t(direction === 'asc' ? 'file.ascending' : 'file.descending')}
          >
            <button
              type="button"
              className="fm-tool"
              aria-label={t(direction === 'asc' ? 'file.ascending' : 'file.descending')}
              onClick={() => {
                setDirection(direction === 'asc' ? 'desc' : 'asc');
                setOffset(0);
              }}
            >
              {direction === 'asc' ? '↑' : '↓'}
            </button>
          </Tooltip>
        </div>
        <div className="fm-search ve-archive-search">
          <input
            ref={searchInput}
            type="search"
            value={search}
            aria-label={t('file.search')}
            aria-keyshortcuts="Alt+K"
            placeholder={t('file.search')}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span aria-hidden="true">
            <kbd>{macKeyboard ? '⌥ + K' : 'ALT + K'}</kbd>
          </span>
        </div>
      </div>
      {!!selected.size && !accessLost && (
        <section className="ve-archive-selection" aria-label={t('file.selection')}>
          <span role="status">{t('file.selected', { count: selected.size })}</span>
          <Tooltip
            placement="cursor"
            content={t(
              selected.size === 1 && ![...selected.values()][0]?.directory
                ? 'web.download'
                : 'file.downloadZip',
            )}
          >
            <button
              type="button"
              className="fm-tool"
              aria-label={t(
                selected.size === 1 && ![...selected.values()][0]?.directory
                  ? 'web.download'
                  : 'file.downloadZip',
              )}
              onClick={() => downloadEntries([...selected.values()])}
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" />
              </svg>
            </button>
          </Tooltip>
          {onExtract && (
            <Tooltip placement="cursor" content={t('file.extract')}>
              <button
                type="button"
                className="fm-tool"
                aria-label={t('file.extract')}
                onClick={() => extract([...selected.values()])}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  aria-hidden="true"
                >
                  <path d="M3 7V5h7l2 3h9v13H3V7ZM12 17v-7m-3 3 3-3 3 3" />
                </svg>
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            className="fm-tool"
            aria-label={t('file.clearSelection')}
            onClick={() => setSelected(new Map())}
          >
            ×
          </button>
        </section>
      )}
      {page.error && <ErrorNotice error={page.error} retry={() => void page.refetch()} />}
      {page.isPending ? (
        <ViewerLoading />
      ) : (
        !accessLost &&
        page.data && (
          <>
            <section
              aria-label={t('file.entries')}
              className="ve-archive-list"
              ref={scroll}
              aria-busy={busy}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                  event.preventDefault();
                  setSelected(new Map(entries.map((item) => [item.path, item])));
                }
                if (event.key === 'Escape' && selected.size && !event.defaultPrevented) {
                  event.preventDefault();
                  setSelected(new Map());
                }
              }}
            >
              <table aria-label={t('file.entries')}>
                <thead>
                  <tr>
                    <th className="ve-archive-check" scope="col">
                      <input
                        type="checkbox"
                        aria-label={t('viewer.archiveSelectPage')}
                        checked={
                          entries.length > 0 && entries.every((entry) => selected.has(entry.path))
                        }
                        ref={(element) => {
                          if (element)
                            element.indeterminate =
                              entries.some((entry) => selected.has(entry.path)) &&
                              !entries.every((entry) => selected.has(entry.path));
                        }}
                        onChange={(event) =>
                          setSelected((previous) => {
                            const next = new Map(previous);
                            for (const entry of entries) {
                              if (event.target.checked) next.set(entry.path, entry);
                              else next.delete(entry.path);
                            }
                            return next;
                          })
                        }
                      />
                    </th>
                    {(
                      [
                        ['name', 'web.name'],
                        ['size', 'web.size'],
                        ['modifiedAt', 'file.modified'],
                      ] as const
                    ).map(([field, label]) => (
                      <th
                        key={field}
                        scope="col"
                        aria-sort={
                          sort === field
                            ? direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                        className={field === 'modifiedAt' ? 've-archive-date' : undefined}
                      >
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setSort(field);
                            setSortTouched(true);
                            setDirection(sort === field && direction === 'asc' ? 'desc' : 'asc');
                            setOffset(0);
                          }}
                        >
                          {t(label)}
                          {sort === field && sortTouched && (
                            <span aria-hidden="true">{direction === 'asc' ? ' ↑' : ' ↓'}</span>
                          )}
                        </button>
                      </th>
                    ))}
                    <th scope="col" className="ve-archive-action">
                      <span className="sr-only">{t('web.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, index) => (
                    <tr
                      key={entry.path}
                      className={selected.has(entry.path) ? 'fm-selected' : undefined}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        showMenu(
                          entry,
                          event.currentTarget.querySelector<HTMLButtonElement>('.ve-entry') ??
                            event.currentTarget,
                          { x: event.clientX, y: event.clientY },
                        );
                      }}
                      onClick={(event) => {
                        if (!(event.target as HTMLElement).closest('button,input'))
                          select(entry, event);
                      }}
                    >
                      <td className="ve-archive-check">
                        <input
                          type="checkbox"
                          aria-label={t('file.select', { name: entry.name })}
                          checked={selected.has(entry.path)}
                          onClick={(event) => select(entry, event, true)}
                          onChange={() => {}}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ve-entry"
                          onMouseEnter={() => {
                            if (entry.directory && !prefetchingFolder.current) {
                              prefetchingFolder.current = true;
                              void cache
                                .prefetchQuery({ ...options(entry.path, 0, ''), staleTime: 30_000 })
                                .finally(() => {
                                  prefetchingFolder.current = false;
                                  trimArchivePages(options(directory, offset).queryKey);
                                });
                            }
                          }}
                          onClick={(event) =>
                            event.ctrlKey || event.metaKey || event.shiftKey
                              ? select(entry, event)
                              : open(entry)
                          }
                          onKeyDown={(event) => {
                            if (event.key === ' ') {
                              event.preventDefault();
                              select(entry, event, true);
                            }
                            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                              event.preventDefault();
                              const next =
                                event.key === 'Home'
                                  ? 0
                                  : event.key === 'End'
                                    ? entries.length - 1
                                    : Math.max(
                                        0,
                                        Math.min(
                                          entries.length - 1,
                                          index + (event.key === 'ArrowUp' ? -1 : 1),
                                        ),
                                      );
                              if (event.shiftKey && entries[next]) {
                                anchor.current ??= entry.path;
                                select(entries[next], event);
                              }
                              scroll.current
                                ?.querySelectorAll<HTMLButtonElement>('.ve-entry')
                                [next]?.focus();
                            }
                            if (
                              event.key === 'ContextMenu' ||
                              (event.shiftKey && event.key === 'F10')
                            ) {
                              event.preventDefault();
                              showMenu(entry, event.currentTarget);
                            }
                          }}
                        >
                          <FileIcon
                            name={entry.name}
                            folder={entry.directory}
                            archive={/\.(?:zip|jar|tar|tgz|gz|bz2|xz|zst|7z|rar)$/i.test(
                              entry.name,
                            )}
                          />
                          <span>{entry.name}</span>
                        </button>
                      </td>
                      <td className="ve-archive-size">
                        {entry.directory ? '—' : format.bytes(entry.size)}
                      </td>
                      <td className="ve-archive-date">
                        {entry.modifiedAt ? format.date(entry.modifiedAt) : '—'}
                      </td>
                      <td className="ve-archive-action">
                        <button
                          type="button"
                          className="secondary fm-icon-button fm-menu-trigger"
                          aria-label={t('file.actionsFor', { name: entry.name })}
                          aria-haspopup="menu"
                          aria-expanded={menu?.entry.path === entry.path}
                          onClick={(event) => showMenu(entry, event.currentTarget)}
                        >
                          ⋯
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!entries.length && (
                <p className="ve-empty">{t(query ? 'file.noMatches' : 'service.folderEmpty')}</p>
              )}
            </section>
            {page.data && page.data.total > pageSize && (
              <div className="ve-pagination">
                <button
                  type="button"
                  className="secondary"
                  disabled={offset === 0}
                  onClick={() => setOffset((value) => Math.max(0, value - pageSize))}
                >
                  {t('viewer.previous')}
                </button>
                <span>
                  {format.number(offset + 1, 0)}–
                  {format.number(Math.min(offset + pageSize, page.data.total), 0)} /{' '}
                  {format.number(page.data.total, 0)}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={offset + pageSize >= page.data.total}
                  onClick={() => setOffset((value) => value + pageSize)}
                >
                  {t('viewer.next')}
                </button>
              </div>
            )}
          </>
        )
      )}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={t('file.actionsFor', { name: menu.entry.name })}
            className="fm-menu ve-archive-menu"
            style={{ left: menu.x, top: menu.y }}
            onKeyDown={(event) => {
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
              ];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                buttons[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buttons.length - 1
                      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) %
                        buttons.length
                ]?.focus();
              }
              if (event.key === 'Escape' || event.key === 'Tab') {
                event.preventDefault();
                setMenu(undefined);
                menuTrigger.current?.focus();
              }
            }}
          >
            <button type="button" role="menuitem" onClick={() => open(menu.entry)}>
              {t(menu.entry.directory ? 'service.openFolder' : 'viewer.open')}
            </button>
            <button type="button" role="menuitem" onClick={() => downloadEntries(menuItems)}>
              {t(
                menuItems.length === 1 && !menu.entry.directory
                  ? 'web.download'
                  : 'file.downloadZip',
              )}
            </button>
            {onExtract && (
              <button type="button" role="menuitem" onClick={() => extract(menuItems)}>
                {t('file.extract')}
              </button>
            )}
          </div>,
          document.body,
        )}
    </section>
  );
}
