import { useQuery } from '@tanstack/react-query';
import {
  type DragEvent,
  type KeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBlocker, useLocation } from 'react-router';
import { fileEditorAvailability } from '../../../../packages/core/src/file-content.js';
import { ApiError, api, apiError, download, queryClient, upload } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import { ActionForm, Dialog, Empty, ErrorNotice, Input, Time, text } from '../components/ui.js';
import {
  type FileOrder,
  fileBreadcrumbs,
  joinFilePath as join,
  normalizeFilePath,
  selectFileRange,
  validMoveTarget,
  visibleFiles,
} from './file-manager-model.js';
import type { FileEditorControls } from './file-text-editor.js';

const importEditor = () =>
  import('./file-text-editor.js').then((module) => ({ default: module.FileTextEditor }));
let editorModule: ReturnType<typeof importEditor> | undefined;
function loadEditor() {
  editorModule ??= importEditor().catch((error) => {
    editorModule = undefined;
    throw error;
  });
  return editorModule;
}
const FileTextEditor = lazy(loadEditor);

import {
  fileDirectoryQuery,
  type ServerFile,
  serverPath,
  useServer,
  useTransfers,
} from './service-contracts.js';
import './files.css';
import {
  discardFileSave,
  type FileSaveRecord,
  fileSaveScope,
  getFileSave,
  submitFileSave,
  updateFileSaveDraft,
  useFileSaveRecords,
} from './file-background-save.js';
import { FileIcon } from './file-icon.js';
import { FilePathPicker } from './file-path-picker.js';
import { FileSelectionSummary, useFileTransfer } from './file-transfer-flow.js';
import { nextUpload, planUploadBatch, runUploadPool } from './file-upload-queue.js';
import { FolderUploadError, planFolderUpload, prepareFolderUpload } from './folder-upload.js';
import { InlineFileRename } from './inline-file-rename.js';
import { validFilename } from './inline-file-rename-model.js';

type Mode = 'mkdir' | 'new' | 'edit' | 'rename' | 'delete' | 'extract';
type UploadItem = {
  id: number;
  file: File;
  directory: string;
  path: string;
  exclusive: boolean;
  sent: number;
  speed: number;
  status: 'queued' | 'waiting' | 'uploading' | 'confirming' | 'complete' | 'cancelled' | 'failed';
  error?: unknown;
};
const uploadBusyRetryDelays = [250, 500, 1000, 2000] as const;
function waitForUploadRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(finish, delay);
    function finish() {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}
const dragType = 'application/x-nickhosting-files';
const filePlaceholders = Array.from({ length: 12 }, (_, index) => ({
  id: `file-placeholder-${index}`,
  width: `${40 + (index % 4) * 12}%`,
}));

