import { createMinecraftUiController, type MinecraftWorlds } from '@nickhosting/minecraft/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, download, idempotencyKey } from '../../api/client.js';
import { hashFile } from '../../api/hash.js';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { Check, ConfirmDialog, Dialog, ErrorNotice, Input } from '../../components/ui.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { gameUiClient } from '../../features/integrations.js';
import './worlds.css';

const controller = createMinecraftUiController(gameUiClient);
const key = (name: string) => `games.minecraft.worlds.${name}`;
type Selection = { action: 'select' | 'delete' | 'replace'; name: string; requestKey: string };
type Intent = { requestKey: string; command: Record<string, unknown> };
type Progress = { phase: 'hashing' | 'uploading' | 'checking'; sent: number; total: number };

function Icon({
  name,
}: {
  name: 'search' | 'refresh' | 'upload' | 'world' | 'select' | 'download' | 'delete';
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
      {name === 'search' && (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" />
        </>
      )}
      {name === 'refresh' && (
        <>
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
        </>
      )}
      {name === 'upload' && <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />}
      {name === 'world' && (
        <>
          <path d="m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9" />
          <path d="m7.5 5.5 9 5" />
        </>
      )}
      {name === 'select' && <path d="m5 12 4 4L19 6" />}
      {name === 'download' && <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />}
      {name === 'delete' && <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />}
    </svg>
  );
}

