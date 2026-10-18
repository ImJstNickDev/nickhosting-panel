import { createMinecraftUiController, type MinecraftWorlds } from '@nickhosting/minecraft/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, download, idempotencyKey } from '../../api/client.js';
import { hashFile } from '../../api/hash.js';
import { useFormat, useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { Check, ConfirmDialog, Dialog, ErrorNotice, Input } from '../../components/ui.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { gameUiClient } from '../../features/integrations.js';
import { MinecraftWorldCatalog, type SelectedCatalogWorld } from './world-catalog.js';
import { prepareMinecraftWorldFolder, WorldFolderArchiveError } from './world-folder-archive.js';
import './worlds.css';

const controller = createMinecraftUiController(gameUiClient);
const key = (name: string) => `games.minecraft.worlds.${name}`;
type Selection = { action: 'select' | 'delete' | 'replace'; name: string; requestKey: string };
type Intent = { requestKey: string; command: Record<string, unknown> };
type Progress = {
  phase: 'preparing' | 'hashing' | 'uploading' | 'checking';
  sent: number;
  total: number;
};

function configuredWorldRoots(value: string | null | undefined): string[] | undefined {
  if (!value || value.startsWith('/') || value.startsWith('\\')) return undefined;
  const parts: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part.toLowerCase());
  }
  const root = parts[0];
  if (!root) return undefined;
  // The list shows root directories; protect the ancestor of a nested world too.
  return parts.length === 1 ? [root, `${root}_nether`, `${root}_the_end`] : [root];
}

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
  const format = useFormat();
  const id = useId();
  const snapshot = props.data.metadata?.worlds as MinecraftWorlds | undefined;
  const supported = Boolean(snapshot?.installed && snapshot.supported);
  const offline = ['offline', 'stopped'].includes(props.runtimeState);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogSource, setCatalogSource] = useState<SelectedCatalogWorld>();
  const [importing, setImporting] = useState(false);
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
  const folderPicker = useRef<HTMLInputElement>(null);
  const importKey = useRef(idempotencyKey());
  const mutationsDisabled =
    !props.canManage || !supported || props.pending || busy || Boolean(uncertain);
  const disabled = mutationsDisabled || !offline;
  const importStateAllowed =
    offline || (props.runtimeState === 'running' && snapshot?.selectedWorld != null);
  const importDisabled = mutationsDisabled || !importStateAllowed;
  const removeDisabled = mutationsDisabled || !importStateAllowed;
  const activeRoots = configuredWorldRoots(snapshot?.selectedWorld);
  const activeWorld = (name: string) => !activeRoots || activeRoots.includes(name.toLowerCase());
  const rows = snapshot?.worlds ?? [];
  const visible = rows.filter((row) =>
    row.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const lastPage = Math.max(0, Math.ceil(visible.length / 50) - 1);
  const currentPage = Math.min(page, lastPage);
  const pageRows = visible.slice(currentPage * 50, currentPage * 50 + 50);
  const targetValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target);
  const existing = rows.some((row) => row.name === target);
  const liveCollision =
    !offline &&
    (rows.some((row) => row.name.toLowerCase() === target.toLowerCase()) ||
      snapshot?.selectedWorld?.toLowerCase() === target.toLowerCase());
  const caseCollision = rows.find(
    (row) => row.name !== target && row.name.toLowerCase() === target.toLowerCase(),
  );
  const currentState = useRef({ importDisabled });
  currentState.current = { importDisabled };
  const importInProgress =
    props.pending &&
    (!props.operation || ['queued', 'running'].includes(props.operation.state)) &&
    props.operation?.effectState !== 'uncertain' &&
    (importing || props.fileTransfer);

  useEffect(() => () => transfer.current?.abort(), []);
  useEffect(() => {
    if (!props.pending) setImporting(false);
  }, [props.pending]);
  useEffect(() => {
    if (!importStateAllowed || !props.canManage || props.pending || !supported) {
      transfer.current?.abort();
      if (!mutationLock.current) setSelection(undefined);
    }
  }, [importStateAllowed, props.canManage, props.pending, supported]);
  useEffect(() => {
    if (!offline && !mutationLock.current) {
      setSelection((current) => (current?.action === 'delete' ? current : undefined));
      setBackup(false);
    }
  }, [offline]);

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
  function suggestTarget(name: string) {
    const base =
      name
        .replace(/\.zip$/i, '')
        .normalize('NFKD')
        .replace(/[^A-Za-z0-9_-]/g, '-')
        .replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, 56) || 'world';
    let suggested = base;
    for (
      let suffix = 2;
      rows.some((row) => row.name.toLowerCase() === suggested.toLowerCase()) ||
      snapshot?.selectedWorld?.toLowerCase() === suggested.toLowerCase();
      suffix++
    )
      suggested = `${base}-${suffix}`;
    return suggested;
  }
  function chooseCatalogWorld(world: SelectedCatalogWorld) {
    if (importDisabled) return;
    openImport();
    setCatalogSource(world);
    setFileName(world.filename);
    setTarget(suggestTarget(world.projectName));
    setArchiveRef(world.sourceId);
    setCatalogOpen(false);
  }
  function openImport() {
    if (importDisabled || transfer.current) return;
    setAdding(true);
    setCatalogSource(undefined);
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
  async function upload(files: FileList | null, folder = false) {
    if (importDisabled || transfer.current || !files?.length) return;
    const selectedFiles = Array.from(files);
    const firstFile = selectedFiles[0];
    if (!firstFile) return;
    if (
      !folder &&
      (selectedFiles.length !== 1 ||
        !selectedFiles[0]?.name.toLowerCase().endsWith('.zip') ||
        selectedFiles[0].size === 0)
    ) {
      setUploadError(new ApiError('validation_failed', key('invalidZip')));
      return;
    }
    const selectedName = folder
      ? selectedFiles[0]?.webkitRelativePath.split('/')[0] || selectedFiles[0]?.name || ''
      : selectedFiles[0]?.name || '';
    const abort = new AbortController();
    transfer.current = abort;
    setArchiveRef(undefined);
    setUploadError(undefined);
    setOperationError(undefined);
    setFileName(selectedName);
    setTarget(suggestTarget(selectedName));
    importKey.current = idempotencyKey();
    try {
      let file: File;
      if (folder) {
        setProgress({
          phase: 'preparing',
          sent: 0,
          total: selectedFiles.reduce((sum, item) => sum + item.size, 0),
        });
        file = await prepareMinecraftWorldFolder(selectedFiles, {
          signal: abort.signal,
          onProgress: ({ processedBytes, totalBytes }) =>
            setProgress({ phase: 'preparing', sent: processedBytes, total: totalBytes }),
        });
      } else file = firstFile;
      abort.signal.throwIfAborted();
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
          : error instanceof WorldFolderArchiveError
            ? new ApiError(
                'validation_failed',
                key(
                  error.code === 'limit_exceeded'
                    ? 'folderLimit'
                    : error.code === 'invalid_folder'
                      ? 'invalidFolder'
                      : 'folderFailed',
                ),
              )
            : error,
      );
    } finally {
      setProgress(undefined);
      transfer.current = undefined;
      if (picker.current) picker.current.value = '';
      if (folderPicker.current) folderPicker.current.value = '';
    }
  }
  function allowsState(intent: Intent) {
    if (intent.command.kind === 'world-remove')
      return (
        importStateAllowed &&
        typeof intent.command.world === 'string' &&
        !activeWorld(intent.command.world)
      );
    return intent.command.kind === 'world-import' && !intent.command.replace
      ? importStateAllowed
      : offline;
  }
  async function submit(intent: Intent, recovery = false) {
    if (
      mutationLock.current ||
      !allowsState(intent) ||
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
      const removedWorld =
        intent.command.kind === 'world-remove' && typeof intent.command.world === 'string'
          ? intent.command.world
          : undefined;
      props.onAccepted(
        result.jobId,
        removedWorld
          ? {
              quickCompletion: true,
              confirmedUpdate: (current) => {
                const worlds = current.metadata?.worlds as MinecraftWorlds | undefined;
                if (!worlds) return current;
                return {
                  ...current,
                  metadata: {
                    ...current.metadata,
                    worlds: {
                      ...worlds,
                      worlds: worlds.worlds.filter((world) => world.name !== removedWorld),
                    },
                  },
                };
              },
            }
          : undefined,
      );
      setImporting(intent.command.kind === 'world-import');
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
    if (
      importDisabled ||
      !archiveRef ||
      !targetValid ||
      caseCollision ||
      liveCollision ||
      transfer.current
    )
      return;
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
    if ((action === 'delete' ? removeDisabled || activeWorld(name) : disabled) || transfer.current)
      return;
    setOperationError(undefined);
    setBackup(action !== 'delete' && offline);
    setSelection({ action, name, requestKey: idempotencyKey() });
  }
  async function confirm() {
    if (!selection || (selection.action === 'delete' ? removeDisabled : disabled)) return;
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
        activeWorld(selection.name) ||
        !rows.some((row) => row.name === selection.name && row.validation)
      )
        return;
      await submit({
        requestKey: selection.requestKey,
        command: {
          kind: 'world-remove',
          world: selection.name,
          confirm: true,
          backupBefore: offline && backup,
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
              className="secondary minecraft-worlds-import"
              disabled={importDisabled || Boolean(progress)}
              onClick={() => setCatalogOpen(true)}
            >
              <Icon name="search" />
              {t(key('catalog.browse'))}
            </button>
          )}
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
      {importInProgress && (
        <div className="minecraft-worlds-transfer" role="status" aria-live="polite">
          <div>
            <span>{t(key('importing'))}</span>
            {props.fileTransfer && props.fileTransfer.totalFiles > 0 && (
              <span className="minecraft-worlds-transfer-count">
                {t(key('transferredFiles'), {
                  completed: format.number(props.fileTransfer.completedFiles, 0),
                  total: format.number(props.fileTransfer.totalFiles, 0),
                })}
              </span>
            )}
          </div>
          <progress
            aria-label={t(key('importing'))}
            max={Math.max(1, props.fileTransfer?.totalFiles ?? 0)}
            value={
              props.fileTransfer && props.fileTransfer.totalFiles > 0
                ? props.fileTransfer.completedFiles
                : undefined
            }
          />
        </div>
      )}
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
                disabled={busy || !allowsState(uncertain) || !props.canManage || props.pending}
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
                        {world.validation && (
                          <span className="minecraft-world-version">
                            {world.validation.versionName ||
                              world.validation.detectedRelease ||
                              t(key('versionUnknown'))}
                          </span>
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
                            activeWorld(world.name)
                              ? t(key('selectedCannotDelete'))
                              : !world.validation
                                ? t(key('cannotDelete'))
                                : actionName('delete')
                          }
                        >
                          <button
                            type="button"
                            className="minecraft-world-action minecraft-world-action--danger"
                            aria-label={actionName('delete')}
                            disabled={
                              removeDisabled ||
                              activeWorld(world.name) ||
                              !world.validation ||
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
      {catalogOpen && (
        <MinecraftWorldCatalog
          serverId={props.serverId}
          release={snapshot?.release}
          disabled={importDisabled}
          onClose={() => setCatalogOpen(false)}
          onChoose={chooseCatalogWorld}
        />
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
        initialFocusSelector={catalogSource ? '[data-world-target]' : '[data-world-picker]'}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void importWorld();
          }}
        >
          {Boolean(uploadError) && <ErrorNotice error={uploadError} />}
          {Boolean(operationError) && <ErrorNotice error={operationError} />}
          {catalogSource ? (
            <div className="minecraft-worlds-catalog-source">
              <strong>{catalogSource.projectName}</strong>
              <span>{catalogSource.filename}</span>
              {snapshot?.release &&
                catalogSource.gameVersions.length > 0 &&
                !catalogSource.gameVersions.includes(snapshot.release) && (
                  <p className="minecraft-worlds-replacement">
                    {t(key('catalog.otherVersion'), {
                      versions: catalogSource.gameVersions.join(', '),
                      current: snapshot.release,
                    })}
                  </p>
                )}
            </div>
          ) : (
            <fieldset
              aria-label={t(key('source'))}
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
              <div className="actions minecraft-worlds-source-actions">
                <button
                  type="button"
                  data-world-picker
                  className="secondary"
                  disabled={importDisabled || Boolean(progress)}
                  onClick={() => picker.current?.click()}
                >
                  {t(key('chooseZip'))}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={importDisabled || Boolean(progress)}
                  onClick={() => folderPicker.current?.click()}
                >
                  {t(key('chooseFolder'))}
                </button>
              </div>
              <input
                ref={picker}
                type="file"
                accept=".zip,application/zip"
                aria-label={t(key('zip'))}
                hidden
                onChange={(event) => void upload(event.target.files)}
              />
              <input
                ref={folderPicker}
                type="file"
                {...{ webkitdirectory: '' }}
                multiple
                aria-label={t(key('worldFolder'))}
                hidden
                onChange={(event) => void upload(event.target.files, true)}
              />
              <span>{fileName || t(key('dropZip'))}</span>
            </fieldset>
          )}
          {progress && (
            <div className="minecraft-worlds-progress">
              <label htmlFor={`${id}-progress`}>{t(key(progress.phase))}</label>
              <progress
                id={`${id}-progress`}
                max={Math.max(1, progress.total)}
                value={progress.phase === 'checking' ? undefined : progress.sent}
              />
              <button type="button" className="secondary" onClick={() => transfer.current?.abort()}>
                {t(key('cancelUpload'))}
              </button>
            </div>
          )}
          {archiveRef && (
            <p className="minecraft-worlds-status" role="status">
              {t(key(catalogSource ? 'catalog.ready' : 'uploaded'))}
            </p>
          )}
          <Input
            label={t(key('folder'))}
            data-world-target
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
          {caseCollision && !liveCollision && (
            <p className="minecraft-worlds-replacement" role="status">
              {t(key('caseCollision'), { name: caseCollision.name })}
            </p>
          )}
          {liveCollision && (
            <p className="minecraft-worlds-replacement" role="status">
              {t(key('liveCollision'), { name: target })}
            </p>
          )}
          {existing && !liveCollision && (
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
                Boolean(liveCollision) ||
                Boolean(progress)
              }
            >
              {t(key(existing && !liveCollision ? 'reviewReplacement' : 'import'))}
            </button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={Boolean(selection)}
        title={selection ? t(key(selection.action)) : ''}
        confirmLabel={selection ? t(key(selection.action)) : undefined}
        destructive={selection?.action !== 'select'}
        busy={selection?.action === 'delete' ? removeDisabled : disabled}
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
                disabled={busy || !offline}
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
