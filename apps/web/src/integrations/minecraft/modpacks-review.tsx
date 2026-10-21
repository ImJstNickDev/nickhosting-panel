import { useEffect, useRef, useState } from 'react';
import type {
  MinecraftModpackOperation,
  MinecraftModpacksSnapshot,
} from '../../../../../games/minecraft/src/ui/modpacks-controller.js';
import { useFormat, useT } from '../../app/i18n.js';
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
    <button
      type="button"
      className="modpacks-choice"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
      <span className="modpacks-switch" aria-hidden="true">
        <i />
      </span>
    </button>
  );
}
export function ModpackReview(props: {
  operation: MinecraftModpackOperation;
  installed?: MinecraftModpacksSnapshot['installed'];
  canManage: boolean;
  busy: boolean;
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
  const [backup, setBackup] = useState(true);
  const [blockerPage, setBlockerPage] = useState(0);
  const [deletePage, setDeletePage] = useState(0);
  const blockerOffset =
    Math.min(blockerPage, Math.max(0, Math.ceil(operation.blockers.length / 100) - 1)) * 100;
  const deleteOffset =
    Math.min(deletePage, Math.max(0, Math.ceil(operation.deletePaths.length / 100) - 1)) * 100;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const locked =
    props.busy ||
    !props.canManage ||
    ['apply_queued', 'applying', 'uncertain'].includes(operation.state);
  const ready =
    operation.state === 'ready' &&
    operation.runtimeSupported &&
    operation.blockers.length === 0 &&
    Boolean(operation.planDigest);
  const pack = operation.pack;
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
          disabled={locked}
          onClick={props.onDiscard}
        />
      </header>
      <div className="modpacks-review-body">
        <div className="modpacks-review-main">
          <div className="modpacks-pack-heading">
            <ModsArtwork
              image={pack?.project.imageUrl}
              name={pack?.project.name ?? operation.selection.projectId}
            />
            <div>
              <span className="modpacks-provider">
                {modpackProviders[operation.selection.provider]}
              </span>
              <h3 ref={heading} tabIndex={-1}>
                {pack?.project.name ?? operation.selection.projectId}
              </h3>
              <p>{pack?.version.version ?? operation.selection.versionId}</p>
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
          {operation.changes && (
            <section className="modpacks-change-summary" aria-label={t(k('changes'))}>
              <span>
                <strong>{format.number(operation.changes.write, 0)}</strong>
                {t(k('updated'))}
              </span>
              <span>
                <strong>{format.number(operation.changes.remove, 0)}</strong>
                {t(k('removed'))}
              </span>
              <span>
                <strong>{format.number(operation.changes.preserve, 0)}</strong>
                {t(k('retained'))}
              </span>
              <span>
                <strong>{format.bytes(operation.changes.bytes)}</strong>
                {t(k('downloadSize'))}
              </span>
            </section>
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
                              disabled={locked}
                              onClick={() =>
                                props.onFileDecision?.(blocker.path ?? '', 'keep-local')
                              }
                            >
                              {t(k('keepLocal'))}
                            </button>
                            <button
                              type="button"
                              disabled={locked}
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
              <button type="button" disabled={locked} onClick={props.onRetry}>
                {t(k('retry'))}
              </button>
            </div>
          )}
          {operation.state === 'uncertain' && (
            <div className="modpacks-recovery">
              <p>{t(k('uncertain'))}</p>
              <button
                type="button"
                disabled={props.busy || !props.canManage}
                onClick={props.onRecover}
              >
                {t(k('recover'))}
              </button>
            </div>
          )}
          {operation.deletePaths.length > 0 && (
            <details className="modpacks-removals">
              <summary>{t(k('removedPaths'), { count: operation.deletePaths.length })}</summary>
              <ul>
                {operation.deletePaths.slice(deleteOffset, deleteOffset + 100).map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
              <ReviewPagination
                page={deleteOffset / 100}
                total={operation.deletePaths.length}
                onChange={setDeletePage}
              />
            </details>
          )}
        </div>
        <aside className="modpacks-review-options" aria-label={t(k('reviewChoices'))}>
          <h4>{t(k(operation.selection.mode))}</h4>
          {operation.selection.mode === 'replace' && (
            <p className="modpacks-replace-warning">{t(k('replaceWarning'))}</p>
          )}
          {operation.selection.mode === 'replace' ? (
            <Choice
              title={t(k('preserveWorlds'))}
              hint={t(k('preserveWorldsHint'))}
              checked={operation.selection.worldPolicy === 'preserve'}
              disabled={locked}
              onChange={(value) => props.onWorldPolicy(value ? 'preserve' : 'reset')}
            />
          ) : (
            <p className="modpacks-preserved">
              <ModsIcon name="check" />
              {t(k('worldsPreserved'))}
            </p>
          )}
          {operation.selection.mode === 'replace' &&
            operation.selection.worldPolicy === 'reset' && (
              <p className="modpacks-reset-warning">
                <ModsIcon name="warning" />
                {t(k('worldsReset'))}
              </p>
            )}
          <Choice
            title={t(k('backup'))}
            hint={t(k('backupHint'))}
            checked={backup}
            disabled={locked}
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
            disabled={!ready || locked}
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
    <div className="mods-pagination">
      <ModsAction
        icon="back"
        label={t(k('previous'))}
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      />
      <span>{t(k('page'), { page: page + 1, pages })}</span>
      <ModsAction
        icon="next"
        label={t(k('next'))}
        disabled={page + 1 >= pages}
        onClick={() => onChange(page + 1)}
      />
    </div>
  );
}
