import {
  createMinecraftUiController,
  type MinecraftDatapackCatalogPlan,
  type MinecraftDatapacks,
  type WorldCatalogFile,
} from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, idempotencyKey, queryClient } from '../../api/client.js';
import { hashFile } from '../../api/hash.js';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { ConfirmDialog, ErrorNotice } from '../../components/ui.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { gameUiClient } from '../../features/integrations.js';
import { contentPreparationErrorKey } from './content-preparation-error.js';
import { MinecraftDatapackCatalog } from './datapack-catalog.js';
import { DatapackDependencies } from './datapack-dependencies.js';
import { prepareMinecraftWorldFolder } from './world-folder-archive.js';
import './datapacks.css';

const controller = createMinecraftUiController(gameUiClient);
const key = (name: string) => `games.minecraft.datapacks.${name}`;
type Action = 'install' | 'enable' | 'disable' | 'delete';
type Pack = MinecraftDatapacks['packs'][number];
type Preparation = {
  identity: string;
  world: string;
  provider: 'modrinth' | 'curseforge';
  projectId: string;
  file: WorldCatalogFile;
  state: 'queued' | 'preparing' | 'ready' | 'failed' | 'blocked' | 'review';
  plan?: MinecraftDatapackCatalogPlan;
  optionalProjectIds?: string[];
  disablePaths?: string[];
  requestKey: string;
  error?: unknown;
};
export function DatapackIcon({
  name,
}: {
  name:
    | 'pack'
    | 'upload'
    | 'folder'
    | 'search'
    | 'refresh'
    | 'close'
    | 'delete'
    | 'enable'
    | 'disable'
    | 'replace'
    | 'files'
    | 'world'
    | 'inspect';
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'inspect' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 10v6m0-9v.1" />
        </>
      )}
      {name === 'pack' && <path d="m12 3 9 5v9l-9 5-9-5V8zm-9 5 9 5 9-5m-9 5v9M7.5 5.5l9 5v4" />}
      {name === 'world' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m4 16 5-6 4 4 3-3 5 5" />
          <circle cx="15" cy="7.5" r="1" />
        </>
      )}
      {name === 'upload' && <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />}
      {name === 'folder' && <path d="M3 7V5h7l2 3h9v13H3V7m9 10V11m-3 3 3-3 3 3" />}
      {name === 'search' && (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" />
        </>
      )}
      {name === 'refresh' && (
        <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
      )}
      {name === 'close' && <path d="m6 6 12 12M6 18 18 6" />}
      {name === 'delete' && <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />}
      {name === 'enable' && <path d="m7 4 13 8-13 8z" />}
      {name === 'disable' && <path d="M8 5v14M16 5v14" />}
      {name === 'replace' && <path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4" />}
      {name === 'files' && <path d="M3 7V4h7l2 3h9v13H3z" />}
    </svg>
  );
}

