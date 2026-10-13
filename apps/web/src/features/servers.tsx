import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
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
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  Badge,
  Check,
  Details,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
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
import {
  platformPath,
  type Resources,
  type ServerInfo,
  serverPath,
  useServer,
} from './service-contracts.js';
import { useStorageUsage } from './use-storage-usage.js';
import './home.css';

export { ServersPage } from './server-browser.js';

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
function ServerCardResource({
  icon,
  label,
  children,
}: {
  icon: keyof typeof quotaIcons;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="server-card-resource">
      <dt>
        <span className="visually-hidden">{label}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={quotaIcons[icon]} />
        </svg>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
function ServerCard({
  server,
  headingLevel = 2,
  ownerName,
}: {
  server: ServerInfo;
  headingLevel?: 2 | 3;
  ownerName?: string;
}) {
  const t = useT(),
    format = useFormat();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const resources = useQuery({
    queryKey: ['resources', server.id],
    queryFn: ({ signal }) => api<Resources>(`${serverPath(server.id)}/resources`, { signal }),
    refetchInterval: 10000,
  });
  const bytes =
    !resources.error && now - resources.dataUpdatedAt < 30000
      ? resources.data?.resources.disk_bytes
      : undefined;
  const disk =
    bytes !== undefined && Number.isFinite(bytes) && bytes >= 0
      ? format.bytes(bytes)
      : t(resources.isPending ? 'web.loading' : 'web.unavailable');
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const artwork = getGameArtwork(server.gameId);
  return (
    <li key={server.id} className="server-card">
      <Tooltip
        content={[
          `${t('platform.memoryLimit')}: ${format.number(server.limits.memory)} MiB`,
          `${t('platform.cpuLimit')}: ${format.number(server.limits.cpu)}%`,
          `${t('web.disk')} · ${t('web.usage')}: ${disk}`,
        ].join('\n')}
      >
        <Link
          className="server-card-link"
          to={`/servers/${server.id}`}
          aria-labelledby={`server-card-name-${server.id}`}
          aria-describedby={`server-card-resources-${server.id}`}
        >
          {artwork && <img className="server-artwork" src={artwork} alt="" loading="lazy" />}
          <div className="server-card-body">
            <div className="server-card-heading">
              <Heading id={`server-card-name-${server.id}`}>{server.name}</Heading>
              <Badge
                value={server.runtimeState}
                label={t(
                  server.runtimeState === 'running'
                    ? 'platform.online'
                    : statusKey(server.runtimeState),
                )}
              />
            </div>
            <p className="muted">
              {server.gameNameKey ? t(server.gameNameKey) : server.gameId} · {server.runtimeId}
              {ownerName && <span className="server-card-owner"> · {ownerName}</span>}
            </p>
            <dl className="server-card-resources" id={`server-card-resources-${server.id}`}>
              <ServerCardResource icon="memoryMiB" label={t('platform.memoryLimit')}>
                {format.number(server.limits.memory)} MiB
              </ServerCardResource>
              <ServerCardResource icon="cpuPercent" label={t('platform.cpuLimit')}>
                {format.number(server.limits.cpu)}%
              </ServerCardResource>
              <ServerCardResource icon="storageMiB" label={`${t('web.disk')} · ${t('web.usage')}`}>
                {disk}
              </ServerCardResource>
            </dl>
          </div>
        </Link>
      </Tooltip>
      {server.activeOperationId && (
        <div className="server-card-footer">
          <Link to={`/activity/${server.activeOperationId}`}>{t('platform.activeOperation')}</Link>
        </div>
      )}
    </li>
  );
}
export function ServerCards({
  items,
  headingLevel = 2,
  view = 'grid',
  ownerNames,
}: {
  items: ServerInfo[];
  headingLevel?: 2 | 3;
  view?: 'grid' | 'list';
  ownerNames?: Map<string, string>;
}) {
  return (
    <ul className={`server-grid ${view === 'list' ? 'server-list' : ''}`}>
      {items.map((server) => (
        <ServerCard
          key={server.id}
          server={server}
          headingLevel={headingLevel}
          ownerName={ownerNames?.get(server.ownerId)}
        />
      ))}
    </ul>
  );
}
function HomeSection({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: { to: string; label: string };
}) {
  return (
    <section className="home-section">
      <header className="section-heading">
        <h2>{title}</h2>
        {action && (
          <Link className="home-section-link" to={action.to}>
            {action.label}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m9 5 7 7-7 7" />
            </svg>
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

const quotaIcons = {
  memoryMiB: 'M3 7h18v10H3ZM7 10v4m5-4v4m5-4v4M7 17v3m5-3v3m5-3v3',
  cpuPercent:
    'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 9h6v6H9ZM9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3m16-6h3m-3 6h3',
  storageMiB: 'M5 4h14l2 10v6H3v-6L5 4ZM3 14h18M7 17h1m3 0h1',
  serverCount: 'M4 3h16v7H4ZM4 14h16v7H4ZM7 6h1m-1 11h1',
};

export function QuotaSummary() {
  const t = useT(),
    format = useFormat();
  const quota = useQuery({
    queryKey: ['quota'],
    queryFn: () => api<Quota>('/v1/platform/quotas'),
    refetchInterval: 15000,
  });
  const storageUsage = useStorageUsage(
    quota.data?.storageUsage,
    quota.data?.observedAt,
    quota.dataUpdatedAt,
  );
  return (
    <HomeSection title={t('web.quota')}>
      {quota.isPending ? (
        <Loading />
      ) : quota.error ? (
        <ErrorNotice error={quota.error} retry={() => void quota.refetch()} />
      ) : (
        quota.data && (
          <>
            <div className="home-quota-grid">
              {(['memoryMiB', 'cpuPercent', 'storageMiB', 'serverCount'] as const).map((key) => {
                const unit = key.endsWith('MiB') ? ' MiB' : key === 'cpuPercent' ? '%' : '';
                const amount = (value: number) => `${format.number(value)}${unit}`;
                return (
                  <article className="home-quota-card" key={key}>
                    <header>
                      <span className="home-quota-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d={quotaIcons[key]} />
                        </svg>
                      </span>
                      <h3>
                        {t(
                          key === 'memoryMiB'
                            ? 'web.memory'
                            : key === 'cpuPercent'
                              ? 'web.cpu'
                              : key === 'storageMiB'
                                ? 'web.disk'
                                : 'web.servers',
                        )}
                      </h3>
                    </header>
                    <dl>
                      <div className="home-quota-committed">
                        <dt>
                          {t(
                            key === 'storageMiB' && quota.data.limits.storageMiB === null
                              ? 'web.usage'
                              : 'web.reserved',
                          )}
                        </dt>
                        <dd>
                          {key === 'storageMiB' && quota.data.limits.storageMiB === null
                            ? storageUsage === null
                              ? t('web.unavailable')
                              : format.bytes(storageUsage)
                            : amount(quota.data.committed[key])}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('web.quota')}</dt>
                        <dd>
                          {quota.data.limits[key] === null
                            ? t(
                                key === 'serverCount' ||
                                  (key === 'storageMiB' && quota.data.storageBudgetMiB === 0)
                                  ? 'platform.unlimited'
                                  : 'platform.globalPool',
                              )
                            : amount(quota.data.limits[key])}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('platform.remaining')}</dt>
                        <dd>
                          {key === 'storageMiB' && quota.data.limits.storageMiB === null ? (
                            quota.data.sharedStorageAvailableBytes == null ? (
                              t('web.unavailable')
                            ) : (
                              format.bytes(quota.data.sharedStorageAvailableBytes)
                            )
                          ) : quota.data.remaining[key] === null ? (
                            key === 'serverCount' ? (
                              <span role="img" aria-label={t('platform.unlimited')}>
                                ∞
                              </span>
                            ) : (
                              '—'
                            )
                          ) : (
                            amount(quota.data.remaining[key])
                          )}
                        </dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
            <p className="home-quota-hint muted">{t('platform.allowanceHint')}</p>
          </>
        )
      )}
    </HomeSection>
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
      <HomeSection
        title={t('platform.recentServers')}
        action={{ to: '/servers', label: t('platform.allServers') }}
      >
        {servers.isPending ? (
          <Loading />
        ) : servers.error ? (
          <ErrorNotice error={servers.error} retry={() => void servers.refetch()} />
        ) : servers.data?.items.length ? (
          <ServerCards items={servers.data.items} headingLevel={3} />
        ) : (
          <Empty text={t('web.noServers')} />
        )}
      </HomeSection>
      <QuotaSummary />
      <HomeSection
        title={t('platform.recentActivity')}
        action={{ to: '/activity', label: t('platform.allActivity') }}
      >
        {activity.isPending ? (
          <Loading />
        ) : activity.error ? (
          <ErrorNotice error={activity.error} retry={() => void activity.refetch()} />
        ) : !activity.data?.items.length ? (
          <Empty text={t('platform.noActivity')} />
        ) : (
          <ul className="home-activity-list">
            {activity.data.items.map((job) => (
              <li key={job.id}>
                <Link to={`/activity/${job.id}`}>
                  <span>{job.serverName ?? t('platform.operation')}</span>
                  <span className="muted">
                    {t(job.action ? `platform.${job.action}` : 'platform.operation')}
                  </span>
                </Link>
                <Badge value={job.effectState === 'uncertain' ? 'uncertain' : job.state} />
                <Time value={job.updatedAt} />
              </li>
            ))}
          </ul>
        )}
      </HomeSection>
    </Page>
  );
}
/** Keep the intent key through a lost response. Retrying the same form must not
 * create a duplicate external operation; a changed payload is a new intent. */
export function useRequestOperation(serverId: string) {
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
    // Acceptance is not completion. Disable conflicting actions immediately,
    // without making the control wait for unrelated background refreshes.
    await queryClient.cancelQueries({ queryKey: ['server', serverId], exact: true });
    queryClient.setQueryData<ServerInfo>(['server', serverId], (current) =>
      current
        ? {
            ...current,
            activeOperationId: result.jobId,
            availableActions: {
              ...current.availableActions,
              start: false,
              stop: false,
              restart: false,
              kill: false,
              backup: false,
              configure: false,
              delete: false,
            },
          }
        : current,
    );
    void Promise.allSettled([
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
    server = useServer(serverId);

  if (server.isPending) return <Loading />;
  if (server.error) return <ErrorNotice error={server.error} retry={() => void server.refetch()} />;
  const data = server.data;
  if (!data) return null;
  return (
    <Section title={t('web.serverStatus')}>
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
              <Badge key="readiness" value={data.readiness} label={t(statusKey(data.readiness))} />
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
  const [destructive, setDestructive] = useState<'reinstall' | 'wipe' | 'delete' | null>(null);
  if (server.isPending) return <Loading />;
  if (server.error) return <ErrorNotice error={server.error} />;
  const data = server.data;
  if (!data) return null;
  if (!data.permissions.manage) return <Notice>{t('errors.forbidden')}</Notice>;
  return (
    <>
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
              await request({
                action: 'configure',
                limits: {
                  ...data.limits,
                  memory: number(form, 'memory'),
                  cpu: number(form, 'cpu'),
                  disk: data.limits.disk === 0 ? 0 : number(form, 'disk'),
                },
              });
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
            {data.limits.disk === 0 ? (
              <p className="muted">{t('gameUi.sharedStorage')}</p>
            ) : (
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
            )}
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
              await request({
                action: destructive,
                confirm: true,
                backupBefore: form.get('backupBefore') === 'on',
              });
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