function FileListSkeleton({ view }: { view: 'list' | 'grid' }) {
  const t = useT();
  return (
    <>
      <div className={`fm-list fm-${view} fm-loading`} aria-busy="true">
        <div className="fm-columns" aria-hidden="true">
          <span className="fm-skeleton fm-skeleton-check" />
          <span className="fm-skeleton fm-skeleton-heading" />
          <span className="fm-skeleton fm-skeleton-heading" />
          <span className="fm-skeleton fm-skeleton-heading" />
        </div>
        <ul aria-hidden="true">
          {filePlaceholders.map(({ id, width }) => (
            <li className="fm-entry" key={id}>
              <span className="fm-skeleton fm-skeleton-check" />
              <span className="fm-filename">
                <span className="fm-skeleton fm-skeleton-icon" />
                <span className="fm-skeleton fm-skeleton-name" style={{ width }} />
              </span>
              <span className="fm-size">
                <span className="fm-skeleton" />
              </span>
              <span className="fm-date">
                <span className="fm-skeleton" />
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="fm-count" aria-hidden="true">
        <span className="fm-skeleton fm-skeleton-heading" />
      </div>
      <span className="sr-only" role="status">
        {t('web.loading')}
      </span>
    </>
  );
}

function FileEditorSkeleton() {
  const t = useT();
  return (
    <div className="fm-editor-skeleton" aria-busy="true">
      <div className="fm-editor-skeleton-lines" aria-hidden="true">
        {filePlaceholders.map(({ id, width }) => (
          <div key={id}>
            <span className="fm-skeleton fm-skeleton-check" />
            <span className="fm-skeleton" style={{ width }} />
          </div>
        ))}
      </div>
      <span className="sr-only" role="status">
        {t('file.editorLoading')}
      </span>
    </div>
  );
}
function ToolbarIcon({
  kind,
}: {
  kind:
    | 'folder'
    | 'file'
    | 'upload'
    | 'uploadFolder'
    | 'refresh'
    | 'path'
    | 'rename'
    | 'home'
    | 'save'
    | 'undo'
    | 'redo'
    | 'find'
    | 'download'
    | 'move'
    | 'copy'
    | 'delete'
    | 'clear';
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'download' ? (
        <path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" />
      ) : kind === 'move' ? (
        <path d="M3 7V5h7l2 3h9v12H3V7Zm4 7h10m-3-3 3 3-3 3" />
      ) : kind === 'copy' ? (
        <path d="M9 8h12v13H9ZM5 16H3V3h12v2" />
      ) : kind === 'delete' ? (
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
      ) : kind === 'clear' ? (
        <path d="m6 6 12 12M6 18 18 6" />
      ) : kind === 'home' ? (
        <path d="m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10" />
      ) : kind === 'save' ? (
        <path d="M4 3h13l3 3v15H4ZM8 3v6h8V3M8 21v-8h8v8" />
      ) : kind === 'undo' ? (
        <path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12" />
      ) : kind === 'redo' ? (
        <path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12" />
      ) : kind === 'find' ? (
        <>
          <circle cx="10" cy="10" r="6" />
          <path d="m15 15 6 6" />
        </>
      ) : kind === 'path' ? (
        <path d="M3 6h7l2 3h9v11H3V6Zm5 9h8m-3-3 3 3-3 3" />
      ) : kind === 'rename' ? (
        <path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" />
      ) : kind === 'refresh' ? (
        <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" />
      ) : kind === 'upload' ? (
        <path d="M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5" />
      ) : kind === 'file' ? (
        <>
          <path d="M14 3H5v18h14V8l-5-5v5h5" />
          <path d="M12 12v6m-3-3h6" />
        </>
      ) : (
        <>
          <path d="M3 7V5h7l2 3h9v12H3V7Z" />
          {kind === 'folder' ? <path d="M12 11v6m-3-3h6" /> : <path d="M12 18v-7m-3 3 3-3 3 3" />}
        </>
      )}
    </svg>
  );
}
export function FilesPage({ serverId }: { serverId: string }) {
  return <FilesWorkspace key={serverId} serverId={serverId} />;
}
function FilesWorkspace({ serverId }: { serverId: string }) {
  const t = useT(),
    format = useFormat();
  const session = useSession();
  const saveScope = useMemo(
    () => (session.data ? fileSaveScope(session.data) : undefined),
    [session.data],
  );
  const saves = useFileSaveRecords(saveScope);
  const location = useLocation();
  const recoveredSave = useRef<string | undefined>(undefined);
  const saveIdentity = useRef(saveScope?.join('\0'));
  saveIdentity.current = saveScope?.join('\0');
  const macKeyboard = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  const pathShortcut = `${macKeyboard ? '⌥' : 'ALT'} + G`;
  const searchInput = useRef<HTMLInputElement>(null);
  const server = useServer(serverId),
    transfers = useTransfers(serverId);
  const directoryKey = saveScope
    ? JSON.stringify(['file-directory', ...saveScope, serverId])
    : undefined;
  const readDirectory = (key: string | undefined) => {
    try {
      const path = key ? sessionStorage.getItem(key) : null;
      return path !== null && normalizeFilePath(path) !== undefined ? path : '';
    } catch {
      return '';
    }
  };
  const [folder, setFolder] = useState(() => ({
    key: directoryKey,
    path: readDirectory(directoryKey),
  }));
  const directory = folder.key === directoryKey ? folder.path : readDirectory(directoryKey);
  function setDirectory(path: string) {
    setFolder({ key: directoryKey, path });
    try {
      if (directoryKey) sessionStorage.setItem(directoryKey, path);
    } catch {
      // Browsers may disable storage; folder navigation still works normally.
    }
  }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string>();
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<FileOrder>('name');
  const [descending, setDescending] = useState(false);
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [pathEditing, setPathEditing] = useState(false);
  const [pathFocusSignal, setPathFocusSignal] = useState(0);
  const editPath = useCallback(() => {
    setPathEditing(true);
    setPathFocusSignal((value) => value + 1);
  }, []);
  const [mode, setMode] = useState<Mode>();
  const [targets, setTargets] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const [newName, setNewName] = useState('');
  const [revision, setRevision] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<unknown>();
  const [saveError, setSaveError] = useState<unknown>();
  const baseline = useRef('');
  const contentRef = useRef(content);
  contentRef.current = content;
  const [editorControls, setEditorControls] = useState<FileEditorControls>();
  const managerRef = useRef<HTMLElement>(null);
  const [inlineRename, setInlineRename] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const renamedFileFocus = useRef(false);
  const [editorAvailability, setEditorAvailability] =
    useState<ReturnType<typeof fileEditorAvailability>>('text');
  const editing = mode === 'edit' || mode === 'new';

  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<{ entry: ServerFile; left: number; top: number }>();
  const [dropActive, setDropActive] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadPause, setUploadPause] = useState<'checking' | 'blocked' | 'busy'>();
  const [preparingFolder, setPreparingFolder] = useState(false);
  const folderPreparation = useRef<AbortController | undefined>(undefined);
  const [pendingUploads, setPendingUploads] = useState<File[]>([]);
  const uploadId = useRef(0),
    uploadRunning = useRef(false);
  const activeUploads = useRef(new Map<number, AbortController>());
  const preparingUploadBatch = useRef<AbortController | undefined>(undefined);
  const activeUploadBatch = useRef<{ id: string; entryIds: Set<number> } | undefined>(undefined);
  const pendingUploadBatch = useRef<{ id: string; items: UploadItem[] } | undefined>(undefined);
  const uploadQueue = useRef<UploadItem[]>([]);
  const uploadIdentity = saveScope?.join('\0');
  const previousUploadIdentity = useRef(uploadIdentity);
  const uploadDisplayRefresh = useRef<(final?: boolean) => void>(() => {});
  const uploadDisplayPending = useRef<{ identity: string | undefined; final: boolean } | undefined>(
    undefined,
  );
  const displayDirectory = useRef(directory);
  displayDirectory.current = directory;
  const mounted = useRef(true);
  const abandonPendingUploadBatch = useCallback(() => {
    const planned = pendingUploadBatch.current;
    // An in-flight preparation owns cleanup after its response. A lost response
    // retained for manual retry can be closed by its known id without sending files.
    if (!planned || preparingUploadBatch.current) return;
    const identity = saveIdentity.current;
    void api(`${serverPath(serverId)}/files/upload-batches/${planned.id}`, { method: 'DELETE' })
      .then(() => {
        if (pendingUploadBatch.current === planned) pendingUploadBatch.current = undefined;
        if (mounted.current && saveIdentity.current === identity) {
          void queryClient.invalidateQueries({ queryKey: ['transfers', serverId] });
          void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
        }
      })
      .catch((failure) => {
        if (mounted.current && saveIdentity.current === identity) setError(failure);
      });
  }, [serverId]);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const editorForm = useRef<HTMLDivElement>(null);
  const activeFile = targets[0];
  useEffect(() => {
    if (!editing) return;
    if (renamedFileFocus.current) {
      renamedFileFocus.current = false;
      return;
    }
    if (mode === 'new')
      editorForm.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
    else if (activeFile)
      (
        editorForm.current?.querySelector<HTMLElement>('.cm-content') ?? editorForm.current
      )?.focus();
  }, [editing, activeFile, mode]);
  const mutationRunning = useRef(false);
  const readAbort = useRef<AbortController | undefined>(undefined),
    readSequence = useRef(0);
  const uploadSnapshot = useRef(uploads);
  uploadSnapshot.current = uploads;
  const directoryQuery = fileDirectoryQuery(serverId, directory);
  const files = useQuery({
    ...directoryQuery,
    queryFn: async (context) => {
      // Only retire hints for uploads completed BEFORE this listing started.
      // An older in-flight listing cannot prove a just-uploaded file is absent.
      const completed = new Set(
        uploadSnapshot.current
          .filter(
            (item) =>
              item.status === 'complete' &&
              item.path.slice(0, Math.max(0, item.path.lastIndexOf('/'))) === directory,
          )
          .map((item) => item.id),
      );
      const identity = saveIdentity.current;
      const entries = await directoryQuery.queryFn(context);
      if (
        completed.size &&
        mounted.current &&
        !context.signal.aborted &&
        saveIdentity.current === identity
      )
        setUploads((previous) => previous.filter((item) => !completed.has(item.id)));
      return entries;
    },
  });
  useEffect(() => {
    let active = true,
      dirty = false,
      urgent = false,
      inFlight = false,
      lastStarted = 0;
    let timer: number | undefined;
    let ownedRequest: Promise<unknown> | undefined;
    const queryKey = fileDirectoryQuery(serverId, directory).queryKey;
    const current = () =>
      active &&
      mounted.current &&
      saveIdentity.current === uploadIdentity &&
      displayDirectory.current === directory;
    const schedule = () => {
      if (!current() || !dirty || inFlight || timer !== undefined) return;
      timer = window.setTimeout(
        () => {
          timer = undefined;
          if (!current()) return;
          const final = urgent;
          dirty = false;
          urgent = false;
          inFlight = true;
          lastStarted = performance.now();
          const existing = queryClient.getQueryCache().find({ queryKey, exact: true });
          const previousRequest =
            existing?.state.fetchStatus === 'fetching' ? existing.promise : undefined;
          const request = files.refetch({ cancelRefetch: false });
          ownedRequest = queryClient.getQueryCache().find({ queryKey, exact: true })?.promise;
          if (previousRequest && previousRequest === ownedRequest) {
            // A navigation/focus listing may predate the just-confirmed upload.
            // Joining it saves a request, but cannot satisfy the final refresh.
            dirty = true;
            urgent = final;
          }
          const settled = () => {
            if (!current()) return;
            inFlight = false;
            schedule();
          };
          // The file query owns display errors; they never change upload outcomes.
          void request.then(settled, settled);
        },
        urgent ? 0 : Math.max(0, 1000 - (performance.now() - lastStarted)),
      );
    };
    uploadDisplayRefresh.current = (final = false) => {
      if (!current()) return;
      dirty = true;
      urgent ||= final;
      uploadDisplayPending.current = undefined;
      if (final && timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      schedule();
    };
    const pending = uploadDisplayPending.current;
    if (pending && pending.identity === uploadIdentity) uploadDisplayRefresh.current(pending.final);
    else uploadDisplayPending.current = undefined;
    return () => {
      active = false;
      uploadDisplayRefresh.current = () => {};
      window.clearTimeout(timer);
      if (dirty && saveIdentity.current === uploadIdentity)
        uploadDisplayPending.current = {
          identity: uploadIdentity,
          final: urgent || uploadDisplayPending.current?.final === true,
        };
      // Do not cancel a newer query started by navigation or an identity reset.
      if (
        inFlight &&
        ownedRequest &&
        queryClient.getQueryCache().find({ queryKey, exact: true })?.promise === ownedRequest
      )
        void queryClient.cancelQueries({ queryKey, exact: true });
    };
  }, [directory, files.refetch, serverId, uploadIdentity]);
  const rows = useMemo(
    () => visibleFiles(files.data ?? [], search, order, descending),
    [files.data, search, order, descending],
  );
  const canManage = server.data?.permissions.manage === true;
  const canMutate = canManage && server.data?.availableActions.files === true;
  const uploadAvailable = transfers.data?.upload.available === true;
  const selectedNames = [...selected];
  const selectedEntries = files.data?.filter((entry) => selected.has(entry.name)) ?? [];
  const capabilities = useQuery({
    queryKey: ['file-capabilities', serverId],
    refetchInterval: 10000,
    queryFn: () =>
      api<{ extractFormats: string[]; copy: boolean; extract: boolean }>(
        `${serverPath(serverId)}/files/capabilities`,
      ),
  });
  const transferFlow = useFileTransfer({
    serverId,
    identity: saveIdentity.current,
    canMutate,
    canCopy: capabilities.data?.copy === true,
    isBusy: () => mutationRunning.current,
    setBusy: (busy) => {
      mutationRunning.current = busy;
      setMutating(busy);
    },
    onClose: closeEditor,
    onComplete: (names) =>
      setSelected((current) => new Set([...current].filter((name) => !names.includes(name)))),
  });
  const parent = directory.split('/').slice(0, -1).join('/');
  const uploadReason = transfers.error
    ? 'file.uploadReason.request'
    : transfers.isPending
      ? 'web.loading'
      : `file.uploadReason.${transfers.data?.upload.reason ?? 'configuration_invalid'}`;
  const archiveFormats = (capabilities.data?.extractFormats ?? []).map(
    (extension) => `.${extension}`,
  );
  const isArchive = (name: string) =>
    archiveFormats.some((extension) => name.toLowerCase().endsWith(extension));
  const cancelRead = useCallback(() => {
    readSequence.current++;
    readAbort.current?.abort();
    readAbort.current = undefined;
    setReading(false);
  }, []);
  useEffect(() => {
    // Preserve the Owner-requested lazy module warmup on Files tab entry.
    void loadEditor().catch(() => {});
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of activeUploads.current.values()) controller.abort();
      abandonPendingUploadBatch();
      preparingUploadBatch.current?.abort();
      folderPreparation.current?.abort();
      readAbort.current?.abort();
    };
  }, [abandonPendingUploadBatch]);
  useEffect(() => {
    if (previousUploadIdentity.current === uploadIdentity) return;
    previousUploadIdentity.current = uploadIdentity;
    for (const controller of activeUploads.current.values()) controller.abort();
    abandonPendingUploadBatch();
    preparingUploadBatch.current?.abort();
    uploadQueue.current = [];
    pendingUploadBatch.current = undefined;
    setUploads([]);
    setUploadPause(undefined);
  }, [uploadIdentity, abandonPendingUploadBatch]);
  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      const modifier = event.altKey && !event.ctrlKey && !event.metaKey;
      const pathRequest = modifier && event.code === 'KeyG';
      const searchRequest = modifier && event.code === 'KeyK' && !editing;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.shiftKey ||
        (!pathRequest && !searchRequest) ||
        document.querySelector('dialog[open]')
      )
        return;
      event.preventDefault();
      setMenu(undefined);
      if (pathRequest) editPath();
      else {
        setPathEditing(false);
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, [editPath, editing]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined);
    };
    const resize = () => setMenu(undefined);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', resize);
    };
  }, [menu]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        dirty ||
        uploadRunning.current ||
        uploadQueue.current.length ||
        mutationRunning.current ||
        folderPreparation.current
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const navigationGuard = useRef<() => boolean>(() => false);
  navigationGuard.current = () => hasUnsubmittedChanges() || mutationRunning.current;
  const navigationBlocker = useBlocker(useCallback(() => navigationGuard.current(), []));
  const handledNavigation = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    // A draft update may render again before the router applies reset/proceed.
    // Handle each blocked transition once, including repeated Back attempts.
    if (
      navigationBlocker.state !== 'blocked' ||
      handledNavigation.current === navigationBlocker.proceed
    )
      return;
    handledNavigation.current = navigationBlocker.proceed;
    if (!mutationRunning.current && confirmEditorExit()) navigationBlocker.proceed();
    else navigationBlocker.reset();
  });
  function currentSave() {
    return getFileSave(
      saveScope,
      serverId,
      join(directory, mode === 'new' ? newName : (targets[0] ?? '')),
    );
  }
  function hasUnsubmittedChanges() {
    const pending = currentSave();
    return pending?.status === 'pending' ? pending.submittedContent !== contentRef.current : dirty;
  }
  function confirmEditorExit() {
    if (!hasUnsubmittedChanges()) return true;
    if (!window.confirm(t('service.discardEdits'))) return false;
    const pending = currentSave();
    if (pending?.status === 'pending')
      updateFileSaveDraft(saveScope, serverId, pending.path, pending.submittedContent);
    else if (pending) discardFileSave(saveScope, serverId, pending.path);
    if (pending?.status === 'pending') {
      contentRef.current = pending.submittedContent;
      setContent(pending.submittedContent);
    }
    setDirty(false);
    return true;
  }
  // A refreshed provider listing may remove files selected before another user's operation.
  useEffect(() => {
    if (files.data)
      setSelected(
        (previous) =>
          new Set([...previous].filter((name) => files.data.some((entry) => entry.name === name))),
      );
  }, [files.data]);
  function navigate(path: string, preserveName = false) {
    if (mutationRunning.current) return;
    const normalized = normalizeFilePath(path);
    if (normalized === undefined) {
      setError({ messageKey: 'file.invalidPath' });
      return;
    }
    if (!confirmEditorExit()) return;
    cancelRead();
    setSaving(false);
    setInlineRename(false);
    setMode(undefined);
    setDirty(false);
    setDirectory(preserveName ? path : normalized);
    setSelected(new Set());
    setAnchor(undefined);
    setSearch('');
    setPathEditing(false);
    setError(undefined);
    setMenu(undefined);
  }
  function closeEditor() {
    if (mutationRunning.current) return;
    if (!confirmEditorExit()) return;
    cancelRead();
    setSaving(false);
    setInlineRename(false);
    setDirty(false);
    setMode(undefined);
    setReadError(undefined);
    requestAnimationFrame(() => {
      if (menuTrigger.current?.isConnected) {
        menuTrigger.current.focus();
        return;
      }
      const entry = [
        ...(managerRef.current?.querySelectorAll<HTMLButtonElement>('.fm-filename') ?? []),
      ].find((button) => button.dataset.fileName === targets[0]);
      (
        entry ?? managerRef.current?.querySelector<HTMLButtonElement>('.fm-breadcrumb button')
      )?.focus();
    });
  }
  function chooseMode(value: Mode | 'move' | 'copy', names = selectedNames, folder = directory) {
    if (!menu) menuTrigger.current = document.activeElement as HTMLElement;
    setError(undefined);
    setMenu(undefined);
    setTargets(names);
    if (value === 'move' || value === 'copy') {
      transferFlow.begin({ source: directory, destination: folder, names }, value);
      return;
    }
    setMode(value);
    setReadError(undefined);
    setSaveError(undefined);
    if (value === 'new') {
      baseline.current = '';
      setEditorAvailability('text');
      setContent('');
      setNewName('');
      setRevision(null);
      setDirty(false);
    }
  }
  async function open(entry: ServerFile, folder = directory) {
    if (mutationRunning.current) return;
    if (!menu) menuTrigger.current = document.activeElement as HTMLElement;
    if (entry.is_symlink) return;
    if (!entry.is_file) {
      navigate(join(folder, entry.name), true);
      return;
    }
    if (!confirmEditorExit()) return;
    const pending = getFileSave(saveScope, serverId, join(folder, entry.name));
    if (pending) {
      restoreSave(pending);
      return;
    }
    setPathEditing(false);
    if (folder !== directory) {
      setDirectory(folder);
      setSearch('');
      setSelected(new Set());
      setAnchor(undefined);
    }
    cancelRead();
    setSaving(false);
    setInlineRename(false);
    const sequence = ++readSequence.current,
      controller = new AbortController();
    readAbort.current = controller;
    setTargets([entry.name]);
    setEditorAvailability(fileEditorAvailability(entry));
    setSaveError(undefined);
    baseline.current = '';
    setMode('edit');
    setContent('');
    setRevision(null);
    setDirty(false);
    setReading(true);
    setReadError(undefined);
    if (fileEditorAvailability(entry) !== 'text') {
      setReading(false);
      return;
    }
    try {
      const value = await api<{ content: string; revision: string }>(
        `${serverPath(serverId)}/files/editor?path=${encodeURIComponent(join(folder, entry.name))}`,
        { signal: controller.signal },
      );
      if (sequence === readSequence.current && !controller.signal.aborted) {
        setContent(value.content);
        baseline.current = value.content;
        setRevision(value.revision);
      }
    } catch (failure) {
      if (sequence === readSequence.current && !controller.signal.aborted) setReadError(failure);
    } finally {
      if (sequence === readSequence.current) setReading(false);
    }
  }
  async function mutation(body: unknown, endpoint = '/files', method = 'POST') {
    if (mutationRunning.current) return;
    mutationRunning.current = true;
    setMutating(true);
    try {
      try {
        await api(`${serverPath(serverId)}${endpoint}`, { body, method });
      } catch (failure) {
        if (
          endpoint === '/files/editor' &&
          failure &&
          typeof failure === 'object' &&
          'code' in failure &&
          failure.code === 'conflict'
        )
          throw { messageKey: 'file.concurrentChange' };
        throw failure;
      }
      setDirty(false);
      setMode(undefined);
      setSelected(new Set());
      await files.refetch();
    } finally {
      mutationRunning.current = false;
      setMutating(false);
    }
  }
  function restoreSave(record: FileSaveRecord) {
    cancelRead();
    const sequence = readSequence.current;
    const separator = record.path.lastIndexOf('/');
    const folder = separator < 0 ? '' : record.path.slice(0, separator);
    const name = record.path.slice(separator + 1);
    setDirectory(folder);
    setTargets([name]);
    setNewName(name);
    setMode(record.expectedRevision === null ? 'new' : 'edit');
    setPathEditing(false);
    setInlineRename(false);
    setEditorAvailability('text');
    setReadError(undefined);
    setSaveError(record.error);
    baseline.current = '';
    contentRef.current = record.content;
    setContent(record.content);
    setRevision(record.expectedRevision);
    setDirty(true);
    setSaving(record.status === 'pending');
    if (record.status === 'pending')
      void finishSave(record.completion, sequence, record.submittedContent, name);
  }
  useEffect(() => {
    const id = location.state?.fileSaveId;
    const attempt = `${location.key}:${id}`;
    if (typeof id !== 'string' || recoveredSave.current === attempt) return;
    const record = saves.find((item) => item.id === id && item.serverId === serverId);
    if (!record || mutationRunning.current) return;
    recoveredSave.current = attempt;
    if (editing && currentSave()?.id === id) {
      editorControls?.focus();
      return;
    }
    if (confirmEditorExit()) restoreSave(record);
  });
  async function finishSave(
    request: Promise<{ revision: string }>,
    sequence: number,
    submitted: string,
    name: string,
  ) {
    const identity = saveIdentity.current;
    try {
      const result = await request;
      if (
        !mounted.current ||
        sequence !== readSequence.current ||
        identity !== saveIdentity.current
      )
        return;
      baseline.current = submitted;
      setRevision(result.revision);
      setDirty(contentRef.current !== submitted);
      setTargets([name]);
      setMode('edit');
    } catch (failure) {
      if (
        !mounted.current ||
        sequence !== readSequence.current ||
        identity !== saveIdentity.current
      )
        return;
      setSaveError(
        failure && typeof failure === 'object' && 'code' in failure && failure.code === 'conflict'
          ? { messageKey: 'file.concurrentChange' }
          : failure,
      );
      setDirty(true);
    } finally {
      if (mounted.current && sequence === readSequence.current && identity === saveIdentity.current)
        setSaving(false);
    }
  }
  async function saveEditor() {
    if (
      !canMutate ||
      !saveScope ||
      mutationRunning.current ||
      saving ||
      reading ||
      readError ||
      editorAvailability !== 'text'
    )
      return;
    const name = mode === 'new' ? newName : targets[0];
    if (!name || !validFilename(name)) {
      setSaveError({ messageKey: 'file.invalidName' });
      return;
    }
    if (getFileSave(saveScope, serverId, join(directory, name))?.status === 'pending') return;
    const sequence = readSequence.current;
    const submitted = contentRef.current;
    setSaving(true);
    setSaveError(undefined);
    await finishSave(
      submitFileSave(saveScope, {
        serverId,
        path: join(directory, name),
        content: submitted,
        expectedRevision: mode === 'new' ? null : revision,
      }),
      sequence,
      submitted,
      name,
    );
  }
  async function renameEditor(name: string, reason: 'enter' | 'blur') {
    if (!canMutate || dirty || mutationRunning.current || saving || reading)
      throw { messageKey: 'errors.forbidden' };
    if (!validFilename(name)) throw { messageKey: 'file.invalidName' };
    const original = files.data?.find((entry) => entry.name === targets[0]);
    if (!original) throw { messageKey: 'file.pathNotFound' };
    if (fileEditorAvailability({ ...original, name }) !== 'text')
      throw { messageKey: 'file.renameUneditable' };
    mutationRunning.current = true;
    setMutating(true);
    setRenaming(true);
    // Enter returns to the existing selection immediately. Blur preserves the
    // user's chosen focus target, and completion must never focus the editor.
    if (reason === 'enter') requestAnimationFrame(() => editorControls?.focus());
    try {
      await api(`${serverPath(serverId)}/files`, {
        method: 'POST',
        body: { action: 'rename', root: directory, files: [{ from: original.name, to: name }] },
      });
      renamedFileFocus.current = true;
      setTargets([name]);
      setEditorAvailability(fileEditorAvailability({ ...original, name }));
      void files.refetch();
    } finally {
      mutationRunning.current = false;
      setMutating(false);
      setRenaming(false);
    }
  }
  function saveShortcut() {
    if (canMutate) editorForm.current?.querySelector('form')?.requestSubmit();
  }
  function downloadNames(names: string[]) {
    const entry = files.data?.find((item) => item.name === names[0]);
    const direct = names.length === 1 && entry?.is_file;
    if (direct)
      download(
        `${serverPath(serverId)}/files/content?path=${encodeURIComponent(join(directory, names[0] ?? ''))}`,
      );
    else downloadZip(names);
  }
  function downloadZip(names: string[]) {
    download(`${serverPath(serverId)}/files/archive`, {
      root: directory,
      files: JSON.stringify(names),
    });
  }
  function showMenu(entry: ServerFile, element: HTMLElement, x?: number, y?: number) {
    menuTrigger.current = element;
    const rect = element.getBoundingClientRect();
    setMenu({
      entry,
      left: Math.max(8, Math.min(x ?? rect.right - 196, window.innerWidth - 212)),
      top: Math.max(8, Math.min(y ?? rect.bottom, window.innerHeight - 350)),
    });
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('input:not([type="checkbox"]),textarea,[contenteditable="true"],dialog'))
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelected(new Set(rows.filter((entry) => !entry.is_symlink).map((entry) => entry.name)));
    }
    if (event.key === 'Escape') {
      setSelected(new Set());
      setMenu(undefined);
    }
  }
  function dropFolder(event: DragEvent, folder: string) {
    if (!event.dataTransfer.types.includes(dragType) || !canMutate || mutationRunning.current)
      return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const payload = JSON.parse(event.dataTransfer.getData(dragType)) as {
        serverId: string;
        directory: string;
        names: string[];
      };
      if (
        payload.serverId !== serverId ||
        payload.directory !== directory ||
        !Array.isArray(payload.names) ||
        !payload.names.length ||
        !payload.names.every((name) =>
          files.data?.some((entry) => entry.name === name && !entry.is_symlink),
        )
      )
        return;
      if (!validMoveTarget(directory, payload.names, folder)) {
        setError({ messageKey: 'file.invalidMove' });
        return;
      }
      setMenu(undefined);
      menuTrigger.current = document.activeElement as HTMLElement;
      transferFlow.begin(
        { source: directory, destination: folder, names: payload.names },
        'move',
        false,
      );
    } catch {
      setError({ messageKey: 'file.invalidMove' });
    }
  }
  function dragOverFolder(event: DragEvent) {
    if (canMutate && event.dataTransfer.types.includes(dragType)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  }
  function updateUpload(id: number, patch: Partial<UploadItem>) {
    if (mounted.current)
      setUploads((previous) =>
        previous.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
  }
  function refreshUploadDisplay(final = false) {
    // Mark cached folders stale without fetching every directory touched by a batch.
    void queryClient.invalidateQueries({ queryKey: ['files', serverId], refetchType: 'none' });
    uploadDisplayPending.current = {
      identity: saveIdentity.current,
      final: final || uploadDisplayPending.current?.final === true,
    };
    uploadDisplayRefresh.current(final);
  }
  function runUploads() {
    const descriptor = transfers.data?.upload;
    return descriptor?.batchMaxBytes && descriptor.batchMaxBytes > 0
      ? runParallelUploads(descriptor.batchMaxBytes, descriptor.batchMaxFiles ?? 500)
      : Promise.resolve().then(() =>
          setError({ messageKey: 'file.uploadReason.configuration_invalid' }),
        );
  }
  async function runParallelUploads(maxBytes: number, maxFiles: number) {
    if (uploadRunning.current) return;
    const identity = saveIdentity.current;
    const isCurrent = () => mounted.current && identity === saveIdentity.current;
    if (!identity || !isCurrent()) return;
    uploadRunning.current = true;
    const endpoint = `${serverPath(serverId)}/files/upload-batches`;
    const closeBatch = (id: string) => api(`${endpoint}/${id}`, { method: 'DELETE' });
    let pause = false;
    let pauseState: 'busy' | 'blocked' | undefined;
    let unsettledCancellation = false;
    const settleCancellation = async (batchId: string, item: UploadItem) => {
      const signal = AbortSignal.timeout(5000);
      let queuedCancellationRequested = false;
      if (isCurrent()) updateUpload(item.id, { status: 'waiting', speed: 0 });
      try {
        while (isCurrent() && !signal.aborted) {
          try {
            const result = await api<{
              closed: boolean;
              files: {
                id: string;
                state: 'queued' | 'active' | 'complete' | 'cancelled' | 'uncertain';
              }[];
            }>(`${endpoint}/${batchId}`, { signal });
            const state = result.files.find((entry) => entry.id === String(item.id))?.state;
            if (state === 'complete') {
              if (isCurrent()) {
                updateUpload(item.id, { status: 'complete', sent: item.file.size });
                refreshUploadDisplay();
              }
              return;
            }
            if (state === 'cancelled' || result.closed) {
              if (isCurrent()) updateUpload(item.id, { status: 'cancelled' });
              return;
            }
            if (state === 'uncertain') break;
            if (state === 'queued' && !queuedCancellationRequested) {
              await api(`${endpoint}/${batchId}/cancel`, {
                body: { entryId: String(item.id) },
                signal,
              });
              queuedCancellationRequested = true;
            }
          } catch (failure) {
            if (!(failure instanceof ApiError) || failure.code !== 'operation_busy') throw failure;
          }
          await waitForUploadRetry(150, signal);
        }
      } catch {
        // A disconnected browser cannot infer the provider's final write outcome.
      }
      if (isCurrent()) {
        unsettledCancellation = true;
        pauseState = 'blocked';
        updateUpload(item.id, {
          status: 'failed',
          error: new ApiError('operation_uncertain', 'errors.operation_uncertain'),
        });
      }
    };
    try {
      setUploadPause(undefined);
      setError(undefined);
      while (uploadQueue.current.length && isCurrent() && !pause) {
        // Oversized files remain visible as failures; they do not prevent small
        // siblings from proceeding. The server still enforces authoritative limits.
        for (const item of [...uploadQueue.current]) {
          if (item.file.size <= maxBytes) continue;
          uploadQueue.current = uploadQueue.current.filter((other) => other.id !== item.id);
          updateUpload(item.id, {
            status: 'failed',
            error: new ApiError('storage_exhausted', 'errors.storage_exhausted'),
          });
        }
        const planned = pendingUploadBatch.current ?? {
          id: crypto.randomUUID(),
          items: planUploadBatch(uploadQueue.current, maxBytes, Math.min(500, maxFiles)),
        };
        if (!planned.items.length) break;
        pendingUploadBatch.current = planned;
        const preparation = new AbortController();
        preparingUploadBatch.current = preparation;
        let prepared:
          | { id: string | null; concurrency: number; rejected: { id: string; code: string }[] }
          | undefined;
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              // Keep the small manifest request alive through navigation so a
              // created reservation can be closed from its actual response.
              prepared = await api(endpoint, {
                body: {
                  id: planned.id,
                  files: planned.items.map((item) => ({
                    id: String(item.id),
                    path: item.path,
                    bytes: item.file.size,
                    overwrite: !item.exclusive,
                  })),
                },
              });
              break;
            } catch (failure) {
              const delay = uploadBusyRetryDelays[attempt];
              if (!isCurrent() || preparation.signal.aborted) throw failure;
              if (
                !(failure instanceof ApiError) ||
                failure.code !== 'operation_busy' ||
                delay === undefined
              )
                throw failure;
              for (const item of planned.items)
                if (uploadQueue.current.some((other) => other.id === item.id))
                  updateUpload(item.id, { status: 'waiting' });
              await waitForUploadRetry(delay, preparation.signal);
              if (preparation.signal.aborted) throw failure;
            }
          }
        } catch (failure) {
          if (isCurrent()) {
            for (const item of planned.items)
              if (uploadQueue.current.some((other) => other.id === item.id))
                updateUpload(item.id, { status: 'queued' });
            setError(failure);
            pauseState =
              failure instanceof ApiError && failure.code === 'operation_busy' ? 'busy' : 'blocked';
          }
          break;
        } finally {
          if (preparingUploadBatch.current === preparation)
            preparingUploadBatch.current = undefined;
        }
        if (!prepared) break;
        if (pendingUploadBatch.current === planned) pendingUploadBatch.current = undefined;
        if (!isCurrent()) {
          if (prepared.id) await closeBatch(prepared.id).catch(() => {});
          break;
        }
        for (const rejection of prepared.rejected) {
          const item = planned.items.find((entry) => String(entry.id) === rejection.id);
          if (!item || !uploadQueue.current.some((entry) => entry.id === item.id)) continue;
          uploadQueue.current = uploadQueue.current.filter((entry) => entry.id !== item.id);
          updateUpload(item.id, {
            status: 'failed',
            error: apiError({ code: rejection.code, messageKey: `errors.${rejection.code}` }),
          });
        }
        if (!prepared.id) continue;
        const batch = { id: prepared.id, entryIds: new Set(planned.items.map((item) => item.id)) };
        activeUploadBatch.current = batch;
        try {
          const cancelled = planned.items.filter(
            (item) =>
              !prepared.rejected.some((entry) => entry.id === String(item.id)) &&
              !uploadQueue.current.some((entry) => entry.id === item.id),
          );
          await Promise.all(
            cancelled.map((item) =>
              api(`${endpoint}/${batch.id}/cancel`, { body: { entryId: String(item.id) } }),
            ),
          );
          await runUploadPool({
            concurrency: prepared.concurrency,
            next: (active: readonly UploadItem[]) => {
              if (!isCurrent() || pause) return undefined;
              const item = nextUpload(
                uploadQueue.current.filter((entry) => batch.entryIds.has(entry.id)),
                active,
              );
              if (item) uploadQueue.current.splice(uploadQueue.current.indexOf(item), 1);
              return item;
            },
            run: async (item) => {
              const controller = new AbortController();
              activeUploads.current.set(item.id, controller);
              try {
                for (let attempt = 0; isCurrent() && !controller.signal.aborted; attempt++) {
                  const start = performance.now();
                  updateUpload(item.id, { status: 'uploading', error: undefined });
                  try {
                    await upload(
                      `${serverPath(serverId)}/files/upload?path=${encodeURIComponent(item.path)}${item.exclusive ? '&overwrite=false' : ''}&batchId=${encodeURIComponent(batch.id)}&entryId=${item.id}`,
                      item.file,
                      {
                        signal: controller.signal,
                        onProgress: (sent) => {
                          if (isCurrent())
                            updateUpload(item.id, {
                              sent,
                              speed: sent / Math.max(0.1, (performance.now() - start) / 1000),
                              status: sent === item.file.size ? 'confirming' : 'uploading',
                            });
                        },
                      },
                    );
                    if (isCurrent()) {
                      updateUpload(item.id, { status: 'complete', sent: item.file.size });
                      refreshUploadDisplay();
                    }
                    return;
                  } catch (failure) {
                    if (!isCurrent()) return;
                    if (controller.signal.aborted) {
                      await settleCancellation(batch.id, item);
                      return;
                    }
                    if (failure instanceof ApiError && failure.code === 'operation_busy') {
                      const delay = uploadBusyRetryDelays[attempt];
                      updateUpload(item.id, {
                        status: delay === undefined ? 'queued' : 'waiting',
                        sent: 0,
                        speed: 0,
                      });
                      if (delay === undefined) {
                        uploadQueue.current.unshift(item);
                        pause = true;
                        pauseState = 'busy';
                        return;
                      }
                      await waitForUploadRetry(delay, controller.signal);
                      continue;
                    }
                    // An unknown write belongs to this entry only. Never replay it;
                    // the batch reservation already covers every remaining sibling.
                    updateUpload(item.id, {
                      status: 'failed',
                      error: failure,
                    });
                    return;
                  }
                }
                if (isCurrent() && controller.signal.aborted)
                  await settleCancellation(batch.id, item);
              } finally {
                activeUploads.current.delete(item.id);
              }
            },
          });
          // Admitted siblings may finish independently; an unresolved cancellation
          // must settle before another batch can reserve or submit new work.
          if (unsettledCancellation) {
            pause = true;
            pauseState = 'blocked';
          }
        } catch (failure) {
          pause = true;
          if (isCurrent()) {
            setError(failure);
            pauseState = 'blocked';
          }
        } finally {
          if (activeUploadBatch.current === batch) activeUploadBatch.current = undefined;
          try {
            await closeBatch(batch.id);
          } catch (failure) {
            pause = true;
            if (isCurrent()) {
              setError(failure);
              pauseState = 'blocked';
            }
          }
        }
      }
    } finally {
      uploadRunning.current = false;
      if (isCurrent()) {
        // Resume only after active requests and reservation cleanup have settled.
        setUploadPause(
          uploadQueue.current.length || unsettledCancellation ? pauseState : undefined,
        );
        refreshUploadDisplay(true);
        void queryClient.invalidateQueries({ queryKey: ['transfers', serverId] });
        void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
      } else if (mounted.current && uploadQueue.current.length) void runUploads();
    }
  }
  function queueUploads(incoming: File[], target = directory, paths?: string[]) {
    const items = incoming.map((file, index) => ({
      id: ++uploadId.current,
      file,
      directory: target,
      path: paths?.[index] ?? join(target, file.name),
      exclusive: Boolean(paths),
      sent: 0,
      speed: 0,
      status: 'queued' as const,
    }));
    setUploads((previous) => [...previous, ...items]);
    uploadQueue.current.push(...items);
    setPendingUploads([]);
    if (!uploadPause) void runUploads();
  }
  function acceptUploads(incoming: File[]) {
    if (folderPreparation.current) {
      setError({ messageKey: 'file.folderPreparing' });
      return;
    }
    if (!uploadAvailable) {
      setError({ messageKey: uploadReason });
      return;
    }
    if (incoming.some((file) => file.name.includes('/') || file.name.includes('\\'))) {
      setError({ messageKey: 'file.invalidPath' });
      return;
    }
    if (
      incoming.some(
        (file) =>
          files.data?.some((entry) => entry.name === file.name) ||
          uploads.some(
            (item) =>
              item.path === join(directory, file.name) &&
              item.status !== 'cancelled' &&
              item.status !== 'failed',
          ),
      )
    ) {
      setPendingUploads(incoming);
      return;
    }
    queueUploads(incoming);
  }
  async function acceptFolder(incoming: File[]) {
    if (!incoming.length) {
      setError({ messageKey: 'file.folderError.empty_selection' });
      return;
    }
    if (!uploadAvailable) {
      setError({ messageKey: uploadReason });
      return;
    }
    if (uploadRunning.current || uploadQueue.current.length || folderPreparation.current) {
      setError({ messageKey: 'file.waitUploads' });
      return;
    }
    const controller = new AbortController();
    folderPreparation.current = controller;
    setPreparingFolder(true);
    setError(undefined);
    const target = directory;
    try {
      const plan = planFolderUpload(incoming, target);
      await prepareFolderUpload(
        plan,
        {
          list: (path, signal) =>
            api<ServerFile[]>(`${serverPath(serverId)}/files?path=${encodeURIComponent(path)}`, {
              signal,
            }),
          mkdir: (root, name, signal) =>
            api(`${serverPath(serverId)}/files`, {
              method: 'POST',
              body: { action: 'mkdir', root, name },
              signal,
            }),
        },
        controller.signal,
      );
      if (mounted.current && !controller.signal.aborted)
        queueUploads(
          plan.entries.map((entry) => entry.file),
          target,
          plan.entries.map((entry) => entry.path),
        );
    } catch (failure) {
      if (mounted.current)
        setError({
          messageKey:
            failure instanceof FolderUploadError
              ? failure.createdDirectories.length || failure.uncertainDirectory
                ? 'file.folderPartial'
                : `file.folderError.${failure.code}`
              : 'web.errors.request',
        });
    } finally {
      folderPreparation.current = undefined;
      if (mounted.current) {
        setPreparingFolder(false);
        refreshUploadDisplay(true);
      }
    }
  }
  function cancelUpload(id: number) {
    const index = uploadQueue.current.findIndex((item) => item.id === id);
    if (index !== -1) {
      uploadQueue.current.splice(index, 1);
      updateUpload(id, { status: 'cancelled' });
      if (!uploadQueue.current.length) {
        setUploadPause(undefined);
        abandonPendingUploadBatch();
      }
      const batch = activeUploadBatch.current;
      if (batch?.entryIds.has(id))
        void api(`${serverPath(serverId)}/files/upload-batches/${batch.id}/cancel`, {
          body: { entryId: String(id) },
        }).catch((failure) => {
          if (mounted.current) setError(failure);
        });
    } else activeUploads.current.get(id)?.abort();
  }
  const totalSelected = selected.size;
  // Keep completed paths only until a subsequent successful directory listing;
  // show only pending transfers and failures in the queue.
  const visibleUploads = uploads.filter(
    (item) => item.status !== 'complete' && item.status !== 'cancelled',
  );
  const uploadsBusy = uploads.some((item) =>
    ['queued', 'waiting', 'uploading', 'confirming'].includes(item.status),
  );
  return (
    <section
      className="file-manager"
      ref={managerRef}
      aria-label={t('web.files')}
      onKeyDown={keyboard}
      onDragEnter={(event) => {
        if (!editing && event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDropActive(true);
        }
      }}
      onDragOver={(event) => {
        if (!editing && event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = uploadAvailable ? 'copy' : 'none';
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false);
      }}
      onDrop={(event) => {
        if (!editing && event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDropActive(false);
          if (
            [...event.dataTransfer.items].some((item) => item.webkitGetAsEntry?.()?.isDirectory)
          ) {
            setError({ messageKey: 'file.useFolderUpload' });
            return;
          }
          acceptUploads([...event.dataTransfer.files]);
        }
      }}
    >
      <div className={`fm-toolbar ${editing ? 'fm-toolbar-editing' : ''}`}>
        {pathEditing ? (
          <FilePathPicker
            serverId={serverId}
            directory={directory}
            focusSignal={pathFocusSignal}
            onNavigate={(path) => navigate(path, true)}
            onOpenFile={(entry, folder) => void open(entry, folder)}
            onClose={() => setPathEditing(false)}
          />
        ) : (
          <nav aria-label={t('file.breadcrumb')} className="fm-breadcrumb">
            <ol>
              {fileBreadcrumbs(directory).map((part, index, all) => (
                <li key={part.path}>
                  <button
                    type="button"
                    className="text-button"
                    aria-current={!editing && index === all.length - 1 ? 'page' : undefined}
                    onClick={() => navigate(part.path)}
                    onDragOver={dragOverFolder}
                    onDrop={(event) => dropFolder(event, part.path)}
                  >
                    {index === 0 ? t('file.root') : part.name}
                  </button>
                </li>
              ))}
              {editing && (
                <li>
                  {inlineRename && mode === 'edit' ? (
                    <InlineFileRename
                      name={targets[0] ?? ''}
                      onCommit={renameEditor}
                      onCancel={() => {
                        const focused = document.activeElement?.closest('.fm-inline-rename');
                        setInlineRename(false);
                        if (focused) requestAnimationFrame(() => editorControls?.focus());
                      }}
                      onComplete={() => {
                        setInlineRename(false);
                      }}
                    />
                  ) : (
                    <span aria-current="page" className="fm-current-file">
                      {mode === 'new' ? newName || t('service.newFile') : targets[0]}
                      {dirty && <span aria-hidden="true"> *</span>}
                    </span>
                  )}
                </li>
              )}
            </ol>
            {!editing ? (
              <Tooltip placement="cursor" content={t('file.editPath', { shortcut: pathShortcut })}>
                <button
                  type="button"
                  className="fm-tool fm-path-edit"
                  aria-keyshortcuts="Alt+G"
                  aria-label={t('file.editPath', { shortcut: pathShortcut })}
                  onClick={editPath}
                >
                  <ToolbarIcon kind="path" />
                </button>
              </Tooltip>
            ) : (
              mode === 'edit' &&
              canManage && (
                <Tooltip
                  placement="cursor"
                  content={t(dirty ? 'file.saveBeforeRename' : 'service.rename')}
                >
                  <button
                    type="button"
                    className="fm-tool fm-path-edit"
                    aria-label={t('service.rename')}
                    disabled={!canMutate || dirty || reading || mutating || saving || inlineRename}
                    onClick={() => setInlineRename(true)}
                  >
                    <ToolbarIcon kind="rename" />
                  </button>
                </Tooltip>
              )
            )}
          </nav>
        )}
        {!editing && (
          <>
            <div className="fm-search">
              <input
                ref={searchInput}
                type="search"
                aria-label={t('file.search')}
                aria-keyshortcuts="Alt+K"
                placeholder={t('file.searchLabel')}
                value={search}
                onFocus={() => setPathEditing(false)}
                onChange={(event) => setSearch(event.target.value)}
              />
              <span aria-hidden="true">
                <kbd>{macKeyboard ? '⌥ + K' : 'ALT + K'}</kbd>
              </span>
            </div>
            <div className="fm-tools">
              <Tooltip placement="cursor" content={t('file.refresh')}>
                <button
                  type="button"
                  className="fm-tool"
                  aria-label={t('file.refresh')}
                  disabled={files.isFetching}
                  onClick={() => void files.refetch()}
                >
                  <ToolbarIcon kind="refresh" />
                </button>
              </Tooltip>
              {canManage && (
                <>
                  <Tooltip placement="cursor" content={t('service.newFolder')}>
                    <button
                      type="button"
                      className="fm-tool"
                      aria-label={t('service.newFolder')}
                      disabled={!canMutate || preparingFolder}
                      onClick={() => chooseMode('mkdir', [])}
                    >
                      <ToolbarIcon kind="folder" />
                    </button>
                  </Tooltip>
                  <Tooltip placement="cursor" content={t('service.newFile')}>
                    <button
                      type="button"
                      className="fm-tool"
                      aria-label={t('service.newFile')}
                      disabled={!canMutate || preparingFolder}
                      onClick={() => chooseMode('new', [])}
                    >
                      <ToolbarIcon kind="file" />
                    </button>
                  </Tooltip>
                  <Tooltip
                    placement="cursor"
                    content={
                      !uploadAvailable
                        ? t(uploadReason)
                        : preparingFolder
                          ? t('file.folderPreparing')
                          : t('web.upload')
                    }
                  >
                    <button
                      type="button"
                      className="fm-tool"
                      aria-label={t('web.upload')}
                      aria-disabled={!uploadAvailable || preparingFolder}
                      onClick={() => {
                        if (uploadAvailable && !preparingFolder) fileInput.current?.click();
                        else
                          setError({
                            messageKey: preparingFolder ? 'file.folderPreparing' : uploadReason,
                          });
                      }}
                    >
                      <ToolbarIcon kind="upload" />
                    </button>
                  </Tooltip>
                  <Tooltip
                    placement="cursor"
                    content={
                      !uploadAvailable
                        ? t(uploadReason)
                        : preparingFolder || uploadsBusy
                          ? t('file.waitUploads')
                          : t('file.uploadFolder')
                    }
                  >
                    <button
                      type="button"
                      className="fm-tool"
                      aria-label={t('file.uploadFolder')}
                      aria-disabled={!uploadAvailable || preparingFolder || uploadsBusy}
                      onClick={() => {
                        if (uploadAvailable && !preparingFolder && !uploadsBusy)
                          folderInput.current?.click();
                        else
                          setError({
                            messageKey: !uploadAvailable ? uploadReason : 'file.waitUploads',
                          });
                      }}
                    >
                      <ToolbarIcon kind="uploadFolder" />
                    </button>
                  </Tooltip>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="fm-file-input"
                    aria-label={t('service.selectFile')}
                    onChange={(event) => {
                      acceptUploads([...(event.target.files ?? [])]);
                      event.target.value = '';
                    }}
                  />
                  <input
                    ref={folderInput}
                    type="file"
                    multiple
                    {...{ webkitdirectory: '' }}
                    className="fm-file-input"
                    aria-label={t('file.uploadFolder')}
                    onChange={(event) => {
                      void acceptFolder([...(event.target.files ?? [])]);
                      event.target.value = '';
                    }}
                  />
                </>
              )}
            </div>
            <fieldset className="fm-view" aria-label={t('file.view')}>
              <button
                type="button"
                className="secondary fm-icon-button"
                aria-label={t('file.list')}
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                ☰
              </button>
              <button
                type="button"
                className="secondary fm-icon-button"
                aria-label={t('file.grid')}
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                ▦
              </button>
            </fieldset>
          </>
        )}
        {editing && (
          <div className="fm-editor-toolbar" role="toolbar" aria-label={t('file.editor')}>
            {(
              [
                { kind: 'home', label: 'file.backToFiles', disabled: mutating, run: closeEditor },
                {
                  kind: 'save',
                  label: 'web.save',
                  disabled:
                    !canMutate ||
                    reading ||
                    mutating ||
                    saving ||
                    !!readError ||
                    editorAvailability !== 'text' ||
                    (!dirty && mode !== 'new'),
                  run: saveShortcut,
                },
                {
                  kind: 'undo',
                  label: 'editor.undo',
                  disabled: (mutating && !renaming) || !editorControls?.canUndo,
                  run: () => editorControls?.undo(),
                },
                {
                  kind: 'redo',
                  label: 'editor.redo',
                  disabled: (mutating && !renaming) || !editorControls?.canRedo,
                  run: () => editorControls?.redo(),
                },
                {
                  kind: 'find',
                  label: 'editor.search',
                  disabled: reading || !editorControls,
                  run: () => editorControls?.find(),
                },
              ] as const
            ).map((action) => (
              <Tooltip key={action.kind} placement="cursor" content={t(action.label)}>
                <button
                  type="button"
                  className="fm-tool"
                  disabled={action.disabled}
                  aria-label={t(action.label)}
                  onClick={action.run}
                >
                  <ToolbarIcon kind={action.kind} />
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
      {!editing && totalSelected > 0 && (
        <section className="fm-selection" aria-label={t('file.selection')}>
          <span className="fm-selection-count">{t('file.selected', { count: totalSelected })}</span>
          <div className="fm-selection-actions">
            <Tooltip placement="cursor" content={t('file.downloadZip')}>
              <button
                type="button"
                className="fm-tool"
                aria-label={t('file.downloadZip')}
                onClick={() => downloadZip(selectedNames)}
                disabled={
                  selectedEntries.some((entry) => entry.is_symlink) ||
                  !transfers.data?.download.available
                }
              >
                <ToolbarIcon kind="download" />
              </button>
            </Tooltip>
            {canManage && (
              <>
                <Tooltip placement="cursor" content={t('file.move')}>
                  <button
                    type="button"
                    className="fm-tool"
                    aria-label={t('file.move')}
                    disabled={!canMutate}
                    onClick={() => chooseMode('move')}
                  >
                    <ToolbarIcon kind="move" />
                  </button>
                </Tooltip>
                <Tooltip placement="cursor" content={t('file.copy')}>
                  <button
                    type="button"
                    className="fm-tool"
                    aria-label={t('file.copy')}
                    disabled={!canMutate || capabilities.data?.copy !== true}
                    onClick={() => chooseMode('copy')}
                  >
                    <ToolbarIcon kind="copy" />
                  </button>
                </Tooltip>
                <Tooltip placement="cursor" content={t('web.delete')}>
                  <button
                    type="button"
                    className="fm-tool fm-selection-delete"
                    aria-label={t('web.delete')}
                    disabled={!canMutate}
                    onClick={() => chooseMode('delete')}
                  >
                    <ToolbarIcon kind="delete" />
                  </button>
                </Tooltip>
              </>
            )}
          </div>
          <Tooltip placement="cursor" content={t('file.clearSelection')}>
            <button
              type="button"
              className="fm-tool fm-selection-clear"
              aria-label={t('file.clearSelection')}
              onClick={() => {
                managerRef.current
                  ?.querySelector<HTMLInputElement>('.fm-entry input[type="checkbox"]:checked')
                  ?.focus({ preventScroll: true });
                setSelected(new Set());
              }}
            >
              <ToolbarIcon kind="clear" />
            </button>
          </Tooltip>
        </section>
      )}
      {Boolean(error) && <ErrorNotice error={error} />}
      {capabilities.error && (
        <ErrorNotice error={capabilities.error} retry={() => void capabilities.refetch()} />
      )}
      {copied && (
        <span className="fm-copy-status" role="status">
          {t('file.pathCopied')}
        </span>
      )}
      {editing ? (
        <section
          className="fm-editor-view"
          ref={editorForm}
          aria-label={t('file.editor')}
          tabIndex={-1}
        >
          {!reading && editorAvailability === 'text' && !readError && (
            <span className="fm-editor-state sr-only" role="status">
              {t(mutating || saving ? 'web.pending' : dirty ? 'file.unsaved' : 'file.saved')}
            </span>
          )}
          {reading ? (
            <FileEditorSkeleton />
          ) : editorAvailability !== 'text' || readError ? (
            <div className="fm-editor-unavailable">
              {readError ? (
                <ErrorNotice error={readError} />
              ) : (
                <p>{t(`file.editorUnavailable.${editorAvailability}`)}</p>
              )}
              <button
                type="button"
                className="secondary"
                disabled={!transfers.data?.download.available}
                onClick={() =>
                  download(
                    `${serverPath(serverId)}/files/content?path=${encodeURIComponent(join(directory, targets[0] ?? ''))}`,
                  )
                }
              >
                {t('web.download')}
              </button>
            </div>
          ) : (
            <form
              id="file-editor-form"
              className="fm-inline-editor"
              aria-busy={mutating || saving}
              onSubmit={(event) => {
                event.preventDefault();
                void saveEditor();
              }}
            >
              {mode === 'new' && (
                <Input
                  label={t('web.name')}
                  name="name"
                  value={newName}
                  onChange={(event) => {
                    setNewName(event.target.value);
                    setDirty(true);
                  }}
                  required
                  pattern="[^/\\\\]+"
                  disabled={mutating || saving}
                />
              )}
              {Boolean(saveError) && <ErrorNotice error={saveError} />}
              <Suspense fallback={<FileEditorSkeleton />}>
                <FileTextEditor
                  key={readSequence.current}
                  path={join(
                    directory,
                    mode === 'edit' ? (targets[0] ?? '') : newName || 'new.txt',
                  )}
                  value={content}
                  onChange={(value) => {
                    contentRef.current = value;
                    setContent(value);
                    setDirty(value !== baseline.current || (mode === 'new' && newName.length > 0));
                    updateFileSaveDraft(
                      saveScope,
                      serverId,
                      join(directory, mode === 'new' ? newName : (targets[0] ?? '')),
                      value,
                    );
                  }}
                  onSave={saveShortcut}
                  onControls={setEditorControls}
                  readOnly={!canMutate || (mutating && !renaming)}
                  shouldAutoFocus={() =>
                    mode === 'edit' && document.activeElement === editorForm.current
                  }
                  label={t('service.content')}
                />
              </Suspense>
            </form>
          )}
        </section>
      ) : files.isPending ? (
        <FileListSkeleton view={view} />
      ) : files.error ? (
        <>
          <div className="fm-list fm-list-error">
            <ErrorNotice error={files.error} retry={() => void files.refetch()} />
          </div>
          <div className="fm-count" />
        </>
      ) : (
        <>
          <div className={`fm-list fm-${view}`}>
            <div className="fm-columns">
              <input
                type="checkbox"
                aria-label={t('file.selectAll')}
                checked={
                  rows.filter((entry) => !entry.is_symlink).length > 0 &&
                  rows
                    .filter((entry) => !entry.is_symlink)
                    .every((entry) => selected.has(entry.name))
                }
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? new Set(
                          rows.filter((entry) => !entry.is_symlink).map((entry) => entry.name),
                        )
                      : new Set(),
                  )
                }
              />
              {(['name', 'size', 'date'] as const).map((field) => {
                const key = field === 'date' ? 'file.modified' : `web.${field}`;
                const active = order === field;
                const arrow = active && (order !== 'name' || descending);
                return (
                  <Tooltip
                    placement="cursor"
                    key={field}
                    content={
                      active
                        ? t(descending ? 'file.descending' : 'file.ascending')
                        : t('file.sortColumn', { name: t(key) })
                    }
                  >
                    <button
                      type="button"
                      className="fm-column-button"
                      aria-label={t(key)}
                      aria-pressed={active}
                      onClick={() => {
                        if (active) setDescending((value) => !value);
                        else {
                          setOrder(field);
                          setDescending(false);
                        }
                      }}
                    >
                      {t(key)}
                      {arrow && (
                        <svg
                          className="fm-sort-arrow"
                          data-order={descending ? 'descending' : 'ascending'}
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          aria-hidden="true"
                        >
                          <path d={descending ? 'M8 2v12m-4-4 4 4 4-4' : 'M8 14V2m-4 4 4-4 4 4'} />
                        </svg>
                      )}
                    </button>
                  </Tooltip>
                );
              })}
              <span className="sr-only">{t('web.actions')}</span>
            </div>
            {directory && (
              <div className="fm-parent">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => navigate(parent)}
                  aria-label={t('service.parentFolder')}
                  onDragOver={dragOverFolder}
                  onDrop={(event) => dropFolder(event, parent)}
                >
                  <FileIcon folder />
                  ..
                </button>
              </div>
            )}
            <ul aria-label={t('file.entries')}>
              {rows.map((entry) => (
                <li
                  key={entry.name}
                  className={`fm-entry ${selected.has(entry.name) ? 'fm-selected' : ''}`}
                  draggable={canMutate && !entry.is_symlink}
                  onDragStart={(event) => {
                    const names = selected.has(entry.name) ? selectedNames : [entry.name];
                    event.dataTransfer.setData(
                      dragType,
                      JSON.stringify({ serverId, directory, names }),
                    );
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={!entry.is_file && !entry.is_symlink ? dragOverFolder : undefined}
                  onDrop={
                    !entry.is_file && !entry.is_symlink
                      ? (event) => dropFolder(event, join(directory, entry.name))
                      : undefined
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    showMenu(
                      entry,
                      event.currentTarget.querySelector<HTMLButtonElement>('.fm-menu-trigger') ??
                        event.currentTarget,
                      event.clientX,
                      event.clientY,
                    );
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={t('file.select', { name: entry.name })}
                    disabled={entry.is_symlink}
                    checked={selected.has(entry.name)}
                    onChange={() => {}}
                    onClick={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelected((current) =>
                        selectFileRange(rows, current, anchor, entry.name, event.shiftKey, checked),
                      );
                      if (!event.shiftKey) setAnchor(entry.name);
                    }}
                  />
                  <button
                    type="button"
                    className="fm-filename"
                    data-file-name={entry.name}
                    disabled={entry.is_symlink}
                    onClick={() => void open(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        showMenu(entry, event.currentTarget);
                      }
                    }}
                  >
                    <FileIcon
                      folder={!entry.is_file}
                      name={entry.name}
                      gameId={server.data?.gameId}
                      archive={isArchive(entry.name)}
                    />
                    <span>
                      {entry.name}
                      {entry.is_symlink && <small> · {t('service.symlink')}</small>}
                    </span>
                  </button>
                  <span className="fm-size">{entry.is_file ? format.bytes(entry.size) : '—'}</span>
                  <span className="fm-date">
                    <Time value={entry.modified_at} />
                  </span>
                  <button
                    type="button"
                    className="secondary fm-icon-button fm-menu-trigger"
                    aria-haspopup="menu"
                    aria-expanded={menu?.entry.name === entry.name}
                    aria-label={t('file.actionsFor', { name: entry.name })}
                    onClick={(event) => showMenu(entry, event.currentTarget)}
                  >
                    ⋯
                  </button>
                </li>
              ))}
            </ul>
            {!rows.length && <Empty text={t(search ? 'file.noMatches' : 'service.folderEmpty')} />}
          </div>
          <div className="fm-count">{t('file.items', { count: rows.length })}</div>
        </>
      )}
      {dropActive && (
        <div className="fm-drop-overlay" aria-live="polite">
          <FileIcon folder />
          <strong>{t(uploadAvailable ? 'file.dropHere' : uploadReason)}</strong>
        </div>
      )}
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('file.actionsFor', { name: menu.entry.name })}
          className="fm-menu"
          style={{ left: menu.left, top: menu.top }}
          onKeyDown={(event) => {
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            ];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              buttons[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
              ]?.focus();
            }
            if (event.key === 'Escape' || event.key === 'Tab') {
              event.preventDefault();
              setMenu(undefined);
              menuTrigger.current?.focus();
            }
          }}
        >
          {!menu.entry.is_symlink && (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={menu.entry.is_file && fileEditorAvailability(menu.entry) !== 'text'}
                aria-describedby={
                  menu.entry.is_file && fileEditorAvailability(menu.entry) !== 'text'
                    ? 'file-edit-unavailable'
                    : undefined
                }
                onClick={() => {
                  void open(menu.entry);
                  setMenu(undefined);
                }}
              >
                {t(menu.entry.is_file ? 'web.edit' : 'service.openFolder')}
              </button>
              {menu.entry.is_file && fileEditorAvailability(menu.entry) !== 'text' && (
                <small id="file-edit-unavailable" className="fm-menu-reason">
                  {t(`file.editorUnavailable.${fileEditorAvailability(menu.entry)}`)}
                </small>
              )}
              <button
                type="button"
                role="menuitem"
                disabled={!transfers.data?.download.available}
                onClick={() => {
                  downloadNames([menu.entry.name]);
                  setMenu(undefined);
                }}
              >
                {t(menu.entry.is_file ? 'web.download' : 'file.downloadZip')}
              </button>
            </>
          )}
          {canManage && !menu.entry.is_symlink && (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={!canMutate}
                onClick={() => chooseMode('rename', [menu.entry.name])}
              >
                {t('service.rename')}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!canMutate}
                onClick={() => chooseMode('move', [menu.entry.name])}
              >
                {t('file.move')}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!canMutate || capabilities.data?.copy !== true}
                onClick={() => chooseMode('copy', [menu.entry.name])}
              >
                {t('file.copy')}
              </button>
              {menu.entry.is_file && isArchive(menu.entry.name) && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canMutate || capabilities.data?.extract !== true}
                  onClick={() => chooseMode('extract', [menu.entry.name])}
                >
                  {t('file.extract')}
                </button>
              )}
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const path = join(directory, menu.entry.name);
              setMenu(undefined);
              navigator.clipboard
                .writeText(`/${path}`)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch((failure) => setError(failure));
            }}
          >
            {t('file.copyPath')}
          </button>
          {canManage && !menu.entry.is_symlink && (
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={!canMutate}
              onClick={() => chooseMode('delete', [menu.entry.name])}
            >
              {t('web.delete')}
            </button>
          )}
        </div>
      )}
      {preparingFolder && (
        <div className="fm-folder-progress" role="status">
          <span>{t('file.folderPreparing')}</span>
          <button
            type="button"
            className="text-button"
            onClick={() => folderPreparation.current?.abort()}
          >
            {t('web.cancel')}
          </button>
        </div>
      )}
      {visibleUploads.length > 0 && (
        <section className="fm-uploads" aria-label={t('web.upload')}>
          <header>
            <strong>{t('web.upload')}</strong>
          </header>
          {uploadPause && (
            <div className="notice">
              <p role="status">
                {t(
                  uploadPause === 'checking'
                    ? 'file.uploadQueueChecking'
                    : uploadPause === 'busy'
                      ? 'file.uploadQueueBusy'
                      : 'file.uploadQueuePaused',
                )}
              </p>
              <button
                type="button"
                className="text-button"
                disabled={uploadPause === 'checking'}
                onClick={() => void runUploads()}
              >
                {t('file.resumeUploads')}
              </button>
            </div>
          )}
          <ul>
            {visibleUploads.map((item) => (
              <li key={item.id}>
                <div className="fm-upload-name">
                  <span>{item.path.slice(item.directory ? item.directory.length + 1 : 0)}</span>
                  <span>{t(`file.upload.${item.status}`)}</span>
                  {['queued', 'waiting', 'uploading', 'confirming'].includes(item.status) && (
                    <button
                      type="button"
                      className="text-button"
                      aria-label={t('file.cancelUpload', { name: item.file.name })}
                      onClick={() => cancelUpload(item.id)}
                    >
                      {t('web.cancel')}
                    </button>
                  )}
                </div>
                {['uploading', 'confirming'].includes(item.status) && (
                  <>
                    <progress
                      value={item.sent}
                      max={Math.max(1, item.file.size)}
                      aria-label={item.file.name}
                    />
                    <small>
                      {format.bytes(item.sent)} / {format.bytes(item.file.size)} ·{' '}
                      {format.bytes(item.speed)}/s
                    </small>
                  </>
                )}
                {Boolean(item.error) && <ErrorNotice error={item.error} />}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Dialog
        open={pendingUploads.length > 0}
        title={t('file.replaceTitle')}
        closeIcon
        onClose={() => setPendingUploads([])}
      >
        <p>{t('file.replaceWarning')}</p>
        <ul>
          {pendingUploads
            .filter((file) => files.data?.some((entry) => entry.name === file.name))
            .map((file) => (
              <li key={file.name}>{file.name}</li>
            ))}
        </ul>
        <button type="button" onClick={() => queueUploads(pendingUploads)}>
          {t('file.replaceUpload')}
        </button>
      </Dialog>
      {transferFlow.dialog}
      <Dialog
        open={Boolean(mode) && !editing}
        className={mode === 'delete' ? 'fm-delete-confirm' : undefined}
        title={t(
          mode === 'mkdir'
            ? 'service.newFolder'
            : mode === 'rename'
              ? 'service.rename'
              : mode === 'delete'
                ? 'web.delete'
                : 'file.extract',
        )}
        onClose={closeEditor}
        closeIcon
        closeDisabled={mutating}
      >
        <ActionForm
          key={`${mode}:${targets.join(',')}`}
          success={false}
          destructive={mode === 'delete'}
          onCancel={mode === 'delete' ? closeEditor : undefined}
          submitLabel={t(
            mode === 'delete' ? 'web.delete' : mode === 'extract' ? 'file.extract' : 'web.save',
          )}
          onSubmit={async (data) => {
            if (!canMutate) throw { messageKey: 'error.forbidden' };
            if (mode === 'mkdir')
              await mutation({ action: 'mkdir', root: directory, name: text(data, 'name') });
            else if (mode === 'delete')
              await mutation({ action: 'delete', root: directory, files: targets, confirm: true });
            else if (mode === 'rename')
              await mutation({
                action: 'rename',
                root: directory,
                files: [{ from: targets[0], to: text(data, 'name') }],
              });
            else if (mode === 'extract')
              await mutation(
                {
                  root: directory,
                  file: targets[0],
                  destination: text(data, 'name'),
                  confirm: true,
                },
                '/files/extract',
              );
          }}
        >
          {(mode === 'mkdir' || mode === 'rename' || mode === 'extract') && (
            <Input
              label={t(mode === 'extract' ? 'file.extractFolder' : 'web.name')}
              name="name"
              required
              pattern="[^/\\\\]+"
              defaultValue={
                mode === 'rename'
                  ? targets[0]
                  : mode === 'extract'
                    ? `${targets[0]?.replace(/\.(tar\.)?(gz|bz2|xz|zip|tar|tgz|tbz2|txz)$/i, '')}-extracted`
                    : ''
              }
            />
          )}
          {mode === 'delete' && (
            <>
              <FileSelectionSummary names={targets} />
              <p>{t('file.deleteWarning', { count: targets.length })}</p>
            </>
          )}
          {mode === 'extract' && <p>{t('file.extractWarning')}</p>}
        </ActionForm>
      </Dialog>
    </section>
  );
}
