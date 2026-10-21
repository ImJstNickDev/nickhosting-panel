import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  createMinecraftModpacksController,
  type MinecraftModpackOperation,
  type MinecraftModpacksSnapshot,
  type ModpackCatalogProject,
  type ModpackCatalogVersion,
  type ModpackProvider,
} from '../../../../../games/minecraft/src/ui/modpacks-controller.js';
import { idempotencyKey, queryClient } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { ErrorNotice } from '../../components/ui.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { gameUiClient } from '../../features/integrations.js';
import { ViewerSelect } from '../../features/viewer-engine/viewer-select.js';
import {
  modpackKey as k,
  modpackIdentity,
  modpackProviders,
  packRuntimeLabel,
  modpackQueryKey as q,
  recommendedPackVersion,
} from './modpacks-model.js';
import { ModpackReview } from './modpacks-review.js';
import {
  ModsAction,
  ModsArtwork,
  ModsChannel,
  ModsEmpty,
  ModsIcon,
  ModsSkeleton,
} from './mods-primitives.js';
import './mods.css';
import './modpacks.css';

const controller = createMinecraftModpacksController(gameUiClient);
const Description = lazy(() =>
  import('./mods-description.js').then((module) => ({ default: module.ModsDescription })),
);
const terminal = new Set(['applied', 'cancelled']);
const applying = new Set(['apply_queued', 'applying', 'uncertain']);
const active = (operation?: MinecraftModpackOperation | null) =>
  operation && !terminal.has(operation.state) ? operation : undefined;

