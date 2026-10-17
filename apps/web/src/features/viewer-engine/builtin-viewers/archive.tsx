import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, download } from '../../../api/client.js';
import { useFormat, useT } from '../../../app/i18n.js';
import { Tooltip } from '../../../components/tooltip.js';
import { Empty, ErrorNotice } from '../../../components/ui.js';
import {
  FilemanContextMenu,
  FilemanListing,
  FilemanListSkeleton,
  FilemanParent,
  FilemanSearch,
  FilemanSelectionBar,
  FilemanToolbar,
  FilemanToolbarIcon,
  FilemanViewToggle,
} from '../../fileman/presentation.js';
import { serverPath } from '../../service-contracts.js';
import { viewerPath } from '../core/access.js';
import { trimArchivePages } from '../core/archive-memory.js';
import {
  type ArchiveEntry,
  archiveQuery,
  archivePageSize as pageSize,
  type ArchiveSort as Sort,
} from '../core/archive-query.js';
import type { ViewerProps } from '../core/types.js';

export default function ArchiveViewer({
  serverId,
  source,
  identity,
  onOpen,
  onOpenWith,
  chrome,
  listingView,
  onListingView,
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
  const [localView, setLocalView] = useState<'list' | 'grid'>('list');
  const view = listingView ?? localView;
  const setView = onListingView ?? setLocalView;
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [selected, setSelected] = useState<Map<string, ArchiveEntry>>(new Map());
  const anchor = useRef<string | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ entry: ArchiveEntry; x: number; y: number }>();
  const prefetchingFolder = useRef(false);
  const archivesKey = JSON.stringify(source.archives ?? []);
  const options = useCallback(
    (folder: string, start: number, filter = query) =>
      archiveQuery(serverId, identity, source, folder, start, filter, sort, direction),
    [identity, serverId, source, query, sort, direction],
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
  const rows = entries.map((entry) => ({
    ...entry,
    is_file: !entry.directory,
    is_symlink: false,
    modified_at: entry.modifiedAt ?? null,
  }));
  const selectedNames = new Set([...selected.values()].map((entry) => entry.name));
  const searchControl = (
    <FilemanSearch
      value={search}
      onChange={setSearch}
      inputRef={searchInput}
      shortcut={macKeyboard ? '⌥ + K' : 'ALT + K'}
    />
  );
  const toolsControl = (
    <Tooltip placement="cursor" content={t('file.refresh')}>
      <button
        type="button"
        className="fm-tool"
        aria-label={t('file.refresh')}
        disabled={page.isFetching}
        onClick={() => void page.refetch()}
      >
        <FilemanToolbarIcon kind="refresh" />
      </button>
    </Tooltip>
  );
  const viewControl = <FilemanViewToggle view={view} onChange={setView} />;
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
          scroll.current?.querySelector<HTMLButtonElement>('.fm-filename')?.focus();
        }
      }}
    >
      {chrome?.search && chrome?.view && chrome?.tools ? (
        <>
          {createPortal(searchControl, chrome.search)}
          {createPortal(toolsControl, chrome.tools)}
          {createPortal(viewControl, chrome.view)}
        </>
      ) : (
        <FilemanToolbar>
          {searchControl}
          <div className="fm-tools">{toolsControl}</div>
          {viewControl}
        </FilemanToolbar>
      )}
      {!!selected.size && !accessLost && (
        <FilemanSelectionBar count={selected.size} onClear={() => setSelected(new Map())}>
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
              <FilemanToolbarIcon kind="download" />
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
                <FilemanToolbarIcon kind="extract" />
              </button>
            </Tooltip>
          )}
        </FilemanSelectionBar>
      )}
      {page.error && <ErrorNotice error={page.error} retry={() => void page.refetch()} />}
      {page.isPending ? (
        <FilemanListSkeleton view={view} />
      ) : (
        !accessLost &&
        page.data && (
          <>
            <FilemanListing
              entries={rows}
              view={view}
              selected={selectedNames}
              order={sort === 'modifiedAt' ? 'date' : sort}
              descending={direction === 'desc'}
              fetching={busy}
              totalCount={page.data.total}
              listRef={scroll}
              gameId={source.gameId}
              isArchive={(name) => /\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar|jar)$/i.test(name)}
              menuEntry={menu?.entry.name}
              onSort={(field) => {
                const next = field === 'date' ? 'modifiedAt' : field;
                setDirection(sort === next && direction === 'asc' ? 'desc' : 'asc');
                setSort(next);
                setOffset(0);
              }}
              onSelectAll={(checked) =>
                setSelected((previous) => {
                  const next = new Map(previous);
                  for (const entry of entries) {
                    if (checked) next.set(entry.path, entry);
                    else next.delete(entry.path);
                  }
                  return next;
                })
              }
              onSelect={(entry, event) => select(entry, event, true)}
              onOpen={(entry, event) =>
                event.ctrlKey || event.metaKey || event.shiftKey
                  ? select(entry, event)
                  : open(entry)
              }
              onMenu={(entry, trigger, x, y) =>
                showMenu(entry, trigger, x !== undefined && y !== undefined ? { x, y } : undefined)
              }
              parent={
                directory || onArchiveBack ? (
                  <FilemanParent
                    onClick={() =>
                      directory
                        ? navigate(directory.split('/').slice(0, -1).join('/'))
                        : onArchiveBack?.()
                    }
                  />
                ) : undefined
              }
              empty={<Empty text={t(query ? 'file.noMatches' : 'service.folderEmpty')} />}
              rowProps={(entry) => ({
                onMouseDown: (event) => {
                  if (
                    event.button === 0 &&
                    (event.ctrlKey || event.metaKey || event.shiftKey) &&
                    !(event.target as HTMLElement).closest('input,.fm-menu-trigger')
                  )
                    event.preventDefault();
                },
                onClickCapture: (event) => {
                  if ((event.target as HTMLElement).closest('button,input')) return;
                  select(entry, event);
                  event.currentTarget.querySelector<HTMLButtonElement>('.fm-filename')?.focus();
                },
                onMouseEnter: () => {
                  if (entry.directory && !prefetchingFolder.current) {
                    prefetchingFolder.current = true;
                    void cache
                      .prefetchQuery({ ...options(entry.path, 0, ''), staleTime: 30_000 })
                      .finally(() => {
                        prefetchingFolder.current = false;
                        trimArchivePages(options(directory, offset).queryKey);
                      });
                  }
                },
                onKeyDown: (event) => {
                  if (!(event.target as HTMLElement).matches('.fm-filename')) return;
                  if (event.key === ' ') {
                    event.preventDefault();
                    select(entry, event, true);
                  }
                  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const index = entries.findIndex((item) => item.path === entry.path);
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
                      ?.querySelectorAll<HTMLButtonElement>('.fm-filename')
                      [next]?.focus();
                  }
                },
              })}
            />
            {page.data.total > pageSize && (
              <div className="ve-pagination">
                <button
                  type="button"
                  className="secondary"
                  disabled={offset === 0 || busy}
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
                  disabled={offset + pageSize >= page.data.total || busy}
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
          <FilemanContextMenu
            ref={menuRef}
            label={t('file.actionsFor', { name: menu.entry.name })}
            left={menu.x}
            top={menu.y}
            onClose={() => {
              setMenu(undefined);
              menuTrigger.current?.focus();
            }}
          >
            <button type="button" role="menuitem" onClick={() => open(menu.entry)}>
              {t(menu.entry.directory ? 'service.openFolder' : 'viewer.open')}
            </button>
            {!menu.entry.directory && onOpenWith && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenWith({
                    ...source,
                    name: menu.entry.name,
                    size: menu.entry.size,
                    entry: menu.entry.path,
                  });
                  setMenu(undefined);
                }}
              >
                {t('viewer.openWith')}
              </button>
            )}
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
          </FilemanContextMenu>,
          document.body,
        )}
    </section>
  );
}