export function MinecraftWorldsSection(props: GameSectionViewProps) {
  const t = useT();
  const id = useId();
  const snapshot = props.data.metadata?.worlds as MinecraftWorlds | undefined;
  const supported = Boolean(snapshot?.installed && snapshot.supported);
  const offline = ['offline', 'stopped'].includes(props.runtimeState);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [fileName, setFileName] = useState('');
  const [target, setTarget] = useState('');
  const [archiveRef, setArchiveRef] = useState<string>();
  const [uploadError, setUploadError] = useState<unknown>();
  const [operationError, setOperationError] = useState<unknown>();
  const [progress, setProgress] = useState<Progress>();
  const [selection, setSelection] = useState<Selection>();
  const [backup, setBackup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<Intent>();
  const [dragging, setDragging] = useState(false);
  const transfer = useRef<AbortController | undefined>(undefined);
  const mutationLock = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const importKey = useRef(idempotencyKey());
  const disabled =
    !props.canManage ||
    !supported ||
    snapshot?.compatibility !== 'available' ||
    !offline ||
    props.pending ||
    busy ||
    Boolean(uncertain);
  const importDisabled = disabled || snapshot?.compatibility !== 'available';
  const rows = snapshot?.worlds ?? [];
  const visible = rows.filter((row) =>
    row.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const lastPage = Math.max(0, Math.ceil(visible.length / 50) - 1);
  const currentPage = Math.min(page, lastPage);
  const pageRows = visible.slice(currentPage * 50, currentPage * 50 + 50);
  const targetValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target);
  const existing = rows.some((row) => row.name === target);
  const caseCollision = rows.find(
    (row) => row.name !== target && row.name.toLowerCase() === target.toLowerCase(),
  );
  const currentState = useRef({ importDisabled });
  currentState.current = { importDisabled };

  useEffect(() => () => transfer.current?.abort(), []);
  useEffect(() => {
    if (
      !offline ||
      !props.canManage ||
      props.pending ||
      !supported ||
      snapshot?.compatibility !== 'available'
    ) {
      transfer.current?.abort();
      if (!mutationLock.current) setSelection(undefined);
    }
  }, [offline, props.canManage, props.pending, supported, snapshot?.compatibility]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await props.reload();
    } catch {
      // The shared section boundary presents refresh failures and keeps this draft mounted.
    } finally {
      setRefreshing(false);
    }
  }
  function openImport() {
    if (importDisabled || transfer.current) return;
    setAdding(true);
    setFileName('');
    setTarget('');
    setArchiveRef(undefined);
    setUploadError(undefined);
    setOperationError(undefined);
    importKey.current = idempotencyKey();
  }
  function closeImport() {
    if (mutationLock.current) return;
    transfer.current?.abort();
    setAdding(false);
    setDragging(false);
  }
  async function upload(files: FileList | null) {
    if (importDisabled || transfer.current || !files) return;
    if (
      files.length !== 1 ||
      !files[0]?.name.toLowerCase().endsWith('.zip') ||
      files[0].size === 0
    ) {
      setUploadError(new ApiError('validation_failed', key('invalidZip')));
      return;
    }
    const file = files[0];
    const abort = new AbortController();
    transfer.current = abort;
    setArchiveRef(undefined);
    setUploadError(undefined);
    setOperationError(undefined);
    setFileName(file.name);
    const base =
      file.name
        .replace(/\.zip$/i, '')
        .normalize('NFKD')
        .replace(/[^A-Za-z0-9_-]/g, '-')
        .replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, 56) || 'world';
    let suggested = base;
    for (
      let suffix = 2;
      rows.some((row) => row.name.toLowerCase() === suggested.toLowerCase());
      suffix++
    )
      suggested = `${base}-${suffix}`;
    setTarget(suggested);
    importKey.current = idempotencyKey();
    try {
      setProgress({ phase: 'hashing', sent: 0, total: file.size });
      const sha256 = await hashFile(file, {
        signal: abort.signal,
        onProgress: (sent) => setProgress({ phase: 'hashing', sent, total: file.size }),
      });
      setProgress({ phase: 'uploading', sent: 0, total: file.size });
      const result = await controller.uploadSource({
        kind: 'world',
        serverId: props.serverId,
        file,
        sha256,
        idempotencyKey: idempotencyKey(),
        signal: abort.signal,
        onProgress: (sent, total) =>
          setProgress({ phase: sent >= total ? 'checking' : 'uploading', sent, total }),
      });
      if (!abort.signal.aborted && !currentState.current.importDisabled) setArchiveRef(result.id);
    } catch (error) {
      setUploadError(
        error instanceof DOMException && error.name === 'AbortError'
          ? new ApiError('cancelled', key('cancelled'))
          : error,
      );
    } finally {
      setProgress(undefined);
      transfer.current = undefined;
      if (picker.current) picker.current.value = '';
    }
  }
  async function submit(intent: Intent, recovery = false) {
    if (
      mutationLock.current ||
      !offline ||
      !props.canManage ||
      !supported ||
      props.pending ||
      (!recovery && uncertain)
    )
      return;
    mutationLock.current = true;
    setBusy(true);
    setOperationError(undefined);
    try {
      const result = await controller.operate(props.serverId, intent.requestKey, intent.command);
      props.onAccepted(result.jobId);
      setUncertain(undefined);
      setSelection(undefined);
      setAdding(false);
      setArchiveRef(undefined);
    } catch (error) {
      setOperationError(error);
      if (
        !(error instanceof ApiError) ||
        error.status === 0 ||
        error.status >= 500 ||
        error.code === 'operation_uncertain'
      ) {
        setUncertain(intent);
        setSelection(undefined);
        setAdding(false);
      } else if (recovery) {
        // An earlier request may still exist: a later rejection is not proof it never ran.
        setUncertain(intent);
      }
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function importWorld() {
    if (importDisabled || !archiveRef || !targetValid || caseCollision || transfer.current) return;
    if (existing) {
      setBackup(true);
      setSelection({ action: 'replace', name: target, requestKey: idempotencyKey() });
      return;
    }
    await submit({
      requestKey: importKey.current,
      command: { kind: 'world-import', archiveRef, targetWorld: target },
    });
  }
  function choose(action: 'select' | 'delete', name: string) {
    if (disabled || transfer.current) return;
    setOperationError(undefined);
    setBackup(true);
    setSelection({ action, name, requestKey: idempotencyKey() });
  }
  async function confirm() {
    if (!selection || disabled) return;
    if (selection.action === 'select') {
      if (
        snapshot?.compatibility !== 'available' ||
        !rows.some((row) => row.name === selection.name && row.status === 'verified')
      )
        return;
      await submit({
        requestKey: selection.requestKey,
        command: { kind: 'world-select', world: selection.name },
      });
    } else if (selection.action === 'delete') {
      if (
        !snapshot?.selectedWorld ||
        selection.name === snapshot.selectedWorld ||
        !rows.some((row) => row.name === selection.name && row.status === 'verified')
      )
        return;
      await submit({
        requestKey: selection.requestKey,
        command: {
          kind: 'world-remove',
          world: selection.name,
          confirm: true,
          backupBefore: backup,
        },
      });
    } else {
      if (importDisabled || !archiveRef || target !== selection.name || !existing) return;
      await submit({
        requestKey: selection.requestKey,
        command: {
          kind: 'world-import',
          archiveRef,
          targetWorld: selection.name,
          replace: {
            wipeConsent: true,
            expectedDeletePaths: [selection.name],
            backupBefore: backup,
          },
        },
      });
    }
  }

  return (
    <div className="minecraft-worlds">
      <div className="minecraft-worlds-toolbar">
        <div className="minecraft-worlds-search">
          <Icon name="search" />
          <input
            aria-label={t(key('search'))}
            placeholder={t(key('search'))}
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="minecraft-worlds-controls">
          <Tooltip content={t(key('refresh'))}>
            <button
              type="button"
              className="minecraft-world-action"
              aria-label={t(key('refresh'))}
              disabled={refreshing || busy || Boolean(progress)}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" />
            </button>
          </Tooltip>
          {props.canManage && (
            <button
              type="button"
              className="minecraft-worlds-import"
              disabled={importDisabled || Boolean(progress)}
              onClick={openImport}
            >
              <Icon name="upload" />
              {t(key('import'))}
            </button>
          )}
        </div>
      </div>
      {Boolean(operationError) && !adding && !selection && <ErrorNotice error={operationError} />}
      {!snapshot ? (
        <p className="minecraft-worlds-status" role="status">
          {t(key('unavailable'))}
        </p>
      ) : !snapshot.installed ? (
        <p className="minecraft-worlds-status">{t(key('notInstalled'))}</p>
      ) : !snapshot.supported ? (
        <p className="minecraft-worlds-status">{t(key('unsupported'))}</p>
      ) : (
        <>
          {!offline && (
            <p className="minecraft-worlds-status" role="status">
              {t(key(props.runtimeState === 'running' ? 'stopFirst' : 'stateUnknown'))}
            </p>
          )}
          {!props.canManage && <p className="minecraft-worlds-status">{t(key('readOnly'))}</p>}
          {snapshot.compatibility === 'unavailable' && (
            <p className="minecraft-worlds-status" role="status">
              {t(key('compatibilityUnavailable'))}
            </p>
          )}
          {snapshot.selectedWorld && !rows.some((row) => row.name === snapshot.selectedWorld) && (
            <p className="minecraft-worlds-status">
              {t(key('configured'), { name: snapshot.selectedWorld })}
            </p>
          )}
          {snapshot.selectedWorld === null && (
            <p className="minecraft-worlds-status">{t(key('selectionUnknown'))}</p>
          )}
          {uncertain && (
            <div className="notice" role="status">
              <p>{t(key('uncertain'))}</p>
              <button
                type="button"
                className="secondary"
                disabled={busy || !offline || !props.canManage || props.pending}
                onClick={() => void submit(uncertain, true)}
              >
                {t(key('recover'))}
              </button>
            </div>
          )}
          {refreshing && (
            <p className="minecraft-worlds-status" role="status">
              {t(key('refreshing'))}
            </p>
          )}
          {pageRows.length ? (
            <ul className="minecraft-worlds-list">
              {pageRows.map((world) => {
                const selected = world.name === snapshot.selectedWorld;
                const actionName = (action: string) =>
                  t(key('actionFor'), { action: t(key(action)), name: world.name });
                return (
                  <li className="minecraft-world" key={world.name}>
                    <span className="minecraft-world-icon">
                      <Icon name="world" />
                    </span>
                    <div className="minecraft-world-identity">
                      <strong>{world.name}</strong>
                      <div className="minecraft-world-details">
                        {selected && (
                          <span className="minecraft-world-selected">{t(key('selected'))}</span>
                        )}
                        <span
                          className={`minecraft-world-compatibility minecraft-world-compatibility--${world.status}`}
                        >
                          {t(key(`status.${world.status}`))}
                        </span>
                        {world.validation?.versionName && (
                          <span>{world.validation.versionName}</span>
                        )}
                      </div>
                    </div>
                    <div className="minecraft-world-actions">
                      {props.canManage && !selected && (
                        <Tooltip
                          content={
                            world.status !== 'verified'
                              ? t(key('cannotChange'))
                              : actionName('select')
                          }
                        >
                          <button
                            type="button"
                            className="minecraft-world-action"
                            aria-label={actionName('select')}
                            disabled={
                              disabled ||
                              world.status !== 'verified' ||
                              snapshot.compatibility !== 'available'
                            }
                            onClick={() => choose('select', world.name)}
                          >
                            <Icon name="select" />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip content={actionName('download')}>
                        <button
                          type="button"
                          className="minecraft-world-action"
                          aria-label={actionName('download')}
                          disabled={!offline || props.pending || busy || Boolean(uncertain)}
                          onClick={() => {
                            try {
                              download(`/v1/servers/${props.serverId}/files/archive`, {
                                root: '',
                                files: JSON.stringify([world.name]),
                              });
                            } catch (error) {
                              setOperationError(error);
                            }
                          }}
                        >
                          <Icon name="download" />
                        </button>
                      </Tooltip>
                      {props.canManage && (
                        <Tooltip
                          content={
                            selected
                              ? t(key('selectedCannotDelete'))
                              : world.status !== 'verified'
                                ? t(key('cannotChange'))
                                : actionName('delete')
                          }
                        >
                          <button
                            type="button"
                            className="minecraft-world-action minecraft-world-action--danger"
                            aria-label={actionName('delete')}
                            disabled={
                              disabled ||
                              selected ||
                              world.status !== 'verified' ||
                              snapshot.selectedWorld === null
                            }
                            onClick={() => choose('delete', world.name)}
                          >
                            <Icon name="delete" />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="minecraft-worlds-empty" role="status">
              <Icon name="world" />
              <p>{t(key(search.trim() ? 'noMatches' : 'empty'))}</p>
            </div>
          )}
          {visible.length > 50 && (
            <nav className="minecraft-worlds-pagination" aria-label={t(key('pagination'))}>
              <button
                type="button"
                className="secondary"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                {t(key('previous'))}
              </button>
              <span>
                {t(key('page'), { page: String(currentPage + 1), total: String(lastPage + 1) })}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={currentPage === lastPage}
                onClick={() => setPage(currentPage + 1)}
              >
                {t(key('next'))}
              </button>
            </nav>
          )}
        </>
      )}
      <Dialog
        open={adding && selection?.action !== 'replace'}
        title={t(key('import'))}
        onClose={() => {
          if (selection?.action !== 'replace') closeImport();
        }}
        closeIcon
        closeDisabled={busy}
        className="minecraft-worlds-import-dialog"
        initialFocusSelector="[data-world-picker]"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void importWorld();
          }}
        >
          {!offline && (
            <p className="minecraft-worlds-status" role="status">
              {t(key('stopFirst'))}
            </p>
          )}
          {Boolean(uploadError) && <ErrorNotice error={uploadError} />}
          {Boolean(operationError) && <ErrorNotice error={operationError} />}
          <fieldset
            aria-label={t(key('zip'))}
            className={`minecraft-worlds-dropzone${dragging ? ' dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              if (!importDisabled && !progress) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void upload(event.dataTransfer.files);
            }}
          >
            <Icon name="upload" />
            <button
              type="button"
              data-world-picker
              className="secondary"
              disabled={importDisabled || Boolean(progress)}
              onClick={() => picker.current?.click()}
            >
              {t(key(fileName ? 'changeZip' : 'chooseZip'))}
            </button>
            <input
              ref={picker}
              type="file"
              accept=".zip,application/zip"
              aria-label={t(key('zip'))}
              hidden
              onChange={(event) => void upload(event.target.files)}
            />
            <span>{fileName || t(key('dropZip'))}</span>
          </fieldset>
          {progress && (
            <div className="minecraft-worlds-progress">
              <label htmlFor={`${id}-progress`}>{t(key(progress.phase))}</label>
              <progress
                id={`${id}-progress`}
                max={progress.total}
                value={progress.phase === 'checking' ? undefined : progress.sent}
              />
              <button type="button" className="secondary" onClick={() => transfer.current?.abort()}>
                {t(key('cancelUpload'))}
              </button>
            </div>
          )}
          {archiveRef && (
            <p className="minecraft-worlds-status" role="status">
              {t(key('uploaded'))}
            </p>
          )}
          <Input
            label={t(key('folder'))}
            hint={t(key('folderHint'))}
            value={target}
            maxLength={64}
            pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
            required
            disabled={busy || importDisabled}
            onChange={(event) => {
              setTarget(event.target.value);
              importKey.current = idempotencyKey();
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {caseCollision && (
            <p className="minecraft-worlds-replacement" role="status">
              {t(key('caseCollision'), { name: caseCollision.name })}
            </p>
          )}
          {existing && (
            <p className="minecraft-worlds-replacement" role="status">
              {t(key('existing'), { name: target })}
            </p>
          )}
          <div className="actions minecraft-worlds-dialog-actions">
            <button type="button" className="secondary" disabled={busy} onClick={closeImport}>
              {t('web.cancel')}
            </button>
            <button
              type="submit"
              disabled={
                importDisabled ||
                !archiveRef ||
                !targetValid ||
                Boolean(caseCollision) ||
                Boolean(progress)
              }
            >
              {t(key(existing ? 'reviewReplacement' : 'import'))}
            </button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={Boolean(selection)}
        title={selection ? t(key(selection.action)) : ''}
        confirmLabel={selection ? t(key(selection.action)) : undefined}
        destructive={selection?.action !== 'select'}
        busy={disabled}
        onClose={() => {
          if (!mutationLock.current) {
            setSelection(undefined);
            setOperationError(undefined);
          }
        }}
        onConfirm={confirm}
      >
        {selection && (
          <>
            <p>
              {t(key(`confirm.${selection.action}`), {
                name: selection.name,
                server: props.serverName,
              })}
            </p>
            {selection.action === 'select' ? (
              <p className="muted">{t(key('nextStart'))}</p>
            ) : (
              <Check
                label={t(key('backup'))}
                checked={backup}
                disabled={busy}
                onChange={(event) => {
                  setBackup(event.target.checked);
                  setSelection({ ...selection, requestKey: idempotencyKey() });
                }}
              />
            )}
            {Boolean(operationError) && <ErrorNotice error={operationError} />}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
