import { useQuery } from '@tanstack/react-query';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { listPlatformServers } from '../../../../packages/server-management/src/platform-queries.js';
import { api, queryClient } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import { Empty, ErrorNotice, Loading, Page, Select } from '../components/ui.js';
import { creationGamesQuery } from './creation-catalog.js';
import { ServerCards } from './servers.js';
import './server-browser.css';

type Filters = {
  q: string;
  state: string;
  gameId: string;
  runtimeId: string;
  version: string;
  projectId: string;
  ownerId: string;
};
const emptyFilters: Filters = {
  q: '',
  state: '',
  gameId: '',
  runtimeId: '',
  version: '',
  projectId: '',
  ownerId: '',
};

export function ServersPage() {
  const t = useT();
  const session = useSession();
  const isOwner =
    session.data?.context.role === 'owner' && session.data.context.sessionType === 'regular';
  const identity = session.data
    ? `${session.data.context.actorUserId}:${session.data.context.subjectUserId}:${session.data.context.sessionType}`
    : '';
  const [others, setOthers] = useState(false);
  const scope = isOwner ? (others ? 'others' : 'mine') : '';
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('nh.servers.view') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const searchInput = useRef<HTMLInputElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const filterPanel = useRef<HTMLElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [{ page, limit: pageLimit }, setPage] = useState({ page: 1, limit: 0 });
  const mobile = size.width < 600;
  const itemHeight = view === 'grid' ? 264 : mobile ? 110 : 86;
  const columns =
    view === 'list' || size.height < 120 ? 1 : Math.max(1, Math.floor((size.width + 12) / 272));
  const limit = Math.min(
    100,
    columns * Math.max(1, Math.floor((size.height + 12) / (itemHeight + 12))),
  );
  const currentPage = pageLimit === limit ? page : 1;
  const resetPage = () => setPage({ page: 1, limit });
  const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

  useLayoutEffect(() => {
    const measure = () => {
      if (container.current) {
        const main = container.current.closest('main');
        const bottom = Math.max(
          20,
          main ? Number.parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0,
        );
        setHeight(
          Math.max(0, window.innerHeight - container.current.getBoundingClientRect().top - bottom),
        );
      }
      if (results.current) {
        const rect = results.current.getBoundingClientRect();
        setSize((old) =>
          old.width === rect.width && old.height === rect.height
            ? old
            : { width: rect.width, height: rect.height },
        );
      }
    };
    const observer = new ResizeObserver(measure);
    if (container.current) observer.observe(container.current);
    if (results.current) observer.observe(results.current);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((old) => (old.q === search.trim() ? old : { ...old, q: search.trim() }));
      if (search.trim() !== filters.q) setPage({ page: 1, limit });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search, filters.q, limit]);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.code !== 'KeyK' ||
        document.querySelector('dialog[open]')
      )
        return;
      event.preventDefault();
      setExpanded(false);
      searchInput.current?.focus();
      searchInput.current?.select();
    };
    document.addEventListener('keydown', focus);
    return () => document.removeEventListener('keydown', focus);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!filterPanel.current?.contains(target) && !filterButton.current?.contains(target))
        setExpanded(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false);
        filterButton.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [expanded]);
  useEffect(() => {
    void queryClient.prefetchQuery(creationGamesQuery);
  }, []);
  const update = (patch: Partial<Filters>) => {
    setFilters((old) => ({ ...old, q: search.trim(), ...patch }));
    resetPage();
  };
  const params = new URLSearchParams({ limit: String(limit), page: String(currentPage) });
  for (const [key, value] of Object.entries(filters)) {
    if (value && (key !== 'ownerId' || scope === 'others')) params.set(key, value);
  }
  if (scope) params.set('scope', scope);
  const servers = useQuery({
    queryKey: ['servers', 'browse', scope, params.toString(), identity],
    queryFn: ({ signal }) =>
      api<Result<typeof listPlatformServers>>(`/v1/platform/servers?${params}`, { signal }),
    enabled: Boolean(identity && size.width && size.height),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === scope && previousQuery.queryKey[4] === identity
        ? previous
        : undefined,
    refetchInterval: 15000,
  });
  const options = servers.data?.filterOptions;
  const busy = servers.isFetching || filters.q !== search.trim();
  const additional = ['gameId', 'runtimeId', 'version', 'projectId', 'ownerId'] as const;
  const activeCount = additional.filter((key) => filters[key]).length;
  const setMode = (mode: 'grid' | 'list') => {
    setView(mode);
    resetPage();
    try {
      localStorage.setItem('nh.servers.view', mode);
    } catch {
      /* Optional view preference. */
    }
  };
  return (
    <div
      ref={container}
      className="server-browser"
      style={{ height: height || 'calc(100dvh - 110px)' }}
    >
      <Page
        title={t('web.servers')}
        actions={
          <>
            <Link className="button secondary" to="/projects">
              {t('web.projects')}
            </Link>
            <Link className="button" to="/servers/new">
              {t('web.createServer')}
            </Link>
          </>
        }
      >
        <div className="server-browser-toolbar">
          <div className="server-browser-search">
            <label className="visually-hidden" htmlFor="server-search">
              {t('platform.searchServers')}
            </label>
            <input
              id="server-search"
              ref={searchInput}
              type="search"
              value={search}
              maxLength={100}
              autoComplete="off"
              placeholder={t('platform.searchServers')}
              aria-keyshortcuts="Alt+K"
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd>{mac ? '⌥ + K' : 'ALT + K'}</kbd>
          </div>
          <fieldset className="server-browser-segments" aria-label={t('web.status')}>
            {(['', 'running', 'offline'] as const).map((state) => (
              <button
                key={state}
                type="button"
                aria-pressed={filters.state === state}
                onClick={() => update({ state })}
              >
                {t(
                  state === ''
                    ? 'web.all'
                    : state === 'running'
                      ? 'platform.online'
                      : 'web.offline',
                )}
              </button>
            ))}
          </fieldset>
          <Tooltip content={t('platform.serverFilters')}>
            <button
              type="button"
              className="server-browser-icon"
              ref={filterButton}
              aria-label={t('platform.serverFilters')}
              aria-expanded={expanded}
              aria-controls="server-filter-panel"
              onClick={() => setExpanded(!expanded)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16M4 17h16M8 4v6m8 4v6" />
              </svg>
              {activeCount > 0 && <span className="server-filter-count">{activeCount}</span>}
            </button>
          </Tooltip>
          <fieldset
            className="server-browser-segments server-view-toggle"
            aria-label={t('platform.serverView')}
          >
            {(['grid', 'list'] as const).map((mode) => (
              <Tooltip key={mode} content={t(`file.${mode}`)}>
                <button
                  type="button"
                  className="server-browser-icon"
                  aria-label={t(`file.${mode}`)}
                  aria-pressed={view === mode}
                  onClick={() => setMode(mode)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d={
                        mode === 'grid'
                          ? 'M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z'
                          : 'M8 5h12M8 12h12M8 19h12M3 5h1m-1 7h1m-1 7h1'
                      }
                    />
                  </svg>
                </button>
              </Tooltip>
            ))}
          </fieldset>
          {isOwner && (
            <div className="server-owner-switch">
              <span className={!others ? 'active' : ''}>{t('platform.myServers')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={others}
                aria-label={t('platform.otherServers')}
                onClick={() => {
                  setOthers(!others);
                  setFilters({ ...emptyFilters, q: search.trim() });
                  resetPage();
                }}
              >
                <span />
              </button>
              <span className={others ? 'active' : ''}>{t('platform.otherServers')}</span>
            </div>
          )}
          {expanded && (
            <section
              className="server-filter-panel"
              id="server-filter-panel"
              ref={filterPanel}
              aria-label={t('platform.serverFilters')}
            >
              <Select
                label={t('platform.game')}
                value={filters.gameId}
                onChange={(event) =>
                  update({ gameId: event.target.value, runtimeId: '', version: '' })
                }
              >
                <option value="">{t('web.all')}</option>
                {options?.games.map((game) => (
                  <option key={game.id} value={game.id}>
                    {game.nameKey ? t(game.nameKey) : game.id}
                  </option>
                ))}
              </Select>
              {Boolean(options?.runtimes.length) && (
                <Select
                  label={t('platform.runtime')}
                  value={filters.runtimeId}
                  onChange={(event) => update({ runtimeId: event.target.value, version: '' })}
                >
                  <option value="">{t('web.all')}</option>
                  {options?.runtimes.map((runtime) => (
                    <option key={runtime} value={runtime}>
                      {runtime}
                    </option>
                  ))}
                </Select>
              )}
              {Boolean(options?.versions.length) && (
                <Select
                  label={t('gameUi.version')}
                  value={filters.version}
                  onChange={(event) => update({ version: event.target.value })}
                >
                  <option value="">{t('web.all')}</option>
                  {options?.versions.map((version) => (
                    <option key={version} value={version}>
                      {version}
                    </option>
                  ))}
                </Select>
              )}
              <Select
                label={t('platform.project')}
                value={filters.projectId}
                onChange={(event) => update({ projectId: event.target.value })}
              >
                <option value="">{t('web.all')}</option>
                <option value="none">{t('platform.noProject')}</option>
                {options?.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
              {scope === 'others' && (
                <Select
                  label={t('platform.owner')}
                  value={filters.ownerId}
                  onChange={(event) => update({ ownerId: event.target.value })}
                >
                  <option value="">{t('web.all')}</option>
                  {options?.owners.map((owner) => (
                    <option key={owner.id} value={owner.id}>
                      {owner.name}
                    </option>
                  ))}
                </Select>
              )}
              <button
                type="button"
                className="secondary server-clear-filters"
                disabled={!activeCount}
                onClick={() =>
                  update({ gameId: '', runtimeId: '', version: '', projectId: '', ownerId: '' })
                }
              >
                {t('platform.clearServerFilters')}
              </button>
            </section>
          )}
        </div>
        <div
          ref={results}
          className="server-browser-results"
          aria-busy={busy}
          data-view={view}
          data-compact={size.height < 230 || undefined}
          data-tight={size.height < 120 || undefined}
          style={
            {
              '--server-columns': columns,
              '--server-item-height': `${Math.min(itemHeight, size.height || itemHeight)}px`,
            } as CSSProperties
          }
        >
          {servers.isPending ? (
            <Loading />
          ) : servers.error ? (
            <ErrorNotice error={servers.error} retry={() => void servers.refetch()} />
          ) : servers.data?.items.length ? (
            <ServerCards
              items={servers.data.items.slice(0, limit)}
              view={view}
              ownerNames={
                scope === 'others'
                  ? new Map(options?.owners.map((owner) => [owner.id, owner.name]))
                  : undefined
              }
            />
          ) : (
            <Empty
              text={
                Object.values(filters).some(Boolean)
                  ? t('platform.noMatchingServers')
                  : t('web.noServers')
              }
            />
          )}
        </div>
        <nav className="server-browser-pages" aria-label={t('platform.pagination')}>
          <button
            type="button"
            className="secondary"
            disabled={busy || (servers.data?.page ?? 1) <= 1}
            onClick={() => setPage({ page: Math.max(1, (servers.data?.page ?? 1) - 1), limit })}
          >
            {t('web.previous')}
          </button>
          <span role="status">
            {servers.isPending
              ? t('web.loading')
              : t('platform.serverPageOf', {
                  page: servers.data?.page ?? 1,
                  pages: servers.data?.totalPages ?? 1,
                })}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={busy || (servers.data?.page ?? 1) >= (servers.data?.totalPages ?? 1)}
            onClick={() => setPage({ page: (servers.data?.page ?? 1) + 1, limit })}
          >
            {t('web.next')}
          </button>
        </nav>
      </Page>
    </div>
  );
}
