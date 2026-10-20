import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type {
  MinecraftModMetadata,
  MinecraftModQueueItem,
  MinecraftModRoot,
  MinecraftModsSnapshot,
  ModCatalogProject,
  ModCatalogVersion,
  ModProvider,
} from '../../../../../games/minecraft/src/ui/mods-controller.js';
import { idempotencyKey, queryClient } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { ErrorNotice } from '../../components/ui.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { ViewerSelect } from '../../features/viewer-engine/viewer-select.js';
import { contentPreparationErrorKey } from './content-preparation-error.js';
import { matchesMod, modRootState, versionForMod } from './mods-model.js';
import {
  ModsAction,
  ModsArtwork,
  ModsChannel,
  ModsCheckbox,
  ModsEmpty,
  ModsIcon,
  ModsPagination,
  ModsSkeleton,
  ModsTags,
  modsKey,
  modTagLabel,
  projectIdentity,
} from './mods-primitives.js';
import { modsController, modsQueryKey, useModsSelection } from './mods-selection.js';
import { ModsVersions } from './mods-versions.js';
import './mods.css';

const ModsDescription = lazy(() =>
  import('./mods-description.js').then((module) => ({ default: module.ModsDescription })),
);
type Selection = ReturnType<typeof useModsSelection>;
type Snapshot = MinecraftModsSnapshot;
const rootIdentity = (root: Pick<MinecraftModRoot, 'provider' | 'projectId'>) =>
  `${root.provider}:${root.projectId}`;
const sameProject = (
  root: Pick<MinecraftModRoot, 'provider' | 'projectId'>,
  project: Pick<ModCatalogProject, 'provider' | 'id'>,
) => root.provider === project.provider && root.projectId === project.id;
function projectFromMetadata(metadata: MinecraftModMetadata): ModCatalogProject {
  return {
    id: metadata.projectId,
    provider: metadata.provider,
    name: metadata.name,
    summary: '',
    websiteUrl: '',
    imageUrl: metadata.iconUrl,
    authors: [],
    downloads: 0,
    tags: metadata.tags.map((tag) => ({ ...tag, source: metadata.provider, original: tag.label })),
    environment: { kind: metadata.side, source: metadata.provider, original: [] },
  };
}

