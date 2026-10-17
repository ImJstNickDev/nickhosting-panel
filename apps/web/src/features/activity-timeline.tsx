import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import type { listPlatformActivity } from '../../../../packages/server-management/src/platform-queries.js';
import { api } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useFormat, useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { Badge, ErrorNotice, Page, Time } from '../components/ui.js';
import { activityJobKey, activityLabelKey } from './activity-labels.js';
import { CursorControls } from './servers.js';
import './activity.css';

type Item = Result<typeof listPlatformActivity>['items'][number];
const categories = ['lifecycle', 'files', 'backups', 'access', 'settings', 'console'];
const states = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'requested',
  'uncertain',
  'partial',
  'cancelled',
  'dispatched',
];
const jobActions = [
  'provision',
  'start',
  'stop',
  'restart',
  'backup',
  'restore',
  'configure',
  'reinstall',
  'wipe',
  'delete',
  'minecraft-content',
];
function string(value: unknown) {
  return typeof value === 'string' ? value : '';
}
function Icon({ name }: { name: string }) {
  const shapes: Record<string, React.ReactNode> = {
    lifecycle: (
      <>
        <path d="M12 3v9" />
        <path d="M6 5a9 9 0 1 0 12 0" />
      </>
    ),
    files: (
      <>
        <path d="M4 4h7l3 3h6v13H4Z" />
        <path d="M4 10h16" />
      </>
    ),
    backups: (
      <>
        <rect x="4" y="6" width="16" height="15" rx="2" />
        <path d="M3 3h18v4H3m6 5h6" />
      </>
    ),
    access: (
      <>
        <circle cx="8" cy="9" r="5" />
        <path d="m12 13 8 8m-3-3 3-3" />
      </>
    ),
    settings: (
      <>
        <path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6" />
      </>
    ),
    console: (
      <>
        <path d="m5 7 5 5-5 5m8 0h6" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shapes[name] ?? shapes.settings}
    </svg>
  );
}
function ActivityDetails({ item }: { item: Item }) {
  const t = useT(),
    format = useFormat();
  const metadata = item.metadata ?? {};
  const entries = Array.isArray(metadata.entries)
    ? metadata.entries.filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
      )
    : metadata.entry && typeof metadata.entry === 'object'
      ? [metadata.entry as Record<string, unknown>]
      : [];
  const fields = [
    'path',
    'target',
    'count',
    'completed',
    'failed',
    'cancelled',
    'uncertain',
    'bytes',
    'credentialUsername',
    'memberUsername',
    'memberName',
    'role',
  ];
  return (
    <div className="activity-detail">
      <dl>
        <div>
          <dt>{t('activity.source')}</dt>
          <dd>{t(`activity.source.${item.source ?? 'manual'}`)}</dd>
        </div>
        <div>
          <dt>{t('web.created')}</dt>
          <dd>
            <Time value={item.createdAt} />
          </dd>
        </div>
        {item.updatedAt !== item.createdAt && (
          <div>
            <dt>{t('web.updated')}</dt>
            <dd>
              <Time value={item.updatedAt} />
            </dd>
          </div>
        )}
        {item.actorId && item.subjectId && item.actorId !== item.subjectId && (
          <div>
            <dt>{t('activity.assistance')}</dt>
            <dd>{item.subject?.username || item.subject?.name || t('activity.assistedAction')}</dd>
          </div>
        )}
        {fields.map((field) =>
          metadata[field] === undefined ? null : (
            <div key={field}>
              <dt>{t(`activity.detail.${field}`)}</dt>
              <dd>
                {typeof metadata[field] === 'number'
                  ? format.number(metadata[field] as number)
                  : field === 'role'
                    ? t(`activity.role.${string(metadata[field])}`)
                    : string(metadata[field])}
              </dd>
            </div>
          ),
        )}
      </dl>
      {typeof metadata.command === 'string' && (
        <div className="activity-command">
          <span>{t('activity.command')}</span>
          <pre>{metadata.command}</pre>
        </div>
      )}
      {item.category === 'console' && (
        <p className="muted activity-command-note">{t('activity.commandNote')}</p>
      )}
      {entries.length > 0 && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded scroll region must support keyboard scrolling.
        <section className="activity-entries" tabIndex={0} aria-label={t('activity.items')}>
          <ul>
            {entries.map((entry) => (
              <li key={string(entry.id) || `${string(entry.path)}:${string(entry.target)}`}>
                <span>{string(entry.path) || string(entry.target)}</span>
                {entry.target && entry.path && <span>→ {string(entry.target)}</span>}
                {typeof entry.state === 'string' && (
                  <span className="muted">
                    {t(
                      `activity.state.${entry.state === 'complete' ? 'succeeded' : ['pending', 'uploading'].includes(entry.state) ? 'running' : entry.state}`,
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {typeof metadata.count === 'number' &&
        metadata.count > entries.length &&
        entries.length > 0 && (
          <p className="muted">
            {t('activity.shownItems', { count: entries.length, total: metadata.count })}
          </p>
        )}
      {item.jobId && (
        <Link className="activity-job-link" to={`/activity/${item.jobId}`}>
          {t('platform.jobDetails')} <Icon name="chevron" />
        </Link>
      )}
    </div>
  );
}
export function ActivityTimeline({ serverId }: { serverId?: string }) {
  const t = useT(),
    id = useId();
  const [filters, setFilters] = useState<Record<string, string>>({}),
    [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<string[]>([]),
    [expanded, setExpanded] = useState<string | null>(null),
    [more, setMore] = useState(false);
  const [actorLabel, setActorLabel] = useState('');
  const change = (key: string, value: string) => {
    setFilters((old) => ({ ...old, [key]: value }));
    setCursors([]);
    setExpanded(null);
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((old) => (old.q === search ? old : { ...old, q: search }));
      setCursors([]);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    limit: '30',
    ...(serverId ? { serverId } : {}),
    ...Object.fromEntries(
      Object.entries(filters)
        .filter(([, value]) => value)
        .map(([key, value]) => [
          key,
          key === 'from' || key === 'to'
            ? new Date(`${value}T${key === 'from' ? '00:00:00.000' : '23:59:59.999'}`).toISOString()
            : value,
        ]),
    ),
    ...(cursors.length ? { cursor: cursors.at(-1) ?? '' } : {}),
  });
  const activity = useQuery({
    queryKey: ['activity', params.toString()],
    queryFn: () => api<Result<typeof listPlatformActivity>>(`/v1/platform/activity?${params}`),
    refetchInterval: 10000,
  });
  const select = (name: string, label: string, values: string[], prefix: string) => (
    <label className="activity-select">
      <span className="visually-hidden">{label}</span>
      <select
        aria-label={label}
        value={filters[name] ?? ''}
        onChange={(event) => change(name, event.target.value)}
      >
        <option value="">{label}</option>
        {values.map((value) => (
          <option key={value} value={value}>
            {t(`${prefix}${value}`)}
          </option>
        ))}
      </select>
    </label>
  );
  const active = Object.values(filters).some(Boolean) || !!search;
  return (
    <Page title={t('web.activity')}>
      <div className="activity-page">
        <div className="activity-toolbar">
          <label className="activity-search">
            <Icon name="search" />
            <span className="visually-hidden">{t('activity.search')}</span>
            <input
              type="search"
              placeholder={t('activity.search')}
              value={search}
              maxLength={100}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {select('category', t('activity.category'), categories, 'activity.category.')}
          {select('state', t('web.status'), states, 'activity.state.')}
          <Tooltip content={t('activity.filters')}>
            <button
              className={`activity-icon ${more ? 'is-active' : ''}`}
              type="button"
              aria-label={t('activity.filters')}
              aria-expanded={more}
              aria-controls={`${id}-filters`}
              onClick={() => setMore(!more)}
            >
              <Icon name="settings" />
            </button>
          </Tooltip>
          <Tooltip content={t('activity.refresh')}>
            <button
              className="activity-icon"
              type="button"
              aria-label={t('activity.refresh')}
              disabled={activity.isFetching}
              onClick={() => void activity.refetch()}
            >
              <Icon name="refresh" />
            </button>
          </Tooltip>
        </div>
        {more && (
          <div className="activity-more" id={`${id}-filters`}>
            {select(
              'source',
              t('activity.source'),
              ['manual', 'system', 'schedule', 'sftp'],
              'activity.source.',
            )}
            <label className="activity-select">
              <span>{t('platform.action')}</span>
              <select
                aria-label={t('platform.action')}
                value={filters.action ?? ''}
                onChange={(event) => change('action', event.target.value)}
              >
                <option value="">{t('web.all')}</option>
                {jobActions.map((action) => (
                  <option key={action} value={action}>
                    {t(activityJobKey(action))}
                  </option>
                ))}
                {['edit', 'upload', 'download', 'move', 'rename', 'copy', 'extract', 'mkdir'].map(
                  (action) => (
                    <option key={action} value={action}>
                      {t(`activity.file.${action}`)}
                    </option>
                  ),
                )}
              </select>
            </label>
            {(['from', 'to'] as const).map((key) => (
              <label className="activity-date" key={key}>
                <span>{t(`activity.${key}`)}</span>
                <input
                  type="date"
                  value={filters[key] ?? ''}
                  onChange={(event) => change(key, event.target.value)}
                />
              </label>
            ))}
          </div>
        )}
        {active && (
          <div className="activity-applied">
            {filters.actorId && (
              <button
                className="activity-filter-chip"
                type="button"
                onClick={() => change('actorId', '')}
              >
                {actorLabel}
                <Icon name="close" />
                <span className="visually-hidden">{t('activity.clearActor')}</span>
              </button>
            )}
            <button
              className="activity-clear"
              type="button"
              onClick={() => {
                setFilters({});
                setSearch('');
                setCursors([]);
                setExpanded(null);
              }}
            >
              {t('activity.clear')}
            </button>
          </div>
        )}
        {activity.error && (
          <ErrorNotice error={activity.error} retry={() => void activity.refetch()} />
        )}
        <div className="activity-table" aria-busy={activity.isPending}>
          {activity.isPending ? (
            <div className="activity-skeleton" role="status" aria-label={t('web.loading')}>
              {['one', 'two', 'three', 'four', 'five', 'six'].map((key) => (
                <div key={key}>
                  <i />
                  <span />
                  <span />
                </div>
              ))}
            </div>
          ) : !activity.data && activity.error ? null : !activity.data?.items.length ? (
            <div className="activity-empty">
              <Icon name="lifecycle" />
              <p>{t(active ? 'activity.noMatches' : 'platform.noActivity')}</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('platform.operation')}</th>
                  {!serverId && <th scope="col">{t('web.servers')}</th>}
                  <th scope="col">{t('activity.actor')}</th>
                  <th scope="col">{t('web.status')}</th>
                  <th scope="col">{t('activity.when')}</th>
                </tr>
              </thead>
              <tbody>
                {activity.data.items.map((item) => {
                  const open = expanded === item.id,
                    label = t(activityLabelKey(item)),
                    meta = item.metadata ?? {},
                    outcome =
                      item.phase === 'owner_resolved_failed'
                        ? 'failed'
                        : item.effectState === 'uncertain'
                          ? 'uncertain'
                          : (item.outcome ?? item.state);
                  const automatic = ['system', 'schedule'].includes(item.source),
                    actor = automatic
                      ? t(`activity.source.${item.source}`)
                      : item.actor?.username || item.actor?.name || t('activity.unknownActor');
                  return (
                    <Fragment key={item.id}>
                      <tr
                        data-job-id={item.jobId ?? undefined}
                        className={open ? 'activity-open' : ''}
                      >
                        <th scope="row">
                          <button
                            className="activity-row-button"
                            type="button"
                            aria-expanded={open}
                            aria-controls={`${id}-${item.id}`}
                            onClick={() => setExpanded(open ? null : item.id)}
                          >
                            <span className="activity-event-icon">
                              <Icon name={item.category ?? 'lifecycle'} />
                            </span>
                            <span className="activity-row-text">
                              <span>
                                {label}
                                {typeof meta.count === 'number' && meta.count > 1 && (
                                  <small className="activity-count">{meta.count}</small>
                                )}
                              </span>
                              {(meta.path || meta.root || meta.command) && (
                                <small>
                                  {string(meta.command) || string(meta.path) || string(meta.root)}
                                  {meta.target ? ` → ${string(meta.target)}` : ''}
                                </small>
                              )}
                            </span>
                            <span className={`activity-chevron ${open ? 'is-open' : ''}`}>
                              <Icon name="chevron" />
                            </span>
                          </button>
                        </th>
                        {!serverId && (
                          <td className="activity-server" data-label={t('web.servers')}>
                            {item.serverId ? (
                              <Link to={`/servers/${item.serverId}`}>{item.serverName}</Link>
                            ) : (
                              '—'
                            )}
                          </td>
                        )}
                        <td className="activity-actor" data-label={t('activity.actor')}>
                          {item.actorId && !automatic ? (
                            <button
                              type="button"
                              className="activity-person"
                              aria-label={t('activity.filterActor', { name: actor })}
                              onClick={() => {
                                setActorLabel(actor);
                                change('actorId', item.actorId ?? '');
                              }}
                            >
                              {actor}
                            </button>
                          ) : (
                            <span className="muted">{actor}</span>
                          )}
                          {item.source === 'sftp' && <small>SFTP</small>}
                        </td>
                        <td className="activity-outcome" data-label={t('web.status')}>
                          <Badge value={outcome} label={t(`activity.state.${outcome}`)} />
                        </td>
                        <td className="activity-time" data-label={t('activity.when')}>
                          <Time value={item.createdAt} />
                        </td>
                      </tr>
                      {open && (
                        <tr className="activity-detail-row">
                          <td colSpan={serverId ? 4 : 5}>
                            <div id={`${id}-${item.id}`}>
                              <ActivityDetails item={item} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <CursorControls
          next={activity.data?.nextCursor}
          previous={cursors.length > 0}
          onNext={(next) => {
            setCursors([...cursors, next]);
            setExpanded(null);
          }}
          onPrevious={() => {
            setCursors(cursors.slice(0, -1));
            setExpanded(null);
          }}
        />
      </div>
    </Page>
  );
}
