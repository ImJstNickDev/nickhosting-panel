import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  createSatisfactoryModsController,
  type ModChoice,
  type ModInventoryItem,
  type ModPlan,
  type ModProfile,
  type ModProject,
} from '../../../../../games/satisfactory/src/ui/mods-controller.js';
import { ApiError, api, idempotencyKey } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import {
  ModsAction,
  ModsArtwork,
  ModsCheckbox,
  ModsEmpty,
  ModsIcon,
} from '../../components/addon-primitives.js';
import { useUnsavedChanges } from '../../components/navigation-guard.js';
import { ConfirmDialog, Dialog, ErrorNotice, Input, Select } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { useRequestOperation } from '../../features/servers.js';
import '../../components/addon-workspace.css';
import './mods.css';

const AddonDescription = lazy(() =>
  import('../../components/addon-description.js').then((module) => ({
    default: module.AddonDescription,
  })),
);
const controller = createSatisfactoryModsController({ request: api });
const key = (name: string) => `games.satisfactory.mods.${name}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Draft = { selection: ModChoice[]; vanilla: boolean; profileId?: string };
type PreviewInput = Draft & { revision: number; idempotencyKey: string };
type PreviewAttempt = { signature: string; input: PreviewInput };
type View = 'installed' | 'discover' | 'review';

/** One durable preparation at a time; newer edits never inherit an older plan. */
function useIncrementalPreview(
  serverId: string,
  desired: Omit<PreviewInput, 'idempotencyKey'> | undefined,
  enabled: boolean,
  onSettled: () => Promise<void>,
) {
  const signature = desired
    ? JSON.stringify({
        ...desired,
        selection: [...desired.selection].sort((a, b) => a.reference.localeCompare(b.reference)),
      })
    : '';
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const [active, setActive] = useState<PreviewAttempt>();
  const [jobId, setJobId] = useState<string>();
  const [progress, setProgress] = useState<{ signature: string; plan: ModPlan }>();
  const [cache, setCache] = useState<Map<string, ModPlan>>(() => new Map());
  const [failure, setFailure] = useState<{ attempt: PreviewAttempt; cause: unknown }>();
  const [generation, setGeneration] = useState(0);
  const [validatedSignature, setValidatedSignature] = useState('');
  const [validationError, setValidationError] = useState<unknown>();
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation requests an explicit fresh validation.
  useEffect(() => {
    setValidatedSignature('');
    const saved = cacheRef.current.get(signature);
    setValidationError(undefined);
    if (saved?.status !== 'ready') return;
    const abort = new AbortController();
    void controller
      .plan(serverId, saved.id, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setCache((previous) => new Map(previous).set(signature, value));
        setValidatedSignature(signature);
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        if (cause instanceof ApiError && [404, 409].includes(cause.status)) {
          setCache((previous) => {
            const next = new Map(previous);
            next.delete(signature);
            return next;
          });
          setProgress(undefined);
        } else setValidationError(cause);
      });
    return () => abort.abort();
  }, [signature, serverId, generation]);
  // Start directly from the committed draft; an intermediate candidate state
  // would add another render/effect round trip after the checkbox request.
  useEffect(() => {
    if (!enabled || !signature || active || failure) return;
    const saved = cache.get(signature);
    if (saved && (!saved.expiresAt || Date.parse(saved.expiresAt) > Date.now())) return;
    if (saved) {
      setCache((previous) => {
        const next = new Map(previous);
        next.delete(signature);
        return next;
      });
    }
    const input = JSON.parse(signature) as Omit<PreviewInput, 'idempotencyKey'>;
    setActive({
      signature,
      input: { ...input, idempotencyKey: `${idempotencyKey()}_${generation}` },
    });
  }, [signature, enabled, active, failure, cache, generation]);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const accepted = await controller.preview(serverId, active.input);
        if (abort.signal.aborted) return;
        setJobId(accepted.jobId);
        const pollingStarted = performance.now();
        for (;;) {
          const value = await controller.plan(serverId, accepted.planId, abort.signal);
          if (abort.signal.aborted) return;
          setProgress({ signature: active.signature, plan: value });
          if (value.status !== 'pending') {
            setValidatedSignature(active.signature);
            setCache((previous) => {
              const next = new Map(previous);
              next.set(active.signature, value);
              const oldest = next.keys().next().value;
              if (next.size > 4 && oldest) next.delete(oldest);
              return next;
            });
            // Reload outer activity only once; preparation never marks the whole UI busy.
            await settled.current();
            if (!abort.signal.aborted) {
              setActive(undefined);
              setJobId(undefined);
            }
            return;
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              abort.signal.removeEventListener('abort', done);
              resolve();
            };
            abort.signal.addEventListener('abort', done, { once: true });
            // Keep warm previews responsive without sustained 10 Hz polling
            // during a long upstream download. Requests never overlap.
            timer = setTimeout(done, performance.now() - pollingStarted < 10_000 ? 100 : 250);
          });
          if (abort.signal.aborted) return;
        }
      } catch (cause) {
        if (!abort.signal.aborted) {
          // A lost enqueue response may already have started the job. Replay its exact key.
          setFailure({ attempt: active, cause });
          setActive(undefined);
        }
      }
    })();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [active, serverId]);
  const saved = cache.get(signature);
  const result = saved ?? (progress?.signature === signature ? progress.plan : undefined);
  function retry() {
    if (active) return;
    if (validationError) {
      setValidationError(undefined);
      setGeneration((value) => value + 1);
    } else if (failure) {
      setActive(failure.attempt);
      setFailure(undefined);
    } else {
      setCache((previous) => {
        const next = new Map(previous);
        next.delete(signature);
        return next;
      });
      setProgress(undefined);
      setGeneration((value) => value + 1);
    }
  }
  return {
    data: result,
    jobId,
    active: !!active,
    blocked: !!failure,
    error: failure?.cause ?? validationError,
    validated: validatedSignature === signature && !validationError,
    isPending: (!!active || (enabled && (!result || result.status === 'pending'))) && !failure,
    refetch: retry,
    reset: () => {
      setCache(new Map());
      setProgress(undefined);
    },
  };
}

export function SatisfactoryModsSection(props: GameSectionViewProps) {
  return <ModsWorkspace key={props.serverId} {...props} />;
}
function ModsWorkspace(props: GameSectionViewProps) {
  const t = useT();
  const searchHintId = useId();
  const [view, setView] = useState<View>('installed');
  const [draft, setDraft] = useState<Draft>();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [installedSearch, setInstalledSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [offset, setOffset] = useState(0);
  const [project, setProject] = useState<ModProject>();
  const [version, setVersion] = useState('');
  const [versionPolicy, setVersionPolicy] = useState<'exact' | 'minimum'>('exact');
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileEdit, setProfileEdit] = useState<string>();
  const [includeClient, setIncludeClient] = useState(false);
  const [externalOpen, setExternalOpen] = useState(false);
  const [confirm, setConfirm] = useState<
    'rollback' | 'external' | 'reconcile' | 'deleteProfile' | 'stop'
  >();
  const [error, setError] = useState<unknown>();
  const [working, setWorking] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const retry = useRef<(() => Promise<void>) | undefined>(undefined);
  const operationPending = useRef(false);
  const requestPower = useRequestOperation(props.serverId);
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const snapshot = useQuery({
    queryKey: ['satisfactory-mods', props.serverId, props.pending],
    queryFn: ({ signal }) => controller.snapshot(props.serverId, signal),
    staleTime: 0,
  });
  const inventory = useQuery({
    queryKey: ['satisfactory-mods-inventory', props.serverId, props.pending],
    queryFn: ({ signal }) => controller.inventory(props.serverId, signal),
    enabled: !!snapshot.data,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const catalog = useQuery({
    queryKey: ['satisfactory-mods-catalog', props.serverId, search, offset],
    queryFn: ({ signal }) => controller.catalog(props.serverId, search, offset, signal),
    enabled: view === 'discover',
    placeholderData: keepPreviousData,
  });
  const details = useQuery({
    queryKey: ['satisfactory-mod-details', props.serverId, project?.reference],
    queryFn: ({ signal }) => controller.details(props.serverId, project?.reference ?? '', signal),
    enabled: !!project,
  });
  const versions = useQuery({
    queryKey: ['satisfactory-mod-versions', props.serverId, project?.reference],
    queryFn: ({ signal }) => controller.versions(props.serverId, project?.reference ?? '', signal),
    enabled: !!project,
  });
  const updates = useQuery({
    queryKey: ['satisfactory-mods-updates', props.serverId, snapshot.data?.revision],
    queryFn: ({ signal }) => controller.updates(props.serverId, signal),
    enabled: false,
  });
  const data = snapshot.data;
  const current: Draft = draft ?? {
    selection: data?.selection ?? [],
    vanilla: data?.vanilla ?? false,
    profileId: data?.activeProfileId ?? undefined,
  };
  const changed =
    !!draft &&
    (!same(current.selection, data?.selection) ||
      current.vanilla !== data?.vanilla ||
      current.profileId !== (data?.activeProfileId ?? undefined));
  const stopped = ['offline', 'stopped'].includes(props.runtimeState);
  const mayPrepare =
    props.canManage && !working && !uncertain && !!data && !data.externalMode && stopped;
  const plan = useIncrementalPreview(
    props.serverId,
    data && (changed || view === 'review') ? { ...current, revision: data.revision } : undefined,
    mayPrepare && !props.pending,
    async () => {
      await Promise.all([snapshot.refetch(), props.reload()]);
    },
  );
  const ownPreview =
    plan.active || plan.blocked || (!!plan.jobId && data?.activePreviewJobId === plan.jobId);
  const selectionBusy = working || (props.pending && !ownPreview);
  const busy = selectionBusy || plan.active || plan.blocked;
  const canEditSelection = props.canManage && !selectionBusy && !uncertain && !!data;
  const canEditProfile = canEditSelection && !plan.active && !plan.blocked;
  const editable = canEditSelection && !data.externalMode;
  const validSearch = searchInput.trim().length === 0 || searchInput.trim().length >= 3;
  const planStale =
    plan.data?.status === 'ready' &&
    (plan.data.revision !== data?.revision ||
      (!!plan.data.expiresAt && Date.parse(plan.data.expiresAt) <= Date.now()));
  const planReady =
    !plan.active &&
    !plan.blocked &&
    plan.validated &&
    plan.data?.status === 'ready' &&
    plan.data.revision === data?.revision &&
    (!plan.data.expiresAt || Date.parse(plan.data.expiresAt) > Date.now());
  useUnsavedChanges(changed || uncertain, working);
  useEffect(() => {
    if (view === 'review') viewHeading.current?.focus();
  }, [view]);

  async function refresh() {
    await Promise.all([snapshot.refetch(), inventory.refetch()]);
  }
  async function execute(action: () => Promise<void>, repeatable = false) {
    if (operationPending.current) return;
    operationPending.current = true;
    setWorking(true);
    setError(undefined);
    retry.current = repeatable ? () => execute(action, true) : undefined;
    try {
      await action();
      retry.current = undefined;
      setUncertain(false);
    } catch (cause) {
      setError(cause);
      setUncertain(
        repeatable && (!(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500),
      );
    } finally {
      setWorking(false);
      operationPending.current = false;
    }
  }
  function edit(next: Draft) {
    setDraft(next);
  }
  function choose(item: ModProject) {
    setProject(item);
    const constraint =
      current.selection.find((mod) => mod.reference === item.reference)?.version ?? '';
    const selected = /^(>=)?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/.exec(constraint);
    setVersion(selected?.[2] ?? '');
    setVersionPolicy(selected?.[1] ? 'minimum' : 'exact');
  }
  function replace(choice: ModChoice) {
    edit({
      ...current,
      selection: [
        ...current.selection.filter((item) => item.reference !== choice.reference),
        choice,
      ],
    });
  }
  function preview() {
    setView('review');
  }
  function apply() {
    if (!data || !plan.data || !planReady || !editable) return;
    if (plan.data?.expiresAt && Date.parse(plan.data.expiresAt) <= Date.now()) {
      setError(new ApiError('conflict', 'errors.conflict'));
      plan.refetch();
      return;
    }
    const input = {
      planId: plan.data.id,
      revision: data.revision,
      idempotencyKey: idempotencyKey(),
    };
    void execute(async () => {
      let result: { jobId: string };
      try {
        result = await controller.apply(props.serverId, input);
      } catch (cause) {
        if (cause instanceof ApiError && [404, 409].includes(cause.status)) {
          retry.current = undefined;
          plan.refetch();
          await snapshot.refetch();
        }
        throw cause;
      }
      setDraft(undefined);
      plan.reset();
      setView('installed');
      props.onAccepted(result.jobId);
      await refresh();
    }, true);
  }
  function stageUpdates(reference?: string) {
    const offered = updates.data?.items ?? [];
    edit({
      ...current,
      selection: current.selection.map((item) => {
        const update = offered.find(
          (value) =>
            value.reference === item.reference && (!reference || reference === item.reference),
        );
        return update ? { ...item, version: update.version } : item;
      }),
    });
  }
  async function exportProfile(profile: ModProfile) {
    const document = await controller.exportProfile(props.serverId, profile.id);
    const href = URL.createObjectURL(
      new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }),
    );
    const link = window.document.createElement('a');
    link.href = href;
    link.download = `${profile.name.replace(/[^\p{L}\p{N}_-]/gu, '_')}.smmprofile`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  async function confirmAction() {
    if (!data) return;
    const action = confirm;
    const revision = data.revision;
    const idem = idempotencyKey();
    await execute(
      async () => {
        if (action === 'stop') {
          const result = await requestPower({ action: 'stop' });
          props.onAccepted(result.jobId);
        } else if (action === 'rollback') {
          const result = await controller.rollback(props.serverId, revision, idem);
          props.onAccepted(result.jobId);
          setDraft(undefined);
        } else if (action === 'external') {
          const result = await controller.beginExternal(props.serverId, revision, idem);
          if (result.jobId) props.onAccepted(result.jobId);
          setExternalOpen(true);
          setDraft(undefined);
        } else if (action === 'reconcile' && inventory.data) {
          await controller.reconcile(props.serverId, {
            fingerprint: inventory.data.fingerprint,
            selection: current.selection,
            revision,
            profileId: current.profileId,
          });
          setDraft(undefined);
        } else if (action === 'deleteProfile' && profileEdit) {
          await controller.deleteProfile(props.serverId, profileEdit, revision);
          setProfileEdit(undefined);
          setProfileName('');
        }
        setConfirm(undefined);
        await refresh();
      },
      action === 'rollback' || action === 'external' || action === 'stop',
    );
  }
  const installed = new Map<string, ModInventoryItem>(
    (inventory.data?.items ?? []).map((item) => [item.reference, item]),
  );
  for (const item of current.selection)
    if (!installed.has(item.reference))
      installed.set(item.reference, {
        reference: item.reference,
        name: item.reference,
        version: null,
        path: '',
        managed: true,
        dependency: false,
        gameFeature: false,
      });
  const visibleInstalled = [...installed.values()].filter((item) => {
    const choice = current.selection.find((selected) => selected.reference === item.reference);
    return (
      `${item.name} ${item.reference}`.toLowerCase().includes(installedSearch.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'dependencies'
          ? item.dependency
          : filter === 'external'
            ? !item.managed
            : filter === 'disabled'
              ? choice?.enabled === false
              : choice?.enabled !== false && !!item.path))
    );
  });
  const errorNode = (error != null || snapshot.error != null) && (
    <ErrorNotice
      error={error ?? snapshot.error}
      retry={() => {
        if (retry.current) void retry.current();
        else {
          setError(undefined);
          void refresh();
        }
      }}
    />
  );

  return (
    <section className="satisfactory-mods" aria-label={t(key('title'))}>
      <header className="mods-header">
        {view === 'review' ? (
          <div className="mods-review-heading">
            <ModsAction icon="back" label={t(key('back'))} onClick={() => setView('discover')} />
            <h2 ref={viewHeading} tabIndex={-1}>
              {t(key('review'))}
            </h2>
          </div>
        ) : (
          <fieldset className="mods-tabs" aria-label={t(key('title'))}>
            <button
              type="button"
              aria-pressed={view === 'installed'}
              onClick={() => setView('installed')}
            >
              {t(key('installed'))}
              {inventory.data && <span>{inventory.data.items.length}</span>}
            </button>
            <button
              type="button"
              aria-pressed={view === 'discover'}
              onClick={() => setView('discover')}
            >
              {t(key('discover'))}
            </button>
          </fieldset>
        )}
        <div className="mods-header-actions">
          <ModsAction
            icon="refresh"
            label={t(key('refresh'))}
            disabled={busy || inventory.isFetching}
            onClick={() => void refresh()}
          />
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setProfilesOpen(true);
              setProfileName('');
              setProfileEdit(undefined);
            }}
          >
            {t(key('profiles'))}
          </button>
          <ModsAction
            icon="external"
            label={t(key('connectSmm'))}
            onClick={() => setExternalOpen(true)}
          />
          {changed && view !== 'review' && (
            <button
              type="button"
              className="mods-primary"
              disabled={!props.canManage}
              onClick={preview}
            >
              <ModsIcon name="queue" />
              {t(key('review'))}
            </button>
          )}
          {view === 'review' && (
            <button
              type="button"
              className="mods-primary"
              disabled={!editable || !planReady || !stopped || !!inventory.data?.diverged}
              onClick={apply}
            >
              <ModsIcon name="check" />
              {t(key('apply'))}
            </button>
          )}
        </div>
      </header>
      {!profilesOpen && !externalOpen && !confirm && errorNode}
      {plan.error != null && <ErrorNotice error={plan.error} retry={plan.refetch} />}
      {plan.blocked && (
        <p className="satisfactory-notice" role="status">
          {t(key('preparationRetry'))}
        </p>
      )}
      {changed && stopped && !data?.externalMode && view !== 'review' && (
        <p role="status" className="muted">
          {t(
            key(
              planReady
                ? 'prepared'
                : plan.data?.phase === 'inventory'
                  ? 'checkingInventory'
                  : 'backgroundPreparing',
            ),
          )}
        </p>
      )}
      {uncertain && (
        <p className="satisfactory-notice" role="status">
          {t(key('uncertain'))}
        </p>
      )}
      {!props.canManage && <p className="mods-readonly">{t(key('readonly'))}</p>}
      {data?.externalMode && (
        <div className="satisfactory-notice">
          <p>{t(key('externalActive'))}</p>
          <button type="button" className="secondary" onClick={() => setExternalOpen(true)}>
            {t(key('externalManage'))}
          </button>
        </div>
      )}
      {!!inventory.data?.issues?.length && (
        <details className="satisfactory-notice">
          <summary>{t(key('inventoryWarnings'))}</summary>
          <ul>
            {inventory.data.issues.map((issue) => (
              <li key={`${issue.path}-${issue.reason}`}>
                <code>{issue.path}</code>:{' '}
                {t(
                  key(
                    `issue.${['unsafe_path', 'invalid_game_version', 'invalid_lockfile', 'unknown_directory'].includes(issue.reason) ? issue.reason : 'unknown'}`,
                  ),
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {inventory.data?.diverged && (
        <div className="satisfactory-notice">
          <p>{t(key('diverged'))}</p>
          <button
            type="button"
            className="secondary"
            disabled={!props.canManage || busy || !stopped}
            onClick={() => (data?.externalMode ? setConfirm('reconcile') : setExternalOpen(true))}
          >
            {t(key('reconcile'))}
          </button>
        </div>
      )}
      {snapshot.isPending ? (
        <p role="status">{t('web.loading')}</p>
      ) : view === 'installed' ? (
        <>
          <div className="mods-search-toolbar">
            <SearchField
              label={t(key('searchInstalled'))}
              value={installedSearch}
              onChange={(event) => setInstalledSearch(event.target.value)}
            />
            <Select
              label={t(key('filter'))}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              {['all', 'enabled', 'disabled', 'dependencies', 'external'].map((name) => (
                <option key={name} value={name}>
                  {t(key(name))}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className="secondary"
              disabled={!data || updates.isFetching}
              onClick={() => void updates.refetch()}
            >
              {t(key(updates.isFetching ? 'checkingUpdates' : 'checkUpdates'))}
            </button>
            {!!updates.data?.items.length && (
              <button
                type="button"
                className="secondary"
                disabled={!editable}
                onClick={() => stageUpdates()}
              >
                {t(key('updateAll'))}
              </button>
            )}
          </div>
          {updates.error && (
            <ErrorNotice error={updates.error} retry={() => void updates.refetch()} />
          )}
          {updates.data && updates.data.items.length === 0 && (
            <p className="muted" role="status">
              {t(key('noUpdates'))}
            </p>
          )}
          {inventory.error ? (
            <ErrorNotice error={inventory.error} retry={() => void inventory.refetch()} />
          ) : inventory.isPending ? (
            <p role="status">{t(key('readingInventory'))}</p>
          ) : visibleInstalled.length === 0 ? (
            <ModsEmpty
              action={
                <button type="button" className="secondary" onClick={() => setView('discover')}>
                  {t(key('discover'))}
                </button>
              }
            >
              {t(key(installed.size ? 'noResults' : 'empty'))}
            </ModsEmpty>
          ) : (
            <ul className="mods-installed-list">
              {visibleInstalled.map((item) => {
                const choice = current.selection.find(
                  (selected) => selected.reference === item.reference,
                );
                const update = updates.data?.items.find(
                  (value) => value.reference === item.reference,
                );
                return (
                  <li
                    key={item.reference}
                    className="mods-installed-row satisfactory-installed-row"
                  >
                    <ModsArtwork name={item.name} />
                    <div className="satisfactory-mod-copy">
                      <button
                        type="button"
                        className="satisfactory-name"
                        onClick={() =>
                          choose({ id: item.reference, reference: item.reference, name: item.name })
                        }
                      >
                        {item.name}
                      </button>
                      <div className="satisfactory-mod-meta">
                        <span>{item.version ?? t(key('notInstalled'))}</span>
                        {choice && choice.version !== item.version && (
                          <span>→ {choice.version}</span>
                        )}
                        {choice?.enabled === false && (
                          <span>
                            {t(
                              key(
                                data?.selection.find(
                                  (selected) => selected.reference === item.reference,
                                )?.enabled !== false
                                  ? 'disableQueued'
                                  : item.path && item.dependency
                                    ? 'dependencyKept'
                                    : 'disabled',
                              ),
                            )}
                          </span>
                        )}
                        {item.dependency && <span>{t(key('dependency'))}</span>}
                        {!item.managed && <span>{t(key('external'))}</span>}
                        {item.gameFeature && <span>{t(key('gameFeature'))}</span>}
                        {!!item.issues?.length && <span>{t(key('metadataUnreadable'))}</span>}
                      </div>
                    </div>
                    <div className="mods-installed-actions">
                      {update && (
                        <ModsAction
                          icon="download"
                          label={t(key('updateTo'), { version: update.version })}
                          disabled={!editable || !choice}
                          onClick={() => stageUpdates(item.reference)}
                        />
                      )}
                      {choice && (
                        <>
                          <ModsAction
                            icon={choice.enabled === false ? 'enable' : 'disable'}
                            label={t(key(choice.enabled === false ? 'enable' : 'disable'), {
                              name: item.name,
                            })}
                            disabled={!editable}
                            onClick={() =>
                              replace({ ...choice, enabled: choice.enabled === false })
                            }
                          />
                          <ModsAction
                            icon="version"
                            label={t(key('changeVersionFor'), { name: item.name })}
                            disabled={!editable}
                            onClick={() =>
                              choose({
                                id: item.reference,
                                reference: item.reference,
                                name: item.name,
                              })
                            }
                          />
                          <ModsAction
                            icon="delete"
                            label={t(key('remove'), { name: item.name })}
                            disabled={!editable}
                            destructive
                            onClick={() =>
                              edit({
                                ...current,
                                selection: current.selection.filter(
                                  (selected) => selected.reference !== item.reference,
                                ),
                              })
                            }
                          />
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <footer className="satisfactory-mod-footer">
            <ModsCheckbox
              label={t(key('vanilla'))}
              checked={current.vanilla}
              disabled={!editable}
              onChange={(vanilla) => edit({ ...current, vanilla })}
            />
            {data?.rollbackAvailable && (
              <button
                type="button"
                className="secondary"
                disabled={!editable || !stopped || changed}
                onClick={() => setConfirm('rollback')}
              >
                {t(key('rollback'))}
              </button>
            )}
          </footer>
          {current.vanilla && inventory.data?.items.some((item) => !item.managed) && (
            <p className="muted">{t(key('unmanagedRemain'))}</p>
          )}
        </>
      ) : view === 'discover' ? (
        <>
          <form
            className="mods-search-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              if (!validSearch) return;
              setSearch(searchInput.trim());
              setOffset(0);
            }}
          >
            <SearchField
              label={t(key('search'))}
              value={searchInput}
              maxLength={256}
              aria-describedby={searchHintId}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <button type="submit" className="secondary" disabled={!validSearch}>
              {t('web.search')}
            </button>
          </form>
          <small className="muted" id={searchHintId}>
            {t(key('searchHint'))}
          </small>
          {catalog.error ? (
            <ErrorNotice error={catalog.error} retry={() => void catalog.refetch()} />
          ) : catalog.isPending ? (
            <p role="status">{t('web.loading')}</p>
          ) : catalog.data.items.length === 0 ? (
            <ModsEmpty>{t(key('noResults'))}</ModsEmpty>
          ) : (
            <ul className="mods-project-list">
              {catalog.data.items.map((item) => (
                <li
                  className="mods-project"
                  key={item.reference}
                  data-selected={
                    current.selection.some((selected) => selected.reference === item.reference) ||
                    undefined
                  }
                >
                  <ModsCheckbox
                    compact
                    label={t(key('selectMod'), { name: item.name })}
                    checked={current.selection.some(
                      (selected) => selected.reference === item.reference,
                    )}
                    disabled={!editable}
                    onChange={(selected) => {
                      if (selected)
                        void execute(async () => {
                          const choices = await controller.versions(props.serverId, item.reference);
                          const recommended =
                            choices.find(
                              (value) =>
                                value.compatibility === 'compatible' &&
                                !value.version.includes('-'),
                            ) ?? choices.find((value) => value.compatibility !== 'incompatible');
                          if (recommended)
                            replace({
                              reference: item.reference,
                              version: `>=${recommended.version}`,
                              enabled: true,
                            });
                          else choose(item);
                        });
                      else
                        edit({
                          ...current,
                          selection: current.selection.filter(
                            (value) => value.reference !== item.reference,
                          ),
                        });
                    }}
                  />
                  <button type="button" className="mods-project-open" onClick={() => choose(item)}>
                    <ModsArtwork image={item.logo ?? undefined} name={item.name} />
                    <span className="mods-project-copy">
                      <span className="mods-project-title">
                        <strong>{item.name}</strong>
                      </span>
                      <span className="mods-project-summary">{item.description}</span>
                      <span className="satisfactory-mod-meta">
                        {item.authors?.join(', ')}
                        {item.tags?.length ? ` · ${item.tags.join(' · ')}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Pagination
            label={t(key('pages'))}
            previousLabel={t(key('previous'))}
            nextLabel={t(key('next'))}
            summary={
              catalog.data ? t(key('results'), { count: catalog.data.total }) : t('web.loading')
            }
            canPrevious={offset > 0}
            canNext={!!catalog.data && offset + 30 < catalog.data.total}
            disabled={catalog.isFetching}
            onPrevious={() => setOffset(Math.max(0, offset - 30))}
            onNext={() => setOffset(offset + 30)}
          />
        </>
      ) : (
        <>
          {!stopped && (
            <p className="satisfactory-notice">
              {t(key('stopBeforeApply'))}
              {props.canManage &&
                props.permissionKeys.includes('console.power') &&
                props.runtimeState === 'running' && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || uncertain}
                    onClick={() => setConfirm('stop')}
                  >
                    {t(key('stop'))}
                  </button>
                )}
              <Link to={`/servers/${encodeURIComponent(props.serverId)}/console`}>
                {t(key('openConsole'))}
              </Link>
            </p>
          )}
          {working || plan.isPending ? (
            <p role="status">
              {t(
                key(
                  plan.data?.phase === 'inventory'
                    ? 'checkingInventory'
                    : plan.data?.phase === 'queued'
                      ? 'queuedPreparation'
                      : 'resolving',
                ),
              )}
            </p>
          ) : plan.data?.status === 'failed' ? (
            <>
              <ErrorNotice
                error={
                  new ApiError(
                    plan.data.errorCode ?? 'integration_unavailable',
                    `errors.${plan.data.errorCode ?? 'integration_unavailable'}`,
                  )
                }
              />
              <button
                type="button"
                className="secondary"
                disabled={!editable || !stopped}
                onClick={plan.refetch}
              >
                {t(key('resolveAgain'))}
              </button>
            </>
          ) : plan.data?.status === 'ready' ? (
            <>
              <Review plan={plan.data} />
              {planReady && (
                <button
                  type="button"
                  className="secondary"
                  disabled={!editable || !stopped}
                  onClick={plan.refetch}
                >
                  {t(key('resolveAgain'))}
                </button>
              )}
            </>
          ) : (
            <>
              <p>{t(key('reviewHint'))}</p>
              <button type="button" disabled={!editable || !stopped} onClick={plan.refetch}>
                {t(key('resolve'))}
              </button>
            </>
          )}
          {planStale && (
            <p className="satisfactory-notice">
              {t(key('stalePlan'))}
              <button
                type="button"
                className="secondary"
                disabled={!editable || !stopped}
                onClick={plan.refetch}
              >
                {t(key('resolveAgain'))}
              </button>
            </p>
          )}
        </>
      )}
      {changed && (
        <div className="satisfactory-draft-footer">
          <span>{t(key('unapplied'))}</span>
          <button
            type="button"
            className="secondary"
            disabled={selectionBusy || uncertain}
            onClick={() => {
              setDraft(undefined);
            }}
          >
            {t(key('discard'))}
          </button>
        </div>
      )}
      {project && (
        <Dialog
          open
          title={project.name}
          onClose={() => setProject(undefined)}
          initialFocusSelector="select"
          className="satisfactory-mod-dialog"
          closeIcon
        >
          <Suspense fallback={<p>{project.description}</p>}>
            <AddonDescription
              text={
                details.data?.fullDescription ??
                project.fullDescription ??
                project.description ??
                ''
              }
              format="markdown"
              fallback={t(key('noDescription'))}
            />
          </Suspense>
          {!!project.authors?.length && <p className="muted">{project.authors.join(', ')}</p>}
          {details.error && (
            <ErrorNotice error={details.error} retry={() => void details.refetch()} />
          )}
          {versions.error ? (
            <ErrorNotice error={versions.error} retry={() => void versions.refetch()} />
          ) : versions.isPending ? (
            <p role="status">{t('web.loading')}</p>
          ) : (
            <>
              <Select
                label={t(key('version'))}
                value={version}
                disabled={!editable}
                onChange={(event) => setVersion(event.target.value)}
              >
                <option value="">{t(key('chooseVersion'))}</option>
                {versions.data?.map((item) => (
                  <option
                    key={item.version}
                    value={item.version}
                    disabled={item.compatibility === 'incompatible'}
                  >
                    {item.version} · {item.gameVersion}
                    {item.compatibility === 'incompatible' ? ` · ${t(key('incompatible'))}` : ''}
                  </option>
                ))}
              </Select>
              <Select
                label={t(key('versionPolicy'))}
                value={versionPolicy}
                disabled={!editable}
                onChange={(event) =>
                  setVersionPolicy(event.target.value === 'minimum' ? 'minimum' : 'exact')
                }
              >
                <option value="exact">{t(key('exactVersion'))}</option>
                <option value="minimum">{t(key('minimumVersion'))}</option>
              </Select>
              {!versions.data?.length && <p>{t(key('noVersions'))}</p>}
              {versions.data?.find((item) => item.version === version)?.compatibility ===
                'unknown' && <p className="muted">{t(key('compatibilityUnknown'))}</p>}
              <ul className="satisfactory-dependencies">
                {versions.data
                  ?.find((item) => item.version === version)
                  ?.dependencies.map((item) => (
                    <li key={item.mod_id}>
                      {item.mod_id} {item.condition}
                      {item.optional ? ` (${t(key('optional'))})` : ''}
                    </li>
                  ))}
              </ul>
              {!!versions.data?.find((item) => item.version === version)?.changelog && (
                <details>
                  <summary>{t(key('changelog'))}</summary>
                  <p className="satisfactory-description">
                    {versions.data?.find((item) => item.version === version)?.changelog}
                  </p>
                </details>
              )}
              <div className="form-footer">
                <button
                  type="button"
                  disabled={
                    !editable ||
                    !version ||
                    versions.data?.find((item) => item.version === version)?.compatibility ===
                      'incompatible'
                  }
                  onClick={() => {
                    replace({
                      reference: project.reference,
                      version: versionPolicy === 'minimum' ? `>=${version}` : version,
                      enabled: true,
                    });
                    setProject(undefined);
                  }}
                >
                  {t(key('select'))}
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
      {profilesOpen && (
        <Dialog
          open
          title={t(key('profiles'))}
          onClose={() => {
            if (!working && !uncertain) setProfilesOpen(false);
          }}
          closeDisabled={working || uncertain}
          closeIcon
          className="satisfactory-mod-dialog"
        >
          {errorNode}
          <ul className="satisfactory-profile-list">
            {data?.profiles.map((profile) => (
              <li key={profile.id}>
                <div>
                  <strong>{profile.name}</strong>
                  {profile.id === data.activeProfileId && (
                    <span className="muted"> · {t(key('activeProfile'))}</span>
                  )}
                  <small>{t(key('results'), { count: profile.selection.length })}</small>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!canEditProfile}
                    onClick={() => {
                      edit({
                        selection: profile.selection,
                        vanilla: profile.vanilla,
                        profileId: profile.id,
                      });
                      setProfilesOpen(false);
                    }}
                  >
                    {t(key('loadProfile'))}
                  </button>
                  <ModsAction
                    icon="download"
                    label={t(key('exportProfile'), { name: profile.name })}
                    disabled={working}
                    onClick={() => void execute(() => exportProfile(profile))}
                  />
                  <ModsAction
                    icon="version"
                    label={t(key('editProfile'), { name: profile.name })}
                    disabled={!canEditProfile}
                    onClick={() => {
                      setProfileEdit(profile.id);
                      setProfileName(profile.name);
                      setIncludeClient(profile.requiredTargets?.includes('Windows') ?? false);
                    }}
                  />
                  <ModsAction
                    icon="delete"
                    label={t(key('deleteProfile'), { name: profile.name })}
                    destructive
                    disabled={!canEditProfile || profile.id === data.activeProfileId}
                    onClick={() => {
                      setProfileEdit(profile.id);
                      setConfirm('deleteProfile');
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!data || !profileName.trim()) return;
              const input = {
                name: profileName.trim(),
                selection:
                  (profileEdit
                    ? data.profiles.find((item) => item.id === profileEdit)?.selection
                    : undefined) ?? current.selection,
                vanilla:
                  (profileEdit
                    ? data.profiles.find((item) => item.id === profileEdit)?.vanilla
                    : undefined) ?? current.vanilla,
                revision: data.revision,
                idempotencyKey: idempotencyKey(),
                requiredTargets: [
                  ...new Set([
                    ...(profileEdit
                      ? (data.profiles.find((item) => item.id === profileEdit)?.requiredTargets ?? [
                          'LinuxServer',
                        ])
                      : ['LinuxServer']
                    ).filter((target) => target !== 'Windows'),
                    ...(includeClient ? ['Windows'] : []),
                  ]),
                ] as ('Windows' | 'WindowsServer' | 'LinuxServer')[],
              };
              void execute(async () => {
                await controller.saveProfile(props.serverId, profileEdit, input);
                setProfileName('');
                setProfileEdit(undefined);
                await refresh();
              }, true);
            }}
          >
            <Input
              label={t(key('profileName'))}
              value={profileName}
              maxLength={80}
              required
              disabled={!canEditProfile}
              onChange={(event) => setProfileName(event.target.value)}
            />
            <ModsCheckbox
              label={t(key('includeClient'))}
              checked={includeClient}
              disabled={!canEditProfile}
              onChange={setIncludeClient}
            />
            <p className="muted">{t(key(profileEdit ? 'renameProfileHint' : 'saveProfileHint'))}</p>
            <div className="form-footer">
              <button
                type="button"
                className="secondary"
                disabled={working}
                onClick={() => {
                  setProfileEdit(undefined);
                  setIncludeClient(false);
                  setProfileName('');
                }}
              >
                {t('web.cancel')}
              </button>
              <button type="submit" disabled={!canEditProfile || !profileName.trim()}>
                {t(key(profileEdit ? 'saveProfile' : 'createProfile'))}
              </button>
            </div>
          </form>
          <Input
            type="file"
            label={t(key('importProfile'))}
            accept=".smmprofile,application/json"
            disabled={!props.canManage || busy || uncertain}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file || !data) return;
              const identity = idempotencyKey();
              void execute(async () => {
                if (file.size > 2097152)
                  throw new ApiError('validation_failed', 'errors.validation_failed');
                let document: unknown;
                try {
                  document = JSON.parse(await file.text());
                } catch {
                  throw new ApiError('validation_failed', 'errors.validation_failed');
                }
                await controller.importProfile(props.serverId, document, data.revision, identity);
                await refresh();
              }, true);
            }}
          />
          <p className="muted">{t(key('exportHint'))}</p>
        </Dialog>
      )}
      {externalOpen && (
        <Dialog
          open
          title={t(key('connectSmm'))}
          closeIcon
          closeDisabled={working || uncertain}
          onClose={() => {
            if (!working && !uncertain) setExternalOpen(false);
          }}
          className="satisfactory-mod-dialog"
        >
          {errorNode}
          <p>{t(key(data?.externalMode ? 'externalSteps' : 'externalIntro'))}</p>
          {data?.externalMode ? (
            <>
              {!stopped || props.pending ? (
                <p role="status">{t(key('externalStopping'))}</p>
              ) : (
                <p>{t(key('externalReady'))}</p>
              )}
              <Link
                className="secondary satisfactory-sftp-link"
                to={`/servers/${encodeURIComponent(props.serverId)}/files?sftp=open`}
              >
                {t(key('sftp'))}
              </Link>
              <p className="muted">{t(key('externalProfileHint'))}</p>
              <div className="actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  {t(key('refresh'))}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setExternalOpen(false);
                    setProfilesOpen(true);
                  }}
                >
                  {t(key('profiles'))}
                </button>
                <button
                  type="button"
                  disabled={
                    !props.canManage ||
                    busy ||
                    !stopped ||
                    !inventory.data ||
                    inventory.data.diverged ||
                    data.inventoryFingerprint !== inventory.data.fingerprint
                  }
                  onClick={() => {
                    if (!data || !inventory.data) return;
                    const fingerprint = inventory.data.fingerprint;
                    const revision = data.revision;
                    void execute(async () => {
                      await controller.finishExternal(props.serverId, revision, fingerprint);
                      await refresh();
                      setExternalOpen(false);
                    });
                  }}
                >
                  {t(key('finishExternal'))}
                </button>
              </div>
              {!!inventory.data?.issues?.length && (
                <details className="satisfactory-notice">
                  <summary>{t(key('inventoryWarnings'))}</summary>
                  <ul>
                    {inventory.data.issues.map((issue) => (
                      <li key={`${issue.path}-${issue.reason}`}>
                        <code>{issue.path}</code>:{' '}
                        {t(
                          key(
                            `issue.${['unsafe_path', 'invalid_game_version', 'invalid_lockfile', 'unknown_directory'].includes(issue.reason) ? issue.reason : 'unknown'}`,
                          ),
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {inventory.data && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !stopped || !props.canManage}
                  onClick={() =>
                    data?.externalMode ? setConfirm('reconcile') : setExternalOpen(true)
                  }
                >
                  {t(key('reconcile'))}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              disabled={!props.canManage || busy || uncertain || changed}
              onClick={() => setConfirm('external')}
            >
              {t(key('beginExternal'))}
            </button>
          )}
        </Dialog>
      )}
      <ConfirmDialog
        open={!!confirm}
        title={t(key(`${confirm ?? 'rollback'}Title`))}
        busy={working}
        submitDisabled={uncertain}
        onClose={() => {
          if (!uncertain) setConfirm(undefined);
        }}
        onConfirm={confirmAction}
        confirmLabel={t(
          key(
            confirm === 'stop'
              ? 'stop'
              : confirm === 'external'
                ? 'beginExternal'
                : confirm === 'reconcile'
                  ? 'reconcile'
                  : confirm === 'deleteProfile'
                    ? 'delete'
                    : 'rollback',
          ),
        )}
        destructive={confirm === 'rollback' || confirm === 'deleteProfile'}
      >
        <p>{t(key(`${confirm ?? 'rollback'}Hint`))}</p>
        {confirm === 'reconcile' && (
          <ul className="satisfactory-dependencies">
            {current.selection.map((item) => (
              <li key={item.reference}>
                {item.reference} {item.version}
                {item.enabled === false ? ` · ${t(key('disabled'))}` : ''}
              </li>
            ))}
          </ul>
        )}
        {errorNode}
      </ConfirmDialog>
    </section>
  );
}
function Review({ plan }: { plan: ModPlan }) {
  const t = useT();
  return (
    <div className="satisfactory-review">
      <p className="muted">{t(key('resolvedHint'))}</p>
      {plan.vanilla && <p>{t(key('vanilla'))}</p>}
      <ul className="mods-review-list">
        {plan.changes.map((change) => (
          <li key={`${change.reference}-${change.action}`} className="satisfactory-review-row">
            <span className="satisfactory-change-action">{t(key(`change.${change.action}`))}</span>
            <div>
              <strong>{change.reference}</strong>
              <div className="satisfactory-mod-meta">
                {change.fromVersion && <span>{change.fromVersion}</span>}
                {change.toVersion && (
                  <span>
                    {change.fromVersion ? '→ ' : ''}
                    {change.toVersion}
                  </span>
                )}
                {change.dependency && <span>{t(key('dependency'))}</span>}
              </div>
              {!!change.requiredBy?.length && (
                <small>{t(key('requiredBy'), { names: change.requiredBy.join(', ') })}</small>
              )}
            </div>
          </li>
        ))}
      </ul>
      {plan.changes.length === 0 && <p>{t(key('noFileChanges'))}</p>}
    </div>
  );
}
