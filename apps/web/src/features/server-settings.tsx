import { useInfiniteQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import type { listPlatformProjects } from '../../../../packages/server-management/src/platform-queries.js';
import { api, queryClient } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useT } from '../app/i18n.js';
import { useUnsavedChanges } from '../components/navigation-guard.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  ConfirmDialog,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  number,
  Select,
  text,
} from '../components/ui.js';
import { Switch } from '../components/workspace-controls.js';
import { useRequestOperation } from './servers.js';
import { platformPath, type ServerInfo, useServer } from './service-contracts.js';
import './server-settings.css';

type DestructiveAction = 'reinstall' | 'wipe' | 'delete';
type IconName = DestructiveAction | 'reset' | 'search' | 'arrow';
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    reset: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    reinstall: (
      <>
        <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
        <path d="M12 8v8m-3-3 3 3 3-3" />
      </>
    ),
    wipe: (
      <>
        <path d="m9 5 10 10-6 6L3 11l6-6Zm-1 11 6-6M13 21h8" />
      </>
    ),
    delete: (
      <>
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function Reset({ onClick }: { onClick(): void }) {
  const t = useT();
  return (
    <Tooltip content={t('serverSettings.reset')}>
      <button
        type="button"
        className="server-settings-icon"
        aria-label={t('serverSettings.reset')}
        onClick={onClick}
      >
        <Icon name="reset" />
      </button>
    </Tooltip>
  );
}
function SettingsSection({
  title,
  children,
  status,
  className = '',
}: {
  title: string;
  children: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={`server-settings-section ${className}`} aria-labelledby={id}>
      <header>
        <h2 id={id}>{title}</h2>
        {status}
      </header>
      <div className="server-settings-surface">{children}</div>
    </section>
  );
}
async function refreshMetadata(serverId: string) {
  await queryClient.invalidateQueries({ queryKey: ['server', serverId] });
  void queryClient.invalidateQueries({ queryKey: ['servers'] });
}
function NameSettings({ server }: { server: ServerInfo }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? server.name;
  const dirty = value.trim() !== server.name;
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(dirty, saving);
  return (
    <ActionForm
      className={`server-settings-form server-settings-row ${dirty ? 'is-dirty' : ''}`}
      success={false}
      disabled={!server.permissionKeys.includes('settings.write')}
      onBusyChange={setSaving}
      submitDisabled={!dirty}
      footerStart={<Reset onClick={() => setDraft(null)} />}
      onSubmit={async (form) => {
        await api(platformPath(server.id), {
          method: 'PATCH',
          body: { name: text(form, 'name').trim() },
        });
        await refreshMetadata(server.id);
        setDraft(null);
      }}
    >
      <Input
        name="name"
        label={t('web.name')}
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={100}
        required
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
      />
    </ActionForm>
  );
}
function ProjectSettings({ server }: { server: ServerInfo }) {
  const t = useT();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const selected = draft ?? server.projectId ?? '';
  const dirty = selected !== (server.projectId ?? '');
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(dirty, saving);
  const projects = useInfiniteQuery({
    queryKey: ['projects', 'assignment', query],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<Result<typeof listPlatformProjects>>(
        `/v1/platform/projects?${new URLSearchParams({ limit: '100', ...(query ? { q: query } : {}), ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const owned =
    projects.data?.pages
      .flatMap((page) => page.items)
      .filter((project) => project.owner_id === server.ownerId) ?? [];
  return (
    <div className="server-settings-row">
      <ActionForm
        className={`server-settings-form ${dirty ? 'is-dirty' : ''}`}
        success={false}
        onBusyChange={setSaving}
        submitDisabled={!dirty}
        footerStart={<Reset onClick={() => setDraft(null)} />}
        onSubmit={async () => {
          await api(platformPath(server.id), {
            method: 'PATCH',
            body: { projectId: selected || null },
          });
          await refreshMetadata(server.id);
          setDraft(null);
        }}
      >
        <div className="server-settings-project">
          <Select
            name="projectId"
            label={t('platform.project')}
            value={selected}
            onChange={(event) => setDraft(event.target.value)}
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
          <Tooltip content={t('platform.projectSearch')}>
            <button
              type="button"
              className="server-settings-icon"
              aria-label={t('platform.projectSearch')}
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen(!searchOpen);
                if (searchOpen) setSearch('');
              }}
            >
              <Icon name="search" />
            </button>
          </Tooltip>
        </div>
        {searchOpen && (
          <Input
            type="search"
            label={t('platform.projectSearch')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
        {projects.error && <ErrorNotice error={projects.error} />}
        {projects.hasNextPage && (
          <button
            className="server-settings-text"
            type="button"
            disabled={projects.isFetchingNextPage}
            onClick={() => void projects.fetchNextPage()}
          >
            {t('platform.moreProjects')}
          </button>
        )}
        {dirty && (
          <p className="server-settings-hint">
            {t(selected ? 'serverSettings.projectAccess' : 'serverSettings.projectDetach')}
          </p>
        )}
      </ActionForm>
      {server.projectId && (
        <Link className="server-settings-link" to={`/projects/${server.projectId}`}>
          {t('serverSettings.manageSharing')}
          <Icon name="arrow" />
        </Link>
      )}
    </div>
  );
}
function unavailableReason(server: ServerInfo): string {
  if (server.activeOperationId) return 'serverSettings.waitOperation';
  if (server.runtimeState !== 'offline') return 'serverSettings.stopRequired';
  return 'serverSettings.temporarilyUnavailable';
}
function Availability({ server, available }: { server: ServerInfo; available: boolean }) {
  const t = useT();
  if (available) return null;
  return (
    <span className="server-settings-availability" role="status">
      {t(unavailableReason(server))}
    </span>
  );
}
function ResourceSettings({
  server,
  request,
}: {
  server: ServerInfo;
  request: ReturnType<typeof useRequestOperation>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const limits = server.limits;
  const fields = [
    { name: 'memory' as const, label: `${t('web.memory')} (MiB)`, min: 32, max: 1048576 },
    { name: 'cpu' as const, label: `${t('web.cpu')} (%)`, min: 1, max: 100000 },
    ...(limits.disk === 0
      ? []
      : [
          {
            name: 'disk' as const,
            label: `${t('web.disk')} (MiB)`,
            min: limits.disk,
            max: 1073741824,
          },
        ]),
  ];
  const dirty = fields.some(
    ({ name }) => draft[name] !== undefined && Number(draft[name]) !== limits[name],
  );
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(dirty, saving);
  return (
    <ActionForm
      className={`server-settings-resources server-settings-row ${dirty ? 'is-dirty' : ''}`}
      success={false}
      disabled={!server.availableActions.configure}
      onBusyChange={setSaving}
      submitDisabled={!dirty}
      footerStart={<Reset onClick={() => setDraft({})} />}
      onSubmit={async (form) => {
        await request({
          action: 'configure',
          limits: {
            ...limits,
            memory: number(form, 'memory'),
            cpu: number(form, 'cpu'),
            disk: limits.disk === 0 ? 0 : number(form, 'disk'),
          },
        });
      }}
    >
      <div className="server-settings-resource-fields">
        {fields.map(({ name, label, min, max }) => (
          <Input
            key={name}
            name={name}
            label={label}
            type="number"
            min={min}
            max={max}
            step={1}
            value={draft[name] ?? String(limits[name])}
            onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
            required
            hint={
              name === 'cpu'
                ? t('serverSettings.cpuUnit')
                : name === 'disk'
                  ? t('platform.diskGrowOnly')
                  : undefined
            }
          />
        ))}
      </div>
    </ActionForm>
  );
}
export function ServerSettings({ serverId }: { serverId: string }) {
  const t = useT();
  const server = useServer(serverId);
  const request = useRequestOperation(serverId);
  const [action, setAction] = useState<DestructiveAction | null>(null);
  const [backupBefore, setBackupBefore] = useState(false);
  if (server.isPending) return <Loading />;
  if (server.error && !server.data)
    return <ErrorNotice error={server.error} retry={() => void server.refetch()} />;
  const data = server.data;
  if (!data) return null;
  if (!data.permissionKeys.includes('settings.read'))
    return <Notice>{t('errors.forbidden')}</Notice>;
  const label = (value: DestructiveAction) =>
    t(value === 'delete' ? 'platform.deleteServer' : `platform.${value}`);
  return (
    <div className="server-settings" key={data.id}>
      <SettingsSection
        title={t('serverSettings.general')}
        className={data.permissions.sharing ? 'server-settings-general' : ''}
      >
        <NameSettings server={data} />
        {data.permissions.sharing && <ProjectSettings server={data} />}
      </SettingsSection>
      {data.permissions.manage && (
        <SettingsSection
          title={t('platform.resources')}
          status={<Availability server={data} available={data.availableActions.configure} />}
        >
          <ResourceSettings key={data.id} server={data} request={request} />
        </SettingsSection>
      )}
      {data.permissions.manage && (
        <SettingsSection
          title={t('serverSettings.maintenance')}
          status={<Availability server={data} available={data.availableActions.delete} />}
        >
          {(['reinstall', 'wipe', 'delete'] as const).map((value) => (
            <div
              className={`server-settings-maintenance server-settings-row ${value === 'delete' ? 'server-settings-delete' : ''}`}
              key={value}
            >
              <div className="server-settings-action-name">
                <span className="server-settings-action-icon">
                  <Icon name={value} />
                </span>
                <div>
                  <h3>{label(value)}</h3>
                  <p>{t(`serverSettings.${value}Hint`)}</p>
                </div>
              </div>
              <button
                type="button"
                className={value === 'delete' ? 'server-settings-destructive' : 'secondary'}
                disabled={!data.availableActions.delete}
                onClick={() => {
                  setBackupBefore(false);
                  setAction(value);
                }}
              >
                {label(value)}
              </button>
            </div>
          ))}
        </SettingsSection>
      )}
      <ConfirmDialog
        open={action !== null}
        title={label(action ?? 'reinstall')}
        confirmLabel={label(action ?? 'reinstall')}
        destructive
        onClose={() => setAction(null)}
        onConfirm={async () => {
          if (!action) return;
          await request({ action, confirm: true, backupBefore });
          setAction(null);
        }}
      >
        <p>
          {t(
            action === 'delete'
              ? 'platform.deleteServerWarning'
              : `platform.${action ?? 'reinstall'}Warning`,
            { name: data.name },
          )}
        </p>
        {data.availableActions.backup && (
          <Switch
            className="server-settings-backup"
            label={t('platform.backupBefore')}
            checked={backupBefore}
            onChange={setBackupBefore}
          />
        )}
      </ConfirmDialog>
    </div>
  );
}