export function MinecraftModsSection(props: GameSectionViewProps) {
  const t = useT();
  const initial = props.data.metadata?.mods as Snapshot | undefined;
  const inventory = useQuery({
    queryKey: modsQueryKey(props.serverId),
    queryFn: ({ signal }) => modsController.snapshot(props.serverId, signal),
    initialData: initial,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.preparing ||
      query.state.data?.changes.some((change) => ['queued', 'preparing'].includes(change.state))
        ? 1000
        : false,
  });
  const data = inventory.data;
  const selection = useModsSelection(props.serverId, data);
  const [view, setView] = useState<'installed' | 'discover' | 'review'>(
    initial?.packs.length ? 'installed' : 'discover',
  );
  const [project, setProject] = useState<ModCatalogProject>();
  const known = useRef(new Map<string, ModCatalogProject>());
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [applied, setApplied] = useState(false);
  const foregroundLock = useRef(false);
  const applyIntent = useRef<{ revision: number; idempotencyKey: string } | undefined>(undefined);
  const actionIntents = useRef(new Map<string, string>());
  const disabled =
    !props.canManage || props.pending || !data?.supported || !data.installed || Boolean(busy);
  const nonInstallChanges = data?.changes.filter((change) => change.action !== 'install') ?? [];
  const count = selection.roots.length + nonInstallChanges.length;
  const uncertain = data?.changes.some((change) => change.state === 'uncertain');
  const ready =
    Boolean(data?.changes.length) &&
    data?.changes.every((change) => change.state === 'ready') &&
    !data.preparing &&
    !data.blockers.length &&
    !data.error &&
    !selection.saving &&
    !selection.error;
  const rootNames = new Map(
    selection.roots.map((root) => [
      rootIdentity(root),
      known.current.get(rootIdentity(root))?.name ??
        data?.changes.find((item) => matchesMod(item, root))?.name ??
        root.projectId,
    ]),
  );
  useEffect(() => {
    if (!applied) return;
    const timer = setTimeout(() => setApplied(false), 3000);
    return () => clearTimeout(timer);
  }, [applied]);
  useEffect(() => {
    if (data && !selection.saving && !selection.error) {
      for (const pack of [...data.packs, ...data.changes]) {
        if (pack.metadata) {
          const value = projectFromMetadata(pack.metadata);
          if (!known.current.has(projectIdentity(value)))
            known.current.set(projectIdentity(value), value);
        }
      }
    }
  }, [data, selection.saving, selection.error]);
  function openProject(value: ModCatalogProject) {
    known.current.set(projectIdentity(value), value);
    setProject(value);
  }
  function choose(value: ModCatalogProject, checked: boolean) {
    if (disabled) return;
    known.current.set(projectIdentity(value), value);
    setApplied(false);
    selection.change((roots) =>
      checked
        ? roots.some((root) => sameProject(root, value))
          ? roots
          : [
              ...roots,
              {
                provider: value.provider,
                projectId: value.id,
                forceIncompatible: false,
                optionalProjectIds: [],
              },
            ]
        : roots.filter((root) => !sameProject(root, value)),
    );
  }
  function version(value: ModCatalogProject, file: ModCatalogVersion, force: boolean) {
    if (disabled) return;
    known.current.set(projectIdentity(value), value);
    selection.change((roots) => {
      const prior = roots.find((root) => sameProject(root, value));
      const next: MinecraftModRoot = {
        provider: value.provider,
        projectId: value.id,
        versionId: file.id,
        forceIncompatible: force,
        optionalProjectIds: prior?.optionalProjectIds ?? [],
      };
      return prior
        ? roots.map((root) => (sameProject(root, value) ? next : root))
        : [...roots, next];
    });
  }
  async function operation(identity: string, action: (key: string) => Promise<unknown>) {
    if (disabled || foregroundLock.current) return;
    foregroundLock.current = true;
    setBusy(identity);
    setError(undefined);
    setApplied(false);
    const intent = actionIntents.current.get(identity) ?? idempotencyKey();
    actionIntents.current.set(identity, intent);
    try {
      await action(intent);
      actionIntents.current.delete(identity);
      await inventory.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
      foregroundLock.current = false;
    }
  }
  async function apply() {
    if (disabled || !ready || !data || foregroundLock.current) return;
    foregroundLock.current = true;
    setBusy('apply');
    setError(undefined);
    setApplied(false);
    const intent =
      applyIntent.current?.revision === data.revision
        ? applyIntent.current
        : { revision: data.revision, idempotencyKey: idempotencyKey() };
    applyIntent.current = intent;
    try {
      await modsController.apply(props.serverId, intent);
      const result = await inventory.refetch();
      await queryClient.invalidateQueries({ queryKey: ['minecraft-mods-restart', props.serverId] });
      if (result.data && !result.error && !result.data.changes.length && !result.data.error) {
        applyIntent.current = undefined;
        setApplied(true);
        setView('installed');
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
      foregroundLock.current = false;
    }
  }
  const selected = (value: ModCatalogProject) =>
    selection.roots.some((root) => sameProject(root, value));
  const selectedFile = (value: ModCatalogProject) => {
    const root = selection.roots.find((root) => sameProject(root, value)) ?? {
      provider: value.provider,
      projectId: value.id,
    };
    const item =
      data?.changes.find((item) => matchesMod(item, root)) ??
      data?.packs.find((item) => matchesMod(item, root));
    return item ? versionForMod(item, root) : undefined;
  };
  const common = {
    serverId: props.serverId,
    selection,
    data,
    disabled,
    known: known.current,
    onVersion: version,
    onProject: openProject,
    selectedFile,
  };
  return (
    <section className="minecraft-mods" aria-label={t('games.minecraft.sections.mods')}>
      <header className="mods-header">
        {view === 'review' ? (
          <div className="mods-review-heading">
            <ModsAction
              icon="back"
              label={t(modsKey('back'))}
              onClick={() => setView('discover')}
            />
            <h2>
              {t(modsKey('review'))}
              <span>{count}</span>
            </h2>
          </div>
        ) : (
          <fieldset className="mods-tabs" aria-label={t('games.minecraft.sections.mods')}>
            <button
              type="button"
              aria-pressed={view === 'installed'}
              onClick={() => setView('installed')}
            >
              {t(modsKey('installed'))}
              {Boolean(data?.packs.length) && <span>{data?.packs.length}</span>}
            </button>
            <button
              type="button"
              aria-pressed={view === 'discover'}
              onClick={() => setView('discover')}
            >
              {t(modsKey('discover'))}
            </button>
          </fieldset>
        )}
        <div className="mods-header-actions">
          {applied && (
            <span className="mods-applied" role="status">
              <ModsIcon name="check" />
              {t(modsKey('applied'))}
            </span>
          )}
          {view !== 'review' && (
            <>
              <ModsAction
                icon="refresh"
                label={t(modsKey('refresh'))}
                disabled={inventory.isFetching || Boolean(busy)}
                onClick={() => void inventory.refetch()}
              />
              {count > 0 && (
                <button type="button" className="mods-primary" onClick={() => setView('review')}>
                  <ModsIcon name="queue" />
                  {t(modsKey('install'), { count })}
                </button>
              )}
            </>
          )}
          {view === 'review' && (
            <button
              type="button"
              className="mods-primary"
              disabled={disabled || !ready}
              onClick={() => void apply()}
            >
              <ModsIcon name={busy === 'apply' ? 'refresh' : 'check'} />
              {t(modsKey(busy === 'apply' ? 'applying' : 'apply'))}
            </button>
          )}
        </div>
      </header>
      {Boolean(error || inventory.error) && (
        <ErrorNotice
          error={error ?? inventory.error}
          retry={() => {
            setError(undefined);
            void inventory.refetch();
          }}
        />
      )}
      {Boolean(selection.error) && (
        <div className="mods-selection-error">
          <ErrorNotice error={selection.error} retry={selection.retry} />
          <p>{t(modsKey('selectionFailed'))}</p>
        </div>
      )}
      {!props.canManage && <p className="mods-readonly">{t(modsKey('readonly'))}</p>}
      {inventory.isPending ? (
        <ModsSkeleton />
      ) : !data?.supported ? (
        <ModsEmpty>{t(modsKey('unsupported'))}</ModsEmpty>
      ) : !data.installed ? (
        <ModsEmpty>{t(modsKey('notInstalled'))}</ModsEmpty>
      ) : (
        <>
          <div hidden={view !== 'installed'}>
            <InstalledMods
              {...common}
              onDiscover={() => setView('discover')}
              onProject={(value) => {
                openProject(value);
                setView('discover');
              }}
              onAction={(pack, action) =>
                void operation(`${action}:${pack.path}`, (key) =>
                  modsController.change(props.serverId, {
                    path: pack.path,
                    action,
                    idempotencyKey: key,
                  }),
                )
              }
              onDiscard={(changeId) =>
                void operation(`discard:${changeId}`, () =>
                  modsController.discard(props.serverId, changeId),
                )
              }
            />
          </div>
          <div hidden={view !== 'discover'}>
            <DiscoverMods
              {...common}
              visible={view === 'discover'}
              project={project}
              onCloseProject={() => setProject(undefined)}
              selected={selected}
              onSelect={choose}
            />
          </div>
          {view === 'review' && (
            <ReviewMods
              {...common}
              rootNames={rootNames}
              onBack={() => setView('discover')}
              onDiscard={(changeId) =>
                void operation(`discard:${changeId}`, () =>
                  modsController.discard(props.serverId, changeId),
                )
              }
              onRecover={() =>
                void operation('recover', () => modsController.recover(props.serverId))
              }
              uncertain={Boolean(uncertain)}
            />
          )}
        </>
      )}
    </section>
  );
}

type SharedProps = {
  serverId: string;
  selection: Selection;
  data: Snapshot | undefined;
  disabled: boolean;
  known: Map<string, ModCatalogProject>;
  onVersion(project: ModCatalogProject, version: ModCatalogVersion, force: boolean): void;
  onProject(project: ModCatalogProject): void;
  selectedFile(project: ModCatalogProject): { id: string; name: string } | undefined;
};
function DiscoverMods(
  props: SharedProps & {
    visible: boolean;
    project?: ModCatalogProject;
    onCloseProject(): void;
    selected(project: ModCatalogProject): boolean;
    onSelect(project: ModCatalogProject, checked: boolean): void;
  },
) {
  const t = useT(),
    format = useFormat();
  const [provider, setProvider] = useState<ModProvider>('modrinth');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [includeIncompatible, setIncludeIncompatible] = useState(false);
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const detailOpener = useRef<HTMLButtonElement | null>(null);
  const activeProject = props.project ? projectIdentity(props.project) : undefined;
  useEffect(() => {
    if (props.visible && activeProject) detailsHeading.current?.focus({ preventScroll: true });
  }, [props.visible, activeProject]);
  function closeDetails() {
    props.onCloseProject();
    requestAnimationFrame(() => {
      const target = detailOpener.current;
      if (target?.isConnected && target.offsetParent !== null)
        target.focus({ preventScroll: true });
      else searchInput.current?.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const config = useQuery({
    queryKey: ['minecraft-mods-catalog', props.serverId],
    queryFn: ({ signal }) => modsController.catalog(props.serverId, signal),
    staleTime: 60_000,
    enabled: props.visible,
  });
  const available =
    config.data?.providers.some((item) => item.id === provider && item.available) === true;
  const projects = useQuery({
    queryKey: [
      'minecraft-mods-search',
      props.serverId,
      provider,
      query,
      offset,
      includeIncompatible,
    ],
    queryFn: ({ signal }) =>
      modsController.search(
        props.serverId,
        { provider, query, offset, includeIncompatible },
        signal,
      ),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    enabled: available && props.visible,
  });
  const details = useQuery({
    queryKey: ['minecraft-mod-details', props.serverId, props.project?.provider, props.project?.id],
    queryFn: ({ signal }) =>
      modsController.details(
        props.serverId,
        props.project?.provider ?? provider,
        props.project?.id ?? '',
        signal,
      ),
    staleTime: 5 * 60_000,
    enabled: Boolean(props.project) && props.visible,
  });
  const project = details.data ?? props.project;
  return (
    <div className="mods-discover">
      <div className="mods-search-toolbar">
        <label className="mods-search">
          <ModsIcon name="search" />
          <input
            ref={searchInput}
            type="search"
            aria-label={t(modsKey('search'))}
            placeholder={t(modsKey('search'))}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <ViewerSelect
          label={t(modsKey('provider'))}
          value={provider}
          className="mods-select"
          options={[
            { value: 'modrinth', label: 'Modrinth' },
            { value: 'curseforge', label: 'CurseForge' },
          ]}
          onChange={(value) => {
            setProvider(value as ModProvider);
            setOffset(0);
          }}
        />
        <Tooltip content={t(modsKey('betaHint'))}>
          <button
            type="button"
            className="mods-beta-toggle"
            aria-label={t(modsKey('betaPreference'))}
            aria-pressed={props.selection.preferBeta}
            disabled={props.disabled}
            onClick={() => props.selection.setPreferBeta(!props.selection.preferBeta)}
          >
            <span>β</span>
            {t(modsKey('betaPreference'))}
          </button>
        </Tooltip>
      </div>
      <div className="mods-catalog-options">
        <ModsCheckbox
          checked={includeIncompatible}
          onChange={(value) => {
            setIncludeIncompatible(value);
            setOffset(0);
          }}
          label={t(modsKey('showAllProjects'))}
        />
        {props.data && (
          <span>
            {props.data.version} · {props.data.loader}
          </span>
        )}
      </div>
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
            <ModsSkeleton />
          ) : !available ? (
            <ModsEmpty>{t(modsKey('unavailable'))}</ModsEmpty>
          ) : projects.data?.items.length === 0 ? (
            <ModsEmpty>{t(modsKey('noResults'))}</ModsEmpty>
          ) : (
            <ul className="mods-project-list">
              {projects.data?.items.map((item) => {
                const selected = props.selected(item);
                const root = props.selection.roots.find((root) => sameProject(root, item)) ?? {
                  provider: item.provider,
                  projectId: item.id,
                };
                const state = modRootState(props.data, root, props.selection.saving);
                return (
                  <li
                    key={projectIdentity(item)}
                    className="mods-project"
                    data-selected={selected || undefined}
                    data-current={
                      (project && projectIdentity(project) === projectIdentity(item)) || undefined
                    }
                  >
                    <ModsCheckbox
                      label={t(modsKey('select'), { name: item.name })}
                      checked={selected}
                      onChange={(value) => props.onSelect(item, value)}
                      disabled={props.disabled}
                      compact
                    />
                    <button
                      type="button"
                      className="mods-project-open"
                      aria-label={t(modsKey('details'), { name: item.name })}
                      onClick={(event) => {
                        detailOpener.current = event.currentTarget;
                        props.onProject(item);
                      }}
                    >
                      <ModsArtwork image={item.imageUrl} name={item.name} />
                      <span className="mods-project-copy">
                        <span className="mods-project-title">
                          <strong>{item.name}</strong>
                          {selected && (
                            <span className="mods-inline-state" data-state={state}>
                              {t(modsKey(state))}
                            </span>
                          )}
                        </span>
                        <span className="mods-project-summary">{item.summary}</span>
                        <ModsTags side={item.environment.kind} tags={item.tags} compact />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {(projects.data?.total ?? 0) > 20 && (
            <ModsPagination
              offset={offset}
              total={projects.data?.total ?? 0}
              onChange={setOffset}
            />
          )}
        </div>
        {project && (
          <aside
            className="mods-details"
            aria-label={t(modsKey('details'), { name: project.name })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeDetails();
              }
            }}
          >
            <header className="mods-details-header">
              <ModsArtwork image={project.imageUrl} name={project.name} />
              <div>
                <h3 ref={detailsHeading} tabIndex={-1}>
                  {project.name}
                </h3>
                {project.authors.length > 0 && (
                  <small>{t(modsKey('authors'), { authors: project.authors.join(', ') })}</small>
                )}
              </div>
              <ModsAction icon="close" label={t(modsKey('closeDetails'))} onClick={closeDetails} />
            </header>
            <p className="mods-details-summary">{project.summary}</p>
            <ModsTags side={project.environment.kind} tags={project.tags} />
            <div className="mods-details-actions">
              <ModsCheckbox
                label={t(modsKey('select'), { name: project.name })}
                checked={props.selected(project)}
                onChange={(value) => props.onSelect(project, value)}
                disabled={props.disabled}
              />
              {project.websiteUrl.startsWith('https://') && (
                <Tooltip content={t(modsKey('openProject'))}>
                  <a
                    className="mods-icon-action"
                    aria-label={t(modsKey('openProject'))}
                    href={project.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ModsIcon name="external" />
                  </a>
                </Tooltip>
              )}
            </div>
            <ModsVersions
              key={projectIdentity(project)}
              serverId={props.serverId}
              provider={project.provider}
              projectId={project.id}
              selected={props.selectedFile(project)}
              preferBeta={props.selection.preferBeta}
              disabled={props.disabled}
              onSelect={(file, force) => props.onVersion(project, file, force)}
            />
            {details.error && (
              <ErrorNotice error={details.error} retry={() => void details.refetch()} />
            )}
            {details.isPending ? (
              <ModsSkeleton rows={3} />
            ) : (
              details.data && (
                <Suspense fallback={<ModsSkeleton rows={3} />}>
                  <ModsDescription
                    key={projectIdentity(project)}
                    text={details.data.description}
                    format={details.data.descriptionFormat}
                  />
                </Suspense>
              )
            )}
            {project.downloads > 0 && (
              <p className="mods-project-downloads">
                {t(modsKey('downloads'), { count: format.number(project.downloads, 0) })}
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function InstalledMods(
  props: SharedProps & {
    onDiscover(): void;
    onAction(pack: Snapshot['packs'][number], action: 'enable' | 'disable' | 'delete'): void;
    onDiscard(changeId: string): void;
  },
) {
  const t = useT(),
    format = useFormat();
  const [search, setSearch] = useState('');
  const [side, setSide] = useState('all');
  const [category, setCategory] = useState('');
  const [offset, setOffset] = useState(0);
  const packs = props.data?.packs ?? [];
  const categories = new Map(
    packs.flatMap(
      (pack) => pack.metadata?.tags.map((tag) => [tag.id, modTagLabel(tag, t)] as const) ?? [],
    ),
  );
  const filtered = packs.filter(
    (pack) =>
      (pack.metadata?.name ?? pack.name)
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase().trim()) &&
      (side === 'all' || (pack.metadata?.side ?? 'unknown') === side) &&
      (!category || pack.metadata?.tags.some((tag) => tag.id === category)),
  );
  const currentOffset = Math.min(offset, Math.max(0, Math.ceil(filtered.length / 20) - 1) * 20);
  return (
    <div className="mods-installed">
      <div className="mods-search-toolbar">
        <label className="mods-search">
          <ModsIcon name="search" />
          <input
            type="search"
            aria-label={t(modsKey('searchInstalled'))}
            placeholder={t(modsKey('searchInstalled'))}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <ViewerSelect
          label={t(modsKey('environment'))}
          value={side}
          className="mods-select"
          options={['all', 'server', 'client', 'both', 'unknown'].map((value) => ({
            value,
            label: t(modsKey(`side.${value}`)),
          }))}
          onChange={(value) => {
            setSide(value);
            setOffset(0);
          }}
        />
        {categories.size > 0 && (
          <ViewerSelect
            label={t(modsKey('categories'))}
            value={category}
            className="mods-select"
            options={[
              { value: '', label: t(modsKey('allCategories')) },
              ...Array.from(categories, ([value, label]) => ({ value, label })).sort((a, b) =>
                a.label.localeCompare(b.label),
              ),
            ]}
            onChange={(value) => {
              setCategory(value);
              setOffset(0);
            }}
          />
        )}
      </div>
      {packs.length === 0 ? (
        <ModsEmpty
          action={
            <button type="button" className="secondary" onClick={props.onDiscover}>
              {t(modsKey('emptyAction'))}
            </button>
          }
        >
          {t(modsKey('empty'))}
        </ModsEmpty>
      ) : !filtered.length ? (
        <ModsEmpty>{t(modsKey('noResults'))}</ModsEmpty>
      ) : (
        <ul className="mods-installed-list">
          {filtered.slice(currentOffset, currentOffset + 20).map((pack) => {
            const pending = props.data?.changes.find(
              (item) => item.path === pack.path && item.action !== 'install',
            );
            return (
              <li
                key={pack.id}
                className="mods-installed-row"
                data-disabled={pack.state === 'disabled' || undefined}
              >
                <ModsArtwork
                  image={pack.metadata?.iconUrl}
                  name={pack.metadata?.name ?? pack.name}
                />
                <div className="mods-installed-copy">
                  <strong>{pack.metadata?.name ?? pack.name}</strong>
                  <span className="mods-installed-version">
                    {pack.metadata?.version ?? t(modsKey('local'))}
                    {pack.metadata && <ModsChannel channel={pack.metadata.channel} />}
                    <span>· {format.bytes(pack.size)}</span>
                    {pack.state === 'disabled' && <span>{t(modsKey('disabled'))}</span>}
                  </span>
                  <ModsTags side={pack.metadata?.side ?? 'unknown'} tags={pack.metadata?.tags} />
                </div>
                <div className="mods-installed-actions">
                  {pending ? (
                    <>
                      <span className="mods-pending-action">
                        {t(modsKey(`action.${pending.action}`))}
                      </span>
                      <ModsAction
                        icon="close"
                        label={t(modsKey('removeQueue'), { name: pack.name })}
                        disabled={props.disabled}
                        onClick={() => props.onDiscard(pending.id)}
                      />
                    </>
                  ) : (
                    <>
                      {pack.metadata && (
                        <ModsAction
                          icon="version"
                          label={t(modsKey('update'), { name: pack.metadata.name })}
                          disabled={props.disabled}
                          onClick={() =>
                            pack.metadata && props.onProject(projectFromMetadata(pack.metadata))
                          }
                        />
                      )}
                      <ModsAction
                        icon={pack.state === 'enabled' ? 'disable' : 'enable'}
                        label={t(modsKey(pack.state === 'enabled' ? 'disable' : 'enable'), {
                          name: pack.metadata?.name ?? pack.name,
                        })}
                        disabled={props.disabled}
                        onClick={() =>
                          props.onAction(pack, pack.state === 'enabled' ? 'disable' : 'enable')
                        }
                      />
                      <ModsAction
                        icon="delete"
                        label={t(modsKey('delete'), { name: pack.metadata?.name ?? pack.name })}
                        disabled={props.disabled}
                        destructive
                        onClick={() => props.onAction(pack, 'delete')}
                      />
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {filtered.length > 20 && (
        <ModsPagination offset={currentOffset} total={filtered.length} onChange={setOffset} />
      )}
    </div>
  );
}

function ReviewMods(
  props: SharedProps & {
    rootNames: Map<string, string>;
    uncertain: boolean;
    onRecover(): void;
    onDiscard(changeId: string): void;
    onBack(): void;
  },
) {
  const t = useT();
  const [forcing, setForcing] = useState<string>();
  const changes = props.data?.changes ?? [];
  const dependencies = changes.filter((item) => item.action === 'install' && item.dependency);
  const otherChanges = changes.filter((item) => item.action !== 'install');
  const optionalItems = new Map<string, NonNullable<Snapshot['optional']>[number]>();
  for (const item of props.data?.optional ?? []) {
    const key = `${item.provider}:${item.projectId}`;
    const prior = optionalItems.get(key);
    optionalItems.set(key, {
      ...item,
      requiredBy: [...new Set([...(prior?.requiredBy ?? []), ...item.requiredBy])],
    });
  }
  const knownReasons = new Set([
    'conflict',
    'version-conflict',
    'incompatible-version',
    'unavailable',
    'unresolved',
    'datapack_dependency',
  ]);
  function optional(
    projectId: string,
    provider: ModProvider,
    requiredBy: string[],
    checked: boolean,
  ) {
    const matchesRoot = props.selection.roots.some(
      (root) => root.provider === provider && requiredBy.includes(root.projectId),
    );
    props.selection.change((roots) =>
      roots.map((root) =>
        root.provider === provider && (!matchesRoot || requiredBy.includes(root.projectId))
          ? {
              ...root,
              optionalProjectIds: checked
                ? [...new Set([...root.optionalProjectIds, projectId])]
                : root.optionalProjectIds.filter((id) => id !== projectId),
            }
          : root,
      ),
    );
  }
  return (
    <div className="mods-review">
      {!props.selection.roots.length && !otherChanges.length ? (
        <ModsEmpty
          action={
            <button type="button" className="secondary" onClick={props.onBack}>
              {t(modsKey('back'))}
            </button>
          }
        >
          {t(modsKey('noQueue'))}
        </ModsEmpty>
      ) : (
        <ul className="mods-review-list">
          {props.selection.roots.map((root) => {
            const change = changes.find((item) => matchesMod(item, root));
            const state = modRootState(props.data, root, props.selection.saving);
            const info = change ?? props.data?.packs.find((item) => matchesMod(item, root));
            const project =
              props.known.get(rootIdentity(root)) ??
              (info?.metadata
                ? projectFromMetadata({
                    ...info.metadata,
                    provider: root.provider,
                    projectId: root.projectId,
                  })
                : ({
                    id: root.projectId,
                    provider: root.provider,
                    name: root.projectId,
                    summary: '',
                    websiteUrl: '',
                    authors: [],
                    downloads: 0,
                    tags: [],
                    environment: { kind: 'unknown', source: 'unknown', original: [] },
                  } satisfies ModCatalogProject));
            return (
              <li className="mods-review-row" key={rootIdentity(root)}>
                <div className="mods-review-main">
                  <ModsArtwork image={project.imageUrl} name={project.name} />
                  <div className="mods-review-copy">
                    <strong>{project.name}</strong>
                    <span className="mods-review-meta">
                      <span>{root.provider === 'modrinth' ? 'Modrinth' : 'CurseForge'}</span>
                      {change?.metadata && <ModsChannel channel={change.metadata.channel} />}
                      {root.forceIncompatible && (
                        <span className="mods-forced">{t(modsKey('forced'))}</span>
                      )}
                    </span>
                  </div>
                  <span className="mods-inline-state" data-state={state}>
                    {t(modsKey(state))}
                  </span>
                  <ModsAction
                    icon="close"
                    label={t(modsKey('removeQueue'), { name: project.name })}
                    disabled={props.disabled}
                    onClick={() =>
                      props.selection.change((roots) =>
                        roots.filter((item) => rootIdentity(item) !== rootIdentity(root)),
                      )
                    }
                  />
                </div>
                <div className="mods-review-controls">
                  <ModsVersions
                    serverId={props.serverId}
                    provider={root.provider}
                    projectId={root.projectId}
                    selected={props.selectedFile(project)}
                    preferBeta={props.selection.preferBeta}
                    disabled={props.disabled}
                    onSelect={(file, force) => props.onVersion(project, file, force)}
                  />
                  {change?.state === 'failed' && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={props.disabled}
                      onClick={() => props.selection.change((roots) => [...roots])}
                    >
                      {t(modsKey('retry'))}
                    </button>
                  )}
                  {change?.metadata &&
                    change.incompatibilities.length > 0 &&
                    !root.forceIncompatible && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={props.disabled}
                        onClick={() => setForcing(rootIdentity(root))}
                      >
                        {t(modsKey('force'))}
                      </button>
                    )}
                </div>
                {change?.state === 'failed' &&
                  change.error &&
                  (change.error !== 'client_only' ||
                    !change.incompatibilities.includes('client-only')) && (
                    <p className="mods-warning-text">
                      {t(contentPreparationErrorKey(change.error))}
                    </p>
                  )}
                {change?.incompatibilities.length ? (
                  <p className="mods-warning-text">
                    {change.incompatibilities
                      .map((reason) => t(modsKey(`incompatibility.${reason}`)))
                      .join(' · ')}
                  </p>
                ) : null}
                {forcing === rootIdentity(root) && change?.metadata && (
                  <div className="mods-force" role="alert">
                    <div>
                      <ModsIcon name="warning" />
                      <strong>{t(modsKey('forceTitle'))}</strong>
                    </div>
                    <p>{t(modsKey('forceBody'))}</p>
                    <div className="mods-force-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setForcing(undefined)}
                      >
                        {t(modsKey('cancel'))}
                      </button>
                      <button
                        type="button"
                        className="mods-force-confirm"
                        disabled={props.disabled}
                        onClick={() => {
                          props.selection.change((roots) =>
                            roots.map((item) =>
                              rootIdentity(item) === rootIdentity(root)
                                ? {
                                    ...item,
                                    versionId: versionForMod(change, root)?.id,
                                    forceIncompatible: true,
                                  }
                                : item,
                            ),
                          );
                          setForcing(undefined);
                        }}
                      >
                        {t(modsKey('force'))}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
          {otherChanges.map((change) => (
            <QueuedChange
              key={change.id}
              change={change}
              disabled={props.disabled}
              onDiscard={() => props.onDiscard(change.id)}
            />
          ))}
        </ul>
      )}
      {dependencies.length > 0 && (
        <section className="mods-review-group">
          <h3>
            {t(modsKey('dependencies'))}
            <span>{dependencies.length}</span>
          </h3>
          <ul>
            {dependencies.map((change) => (
              <li key={change.id} className="mods-dependency-row">
                <ModsIcon name="mod" />
                <div>
                  <strong>{change.metadata?.name ?? change.name}</strong>
                  <small>
                    {change.metadata?.version}
                    {change.requiredBy.length > 0 &&
                      ` · ${t(modsKey('requiredBy'), { names: change.requiredBy.map((id) => props.rootNames.get(`${change.metadata?.provider}:${id}`) ?? id).join(', ') })}`}
                  </small>
                  {change.state === 'failed' && change.error && (
                    <small className="mods-warning-text">
                      {t(contentPreparationErrorKey(change.error))}
                    </small>
                  )}
                </div>
                {change.metadata && <ModsChannel channel={change.metadata.channel} />}
                <span className="mods-inline-state" data-state={change.state}>
                  {t(modsKey(change.state))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {Boolean(props.data?.optional.length) && (
        <section className="mods-review-group">
          <h3>{t(modsKey('optional'))}</h3>
          <div className="mods-optional">
            {[...optionalItems.values()].map((item) => (
              <ModsCheckbox
                key={`${item.provider}:${item.projectId}`}
                label={item.name}
                checked={props.selection.roots.some(
                  (root) =>
                    root.provider === item.provider &&
                    root.optionalProjectIds.includes(item.projectId),
                )}
                disabled={props.disabled}
                onChange={(checked) =>
                  optional(item.projectId, item.provider, item.requiredBy, checked)
                }
              />
            ))}
          </div>
        </section>
      )}
      {Boolean(props.data?.blockers.length) && (
        <section className="mods-review-group mods-blockers" aria-label={t(modsKey('conflicts'))}>
          <h3>
            <ModsIcon name="warning" />
            {t(modsKey('conflicts'))}
          </h3>
          {props.data?.blockers.map((item) => (
            <div key={`${item.projectId}:${item.reason}`}>
              <strong>{item.name}</strong>
              <p>
                {t(modsKey(`blocker.${knownReasons.has(item.reason) ? item.reason : 'unknown'}`))}
              </p>
            </div>
          ))}
        </section>
      )}
      {props.data?.error && (
        <p className="mods-warning-text" role="alert">
          {t(contentPreparationErrorKey(props.data.error))}{' '}
          <button
            type="button"
            className="text-button"
            disabled={props.disabled}
            onClick={() => props.selection.change((roots) => [...roots])}
          >
            {t(modsKey('retry'))}
          </button>
        </p>
      )}
      {props.uncertain && (
        <div className="mods-recovery">
          <p>{t(modsKey('uncertain'))}</p>
          <button
            type="button"
            className="secondary"
            disabled={props.disabled}
            onClick={props.onRecover}
          >
            {t(modsKey('recover'))}
          </button>
        </div>
      )}
    </div>
  );
}
function QueuedChange({
  change,
  disabled,
  onDiscard,
}: {
  change: MinecraftModQueueItem;
  disabled: boolean;
  onDiscard(): void;
}) {
  const t = useT();
  return (
    <li className="mods-review-row">
      <div className="mods-review-main">
        <ModsArtwork name={change.name} image={change.metadata?.iconUrl} />
        <div className="mods-review-copy">
          <strong>{change.metadata?.name ?? change.name}</strong>
          <small>{t(modsKey(`action.${change.action}`))}</small>
        </div>
        <span className="mods-inline-state" data-state={change.state}>
          {t(modsKey(change.state))}
        </span>
        <ModsAction
          icon="close"
          label={t(modsKey('removeQueue'), { name: change.name })}
          disabled={disabled}
          onClick={onDiscard}
        />
      </div>
      {change.state === 'failed' && change.error && (
        <p className="mods-warning-text">{t(contentPreparationErrorKey(change.error))}</p>
      )}
    </li>
  );
}
