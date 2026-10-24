import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
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
import { ConfirmDialog, ErrorNotice } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { gameUiClient } from '../../features/integrations.js';
import { ViewerSelect } from '../../features/viewer-engine/viewer-select.js';
import { ModpackProviderLabel } from './modpack-provider-label.js';
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
  ModsArtwork,
  ModsChannel,
  ModsCheckbox,
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
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const [noUpdates, setNoUpdates] = useState(false);
  const requestedOperation = searchParams.get('operation');
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
    initial?.operation?.id === requestedOperation && active(initial?.operation)
      ? 'review'
      : initial?.installed
        ? 'installed'
        : 'discover',
  );
  const [project, setProject] = useState<ModpackCatalogProject>();
  const [selectedPack, setSelectedPack] = useState<{
    project: ModpackCatalogProject;
    version: ModpackCatalogVersion;
  }>();
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    action: () => void;
    reprepare: boolean;
  }>();
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
  const canDeleteWorlds = props.permissionKeys.includes('game.minecraft.worlds.delete');
  const canBackup = props.permissionKeys.includes('backups.create');
  const locked =
    !props.permissionKeys.includes('game.minecraft.modpacks.write') ||
    props.pending ||
    busy ||
    operation?.canCancel === false ||
    Boolean(operation && applying.has(operation.state));
  const canContinueOperation =
    (operation?.selection.worldPolicy !== 'reset' || canDeleteWorlds) &&
    (!operation?.selection.install?.backupBefore || canBackup);
  const canRecover =
    canContinueOperation &&
    props.permissionKeys.includes('game.minecraft.modpacks.write') &&
    !busy &&
    !snapshot.error &&
    operation?.state === 'uncertain' &&
    (!props.pending || props.recoverableOperationId === operation.id);
  useEffect(() => {
    if (!firstSnapshot.current && data) {
      firstSnapshot.current = true;
      if (data.operation?.id === requestedOperation && active(data.operation)) setView('review');
      else if (data.installed) setView('installed');
    }
  }, [data, requestedOperation]);
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
  function choose(
    selected: ModpackCatalogProject,
    version: ModpackCatalogVersion,
    options: { keepWorlds: boolean; backupBefore: boolean },
  ) {
    if ((options.backupBefore && !canBackup) || (!options.keepWorlds && !canDeleteWorlds)) return;
    setProject(selected);
    setSelectedPack({ project: selected, version });
    const same =
      data?.installed && modpackIdentity(data.installed.pack.project) === modpackIdentity(selected);
    const mode = data?.installed ? (same ? 'update' : 'replace') : 'install';
    void mutate(async () => {
      if (operation) await controller.discard(props.serverId, operation.id);
      const result = await controller.install(props.serverId, {
        provider: selected.provider,
        projectId: selected.id,
        versionId: version.id,
        mode,
        worldPolicy: options.keepWorlds ? 'preserve' : 'reset',
        fileDecisions: {},
        install: { backupBefore: options.backupBefore },
        idempotencyKey: requestKey(
          `prepare:${operation?.id ?? 'new'}:${selected.provider}:${selected.id}:${version.id}:${options.keepWorlds}:${options.backupBefore}`,
        ),
      });
      navigate(`/servers/${props.serverId}/console`, {
        state: { provisioningJobId: result.operation?.id },
      });
      return result;
    });
  }
  function apply(backupBefore: boolean) {
    if (
      !operation?.planDigest ||
      (backupBefore && !canBackup) ||
      (operation.selection.worldPolicy === 'reset' && !canDeleteWorlds)
    )
      return;
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
  function confirmRuntimeChange(action: () => void, reprepare = false) {
    if (operation?.cancellationEffect === 'runtime-retained')
      setConfirmation({ action, reprepare });
    else action();
  }
  function reprepare(
    changes: Partial<Pick<MinecraftModpackOperation['selection'], 'worldPolicy' | 'fileDecisions'>>,
  ) {
    if (!operation) return;
    confirmRuntimeChange(() => {
      void mutate(async () => {
        await controller.discard(props.serverId, operation.id);
        return controller.prepare(props.serverId, {
          ...operation.selection,
          ...changes,
          idempotencyKey: requestKey(`prepare:${operation.id}:${JSON.stringify(changes)}`),
        });
      });
    }, true);
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
  async function checkUpdates() {
    if (!data?.installed || checkingUpdates) return;
    setCheckingUpdates(true);
    setNoUpdates(false);
    setError(undefined);
    try {
      const current = data.installed.pack;
      const versions = await controller.versions(
        props.serverId,
        current.project.provider,
        current.project.id,
        0,
      );
      const latest = recommendedPackVersion(versions.items);
      queryClient.setQueryData(
        [...q(props.serverId, 'versions'), current.project.provider, current.project.id],
        { pages: [versions], pageParams: [0] },
      );
      if (
        !latest ||
        latest.id === current.version.id ||
        (latest.publishedAt &&
          current.version.publishedAt &&
          Date.parse(latest.publishedAt) <= Date.parse(current.version.publishedAt))
      ) {
        setNoUpdates(true);
      } else {
        setDetailRevision((value) => value + 1);
        setProject(current.project);
        setView('discover');
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setCheckingUpdates(false);
    }
  }
  const installed = data?.installed;
  return (
    <section className="workspace-surface minecraft-mods minecraft-modpacks">
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
              detailRevision={detailRevision}
              onProject={setProject}
              disabled={locked}
              canBackup={canBackup}
              canDeleteWorlds={canDeleteWorlds}
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
                    disabled={checkingUpdates}
                    onClick={() => void checkUpdates()}
                  >
                    <ModsIcon name="refresh" />
                    {t(k(checkingUpdates ? 'checkingUpdates' : 'checkUpdates'))}
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
                {noUpdates && (
                  <p className="modpacks-update-result" role="status">
                    <ModsIcon name="check" />
                    {t(k('noUpdates'))}
                  </p>
                )}
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
                canManage={props.permissionKeys.includes('game.minecraft.modpacks.write')}
                canBackup={canBackup}
                canDeleteWorlds={canDeleteWorlds}
                busy={busy || (props.pending && props.recoverableOperationId !== operation.id)}
                canRecover={canRecover}
                onBack={() => setView('discover')}
                onApply={apply}
                onDiscard={() => confirmRuntimeChange(discard)}
                onWorldPolicy={(worldPolicy) => {
                  if (worldPolicy === 'preserve' || canDeleteWorlds) reprepare({ worldPolicy });
                }}
                onFileDecision={(path, decision) => {
                  if (!canContinueOperation) return;
                  reprepare({
                    fileDecisions: { ...operation.selection.fileDecisions, [path]: decision },
                  });
                }}
                onRetry={() => {
                  if (!canContinueOperation) return;
                  void mutate(() =>
                    controller.retry(
                      props.serverId,
                      operation,
                      requestKey(`retry:${operation.id}`),
                    ),
                  );
                }}
                onRecover={() => {
                  if (!canRecover) return;
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
      <ConfirmDialog
        open={Boolean(confirmation)}
        title={t(k(confirmation?.reprepare ? 'reprepareRetainedTitle' : 'cancelRetainedTitle'))}
        confirmLabel={t(
          k(confirmation?.reprepare ? 'reprepareRetainedConfirm' : 'cancelRetainedConfirm'),
        )}
        destructive
        busy={busy}
        onClose={() => setConfirmation(undefined)}
        onConfirm={async () => {
          const action = confirmation?.action;
          setConfirmation(undefined);
          action?.();
        }}
      >
        <p>{t(k(confirmation?.reprepare ? 'reprepareRetainedBody' : 'cancelRetainedBody'))}</p>
      </ConfirmDialog>
    </section>
  );
}

function ModpackDiscover(props: {
  serverId: string;
  visible: boolean;
  project?: ModpackCatalogProject;
  detailRevision: number;
  onProject: (project?: ModpackCatalogProject) => void;
  disabled: boolean;
  canBackup: boolean;
  canDeleteWorlds: boolean;
  onChoose: (
    project: ModpackCatalogProject,
    version: ModpackCatalogVersion,
    options: { keepWorlds: boolean; backupBefore: boolean },
  ) => void;
  operation?: MinecraftModpackOperation;
  operationProject?: ModpackCatalogProject;
}) {
  const t = useT();
  const [provider, setProvider] = useState<ModpackProvider>('modrinth');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState('');
  const scrollPosition = useRef(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailView = useRef<HTMLElement>(null);
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
    if (identity && props.visible) {
      heading.current?.focus({ preventScroll: true });
      detailView.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [identity, props.visible]);
  function close() {
    props.onProject(undefined);
    requestAnimationFrame(() => {
      window.scrollTo({ top: scrollPosition.current, behavior: 'instant' });
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
  const categories = useQuery({
    queryKey: [...q(props.serverId, 'categories'), provider],
    queryFn: ({ signal }) => controller.categories(props.serverId, provider, signal),
    staleTime: 300_000,
    enabled: props.visible && available,
  });
  const projects = useQuery({
    queryKey: [...q(props.serverId, 'search'), provider, query, offset, category],
    queryFn: ({ signal }) =>
      controller.search(
        props.serverId,
        { provider, query, offset, category: category || undefined },
        signal,
      ),
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
      <div className="mods-search-toolbar" hidden={Boolean(project)}>
        <SearchField
          ref={input}
          maxLength={200}
          label={t(k('search'))}
          placeholder={t(k('search'))}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ViewerSelect
          label={t(k('provider'))}
          value={provider}
          className="mods-select modpacks-provider-select"
          triggerContent={<ModpackProviderLabel provider={provider} />}
          options={Object.entries(modpackProviders).map(([value, label]) => ({
            value,
            label,
            content: <ModpackProviderLabel provider={value as ModpackProvider} />,
          }))}
          onChange={(value) => {
            setProvider(value as ModpackProvider);
            setOffset(0);
            setCategory('');
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
      {(config.error || projects.error || categories.error) && (
        <ErrorNotice
          error={config.error ?? projects.error ?? categories.error}
          retry={() => {
            void config.refetch();
            void projects.refetch();
            void categories.refetch();
          }}
        />
      )}
      <div className="modpacks-catalog-layout" data-details={Boolean(project) || undefined}>
        <aside
          className="modpacks-categories"
          hidden={Boolean(project) || !categories.data?.items.length}
          aria-label={t(k('categories'))}
        >
          <h4>{t(k('categories'))}</h4>
          <button
            type="button"
            aria-pressed={!category}
            onClick={() => {
              setCategory('');
              setOffset(0);
            }}
          >
            {t(k('allCategories'))}
          </button>
          {categories.data?.items.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={category === item.id}
              onClick={() => {
                setCategory(item.id);
                setOffset(0);
              }}
            >
              {item.name}
            </button>
          ))}
        </aside>
        <div hidden={Boolean(project)} className="mods-results" aria-busy={projects.isFetching}>
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
                      scrollPosition.current = window.scrollY;
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
            ref={detailView}
            className="mods-details modpacks-details"
            aria-label={t(k('details'), { name: project.name })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                close();
              }
            }}
          >
            <button type="button" className="modpacks-back" onClick={close}>
              <ModsIcon name="back" />
              {t(k('back'))}
            </button>
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
            </header>
            <p className="mods-details-summary">{project.summary}</p>
            <PackVersions
              key={`${modpackIdentity(project)}:${props.detailRevision}`}
              serverId={props.serverId}
              project={project}
              disabled={props.disabled}
              canBackup={props.canBackup}
              canDeleteWorlds={props.canDeleteWorlds}
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
  canBackup: boolean;
  canDeleteWorlds: boolean;
  operation?: MinecraftModpackOperation;
  onChoose: (
    project: ModpackCatalogProject,
    version: ModpackCatalogVersion,
    options: { keepWorlds: boolean; backupBefore: boolean },
  ) => void;
}) {
  const t = useT();
  const format = useFormat();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ModpackCatalogVersion>();
  const [keepWorlds, setKeepWorlds] = useState(!props.canDeleteWorlds);
  const [backupBefore, setBackupBefore] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  const versions = useInfiniteQuery({
    queryKey: [...q(props.serverId, 'versions'), props.project.provider, props.project.id],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      controller.versions(
        props.serverId,
        props.project.provider,
        props.project.id,
        pageParam,
        signal,
      ),
    getNextPageParam: (last) =>
      last.offset + last.limit < last.total ? last.offset + last.limit : undefined,
    staleTime: 300_000,
  });
  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);
  const items = versions.data?.pages.flatMap((page) => page.items) ?? [];
  const chosen = selected ?? recommendedPackVersion(versions.data?.pages[0]?.items ?? []);
  const same =
    props.operation?.selection.provider === props.project.provider &&
    props.operation.selection.projectId === props.project.id &&
    props.operation.selection.versionId === chosen?.id;
  return (
    <div className="modpacks-version-picker">
      {versions.error && (
        <ErrorNotice error={versions.error} retry={() => void versions.refetch()} />
      )}
      {versions.isPending ? (
        <ModsSkeleton label={t(k('loading'))} rows={1} />
      ) : (
        <>
          <div className="modpacks-install-row">
            <div className="mods-version-picker">
              <button
                ref={trigger}
                type="button"
                className="mods-version-trigger"
                aria-expanded={open}
                aria-controls={id}
                aria-label={t(k('version'))}
                onClick={() => setOpen(!open)}
              >
                <ModsIcon name="version" />
                <span>{chosen?.version ?? t(k('noVersions'))}</span>
                <ModsIcon name="chevron" />
              </button>
              {open && (
                <fieldset
                  ref={panel}
                  id={id}
                  className="mods-version-panel"
                  tabIndex={-1}
                  aria-label={t(k('version'))}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      setOpen(false);
                      trigger.current?.focus();
                    }
                  }}
                >
                  <div className="mods-version-list">
                    {items.map((version) => (
                      <button
                        key={version.id}
                        type="button"
                        className="mods-version-option"
                        aria-pressed={chosen?.id === version.id}
                        disabled={!version.available}
                        onClick={() => {
                          setSelected(version);
                          setOpen(false);
                          trigger.current?.focus({ preventScroll: true });
                        }}
                      >
                        <span>
                          <strong>{version.version}</strong>
                          {version.channel !== 'unknown' && (
                            <ModsChannel channel={version.channel} />
                          )}
                        </span>
                        <small>
                          {[
                            version.minecraftVersions.join(', '),
                            version.loaders.join(', '),
                            version.publishedAt ? format.date(version.publishedAt) : undefined,
                            version.bytes === undefined ? undefined : format.bytes(version.bytes),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                        {!version.available && (
                          <small>
                            {t(k(`unavailable.${version.unavailableReason ?? 'unresolved'}`))}
                          </small>
                        )}
                      </button>
                    ))}
                    {versions.hasNextPage && (
                      <button
                        className="modpacks-quiet"
                        type="button"
                        disabled={versions.isFetchingNextPage}
                        onClick={() => void versions.fetchNextPage()}
                      >
                        {t(versions.isFetchingNextPage ? 'web.loading' : 'web.loadMore')}
                      </button>
                    )}
                  </div>
                </fieldset>
              )}
            </div>
            <button
              type="button"
              className="mods-primary"
              disabled={
                props.disabled || !chosen?.available || same || (backupBefore && !props.canBackup)
              }
              onClick={() =>
                chosen &&
                props.onChoose(props.project, chosen, {
                  keepWorlds: keepWorlds || !props.canDeleteWorlds,
                  backupBefore,
                })
              }
            >
              <ModsIcon name="download" />
              {t(k('install'))}
            </button>
          </div>
          {chosen && (
            <div className="modpacks-version-facts">
              <span>{chosen.minecraftVersions.join(', ')}</span>
              <span>{chosen.loaders.join(', ')}</span>
              {chosen.bytes !== undefined && <span>{format.bytes(chosen.bytes)}</span>}
              {!selected && chosen.channel === 'release' && <span>{t(k('latestStable'))}</span>}
            </div>
          )}
          <div className="modpacks-install-options">
            <ModsCheckbox
              label={t(k('preserveWorlds'))}
              checked={keepWorlds || !props.canDeleteWorlds}
              disabled={props.disabled || !props.canDeleteWorlds}
              onChange={setKeepWorlds}
            />
            <ModsCheckbox
              label={t(k('backup'))}
              checked={backupBefore}
              disabled={props.disabled || !props.canBackup}
              onChange={setBackupBefore}
            />
          </div>
          {!props.canDeleteWorlds ? (
            <p className="modpacks-muted">{t(k('worldsPermission'))}</p>
          ) : (
            !keepWorlds && <p className="modpacks-muted">{t(k('worldsReset'))}</p>
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
    <Pagination
      label={t('web.pagination')}
      previousLabel={t(k('previous'))}
      nextLabel={t(k('next'))}
      summary={t(k('page'), {
        page: Math.floor(offset / limit) + 1,
        pages: Math.max(1, Math.ceil(total / limit)),
      })}
      canPrevious={Math.floor(offset / limit) > 0}
      canNext={Math.floor(offset / limit) + 1 < Math.ceil(total / limit)}
      onPrevious={() => onChange(Math.max(0, offset - limit))}
      onNext={() => onChange(offset + limit)}
    />
  );
}
