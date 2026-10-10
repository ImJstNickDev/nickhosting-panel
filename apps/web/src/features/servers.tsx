import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type ReactNode, useRef, useState } from 'react';
import { Link } from 'react-router';
import type {
  getPlatformQuota,
  listPlatformActivity,
  listPlatformProjects,
  listPlatformServers,
} from '../../../../packages/server-management/src/platform-queries.js';
import { api, idempotencyKey, queryClient } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useFormat, useT } from '../app/i18n.js';
import {
  ActionForm,
  Badge,
  Check,
  Details,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  JobNotice,
  Loading,
  Notice,
  number,
  Page,
  Section,
  Select,
  Time,
  text,
} from '../components/ui.js';
import { getGameArtwork } from './integrations.js';
import { platformPath, type ServerInfo, serverPath, useServer } from './service-contracts.js';

type ServerList = Result<typeof listPlatformServers>;
type Projects = Result<typeof listPlatformProjects>;
type Quota = Result<typeof getPlatformQuota>;
type Activity = Result<typeof listPlatformActivity>;
export function statusKey(state: string) {
  return [
    'unknown',
    'offline',
    'running',
    'ready',
    'queued',
    'failed',
    'succeeded',
    'uncertain',
  ].includes(state)
    ? `web.${state}`
    : `platform.${state}`;
}
export function CursorControls({
  next,
  previous,
  onNext,
  onPrevious,
}: {
  next: string | null | undefined;
  previous: boolean;
  onNext: (value: string) => void;
  onPrevious: () => void;
}) {
  const t = useT();
  if (!next && !previous) return null;
  return (
    <nav className="actions" aria-label={t('platform.pagination')}>
      <button type="button" className="secondary" disabled={!previous} onClick={onPrevious}>
        {t('web.previous')}
      </button>
      <button
        type="button"
        className="secondary"
        disabled={!next}
        onClick={() => {
          if (next) onNext(next);
        }}
      >
        {t('web.next')}
      </button>
    </nav>
  );
}
export function TableRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll overflowing tables in a named region.
    <section className="table-scroll" aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}