export function MinecraftDatapacksSection(props: GameSectionViewProps) {
  const t = useT();
  const initial = props.data.metadata?.datapacks as MinecraftDatapacks | undefined;
  const [world, setWorld] = useState(initial?.world ?? '');
  const [search, setSearch] = useState('');
  const [inspected, setInspected] = useState<string>();
  const [page, setPage] = useState(0);
  const [catalog, setCatalog] = useState(false);
  const [dependencyDetails, setDependencyDetails] = useState<string>();
  const [preparations, setPreparations] = useState<Preparation[]>([]);
  const preparationQueue = useRef<Preparation[]>([]);
  const preparingCatalog = useRef(false);
  const alive = useRef(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [remove, setRemove] = useState<Pack>();
  const [progress, setProgress] = useState<{
    name: string;
    phase: string;
    sent?: number;
    total?: number;
  }>();
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const replacement = useRef<Pack | undefined>(undefined);
  const transfer = useRef<AbortController | undefined>(undefined);
  const lock = useRef(false);
  const requestKeys = useRef(new Map<string, string>());
  const queryKey = ['minecraft-datapacks', props.serverId, world];
  const inventory = useQuery({
    queryKey,
    queryFn: ({ signal }) => controller.datapacks(props.serverId, world || undefined, signal),
    initialData: initial?.world === world ? initial : undefined,
    staleTime: 5_000,
  });
  const inspection = useQuery({
    queryKey: ['minecraft-datapack-inspection', props.serverId, world, inspected],
    queryFn: ({ signal }) =>
      controller.inspectDatapack(props.serverId, world, inspected ?? '', signal),
    enabled: Boolean(inspected),
    staleTime: 0,
  });
  const data = inventory.data;
  const supported = data?.installed && data.supported;
  const disabled = !props.canManage || !supported || props.pending || Boolean(busy);
  const changes = data?.changes ?? [];
  const nativePending = changes.some(
    (change) =>
      change.action === 'enable' &&
      data?.packs.some(
        (pack) =>
          pack.name === change.name && pack.state === 'enabled' && pack.nativeState === 'disabled',
      ),
  );
  const ready = changes.length > 0 && changes.every((change) => change.state === 'ready');
  const preparing = preparations.some(
    (item) => item.state === 'queued' || item.state === 'preparing',
  );
  const applyAllowed =
    (ready ||
      (!changes.length &&
        data?.reload.state === 'required' &&
        data.running &&
        world === data.selectedWorld)) &&
    !disabled &&
    !progress &&
    !preparing &&
    !preparations.some(
      (item) => item.world === world && ['blocked', 'review', 'failed'].includes(item.state),
    );
  const visible = (data?.packs ?? []).filter((pack) =>
    pack.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(visible.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const rows = visible.slice(currentPage * 50, currentPage * 50 + 50);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      transfer.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!props.canManage) transfer.current?.abort();
  }, [props.canManage]);
  function requestKey(identity: string) {
    const value = requestKeys.current.get(identity) ?? idempotencyKey();
    requestKeys.current.set(identity, value);
    return value;
  }
  function publishPreparations() {
    if (alive.current) setPreparations(preparationQueue.current.map((item) => ({ ...item })));
  }
  async function drainPreparations() {
    if (preparingCatalog.current) return;
    preparingCatalog.current = true;
    try {
      while (alive.current) {
        const next = preparationQueue.current.find((item) => item.state === 'queued');
        if (!next) break;
        next.state = 'preparing';
        next.error = undefined;
        publishPreparations();
        try {
          // Resolve metadata once during preparation, never from the Apply handler.
          const plan = await controller.planDatapack(props.serverId, {
            provider: next.provider,
            projectId: next.projectId,
            versionId: next.file.id,
            world: next.world,
            optionalProjectIds: next.optionalProjectIds,
          });
          next.plan = plan;
          if (plan.blockers.length) {
            next.state = 'blocked';
          } else if (
            plan.conflicts.some((conflict) => !next.disablePaths?.includes(conflict.path))
          ) {
            next.state = 'review';
          } else {
            const result = await controller.acquireDatapack(props.serverId, {
              provider: next.provider,
              projectId: next.projectId,
              versionId: next.file.id,
              world: next.world,
              idempotencyKey: next.requestKey,
              planId: plan.planId,
              disablePaths: next.disablePaths,
            });
            if (result.state !== 'ready')
              throw new ApiError('integration_unavailable', key('failed'));
            next.state = 'ready';
          }
        } catch (failure) {
          next.state = 'failed';
          next.error = failure;
          if (alive.current) setError(failure);
        }
        publishPreparations();
        void queryClient.invalidateQueries({
          queryKey: ['minecraft-datapacks', props.serverId, next.world],
        });
      }
    } finally {
      preparingCatalog.current = false;
    }
  }
  function queueCatalog(input: {
    provider: 'modrinth' | 'curseforge';
    projectId: string;
    file: WorldCatalogFile;
  }) {
    if (
      disabled ||
      nativePending ||
      preparationQueue.current.filter((item) => ['queued', 'preparing'].includes(item.state))
        .length >= 16
    )
      return;
    const identity = `${input.provider}:${input.projectId}:${input.file.id}`;
    const existing = preparationQueue.current.find(
      (item) => item.world === world && item.identity === identity,
    );
    if (existing) {
      if (existing.plan) {
        setCatalog(false);
        setDependencyDetails(identity);
      } else if (existing.state === 'failed')
        revisePreparation(identity, existing.optionalProjectIds ?? [], existing.disablePaths ?? []);
      return;
    }
    preparationQueue.current.push({
      ...input,
      identity,
      world,
      state: 'queued',
      requestKey: idempotencyKey(),
    });
    publishPreparations();
    void drainPreparations();
  }
  function revisePreparation(
    identity: string,
    optionalProjectIds: string[],
    disablePaths: string[],
  ) {
    const item = preparationQueue.current.find(
      (candidate) => candidate.identity === identity && candidate.world === world,
    );
    if (!item || disabled || ['queued', 'preparing'].includes(item.state)) return;
    setError(undefined);
    item.optionalProjectIds = optionalProjectIds;
    item.disablePaths = disablePaths;
    item.requestKey = idempotencyKey();
    item.state = 'queued';
    item.error = undefined;
    publishPreparations();
    setDependencyDetails(undefined);
    void drainPreparations();
  }
  async function refresh() {
    await inventory.refetch();
  }
  async function mutate(identity: string, operation: () => Promise<unknown>) {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(identity);
    setError(undefined);
    try {
      await operation();
      requestKeys.current.delete(identity);
      void refresh();
    } catch (failure) {
      setError(failure);
      void refresh();
    } finally {
      lock.current = false;
      setBusy(undefined);
    }
  }
  async function apply() {
    const confirmedIds = new Set(changes.map((change) => change.id));
    await mutate(`apply:${world}`, async () => {
      const result = await controller.applyDatapacks(props.serverId, {
        world,
        idempotencyKey: requestKey(`apply:${world}`),
      });
      if (result.state !== 'published') throw new ApiError('operation_uncertain', key('uncertain'));
      // Publication is confirmed by the API, not inferred from request acceptance.
      // Refresh real inventory separately; do not invent installed pack receipts.
      queryClient.setQueryData<MinecraftDatapacks>(queryKey, (current) =>
        current
          ? {
              ...current,
              changes: current.changes.filter((change) => !confirmedIds.has(change.id)),
              reload: { state: result.reload },
            }
          : current,
      );
    });
  }
  async function stage(action: Action, pack?: Pack, sourceId?: string, name?: string) {
    const identity = `${world}:${action}:${pack?.path ?? sourceId ?? name}`;
    await mutate(identity, () =>
      controller.datapackChange(props.serverId, {
        world,
        action,
        ...(pack ? { path: pack.path } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(name ? { name } : {}),
        idempotencyKey: requestKey(identity),
      }),
    );
  }
  async function upload(files: FileList | null, folder = false) {
    if (disabled || nativePending || transfer.current || !files?.length) return;
    const first = files[0];
    if (!first) return;
    const selectedWorld = world;
    const replace = replacement.current;
    replacement.current = undefined;
    const abort = new AbortController();
    transfer.current = abort;
    const name = folder ? (first.webkitRelativePath.split('/')[0] ?? first.name) : first.name;
    setError(undefined);
    try {
      if (!folder && (files.length !== 1 || !/\.zip$/i.test(first.name) || !first.size))
        throw new ApiError('validation_failed', key('invalidZip'));
      setProgress({ name, phase: 'preparing' });
      let file: File;
      if (folder) {
        try {
          file = await prepareMinecraftWorldFolder(Array.from(files), {
            signal: abort.signal,
            marker: 'pack.mcmeta',
          });
        } catch (failure) {
          if (abort.signal.aborted) throw failure;
          throw new ApiError('validation_failed', key('invalidFolder'));
        }
      } else file = first;
      setProgress({ name, phase: 'hashing' });
      const sha256 = await hashFile(file, { signal: abort.signal });
      setProgress({ name, phase: 'uploading', sent: 0, total: file.size });
      const source = await controller.uploadSource({
        kind: 'datapack',
        serverId: props.serverId,
        file,
        sha256,
        idempotencyKey: idempotencyKey(),
        signal: abort.signal,
        onProgress: (sent, total) =>
          setProgress({ name, phase: sent < total ? 'uploading' : 'preparing', sent, total }),
      });
      abort.signal.throwIfAborted();
      setProgress({ name, phase: 'staging' });
      await controller.datapackChange(props.serverId, {
        world: selectedWorld,
        action: 'install',
        sourceId: source.id,
        name: replace?.name ?? file.name,
        ...(replace ? { path: replace.path } : {}),
        idempotencyKey: idempotencyKey(),
      });
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure);
    } finally {
      void queryClient.invalidateQueries({
        queryKey: ['minecraft-datapacks', props.serverId, selectedWorld],
      });
      transfer.current = undefined;
      setProgress(undefined);
      if (picker.current) picker.current.value = '';
      if (folderPicker.current) folderPicker.current.value = '';
    }
  }
  function action(
    name: 'upload' | 'folder' | 'browse' | 'refresh',
    icon: Parameters<typeof DatapackIcon>[0]['name'],
    onClick: () => void,
    blocked = disabled || nativePending,
  ) {
    return (
      <Tooltip content={t(key(name))}>
        <button
          type="button"
          className="datapack-action"
          aria-label={t(key(name))}
          onClick={onClick}
          disabled={blocked}
        >
          <DatapackIcon name={icon} />
        </button>
      </Tooltip>
    );
  }
  if (data && !data.worlds.length && !inventory.error)
    return (
      <section className="minecraft-datapacks" aria-label={t('games.minecraft.sections.datapacks')}>
        <div className="datapack-no-worlds" role="status">
          <DatapackIcon name="world" />
          <p>{t(key('noWorlds'))}</p>
        </div>
      </section>
    );
  return (
    <section className="minecraft-datapacks" aria-label={t('games.minecraft.sections.datapacks')}>
      <div className="datapack-toolbar">
        <label className="datapack-world">
          <span>{t(key('world'))}</span>
          <select
            value={world}
            aria-label={t(key('world'))}
            disabled={Boolean(busy || progress || preparing)}
            onChange={(event) => {
              setWorld(event.target.value);
              setPage(0);
              setInspected(undefined);
              setError(undefined);
            }}
          >
            {(data?.worlds ?? initial?.worlds ?? []).map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className="datapack-search">
          <DatapackIcon name="search" />
          <input
            type="search"
            value={search}
            placeholder={t(key('search'))}
            aria-label={t(key('search'))}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="datapack-tools">
          {action('browse', 'search', () => setCatalog(true))}
          {action(
            'upload',
            'upload',
            () => {
              replacement.current = undefined;
              picker.current?.click();
            },
            disabled || nativePending || Boolean(progress) || preparing,
          )}
          {action(
            'folder',
            'folder',
            () => folderPicker.current?.click(),
            disabled || nativePending || Boolean(progress) || preparing,
          )}
          {action(
            'refresh',
            'refresh',
            () => void refresh(),
            inventory.isFetching || Boolean(busy),
          )}
        </div>
      </div>
      <input
        hidden
        type="file"
        accept=".zip,application/zip"
        ref={picker}
        onChange={(event) => void upload(event.target.files)}
      />
      <input
        hidden
        type="file"
        multiple
        {...{ webkitdirectory: '' }}
        ref={folderPicker}
        onChange={(event) => void upload(event.target.files, true)}
      />
      {error || inventory.error ? <ErrorNotice error={error ?? inventory.error} /> : null}
      {!props.canManage && <p className="datapack-note">{t(key('readonly'))}</p>}
      {inventory.isPending ? (
        <div
          className="datapack-skeleton"
          role="status"
          aria-busy="true"
          aria-label={t(key('loading'))}
        >
          {[0, 1, 2].map((item) => (
            <span key={item} />
          ))}
        </div>
      ) : data && !data.supported ? (
        <p className="datapack-empty">{t(key('unsupported'))}</p>
      ) : !data?.worlds.length ? null : (
        <>
          {data.world !== data.selectedWorld && (
            <p className="datapack-note">{t(key('inactive'))}</p>
          )}
          {progress && (
            <div className="datapack-upload" role="status">
              <span>
                <strong>{progress.name}</strong>
                <small>{t(key(progress.phase))}</small>
              </span>
              {progress.phase === 'uploading' && progress.total ? (
                <progress
                  aria-label={t(key('uploading'))}
                  value={progress.sent}
                  max={progress.total}
                />
              ) : null}
              {progress.phase !== 'staging' && (
                <Tooltip content={t(key('cancelUpload'))}>
                  <button
                    type="button"
                    className="datapack-action"
                    aria-label={t(key('cancelUpload'))}
                    onClick={() => transfer.current?.abort()}
                  >
                    <DatapackIcon name="close" />
                  </button>
                </Tooltip>
              )}
            </div>
          )}
          {preparations.some(
            (item) =>
              item.world === world && (item.state !== 'ready' || item.plan?.optional.length),
          ) && (
            <section className="datapack-changes" aria-label={t(key('preparations'))}>
              {preparations
                .filter(
                  (item) =>
                    item.world === world && (item.state !== 'ready' || item.plan?.optional.length),
                )
                .map((item) => (
                  <div className="datapack-change" key={item.identity}>
                    <span>
                      <strong>{item.file.name}</strong>
                      <small>{t(key(item.state))}</small>
                      {item.state === 'failed' && item.error !== undefined && (
                        <small>{t(contentPreparationErrorKey(item.error))}</small>
                      )}
                      {item.plan?.blockers.map((blocker) => (
                        <small key={`${blocker.projectId}:${blocker.reason}`}>
                          {blocker.name}: {t(key(`dependencies.blocker.${blocker.reason}`))}
                        </small>
                      ))}
                    </span>
                    {item.plan && (
                      <Tooltip content={t(key('dependencies.details'))}>
                        <button
                          type="button"
                          className="datapack-action"
                          aria-label={t(key('actionFor'), {
                            action: t(key('dependencies.details')),
                            name: item.file.name,
                          })}
                          disabled={['queued', 'preparing'].includes(item.state)}
                          onClick={() => {
                            setCatalog(false);
                            setDependencyDetails(item.identity);
                          }}
                        >
                          <DatapackIcon name="inspect" />
                        </button>
                      </Tooltip>
                    )}
                    {item.state === 'failed' && (
                      <Tooltip content={t(key('dependencies.retry'))}>
                        <button
                          type="button"
                          className="datapack-action"
                          aria-label={t(key('dependencies.retry'))}
                          onClick={() =>
                            revisePreparation(
                              item.identity,
                              item.optionalProjectIds ?? [],
                              item.disablePaths ?? [],
                            )
                          }
                        >
                          <DatapackIcon name="refresh" />
                        </button>
                      </Tooltip>
                    )}
                    {item.state !== 'preparing' && (
                      <Tooltip
                        content={t(
                          key(
                            item.state === 'ready' || item.state === 'failed'
                              ? 'dependencies.hide'
                              : 'dependencies.removeQueue',
                          ),
                        )}
                      >
                        <button
                          className="datapack-action"
                          type="button"
                          aria-label={t(key('actionFor'), {
                            action: t(
                              key(
                                item.state === 'ready' || item.state === 'failed'
                                  ? 'dependencies.hide'
                                  : 'dependencies.removeQueue',
                              ),
                            ),
                            name: item.file.name,
                          })}
                          onClick={() => {
                            preparationQueue.current = preparationQueue.current.filter(
                              (candidate) =>
                                candidate.identity !== item.identity ||
                                candidate.world !== item.world,
                            );
                            publishPreparations();
                          }}
                        >
                          <DatapackIcon name="close" />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                ))}
            </section>
          )}
          {changes.length > 0 && (
            <section className="datapack-changes" aria-label={t(key('changes'))}>
              {changes.map((change) => (
                <div key={change.id} className="datapack-change">
                  <span>
                    <strong>{change.name}</strong>
                    <small>
                      {t(key(`action.${change.action}`))} · {t(key(change.state))}
                    </small>
                    {change.state === 'failed' && change.error && (
                      <small>{t(contentPreparationErrorKey(change.error))}</small>
                    )}
                  </span>
                  <Tooltip content={t(key('discard'))}>
                    <button
                      type="button"
                      className="datapack-action"
                      aria-label={t(key('actionFor'), {
                        action: t(key('discard')),
                        name: change.name,
                      })}
                      disabled={
                        disabled ||
                        !(change.cancellable ?? ['ready', 'failed'].includes(change.state))
                      }
                      onClick={() =>
                        void mutate(`cancel:${change.id}`, () =>
                          controller.cancelDatapackChange(props.serverId, change.id),
                        )
                      }
                    >
                      <DatapackIcon name="close" />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </section>
          )}
          {rows.length ? (
            <ul className="datapack-list">
              {rows.map((pack) => {
                const changed = changes.some((change) => change.name === pack.name);
                const metadata =
                  inspected === pack.path && inspection.data
                    ? inspection.data.metadata
                    : pack.metadata;
                const compatibility = metadata?.compatibility ?? pack.compatibility;
                const nativeEnable = pack.state === 'enabled' && pack.nativeState === 'disabled';
                const enable = pack.state === 'disabled' || nativeEnable;
                const nativeBlocked =
                  nativeEnable &&
                  (changes.length > 0 || !data.running || world !== data.selectedWorld);
                return (
                  <li key={pack.id} className="datapack-row">
                    <span className="datapack-icon">
                      <DatapackIcon name="pack" />
                    </span>
                    <div className="datapack-identity">
                      <strong>{pack.name}</strong>
                      {metadata?.description && <p>{metadata.description}</p>}
                      <div className="datapack-details">
                        <span>
                          {t(
                            key(
                              pack.nativeState === 'disabled' && pack.state === 'enabled'
                                ? 'nativeDisabled'
                                : pack.state,
                            ),
                          )}
                        </span>
                        <span className={`datapack-compatibility--${compatibility}`}>
                          {t(key(`compatibility.${compatibility}`))}
                        </span>
                      </div>
                    </div>
                    <div className="datapack-row-actions">
                      <Tooltip content={t(key('inspect'))}>
                        <button
                          type="button"
                          className="datapack-action"
                          aria-expanded={inspected === pack.path}
                          aria-label={t(key('actionFor'), {
                            action: t(key('inspect')),
                            name: pack.name,
                          })}
                          onClick={() =>
                            setInspected((current) =>
                              current === pack.path ? undefined : pack.path,
                            )
                          }
                        >
                          <DatapackIcon name="inspect" />
                        </button>
                      </Tooltip>
                      {pack.state !== 'pending' && (
                        <>
                          <Tooltip
                            content={t(
                              key(
                                nativeEnable && changes.length > 0
                                  ? 'applyFirst'
                                  : nativeEnable && (!data.running || world !== data.selectedWorld)
                                    ? 'nativeOffline'
                                    : enable
                                      ? 'enable'
                                      : 'disable',
                              ),
                            )}
                          >
                            <button
                              type="button"
                              className="datapack-action"
                              aria-label={t(key('actionFor'), {
                                action: t(key(enable ? 'enable' : 'disable')),
                                name: pack.name,
                              })}
                              disabled={
                                disabled ||
                                nativePending ||
                                nativeBlocked ||
                                changed ||
                                preparing ||
                                Boolean(progress)
                              }
                              onClick={() => void stage(enable ? 'enable' : 'disable', pack)}
                            >
                              <DatapackIcon name={enable ? 'enable' : 'disable'} />
                            </button>
                          </Tooltip>
                          {pack.kind === 'zip' && (
                            <Tooltip content={t(key('replace'))}>
                              <button
                                type="button"
                                className="datapack-action"
                                aria-label={t(key('actionFor'), {
                                  action: t(key('replace')),
                                  name: pack.name,
                                })}
                                disabled={
                                  disabled ||
                                  nativePending ||
                                  changed ||
                                  preparing ||
                                  Boolean(progress)
                                }
                                onClick={() => {
                                  replacement.current = pack;
                                  picker.current?.click();
                                }}
                              >
                                <DatapackIcon name="replace" />
                              </button>
                            </Tooltip>
                          )}
                          <Tooltip content={t(key('delete'))}>
                            <button
                              type="button"
                              className="datapack-action datapack-action--danger"
                              aria-label={t(key('actionFor'), {
                                action: t(key('delete')),
                                name: pack.name,
                              })}
                              disabled={
                                disabled ||
                                nativePending ||
                                changed ||
                                preparing ||
                                Boolean(progress)
                              }
                              onClick={() => setRemove(pack)}
                            >
                              <DatapackIcon name="delete" />
                            </button>
                          </Tooltip>
                        </>
                      )}
                    </div>
                    {inspected === pack.path && (
                      <div className="datapack-inspection" aria-live="polite">
                        {inspection.error ? (
                          <ErrorNotice
                            error={inspection.error}
                            retry={() => void inspection.refetch()}
                          />
                        ) : inspection.isPending ? (
                          <span className="datapack-inspection-skeleton" aria-hidden="true" />
                        ) : inspection.data?.reason === 'too_large' ? (
                          <p>{t(key('tooLarge'))}</p>
                        ) : metadata ? (
                          <>
                            <span>
                              {t(key('format'))}: {metadata.formatMin?.join('.') ?? '—'} –{' '}
                              {metadata.formatMax?.join('.') ?? '—'}
                            </span>
                            {metadata.features.length > 0 && (
                              <code>{metadata.features.join(', ')}</code>
                            )}
                          </>
                        ) : (
                          <p>{t(key('compatibility.unknown'))}</p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="datapack-empty">{t(key(search ? 'noResults' : 'empty'))}</p>
          )}
          {pages > 1 && (
            <nav className="datapack-pages" aria-label={t(key('search'))}>
              <button
                type="button"
                className="secondary"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                {t(key('previous'))}
              </button>
              <span>{t(key('page'), { page: currentPage + 1, pages })}</span>
              <button
                type="button"
                className="secondary"
                disabled={currentPage >= pages - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                {t(key('next'))}
              </button>
            </nav>
          )}
          {(changes.length > 0 || data.reload.state !== 'not_required') && (
            <footer className="datapack-apply">
              <div aria-live="polite">
                {data.reload.state !== 'not_required' && (
                  <>
                    <p>
                      {t(
                        key(
                          data.reload.state === 'required' &&
                            (!data.running || world !== data.selectedWorld)
                            ? 'inactive'
                            : `reload.${data.reload.state}`,
                        ),
                      )}
                    </p>
                    <Link to={`/servers/${props.serverId}/console`}>{t(key('console'))}</Link>
                  </>
                )}
              </div>
              {(changes.some((change) => change.state === 'uncertain') ||
                data.reload.state === 'uncertain') && (
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || preparing}
                  onClick={() =>
                    void mutate(`recover:${world}`, () =>
                      controller.recoverDatapacks(props.serverId, world),
                    )
                  }
                >
                  {t(key('recover'))}
                </button>
              )}
              {(changes.length > 0 || (data.running && world === data.selectedWorld)) && (
                <button type="button" disabled={!applyAllowed} onClick={() => void apply()}>
                  {t(key(busy === `apply:${world}` ? 'applying' : 'apply'))}
                </button>
              )}
            </footer>
          )}
        </>
      )}
      {(() => {
        const item = preparations.find(
          (candidate) => candidate.identity === dependencyDetails && candidate.world === world,
        );
        return item?.plan ? (
          <DatapackDependencies
            name={item.file.name}
            plan={item.plan}
            selectedOptional={item.optionalProjectIds ?? []}
            busy={disabled || ['queued', 'preparing'].includes(item.state)}
            onClose={() => setDependencyDetails(undefined)}
            onPrepare={(optional, disables) => revisePreparation(item.identity, optional, disables)}
          />
        ) : null;
      })()}
      <ConfirmDialog
        open={Boolean(remove)}
        title={t(key('deleteTitle'), { name: remove?.name ?? '' })}
        onClose={() => setRemove(undefined)}
        confirmLabel={t(key('delete'))}
        destructive
        onConfirm={async () => {
          if (remove) await stage('delete', remove);
          setRemove(undefined);
        }}
      >
        <p>{t(key('deleteBody'))}</p>
      </ConfirmDialog>
      {catalog && (
        <MinecraftDatapackCatalog
          serverId={props.serverId}
          release={data?.version}
          disabled={
            disabled ||
            nativePending ||
            preparations.filter((item) => ['queued', 'preparing'].includes(item.state)).length >= 16
          }
          preparations={
            new Map(
              preparations
                .filter((item) => item.world === world)
                .map((item) => [item.identity, item.state]),
            )
          }
          onClose={() => setCatalog(false)}
          onQueue={queueCatalog}
        />
      )}
    </section>
  );
}
