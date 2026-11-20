import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type {
  getPlatformUser,
  listPlatformAudit,
  listPlatformUsers,
} from '../../../../packages/server-management/src/platform-queries.js';
import { api } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useFormat, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import {
  ActionForm,
  Details,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  number,
  Page,
  Section,
  Select,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { OwnerUserActions } from './owner-user-actions.js';
import { useStorageUsage } from './use-storage-usage.js';
import './owner-users.css';

export function OwnerUsersPage() {
  const t = useT();
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [{ q, role, cursor }, setFilters] = useState<{
    q: string;
    role: string;
    cursor?: string;
  }>({ q: '', role: '' });
  const macKeyboard = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) =>
        current.q === search.trim() ? current : { ...current, q: search.trim(), cursor: undefined },
      );
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
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
      searchInput.current?.focus();
      searchInput.current?.select();
    }
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, []);
  const users = useQuery({
    queryKey: ['owner-users', q, role, cursor],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ q });
      if (role) params.set('role', role);
      if (cursor) params.set('cursor', cursor);
      return api<Result<typeof listPlatformUsers>>(`/v1/platform/owner/users?${params}`, {
        signal,
      });
    },
    placeholderData: keepPreviousData,
  });
  const updating = users.isFetching || search.trim() !== q;
  return (
    <Page title={t('web.users')}>
      <Section>
        <div className="owner-users-toolbar">
          <div className="owner-users-search">
            <Input
              ref={searchInput}
              type="search"
              label={t('web.search')}
              name="q"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={100}
              aria-keyshortcuts="Alt+K"
              autoComplete="off"
            />
            {updating && (
              <span className="owner-users-refresh" role="status" aria-label={t('web.loading')} />
            )}
            <span aria-hidden="true">
              <kbd>{macKeyboard ? '⌥ + K' : 'ALT + K'}</kbd>
            </span>
          </div>
          <Select
            label={t('web.role')}
            value={role}
            onChange={(event) => {
              setFilters({ q: search.trim(), role: event.target.value });
            }}
          >
            <option value="">{t('web.all')}</option>
            {['owner', 'operator', 'user'].map((value) => (
              <option value={value} key={value}>
                {t(`owner.role.${value}`)}
              </option>
            ))}
          </Select>
          <Link className="button secondary owner-users-invites" to="/owner/invitations">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m3 7 9 6 9-6" />
            </svg>
            {t('web.invites')}
          </Link>
        </div>
        <div className="owner-users-results" aria-busy={updating} aria-live="polite">
          {users.isPending ? (
            <Loading />
          ) : users.error ? (
            <ErrorNotice error={users.error} retry={() => void users.refetch()} />
          ) : !users.data.items.length ? (
            <Empty />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t('web.name')}</th>
                    <th>{t('web.email')}</th>
                    <th>{t('web.role')}</th>
                    <th>{t('web.created')}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <Link to={`/owner/users/${user.id}`}>{user.name}</Link>
                      </td>
                      <td>{user.email}</td>
                      <td>{t(`owner.role.${user.role}`)}</td>
                      <td>
                        <Time value={user.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="actions">
          {cursor && (
            <button
              className="secondary"
              type="button"
              disabled={updating}
              onClick={() => setFilters((current) => ({ ...current, cursor: undefined }))}
            >
              {t('owner.firstPage')}
            </button>
          )}
          {users.data?.nextCursor && (
            <button
              className="secondary"
              type="button"
              disabled={updating || users.isPlaceholderData}
              onClick={() =>
                setFilters((current) => ({
                  ...current,
                  cursor: users.data?.nextCursor ?? undefined,
                }))
              }
            >
              {t('web.next')}
            </button>
          )}
        </div>
      </Section>
    </Page>
  );
}
export function OwnerUserPage() {
  const { userId = '' } = useParams();
  const queryClient = useQueryClient();
  const t = useT(),
    format = useFormat(),
    session = useSession();
  const [params] = useSearchParams();
  const history = params.get('view') === 'history';
  const [editingRole, setEditingRole] = useState(false);
  const user = useQuery({
    queryKey: ['owner-user', userId],
    refetchInterval: 15000,
    queryFn: ({ signal }) =>
      api<Result<typeof getPlatformUser>>(
        `/v1/platform/owner/users/${encodeURIComponent(userId)}`,
        { signal },
      ),
  });
  const storageUsage = useStorageUsage(
    user.data?.quota.storageUsage,
    user.data?.quota.observedAt,
    user.dataUpdatedAt,
  );
  if (user.error) return <ErrorNotice error={user.error} retry={() => void user.refetch()} />;
  const value =
    user.data ??
    queryClient
      .getQueriesData<Result<typeof listPlatformUsers>>({ queryKey: ['owner-users'] })
      .map(([, page]) => page?.items.find((item) => item.id === userId))
      .find((item) => item !== undefined);
  if (!value) return <Loading />;
  const quota = user.data?.quota;
  return (
    <div className="owner-user-detail" key={userId}>
      <Link to="/owner/users" className="owner-user-back">
        ‹ {t('web.users')}
      </Link>
      <Page title={value.name}>
        <div className="owner-user-summary">
          <div className="owner-user-byline">
            <span className="owner-user-initial" aria-hidden="true">
              {Array.from(value.name.trim())[0]?.toUpperCase()}
            </span>
            <span>{value.email}</span>
            <small>
              {t(value.emailVerified ? 'web.accountEmailVerified' : 'web.accountEmailUnverified')}
            </small>
          </div>
          {session.data?.context.sessionType === 'regular' &&
            session.data.context.role === 'owner' && (
              <div className="actions">
                <OwnerUserActions key={userId} actor={session.data.actor} user={value} />
              </div>
            )}
        </div>
        <nav className="tabs" aria-label={value.name}>
          <Link to={{ search: '' }} aria-current={!history ? 'page' : undefined}>
            {t('web.overview')}
          </Link>
          <Link to="?view=history" aria-current={history ? 'page' : undefined}>
            {t('owner.userHistory')}
          </Link>
        </nav>
        {!history && (
          <div className="owner-user-overview">
            <Section title={t('web.profile')}>
              <Details
                values={[
                  [t('web.created'), <Time key="created" value={value.createdAt} />],
                  [
                    t('web.role'),
                    <span key="role" className="owner-user-role">
                      {t(`owner.role.${value.role}`)}
                      {value.role !== 'owner' && (
                        <button
                          type="button"
                          className="secondary"
                          aria-expanded={editingRole}
                          onClick={() => setEditingRole(!editingRole)}
                        >
                          {t(editingRole ? 'web.cancel' : 'web.edit')}
                        </button>
                      )}
                    </span>,
                  ],
                ]}
              />
              {editingRole && value.role !== 'owner' && (
                <ActionForm
                  onSubmit={async (data) => {
                    await api('/v1/owner/roles', {
                      method: 'PATCH',
                      body: { userId, role: text(data, 'role') },
                    });
                    await user.refetch();
                    setEditingRole(false);
                  }}
                >
                  <Select label={t('web.role')} name="role" defaultValue={value.role}>
                    <option value="user">{t('owner.role.user')}</option>
                    <option value="operator">{t('owner.role.operator')}</option>
                  </Select>
                </ActionForm>
              )}
            </Section>
            {!quota ? (
              <Section title={t('web.quota')}>
                <Loading />
              </Section>
            ) : (
              <Section
                title={t('web.quota')}
                actions={
                  <Link to={`/owner/servers?ownerId=${encodeURIComponent(userId)}`}>
                    {t('web.servers')} →
                  </Link>
                }
              >
                <Details
                  values={[
                    [
                      t('web.memory'),
                      `${format.number(quota.committed.memoryMiB)} / ${format.number(quota.limits.memoryMiB)} MiB`,
                    ],
                    [
                      t('web.cpu'),
                      `${format.number(quota.committed.cpuPercent)} / ${format.number(quota.limits.cpuPercent)}%`,
                    ],
                    [
                      quota.limits.storageMiB === null
                        ? `${t('web.disk')} · ${t('web.usage')}`
                        : t('web.disk'),
                      quota.limits.storageMiB === null
                        ? `${storageUsage === null ? t('web.unavailable') : format.bytes(storageUsage)} / ${t(quota.storageBudgetMiB === 0 ? 'platform.unlimited' : 'owner.globalPool')}`
                        : `${format.number(quota.committed.storageMiB)} MiB / ${format.number(quota.limits.storageMiB)} MiB`,
                    ],
                    [
                      t('web.servers'),
                      `${format.number(quota.committed.serverCount)} / ${quota.limits.serverCount === null ? t('owner.noCountLimit') : format.number(quota.limits.serverCount)}`,
                    ],
                  ]}
                />
                <details>
                  <summary>{t('owner.overrideQuota')}</summary>
                  <ActionForm
                    onSubmit={async (data) => {
                      await api('/v1/owner/user-limits', {
                        method: 'PUT',
                        body: {
                          userId,
                          memoryMiB: number(data, 'memory'),
                          cpuPercent: number(data, 'cpu'),
                          ...(quota.storageBudgetMiB === 0
                            ? {}
                            : { storageMiB: number(data, 'storage') }),
                          reason: text(data, 'reason'),
                          ...(text(data, 'expires')
                            ? { expiresAt: new Date(text(data, 'expires')).toISOString() }
                            : {}),
                        },
                      });
                      await Promise.all([
                        user.refetch(),
                        queryClient.invalidateQueries({ queryKey: ['audit', userId] }),
                      ]);
                    }}
                  >
                    <Input
                      label={`${t('web.memory')} (MiB)`}
                      name="memory"
                      type="number"
                      min={1}
                      defaultValue={quota.limits.memoryMiB}
                      required
                    />
                    <Input
                      label={`${t('web.cpu')} (%)`}
                      name="cpu"
                      type="number"
                      min={1}
                      defaultValue={quota.limits.cpuPercent}
                      required
                    />
                    {quota.storageBudgetMiB === 0 ? (
                      <p>
                        {t('web.disk')}: {t('platform.unlimited')}{' '}
                        <Link to="/owner/settings">{t('web.settings')}</Link>
                      </p>
                    ) : (
                      <Input
                        label={`${t('web.disk')} (MiB)`}
                        name="storage"
                        type="number"
                        min={1}
                        defaultValue={quota.storageBudgetMiB}
                        required
                      />
                    )}
                    <Input
                      label={t('web.expires')}
                      name="expires"
                      type="datetime-local"
                      step={1}
                      defaultValue={
                        quota.override?.expiresAt
                          ? new Date(
                              Date.parse(quota.override.expiresAt) -
                                new Date(quota.override.expiresAt).getTimezoneOffset() * 60000,
                            )
                              .toISOString()
                              .slice(0, 19)
                          : ''
                      }
                    />
                    <Textarea
                      label={t('web.reason')}
                      name="reason"
                      minLength={8}
                      maxLength={300}
                      required
                    />
                  </ActionForm>
                </details>
                {quota.override && (
                  <Notice>
                    {t(quota.override.active ? 'owner.overrideActive' : 'owner.overrideExpired')}{' '}
                    {quota.override.expiresAt ? (
                      <Time value={quota.override.expiresAt} />
                    ) : (
                      t('owner.noExpiry')
                    )}
                  </Notice>
                )}
              </Section>
            )}
          </div>
        )}
        {history && (
          <Section title={t('owner.userHistory')}>
            <AuditTable userId={userId} />
          </Section>
        )}
      </Page>
    </div>
  );
}
export { InvitationsPage } from './owner-invitations.js';

export function OwnerAuditPage() {
  const t = useT();
  return (
    <Page title={t('web.audit')}>
      <Section>
        <AuditTable />
      </Section>
    </Page>
  );
}
function AuditTable({ userId }: { userId?: string }) {
  const t = useT();
  const [action, setAction] = useState(''),
    [actor, setActor] = useState(''),
    [cursor, setCursor] = useState<string>();
  const events = useQuery({
    queryKey: ['audit', userId, action, actor, cursor],
    queryFn: () => {
      const params = new URLSearchParams();
      if (userId) params.set('userId', userId);
      if (action) params.set('action', action);
      if (actor) params.set('actorId', actor);
      if (cursor) params.set('cursor', cursor);
      return api<Result<typeof listPlatformAudit>>(`/v1/platform/owner/audit?${params}`);
    },
  });
  const filters = (
    <form
      className="toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setAction(text(data, 'action'));
        setActor(text(data, 'actor'));
        setCursor(undefined);
      }}
    >
      <Input label={t('owner.eventType')} name="action" defaultValue={action} />
      <Input label={t('owner.actorId')} name="actor" defaultValue={actor} />
      <button type="submit" className="secondary">
        {t('web.filter')}
      </button>
    </form>
  );
  return (
    <>
      {userId && (
        <details className="owner-audit-filter">
          <summary>{t('web.filter')}</summary>
          {filters}
        </details>
      )}
      {!userId && filters}
      {events.isPending ? (
        <Loading />
      ) : events.error ? (
        <ErrorNotice error={events.error} />
      ) : !events.data.items.length ? (
        <Empty />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('web.created')}</th>
                <th>{t('owner.eventType')}</th>
                {!userId && <th>{t('owner.actorId')}</th>}
                {!userId && <th>{t('owner.subjectId')}</th>}
                <th>{t('web.details')}</th>
              </tr>
            </thead>
            <tbody>
              {events.data.items.map((event) => (
                <tr key={event.id}>
                  <td>
                    <Time value={event.created_at} />
                  </td>
                  <td>
                    <code>{event.action}</code>
                  </td>
                  {!userId && <td>{event.actor_user_id}</td>}
                  {!userId && <td>{event.subject_user_id}</td>}
                  <td>
                    <details>
                      <summary>{t('web.details')}</summary>
                      <dl className="details">
                        {userId && (
                          <>
                            <div>
                              <dt>{t('owner.actorId')}</dt>
                              <dd>{event.actor_user_id}</dd>
                            </div>
                            <div>
                              <dt>{t('owner.subjectId')}</dt>
                              <dd>{event.subject_user_id}</dd>
                            </div>
                          </>
                        )}
                        {Object.entries(event.metadata as Record<string, unknown>).map(
                          ([key, value]) => (
                            <div key={key}>
                              <dt>{key}</dt>
                              <dd>
                                <code>
                                  {typeof value === 'string' ? value : JSON.stringify(value)}
                                </code>
                              </dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="actions">
        {cursor && (
          <button type="button" className="secondary" onClick={() => setCursor(undefined)}>
            {t('owner.firstPage')}
          </button>
        )}
        {events.data?.nextCursor && (
          <button
            type="button"
            className="secondary"
            onClick={() => setCursor(events.data?.nextCursor ?? undefined)}
          >
            {t('web.next')}
          </button>
        )}
      </div>
    </>
  );
}
