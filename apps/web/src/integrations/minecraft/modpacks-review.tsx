import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type {
  MinecraftModpackOperation,
  MinecraftModpacksSnapshot,
  ModpackCatalogVersion,
} from '../../../../../games/minecraft/src/ui/modpacks-controller.js';
import { createMinecraftModpacksController } from '../../../../../games/minecraft/src/ui/modpacks-controller.js';
import { useFormat, useT } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import { Pagination, Switch } from '../../components/workspace-controls.js';
import { gameUiClient } from '../../features/integrations.js';
import {
  modpackKey as k,
  modpackProviders,
  packLoaderLabel,
  packRuntimeLabel,
} from './modpacks-model.js';
import { ModsAction, ModsArtwork, ModsIcon } from './mods-primitives.js';

const phaseKey: Record<MinecraftModpackOperation['phase'], string> = {
  queued: 'queued',
  resolving: 'resolving',
  downloading: 'preparing',
  inspecting: 'inspecting',
  ready: 'ready',
  checking: 'checking',
  stopping: 'stopping',
  backup: 'backingUp',
  runtime: 'changingRuntime',
  publishing: 'publishing',
  verifying: 'verifying',
  restoring: 'restoring',
  complete: 'completed',
};
export function ModpackProgress({ operation }: { operation: MinecraftModpackOperation }) {
  const t = useT();
  const format = useFormat();
  const progress = operation.progress;
  if (['blocked', 'failed', 'uncertain', 'cancelled'].includes(operation.state)) return null;
  const stateKey = phaseKey[operation.phase];
  const ratio =
    progress && progress.totalFiles > 0
      ? Math.min(1, progress.completedFiles / progress.totalFiles)
      : undefined;
  const waiting = ['queued', 'preparing', 'apply_queued', 'applying'].includes(operation.state);
  return (
    <div className="modpacks-progress" data-state={operation.state} aria-live="polite">
      <div>
        <span>{t(k(stateKey))}</span>
        {progress && progress.totalFiles > 0 && (
          <small>
            {t(k('transfer'), {
              completed: format.number(progress.completedFiles, 0),
              total: format.number(progress.totalFiles, 0),
            })}
          </small>
        )}
      </div>
      {waiting && <progress aria-label={t(k(stateKey))} value={ratio} max={1} />}
      {waiting && progress && progress.completedBytes > 0 && (
        <small>
          {progress.totalBytes !== null
            ? t(k('bytes'), {
                completed: format.bytes(progress.completedBytes),
                total: format.bytes(progress.totalBytes),
              })
            : format.bytes(progress.completedBytes)}
        </small>
      )}
    </div>
  );
}
function Choice({
  title,
  hint,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <Switch
      className="modpacks-choice"
      label={title}
      help={hint}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
export function ModpackReview(props: {
  serverId: string;
  operation: MinecraftModpackOperation;
  project?: NonNullable<MinecraftModpackOperation['pack']>['project'];
  version?: ModpackCatalogVersion;
  installed?: MinecraftModpacksSnapshot['installed'];
  canManage: boolean;
  canBackup: boolean;
  canDeleteWorlds: boolean;
  busy: boolean;
  canRecover: boolean;
  onBack: () => void;
  onApply: (backup: boolean) => void;
  onDiscard: () => void;
  onWorldPolicy: (policy: 'preserve' | 'reset') => void;
  onRetry: () => void;
  onRecover: () => void;
  onFileDecision?: (path: string, decision: 'keep-local' | 'use-pack') => void;
}) {
  const t = useT();
  const format = useFormat();
  const operation = props.operation;
  const [backup, setBackup] = useState(
    Boolean(operation.selection.review?.backupBefore && props.canBackup),
  );
  const canSetWorldPolicy =
    operation.selection.mode === 'replace' || Boolean(operation.selection.review);
  const [blockerPage, setBlockerPage] = useState(0);
  const blockerOffset =
    Math.min(blockerPage, Math.max(0, Math.ceil(operation.blockers.length / 100) - 1)) * 100;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const locked =
    props.busy ||
    !props.canManage ||
    operation.canCancel === false ||
    ['apply_queued', 'applying', 'uncertain'].includes(operation.state);
  const canContinue =
    (operation.selection.worldPolicy !== 'reset' || props.canDeleteWorlds) &&
    (!operation.selection.install?.backupBefore || props.canBackup);
  const ready =
    operation.state === 'ready' &&
    operation.runtimeSupported &&
    operation.blockers.length === 0 &&
    Boolean(operation.planDigest);
  const choicesLocked =
    locked &&
    !(
      operation.canCancel === true &&
      operation.cancellationEffect === 'runtime-retained' &&
      !props.busy &&
      props.canManage
    );
  const project = operation.pack?.project ?? props.project;
  const version = operation.pack?.version ?? props.version;
  return (
    <div className="modpacks-review">
      <header className="mods-review-heading">
        <button type="button" className="modpacks-back" onClick={props.onBack}>
          <ModsIcon name="back" />
          {t(k('back'))}
        </button>
        <ModsAction
          icon="close"
          label={t(k('cancel'))}
          disabled={props.busy || !props.canManage || !(operation.canCancel ?? !locked)}
          onClick={props.onDiscard}
        />
      </header>
      <div className="modpacks-review-body">
        <div className="modpacks-review-main">
          <div className="modpacks-pack-heading">
            <ModsArtwork
              image={project?.imageUrl}
              name={
                project?.name ??
                (operation.selection.provider === 'upload'
                  ? t(k('uploaded'))
                  : operation.selection.projectId)
              }
            />
            <div>
              <span className="modpacks-provider">
                {operation.selection.provider === 'upload'
                  ? t(k('uploaded'))
                  : modpackProviders[operation.selection.provider]}
              </span>
              <h3 ref={heading} tabIndex={-1}>
                {project?.name ??
                  (operation.selection.provider === 'upload'
                    ? t(k('uploaded'))
                    : operation.selection.projectId)}
              </h3>
              <p>
                {version?.version ??
                  (operation.selection.provider === 'upload' ? '' : operation.selection.versionId)}
              </p>
              {project?.summary && <p>{project.summary}</p>}
            </div>
          </div>
          {props.installed && (
            <dl className="modpacks-previous">
              <dt>{t(k('currentPack'))}</dt>
              <dd>
                {props.installed.pack.project.name} · {props.installed.pack.version.version}
              </dd>
            </dl>
          )}
          {operation.pack?.imported && (
            <div className="modpacks-import-summary">
              <p>
                {t(k('archiveFormat'))} · {t(k(`format.${operation.pack.imported.format}`))}
              </p>
              {operation.pack.imported.excludedFiles > 0 && (
                <details>
                  <summary>
                    {t(k('excludedFiles'), {
                      count: format.number(operation.pack.imported.excludedFiles, 0),
                    })}
                  </summary>
                  <ul>
                    {operation.pack.imported.excludedPaths.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                  {operation.pack.imported.excludedFiles >
                    operation.pack.imported.excludedPaths.length && (
                    <p>
                      {t(k('morePaths'), {
                        count:
                          operation.pack.imported.excludedFiles -
                          operation.pack.imported.excludedPaths.length,
                      })}
                    </p>
                  )}
                </details>
              )}
            </div>
          )}
          <ModpackProgress operation={operation} />
          {operation.target && (
            <dl className="modpacks-facts">
              <div>
                <dt>{t(k('runtime'))}</dt>
                <dd>{packRuntimeLabel(operation.target)}</dd>
              </div>
              {props.installed &&
                packRuntimeLabel(props.installed.target) !== packRuntimeLabel(operation.target) && (
                  <div>
                    <dt>{t(k('currentRuntime'))}</dt>
                    <dd>{packRuntimeLabel(props.installed.target)}</dd>
                  </div>
                )}
            </dl>
          )}
          {operation.target &&
            !operation.runtimeSupported &&
            !operation.blockers.some((blocker) => blocker.reason === 'runtime') && (
              <p className="modpacks-notice">
                <ModsIcon name="warning" />
                {t(k('runtimeUnavailable'), { runtime: packLoaderLabel(operation.target.loader) })}
              </p>
            )}
          {operation.changes && operation.planDigest && (
            <ReviewFiles
              key={operation.planDigest}
              serverId={props.serverId}
              id={operation.id}
              digest={operation.planDigest}
              counts={operation.reviewCounts}
              size={format.bytes(operation.changes.bytes)}
            />
          )}
          {operation.blockers.length > 0 && (
            <div className="modpacks-blockers">
              <h4>
                <ModsIcon name="warning" />
                {t(k('needsAttention'))}
              </h4>
              <ul>
                {operation.blockers
                  .slice(blockerOffset, blockerOffset + 100)
                  .map((blocker, index) => (
                    <li key={`${blocker.reason}:${blocker.path ?? index}`}>
                      <div>
                        <span>
                          {blocker.reason === 'runtime' && operation.target
                            ? t(k('runtimeUnavailable'), {
                                runtime: packLoaderLabel(operation.target.loader),
                              })
                            : t(k(`blocker.${blocker.reason}`))}
                        </span>
                        {blocker.path && <code>{blocker.path}</code>}
                      </div>
                      {blocker.reason === 'modified-file' &&
                        blocker.path &&
                        props.onFileDecision && (
                          <div className="modpacks-file-decision">
                            <button
                              type="button"
                              disabled={choicesLocked || !canContinue}
                              onClick={() =>
                                props.onFileDecision?.(blocker.path ?? '', 'keep-local')
                              }
                            >
                              {t(k('keepLocal'))}
                            </button>
                            <button
                              type="button"
                              disabled={choicesLocked || !canContinue}
                              onClick={() => props.onFileDecision?.(blocker.path ?? '', 'use-pack')}
                            >
                              {t(k('usePack'))}
                            </button>
                          </div>
                        )}
                    </li>
                  ))}
              </ul>
              <ReviewPagination
                page={blockerOffset / 100}
                total={operation.blockers.length}
                onChange={setBlockerPage}
              />
            </div>
          )}
          {operation.state === 'failed' && (
            <div className="modpacks-recovery">
              <p>{t(k('failed'))}</p>
              <button type="button" disabled={locked || !canContinue} onClick={props.onRetry}>
                {t(k('retry'))}
              </button>
            </div>
          )}
          {operation.state === 'uncertain' && (
            <div className="modpacks-recovery">
              <p>{t(k('recoverHint'))}</p>
              <button type="button" disabled={!props.canRecover} onClick={props.onRecover}>
                {t(k('recover'))}
              </button>
            </div>
          )}
          {Boolean(operation.changes?.remove) && operation.planDigest && (
            <RemovalPaths
              key={`removals-${operation.planDigest}`}
              serverId={props.serverId}
              operation={operation}
              digest={operation.planDigest}
            />
          )}
        </div>
        <aside className="modpacks-review-options" aria-label={t(k('reviewChoices'))}>
          <h4>{t(k(operation.selection.mode))}</h4>
          {operation.selection.mode === 'replace' && (
            <p className="modpacks-replace-warning">{t(k('replaceWarning'))}</p>
          )}
          {canSetWorldPolicy ? (
            <Choice
              title={t(k('preserveWorlds'))}
              hint={t(k(props.canDeleteWorlds ? 'preserveWorldsHint' : 'worldsPermission'))}
              checked={operation.selection.worldPolicy === 'preserve'}
              disabled={
                choicesLocked ||
                (!props.canDeleteWorlds && operation.selection.worldPolicy === 'preserve')
              }
              onChange={(value) => props.onWorldPolicy(value ? 'preserve' : 'reset')}
            />
          ) : (
            <p className="modpacks-preserved">
              <ModsIcon name="check" />
              {t(k('worldsPreserved'))}
            </p>
          )}
          {operation.selection.worldPolicy === 'reset' && (
            <p className="modpacks-reset-warning">
              <ModsIcon name="warning" />
              {t(k('worldsReset'))}
            </p>
          )}
          <Choice
            title={t(k('backup'))}
            hint={t(k('backupHint'))}
            checked={backup}
            disabled={locked || !props.canBackup}
            onChange={setBackup}
          />
          <p className="modpacks-preserved">
            <ModsIcon name="check" />
            {t(k('localChangesPreserved'))}
          </p>
          <p className="modpacks-muted">{t(k('offlineApply'))}</p>
          <button
            type="button"
            className="mods-primary modpacks-apply"
            disabled={
              !ready ||
              locked ||
              (backup && !props.canBackup) ||
              (operation.selection.worldPolicy === 'reset' && !props.canDeleteWorlds)
            }
            onClick={() => props.onApply(backup)}
          >
            <ModsIcon name="download" />
            {t(k(operation.selection.mode))}
          </button>
          {!props.canManage && <p className="modpacks-muted">{t(k('permission'))}</p>}
        </aside>
      </div>
    </div>
  );
}

const reviewController = createMinecraftModpacksController(gameUiClient);
const fileGroups = ['added', 'replaced', 'removed', 'preserved'] as const;
function RemovalPaths({
  serverId,
  operation,
  digest,
}: {
  serverId: string;
  operation: MinecraftModpackOperation;
  digest: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const total = operation.changes?.remove ?? 0;
  const list = useQuery({
    queryKey: ['modpack-review-files', serverId, operation.id, digest, 'deletions', page],
    queryFn: ({ signal }) =>
      reviewController.reviewFiles(serverId, operation.id, digest, 'deletions', page * 100, signal),
    enabled: open && Boolean(operation.removalsPaged),
    staleTime: Infinity,
  });
  const paths = operation.removalsPaged
    ? list.data?.paths
    : operation.deletePaths?.slice(page * 100, page * 100 + 100);
  return (
    <details className="modpacks-removals" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t(k('removedPaths'), { count: total })}</summary>
      {open &&
        (list.error ? (
          <ErrorNotice error={list.error} retry={() => void list.refetch()} />
        ) : !paths ? (
          <Loading />
        ) : (
          <>
            <ul>
              {paths.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            <ReviewPagination page={page} total={total} onChange={setPage} />
          </>
        ))}
    </details>
  );
}
function ReviewFiles({
  serverId,
  id,
  digest,
  counts,
  size,
}: {
  serverId: string;
  id: string;
  digest: string;
  counts?: MinecraftModpackOperation['reviewCounts'];
  size: string;
}) {
  const t = useT();
  const [open, setOpen] = useState<(typeof fileGroups)[number]>();
  const [page, setPage] = useState(0);
  const group = open ?? 'added';
  const queryKey = ['modpack-review-files', serverId, id, digest] as const;
  const summary = useQuery({
    queryKey: [...queryKey, 'added', 0],
    enabled: !counts,
    queryFn: ({ signal }) => reviewController.reviewFiles(serverId, id, digest, 'added', 0, signal),
    staleTime: Infinity,
  });
  const totals = counts ?? summary.data?.counts;
  const details = useQuery({
    queryKey: [...queryKey, group, page],
    queryFn: ({ signal }) =>
      reviewController.reviewFiles(serverId, id, digest, group, page * 100, signal),
    enabled: Boolean(open),
    staleTime: Infinity,
  });
  return (
    <section className="modpacks-file-review" aria-label={t(k('changes'))}>
      <h4>{t(k('changes'))}</h4>
      {!counts && summary.isError ? (
        <ErrorNotice error={summary.error} retry={() => void summary.refetch()} />
      ) : !totals ? (
        <Loading />
      ) : (
        fileGroups.map((item) => (
          <div key={item}>
            <button
              className="secondary modpacks-file-group"
              type="button"
              aria-expanded={open === item}
              disabled={!totals[item]}
              onClick={() => {
                setPage(0);
                setOpen(open === item ? undefined : item);
              }}
            >
              <span>{t(k(`files.${item}`))}</span>
              <strong>{totals[item]}</strong>
              <ModsIcon name="chevron" />
            </button>
            {open === item &&
              (details.isError ? (
                <ErrorNotice error={details.error} retry={() => void details.refetch()} />
              ) : !details.data ? (
                <Loading />
              ) : (
                <>
                  <ul>
                    {details.data.paths.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                  <ReviewPagination
                    page={page}
                    total={details.data.counts[item]}
                    onChange={setPage}
                  />
                </>
              ))}
          </div>
        ))
      )}
      <small>
        {t(k('downloadSize'))} · {size}
      </small>
    </section>
  );
}

function ReviewPagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const t = useT();
  const pages = Math.ceil(total / 100);
  if (pages < 2) return null;
  return (
    <Pagination
      label={t('web.pagination')}
      previousLabel={t(k('previous'))}
      nextLabel={t(k('next'))}
      summary={t(k('page'), { page: page + 1, pages: Math.max(1, Math.ceil(total / 100)) })}
      canPrevious={page > 0}
      canNext={page + 1 < Math.ceil(total / 100)}
      onPrevious={() => onChange(page - 1)}
      onNext={() => onChange(page + 1)}
    />
  );
}