export function ServerCards({ items }: { items: ServerInfo[] }) {
  const t = useT(),
    format = useFormat();
  return (
    <ul className="server-grid">
      {items.map((server) => {
        const artwork = getGameArtwork(server.gameId);
        return (
          <li key={server.id} className="server-card">
            {artwork && <img className="server-artwork" src={artwork} alt="" loading="lazy" />}
            <div className="server-card-body">
              <div className="section-heading">
                <h2>
                  <Link to={`/servers/${server.id}`}>{server.name}</Link>
                </h2>
                <Badge value={server.runtimeState} label={t(statusKey(server.runtimeState))} />
              </div>
              <p className="muted">
                {server.gameNameKey ? t(server.gameNameKey) : server.gameId} · {server.runtimeId}
              </p>
              <dl className="server-card-resources">
                <div>
                  <dt>{t('platform.memoryLimit')}</dt>
                  <dd>{format.number(server.limits.memory)} MiB</dd>
                </div>
                <div>
                  <dt>{t('platform.cpuLimit')}</dt>
                  <dd>{format.number(server.limits.cpu)}%</dd>
                </div>
                <div>
                  <dt>{t('platform.diskLimit')}</dt>
                  <dd>{format.number(server.limits.disk)} MiB</dd>
                </div>
              </dl>
              {server.activeOperationId && (
                <Link to={`/activity/${server.activeOperationId}`}>
                  {t('platform.activeOperation')}
                </Link>
              )}
              {server.sleepState && (
                <span className="muted">{t(statusKey(server.sleepState))}</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
export function QuotaSummary() {
  const t = useT(),
    format = useFormat();
  const quota = useQuery({
    queryKey: ['quota'],
    queryFn: () => api<Quota>('/v1/platform/quotas'),
    refetchInterval: 15000,
  });
  return (
    <Section title={t('web.quota')}>
      {quota.isPending ? (
        <Loading />
      ) : quota.error ? (
        <ErrorNotice error={quota.error} retry={() => void quota.refetch()} />
      ) : (
        quota.data && (
          <>
            <TableRegion label={t('web.quota')}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('platform.resources')}</th>
                    <th scope="col">{t('web.reserved')}</th>
                    <th scope="col">{t('web.quota')}</th>
                    <th scope="col">{t('platform.remaining')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(['memoryMiB', 'cpuPercent', 'storageMiB', 'serverCount'] as const).map(
                    (key) => (
                      <tr key={key}>
                        <th scope="row">
                          {t(
                            key === 'memoryMiB'
                              ? 'web.memory'
                              : key === 'cpuPercent'
                                ? 'web.cpu'
                                : key === 'storageMiB'
                                  ? 'web.disk'
                                  : 'web.servers',
                          )}
                        </th>
                        <td>
                          {format.number(quota.data.committed[key])}
                          {key.endsWith('MiB') ? ' MiB' : key === 'cpuPercent' ? '%' : ''}
                        </td>
                        <td>
                          {quota.data.limits[key] === null
                            ? t(
                                key === 'serverCount'
                                  ? 'platform.unlimited'
                                  : 'platform.globalPool',
                              )
                            : format.number(quota.data.limits[key])}
                        </td>
                        <td>
                          {quota.data.remaining[key] === null
                            ? '—'
                            : format.number(quota.data.remaining[key])}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </TableRegion>
            <p className="muted">{t('platform.allowanceHint')}</p>
          </>
        )
      )}
    </Section>
  );
}
export function HomePage() {
  const t = useT();
  const servers = useQuery({
    queryKey: ['servers', 'recent'],
    queryFn: () => api<ServerList>('/v1/platform/servers?limit=4'),
    refetchInterval: 15000,
  });
  const activity = useQuery({
    queryKey: ['activity', 'recent'],
    queryFn: () => api<Activity>('/v1/platform/activity?limit=5'),
    refetchInterval: 15000,
  });
  return (
    <Page
      title={t('web.home')}
      actions={
        <Link className="button" to="/servers/new">
          {t('web.createServer')}
        </Link>
      }
    >
      <Section
        title={t('platform.recentServers')}
        actions={<Link to="/servers">{t('platform.allServers')}</Link>}
      >
        {servers.isPending ? (
          <Loading />
        ) : servers.error ? (
          <ErrorNotice error={servers.error} retry={() => void servers.refetch()} />
        ) : servers.data?.items.length ? (
          <ServerCards items={servers.data.items} />
        ) : (
          <Empty text={t('web.noServers')} />
        )}
      </Section>
      <QuotaSummary />
      <Section
        title={t('platform.recentActivity')}
        actions={<Link to="/activity">{t('platform.allActivity')}</Link>}
      >
        {activity.isPending ? (
          <Loading />
        ) : activity.error ? (
          <ErrorNotice error={activity.error} />
        ) : !activity.data?.items.length ? (
          <Empty text={t('platform.noActivity')} />
        ) : (
          <ul className="activity-list">
            {activity.data.items.map((job) => (
              <li key={job.id}>
                <Link to={`/activity/${job.id}`}>
                  {job.serverName ?? t('platform.operation')} ·{' '}
                  {t(job.action ? `platform.${job.action}` : 'platform.operation')}
                </Link>
                <Badge value={job.effectState === 'uncertain' ? 'uncertain' : job.state} />
                <Time value={job.updatedAt} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}
export function ServersPage() {
  const t = useT();
  const [filters, setFilters] = useState({ q: '', state: '', projectId: '' });
  const [cursors, setCursors] = useState<string[]>([]);
  const query = new URLSearchParams({ limit: '12' });
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  if (cursors.length) query.set('cursor', cursors.at(-1) ?? '');
  const servers = useQuery({
    queryKey: ['servers', query.toString()],
    queryFn: () => api<ServerList>(`/v1/platform/servers?${query}`),
    refetchInterval: 15000,
  });
  return (
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
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setFilters({
            q: text(data, 'q'),
            state: text(data, 'state'),
            projectId: text(data, 'projectId'),
          });
          setCursors([]);
        }}
      >
        <Input
          label={t('platform.searchServers')}
          name="q"
          type="search"
          defaultValue={filters.q}
          maxLength={100}
        />
        <Select label={t('web.status')} name="state" defaultValue={filters.state}>
          <option value="">{t('web.all')}</option>
          {['offline', 'starting', 'running', 'stopping', 'unknown'].map((state) => (
            <option key={state} value={state}>
              {t(statusKey(state))}
            </option>
          ))}
        </Select>
        <Select label={t('platform.project')} name="projectId" defaultValue={filters.projectId}>
          <option value="">{t('web.all')}</option>
          <option value="none">{t('platform.noProject')}</option>
        </Select>
        <button type="submit">{t('web.filter')}</button>
      </form>
      {servers.isPending ? (
        <Loading />
      ) : servers.error ? (
        <ErrorNotice error={servers.error} retry={() => void servers.refetch()} />
      ) : servers.data?.items.length ? (
        <ServerCards items={servers.data.items} />
      ) : (
        <Empty
          text={
            Object.values(filters).some(Boolean)
              ? t('platform.noMatchingServers')
              : t('web.noServers')
          }
        />
      )}
      <CursorControls
        next={servers.data?.nextCursor}
        previous={cursors.length > 0}
        onNext={(next) => setCursors([...cursors, next])}
        onPrevious={() => setCursors(cursors.slice(0, -1))}
      />
    </Page>
  );
}
/** Keep the intent key through a lost response. Retrying the same form must not
 * create a duplicate external operation; a changed payload is a new intent. */
function useRequestOperation(serverId: string) {
  const intents = useRef(new Map<string, string>());
  return async (body: Record<string, unknown>) => {
    const fingerprint = JSON.stringify(body);
    let key = intents.current.get(fingerprint);
    if (!key) {
      key = idempotencyKey();
      intents.current.set(fingerprint, key);
    }
    const result = await api<{ jobId: string; serverId: string }>(
      `${serverPath(serverId)}/operations`,
      { body: { ...body, idempotencyKey: key } },
    );
    intents.current.delete(fingerprint);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['server', serverId] }),
      queryClient.invalidateQueries({ queryKey: ['servers'] }),
      queryClient.invalidateQueries({ queryKey: ['activity'] }),
      queryClient.invalidateQueries({ queryKey: ['quota'] }),
    ]);
    return result;
  };
}
export function ServerOverview({ serverId }: { serverId: string }) {
  const t = useT(),
    format = useFormat(),
    server = useServer(serverId),
    request = useRequestOperation(serverId);
  const [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [jobId, setJobId] = useState<string>(),
    [restart, setRestart] = useState(false);
  async function power(action: 'start' | 'stop' | 'restart') {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const job = await request({ action });
      setJobId(job.jobId);
      setRestart(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  if (server.isPending) return <Loading />;
  if (server.error) return <ErrorNotice error={server.error} retry={() => void server.refetch()} />;
  const data = server.data;
  if (!data) return null;
  return (
    <>
      <Section
        title={t('web.overview')}
        actions={
          data.permissions.operate && (
            <div className="actions">
              {(['start', 'stop', 'restart'] as const).map((action) => (
                <button
                  type="button"
                  key={action}
                  className={action === 'start' ? '' : 'secondary'}
                  disabled={busy || !data.availableActions[action]}
                  onClick={() => (action === 'restart' ? setRestart(true) : void power(action))}
                >
                  {t(`web.${action}`)}
                </button>
              ))}
            </div>
          )
        }
      >
        {Boolean(error) && <ErrorNotice error={error} />}
        <JobNotice jobId={jobId} />
        {data.activeOperationId && (
          <Notice>
            <Link to={`/activity/${data.activeOperationId}`}>
              {t('platform.operationBlocksActions')}
            </Link>
          </Notice>
        )}
        {data.firstStart && data.runtimeState === 'offline' && (
          <Notice>
            {t('platform.initialStartDenied')} <Time value={data.firstStart.occurredAt} />
          </Notice>
        )}
        <Details
          values={[
            [t('platform.game'), data.gameNameKey ? t(data.gameNameKey) : data.gameId],
            [t('platform.runtime'), data.runtimeId],
            [
              t('platform.process'),
              <Badge
                key="process"
                value={data.runtimeState}
                label={t(statusKey(data.runtimeState))}
              />,
            ],
            [
              t('platform.readiness'),
              data.capabilities?.readiness === false ? (
                t('web.unavailable')
              ) : (
                <Badge
                  key="readiness"
                  value={data.readiness}
                  label={t(statusKey(data.readiness))}
                />
              ),
            ],
            [t('platform.installation'), t(statusKey(data.installationState))],
            [
              t('platform.sleepState'),
              data.sleepState ? t(statusKey(data.sleepState)) : t('web.unconfigured'),
            ],
            [t('web.memory'), `${format.number(data.limits.memory)} MiB`],
            [t('web.cpu'), `${format.number(data.limits.cpu)}%`],
            [t('web.disk'), `${format.number(data.limits.disk)} MiB`],
            [t('platform.lastObserved'), <Time key="observed" value={data.lastObservedAt} />],
          ]}
        />
      </Section>
      <Dialog open={restart} title={t('web.restart')} onClose={() => setRestart(false)}>
        <p>{t('platform.restartWarning', { name: data.name })}</p>
        <button type="button" disabled={busy} onClick={() => void power('restart')}>
          {t('web.restart')}
        </button>
      </Dialog>
    </>
  );
}
function ProjectChoice({ server }: { server: ServerInfo }) {
  const t = useT(),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState(server.projectId ?? '');
  const projects = useInfiniteQuery({
    queryKey: ['projects', 'assignment', search],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<Projects>(
        `/v1/platform/projects?${new URLSearchParams({ limit: '100', ...(search ? { q: search } : {}), ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const owned =
    projects.data?.pages
      .flatMap((page) => page.items)
      .filter((project) => project.owner_id === server.ownerId) ?? [];
  return (
    <>
      <Input
        label={t('platform.projectSearch')}
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {projects.error && <ErrorNotice error={projects.error} />}
      <Select
        name="projectId"
        label={t('platform.project')}
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
      >
        <option value="">{t('platform.noProject')}</option>
        {selected && !owned.some((project) => project.id === selected) && (
          <option value={selected}>{t('platform.currentProject')}</option>
        )}
        {owned.map((project) => (
          <option value={project.id} key={project.id}>
            {project.name}
          </option>
        ))}
      </Select>
      {projects.hasNextPage && (
        <button
          className="secondary"
          type="button"
          disabled={projects.isFetchingNextPage}
          onClick={() => void projects.fetchNextPage()}
        >
          {t('platform.moreProjects')}
        </button>
      )}
      <small>{t('platform.sharingChange')}</small>
    </>
  );
}
export function ServerSettings({ serverId }: { serverId: string }) {
  const t = useT(),
    server = useServer(serverId),
    request = useRequestOperation(serverId);
  const [jobId, setJobId] = useState<string>(),
    [destructive, setDestructive] = useState<'reinstall' | 'wipe' | 'delete' | null>(null);
  if (server.isPending) return <Loading />;
  if (server.error) return <ErrorNotice error={server.error} />;
  const data = server.data;
  if (!data) return null;
  if (!data.permissions.manage) return <Notice>{t('errors.forbidden')}</Notice>;
  return (
    <>
      <JobNotice jobId={jobId} />
      <Section title={t('platform.metadata')}>
        <ActionForm
          key={data.id}
          onSubmit={async (form) => {
            await api(platformPath(serverId), {
              method: 'PATCH',
              body: {
                name: text(form, 'name'),
                ...(data.permissions.sharing ? { projectId: text(form, 'projectId') || null } : {}),
              },
            });
            await queryClient.invalidateQueries({ queryKey: ['server', serverId] });
            await queryClient.invalidateQueries({ queryKey: ['servers'] });
          }}
        >
          <Input
            name="name"
            label={t('web.name')}
            defaultValue={data.name}
            maxLength={100}
            required
          />
          {data.permissions.sharing && <ProjectChoice server={data} />}
          <small>{t('platform.immutableRuntime')}</small>
        </ActionForm>
      </Section>
      <Section title={t('platform.sharing')}>
        <p>{t('platform.sharingHint')}</p>
        <Link to={data.projectId ? `/projects/${data.projectId}` : '/projects'}>
          {t('web.projects')}
        </Link>
      </Section>
      <Section title={t('platform.resources')}>
        {!data.availableActions.configure ? (
          <Notice>{t('platform.offlineRequired')}</Notice>
        ) : (
          <ActionForm
            key={JSON.stringify(data.limits)}
            submitLabel={t('web.save')}
            success={false}
            onSubmit={async (form) => {
              const job = await request({
                action: 'configure',
                limits: {
                  ...data.limits,
                  memory: number(form, 'memory'),
                  cpu: number(form, 'cpu'),
                  disk: number(form, 'disk'),
                },
              });
              setJobId(job.jobId);
            }}
          >
            <Input
              name="memory"
              label={`${t('web.memory')} (MiB)`}
              type="number"
              min={32}
              max={1048576}
              step={1}
              defaultValue={data.limits.memory}
              required
            />
            <Input
              name="cpu"
              label={`${t('web.cpu')} (%)`}
              hint={t('platform.cpuHint')}
              type="number"
              min={1}
              max={100000}
              step={1}
              defaultValue={data.limits.cpu}
              required
            />
            <Input
              name="disk"
              label={`${t('web.disk')} (MiB)`}
              hint={t('platform.diskGrowOnly')}
              type="number"
              min={data.limits.disk}
              max={1073741824}
              step={1}
              defaultValue={data.limits.disk}
              required
            />
          </ActionForm>
        )}
      </Section>
      <Section title={t('platform.dangerZone')}>
        <div className="actions">
          {(['reinstall', 'wipe', 'delete'] as const).map((action) => (
            <button
              key={action}
              type="button"
              className="danger"
              disabled={!data.availableActions.delete}
              onClick={() => setDestructive(action)}
            >
              {t(action === 'delete' ? 'platform.deleteServer' : `platform.${action}`)}
            </button>
          ))}
        </div>
      </Section>
      <Dialog
        open={destructive !== null}
        title={t(
          destructive === 'delete'
            ? 'platform.deleteServer'
            : `platform.${destructive ?? 'reinstall'}`,
        )}
        onClose={() => setDestructive(null)}
      >
        {destructive && (
          <ActionForm
            key={destructive}
            submitLabel={t('web.confirm')}
            success={false}
            onSubmit={async (form) => {
              const job = await request({
                action: destructive,
                confirm: true,
                backupBefore: form.get('backupBefore') === 'on',
              });
              setJobId(job.jobId);
              setDestructive(null);
            }}
          >
            <p>
              {t(
                destructive === 'delete'
                  ? 'platform.deleteServerWarning'
                  : `platform.${destructive}Warning`,
                { name: data.name },
              )}
            </p>
            {data.capabilities?.backups && (
              <Check name="backupBefore" label={t('platform.backupBefore')} />
            )}
            <Check label={t('platform.confirmConsequence')} required />
          </ActionForm>
        )}
      </Dialog>
    </>
  );
}