export function MinecraftModpacksSection(props: GameSectionViewProps) {
  return <Modpacks key={props.serverId} {...props} />;
}
function Modpacks(props: GameSectionViewProps) {
  const t = useT();
  const initial = props.data.metadata?.modpacks as MinecraftModpacksSnapshot | undefined;
  const snapshot = useQuery({
    queryKey: q(props.serverId),
    queryFn: ({ signal }) => controller.snapshot(props.serverId, signal),
    initialData: initial,
    staleTime: 3000,
    refetchInterval: (query) =>
      ['queued', 'preparing', 'apply_queued', 'applying'].includes(
        query.state.data?.operation?.state ?? '',
      )
        ? 1000
        : false,
  });
  const [view, setView] = useState<'installed' | 'discover' | 'review'>(
    initial?.installed ? 'installed' : 'discover',
  );
  const [project, setProject] = useState<ModpackCatalogProject>();
  const [selectedPack, setSelectedPack] = useState<{
    project: ModpackCatalogProject;
    version: ModpackCatalogVersion;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const firstSnapshot = useRef(Boolean(initial));
  const intent = useRef(new Map<string, string>());
  const mutationLock = useRef(false);
  const data = snapshot.data;
  const operation = active(data?.operation);
  const selection = operation?.selection;
  const operationDetails = useQuery({
    queryKey: [...q(props.serverId, 'details'), selection?.provider, selection?.projectId],
    queryFn: ({ signal }) =>
      controller.details(
        props.serverId,
        selection?.provider ?? 'modrinth',
        selection?.projectId ?? '',
        signal,
      ),
    staleTime: 300_000,
    enabled: Boolean(operation && !operation.pack),
  });
  const operationProject =
    operation?.pack?.project ??
    operationDetails.data ??
    (selectedPack &&
    selectedPack.project.provider === selection?.provider &&
    selectedPack.project.id === selection?.projectId
      ? selectedPack.project
      : undefined);
  const operationVersion =
    operation?.pack?.version ??
    (selectedPack &&
    selectedPack.version.id === selection?.versionId &&
    selectedPack.project.id === selection?.projectId &&
    selectedPack.project.provider === selection?.provider
      ? selectedPack.version
      : undefined);
  const locked =
    !props.canManage ||
    props.pending ||
    busy ||
    Boolean(operation && applying.has(operation.state));
  useEffect(() => {
    if (!firstSnapshot.current && data) {
      firstSnapshot.current = true;
      if (data.installed) setView('installed');
    }
  }, [data]);
  function requestKey(key: string) {
    const value = intent.current.get(key) ?? idempotencyKey();
    intent.current.set(key, value);
    return value;
  }
  async function mutate(action: () => Promise<MinecraftModpacksSnapshot>) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await action();
      queryClient.setQueryData(q(props.serverId), result);
    } catch (cause) {
      setError(cause);
      void snapshot.refetch();
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  function choose(selected: ModpackCatalogProject, version: ModpackCatalogVersion) {
    setProject(selected);
    setSelectedPack({ project: selected, version });
    const same =
      data?.installed && modpackIdentity(data.installed.pack.project) === modpackIdentity(selected);
    const mode = data?.installed ? (same ? 'update' : 'replace') : 'install';
    void mutate(async () => {
      if (operation) await controller.discard(props.serverId, operation.id);
      const result = await controller.prepare(props.serverId, {
        provider: selected.provider,
        projectId: selected.id,
        versionId: version.id,
        mode,
        worldPolicy: 'preserve',
        fileDecisions: {},
        idempotencyKey: requestKey(
          `prepare:${operation?.id ?? 'new'}:${selected.provider}:${selected.id}:${version.id}:preserve`,
        ),
      });
      setView('review');
      return result;
    });
  }
  function apply(backupBefore: boolean) {
    if (!operation?.planDigest) return;
    void mutate(async () => {
      const result = await controller.apply(props.serverId, {
        operationId: operation.id,
        planDigest: operation.planDigest ?? '',
        confirm: true,
        backupBefore,
        expectedDeletePaths: operation.deletePaths,
        idempotencyKey: requestKey(`apply:${operation.id}:${operation.planDigest}:${backupBefore}`),
      });
      await queryClient.invalidateQueries({
        queryKey: ['minecraft-console-notices', props.serverId],
      });
      return result;
    });
  }
  function reprepare(worldPolicy: 'preserve' | 'reset') {
    if (!operation) return;
    void mutate(async () => {
      await controller.discard(props.serverId, operation.id);
      return controller.prepare(props.serverId, {
        ...operation.selection,
        worldPolicy,
        idempotencyKey: requestKey(`prepare:${operation.id}:${worldPolicy}`),
      });
    });
  }
  function discard() {
    if (!operation) return;
    void mutate(async () => {
      const result = await controller.discard(props.serverId, operation.id);
      intent.current.clear();
      setView('discover');
      return result;
    });
  }
  const installed = data?.installed;
  return (
    <section className="minecraft-mods minecraft-modpacks">
      <header className="mods-header">
        <nav className="mods-tabs" aria-label={t('games.minecraft.sections.modpacks')}>
          <button
            type="button"
            aria-pressed={view === 'installed'}
            onClick={() => setView('installed')}
          >
            {t(k('installed'))}
          </button>
          <button
            type="button"
            aria-pressed={view === 'discover'}
            onClick={() => setView('discover')}
          >
            {t(k('discover'))}
          </button>
        </nav>
        {operation && view !== 'review' && (
          <button
            type="button"
            className="mods-primary modpacks-review-link"
            onClick={() => setView('review')}
          >
            <ModsIcon name="queue" />
            {t(k('review'))}
            <i data-ready={operation.state === 'ready'} aria-hidden="true" />
          </button>
        )}
      </header>
      {(error || snapshot.error) && (
        <ErrorNotice
          error={error ?? snapshot.error}
          retry={() => {
            setError(undefined);
            void snapshot.refetch();
          }}
        />
      )}
      {operationDetails.error && !operation?.pack && (
        <ErrorNotice
          error={operationDetails.error}
          retry={() => {
            void operationDetails.refetch();
          }}
        />
      )}
      {snapshot.isPending ? (
        <ModsSkeleton label={t(k('loading'))} />
      ) : (
        <>
          <div hidden={view !== 'discover'}>
            <ModpackDiscover
              serverId={props.serverId}
              visible={view === 'discover'}
              project={project}
              onProject={setProject}
              disabled={locked}
              onChoose={choose}
              operation={operation}
              operationProject={operationProject}
            />
          </div>
          {view === 'installed' &&
            (installed ? (
              <article className="modpacks-installed">
                <div className="modpacks-pack-heading">
                  <ModsArtwork
                    image={installed.pack.project.imageUrl}
                    name={installed.pack.project.name}
                  />
                  <div>
                    <span className="modpacks-provider">
                      {modpackProviders[installed.pack.project.provider]}
                    </span>
                    <h3>{installed.pack.project.name}</h3>
                    <p>{installed.pack.version.version}</p>
                  </div>
                  <span className="modpacks-installed-badge">
                    <ModsIcon name="check" />
                    {t(k('completed'))}
                  </span>
                </div>
                <dl className="modpacks-facts">
                  <div>
                    <dt>{t(k('runtime'))}</dt>
                    <dd>{packRuntimeLabel(installed.target)}</dd>
                  </div>
                </dl>
                {data?.operation?.restartRequired && (
                  <p className="modpacks-notice">
                    <ModsIcon name="refresh" />
                    {t(k('restart'))}
                  </p>
                )}
                <div className="modpacks-installed-actions">
                  <button
                    type="button"
                    className="mods-primary"
                    onClick={() => {
                      setProject(installed.pack.project);
                      setView('discover');
                    }}
                  >
                    <ModsIcon name="refresh" />
                    {t(k('checkUpdates'))}
                  </button>
                  <button
                    type="button"
                    className="modpacks-quiet"
                    onClick={() => {
                      setProject(undefined);
                      setView('discover');
                    }}
                  >
                    {t(k('replace'))}
                  </button>
                </div>
              </article>
            ) : (
              <ModsEmpty
                action={
                  <button
                    type="button"
                    className="mods-primary"
                    onClick={() => setView('discover')}
                  >
                    {t(k('discover'))}
                  </button>
                }
              >
                {t(k('empty'))}
              </ModsEmpty>
            ))}
          {view === 'review' &&
            (operation ? (
              <ModpackReview
                operation={operation}
                project={operationProject}
                version={operationVersion}
                canManage={props.canManage}
                busy={busy || props.pending}
                onBack={() => setView('discover')}
                onApply={apply}
                onDiscard={discard}
                onWorldPolicy={reprepare}
                onFileDecision={(path, decision) => {
                  void mutate(async () => {
                    await controller.discard(props.serverId, operation.id);
                    return controller.prepare(props.serverId, {
                      ...operation.selection,
                      fileDecisions: { ...operation.selection.fileDecisions, [path]: decision },
                      idempotencyKey: requestKey(`decision:${operation.id}:${path}:${decision}`),
                    });
                  });
                }}
                onRetry={() => {
                  void mutate(() =>
                    controller.retry(
                      props.serverId,
                      operation,
                      requestKey(`retry:${operation.id}`),
                    ),
                  );
                }}
                onRecover={() => {
                  void mutate(() => controller.recover(props.serverId, operation.id));
                }}
              />
            ) : data?.operation?.state === 'applied' && installed ? (
              <div className="modpacks-complete">
                <ModsIcon name="check" />
                <h3>{t(k('completed'))}</h3>
                <p>
                  {installed.pack.project.name} · {installed.pack.version.version}
                </p>
                <button type="button" className="mods-primary" onClick={() => setView('installed')}>
                  {t(k('installed'))}
                </button>
              </div>
            ) : (
              <ModsEmpty>{t(k('empty'))}</ModsEmpty>
            ))}
        </>
      )}
    </section>
  );
}

function ModpackDiscover(props: {
  serverId: string;
  visible: boolean;
  project?: ModpackCatalogProject;
  onProject: (project?: ModpackCatalogProject) => void;
  disabled: boolean;
  onChoose: (project: ModpackCatalogProject, version: ModpackCatalogVersion) => void;
  operation?: MinecraftModpackOperation;
  operationProject?: ModpackCatalogProject;
}) {
  const t = useT();
  const [provider, setProvider] = useState<ModpackProvider>('modrinth');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const identity = props.project ? modpackIdentity(props.project) : undefined;
  const projectProvider = props.project?.provider;
  useEffect(() => {
    if (projectProvider) setProvider(projectProvider);
  }, [projectProvider]);
  useEffect(() => {
    if (identity && props.visible) heading.current?.focus({ preventScroll: true });
  }, [identity, props.visible]);
  function close() {
    props.onProject(undefined);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      else input.current?.focus({ preventScroll: true });
    });
  }
  const config = useQuery({
    queryKey: q(props.serverId, 'catalog'),
    queryFn: ({ signal }) => controller.catalog(props.serverId, signal),
    staleTime: 60_000,
    enabled: props.visible,
  });
  const available = config.data?.providers.find((item) => item.id === provider)?.available === true;
  const projects = useQuery({
    queryKey: [...q(props.serverId, 'search'), provider, query, offset],
    queryFn: ({ signal }) => controller.search(props.serverId, { provider, query, offset }, signal),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    enabled: available && props.visible,
  });
  const details = useQuery({
    queryKey: [...q(props.serverId, 'details'), props.project?.provider, props.project?.id],
    queryFn: ({ signal }) =>
      controller.details(
        props.serverId,
        props.project?.provider ?? 'modrinth',
        props.project?.id ?? '',
        signal,
      ),
    staleTime: 300_000,
    enabled: Boolean(props.project) && props.visible,
  });
  const project = details.data ?? props.project;
  return (
    <div className="mods-discover">
      <div className="mods-search-toolbar">
        <label className="mods-search">
          <ModsIcon name="search" />
          <input
            ref={input}
            type="search"
            maxLength={200}
            aria-label={t(k('search'))}
            placeholder={t(k('search'))}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <ViewerSelect
          label={t(k('provider'))}
          value={provider}
          className="mods-select"
          options={Object.entries(modpackProviders).map(([value, label]) => ({ value, label }))}
          onChange={(value) => {
            setProvider(value as ModpackProvider);
            setOffset(0);
            props.onProject(undefined);
          }}
        />
      </div>
      {props.operation && (
        <button
          type="button"
          className="modpacks-selection-strip"
          disabled={!props.operationProject}
          onClick={() => props.operationProject && props.onProject(props.operationProject)}
        >
          <ModsArtwork
            name={props.operationProject?.name ?? props.operation.selection.projectId}
            image={props.operationProject?.imageUrl}
          />
          <span>
            <strong>{props.operationProject?.name ?? props.operation.selection.projectId}</strong>
            <small>
              {t(
                k(
                  props.operation.state === 'blocked'
                    ? 'needsAttention'
                    : props.operation.state === 'preparing'
                      ? 'preparing'
                      : props.operation.state === 'apply_queued' ||
                          props.operation.state === 'applying'
                        ? 'applying'
                        : props.operation.state,
                ),
              )}
            </small>
          </span>
          <ModsIcon name="check" />
        </button>
      )}
      {(config.error || projects.error) && (
        <ErrorNotice
          error={config.error ?? projects.error}
          retry={() => {
            void config.refetch();
            void projects.refetch();
          }}
        />
      )}
      <div className="mods-catalog-layout" data-details={Boolean(project) || undefined}>
        <div className="mods-results" aria-busy={projects.isFetching}>
          {config.isPending || (available && projects.isPending) ? (
            <ModsSkeleton label={t(k('loading'))} />
          ) : !available ? (
            <ModsEmpty>{t(k('unavailable'))}</ModsEmpty>
          ) : projects.data?.items.length === 0 ? (
            <ModsEmpty>{t(k('noResults'))}</ModsEmpty>
          ) : (
            <ul className="mods-project-list">
              {projects.data?.items.map((item) => (
                <li
                  key={modpackIdentity(item)}
                  className="mods-project modpacks-project"
                  data-current={
                    (project && modpackIdentity(project) === modpackIdentity(item)) || undefined
                  }
                >
                  <button
                    type="button"
                    className="mods-project-open"
                    aria-label={t(k('details'), { name: item.name })}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      props.onProject(item);
                    }}
                  >
                    <ModsArtwork image={item.imageUrl} name={item.name} />
                    <span className="mods-project-copy">
                      <span className="mods-project-title">
                        <strong>{item.name}</strong>
                      </span>
                      <span className="mods-project-summary">{item.summary}</span>
                      {item.authors.length > 0 && (
                        <small>{t(k('authors'), { authors: item.authors.join(', ') })}</small>
                      )}
                    </span>
                    <ModsIcon name="next" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {projects.data && projects.data.total > projects.data.limit && (
            <PackPagination
              offset={offset}
              total={projects.data.total}
              limit={projects.data.limit}
              onChange={setOffset}
            />
          )}
        </div>
        {project && (
          <aside
            className="mods-details modpacks-details"
            aria-label={t(k('details'), { name: project.name })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                close();
              }
            }}
          >
            <header className="mods-details-header">
              <ModsArtwork image={project.imageUrl} name={project.name} />
              <div>
                <h3 ref={heading} tabIndex={-1}>
                  {project.name}
                </h3>
                {project.authors.length > 0 && (
                  <small>{t(k('authors'), { authors: project.authors.join(', ') })}</small>
                )}
              </div>
              <ModsAction icon="close" label={t(k('closeDetails'))} onClick={close} />
            </header>
            <p className="mods-details-summary">{project.summary}</p>
            <PackVersions
              key={modpackIdentity(project)}
              serverId={props.serverId}
              project={project}
              disabled={props.disabled}
              operation={props.operation}
              onChoose={props.onChoose}
            />
            {/^(https?):\/\//i.test(project.websiteUrl) && (
              <a
                className="modpacks-project-link"
                href={project.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ModsIcon name="external" />
                {t(k('openProject'))}
              </a>
            )}
            {details.error ? (
              <ErrorNotice
                error={details.error}
                retry={() => {
                  void details.refetch();
                }}
              />
            ) : details.isPending ? (
              <ModsSkeleton label={t(k('loading'))} rows={2} />
            ) : (
              details.data?.description && (
                <Suspense fallback={<ModsSkeleton label={t(k('loading'))} rows={2} />}>
                  {details.data.descriptionFormat === 'text' ? (
                    <p className="modpacks-description-text">{details.data.description}</p>
                  ) : (
                    <Description
                      text={details.data.description}
                      format={details.data.descriptionFormat}
                    />
                  )}
                </Suspense>
              )
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
function PackVersions(props: {
  serverId: string;
  project: ModpackCatalogProject;
  disabled: boolean;
  operation?: MinecraftModpackOperation;
  onChoose: (project: ModpackCatalogProject, version: ModpackCatalogVersion) => void;
}) {
  const t = useT();
  const format = useFormat();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string>();
  const versions = useQuery({
    queryKey: [...q(props.serverId, 'versions'), props.project.provider, props.project.id, offset],
    queryFn: ({ signal }) =>
      controller.versions(props.serverId, props.project.provider, props.project.id, offset, signal),
    staleTime: 300_000,
  });
  const recommended = recommendedPackVersion(versions.data?.items ?? []);
  const chosen = versions.data?.items.find(
    (item) => item.id === (selected ?? recommended?.id ?? versions.data?.items[0]?.id),
  );
  const same =
    props.operation?.selection.provider === props.project.provider &&
    props.operation.selection.projectId === props.project.id &&
    props.operation.selection.versionId === chosen?.id;
  return (
    <div className="modpacks-version-picker">
      <div className="modpacks-version-label">
        <strong>{t(k('version'))}</strong>
        {!selected && recommended?.channel === 'release' && <small>{t(k('latestStable'))}</small>}
      </div>
      {versions.error ? (
        <ErrorNotice
          error={versions.error}
          retry={() => {
            void versions.refetch();
          }}
        />
      ) : versions.isPending ? (
        <ModsSkeleton label={t(k('loading'))} rows={1} />
      ) : versions.data?.items.length === 0 ? (
        <p>{t(k('noVersions'))}</p>
      ) : (
        <>
          <ViewerSelect
            label={t(k('version'))}
            value={chosen?.id ?? ''}
            className="mods-select modpacks-version-select"
            options={(versions.data?.items ?? []).map((version) => ({
              value: version.id,
              label: `${version.version}${version.channel === 'beta' ? ' · BETA' : version.channel === 'alpha' ? ' · ALPHA' : ''}${!version.available ? ` · ${t(k(`unavailable.${version.unavailableReason ?? 'unresolved'}`))}` : ''}`,
            }))}
            onChange={setSelected}
          />
          {chosen && (
            <>
              <div className="modpacks-version-facts">
                <span>{chosen.minecraftVersions.join(', ')}</span>
                <span>{chosen.loaders.join(', ')}</span>
                {chosen.bytes !== undefined && <span>{format.bytes(chosen.bytes)}</span>}
                {chosen.channel !== 'unknown' && <ModsChannel channel={chosen.channel} />}
              </div>
              {!chosen.available && (
                <p className="modpacks-notice">
                  <ModsIcon name="warning" />
                  {t(k(`unavailable.${chosen.unavailableReason ?? 'unresolved'}`))}
                </p>
              )}
              <button
                type="button"
                className="mods-primary"
                disabled={props.disabled || !chosen.available || same}
                onClick={() => props.onChoose(props.project, chosen)}
              >
                <ModsIcon name={same ? 'check' : 'download'} />
                {t(k(same ? 'selected' : 'choose'))}
              </button>
            </>
          )}
          {versions.data && versions.data.total > versions.data.limit && (
            <PackPagination
              offset={offset}
              limit={versions.data.limit}
              total={versions.data.total}
              onChange={(value) => {
                setOffset(value);
                setSelected(undefined);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
export function PackPagination({
  offset,
  total,
  limit,
  onChange,
}: {
  offset: number;
  total: number;
  limit: number;
  onChange: (offset: number) => void;
}) {
  const t = useT();
  return (
    <div className="mods-pagination">
      <ModsAction
        icon="back"
        label={t(k('previous'))}
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      />
      <span>
        {t(k('page'), { page: Math.floor(offset / limit) + 1, pages: Math.ceil(total / limit) })}
      </span>
      <ModsAction
        icon="next"
        label={t(k('next'))}
        disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      />
    </div>
  );
}
