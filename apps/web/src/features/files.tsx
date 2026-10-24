import type { FilemanContext } from '@nickhosting/game-sdk/ui';
import { useQuery } from '@tanstack/react-query';
import {
  type DragEvent,
  type KeyboardEvent,
  lazy,
  type MouseEvent,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation } from 'react-router';
import { fileEditorAvailability } from '../../../../packages/core/src/file-content.js';
import { ApiError, api, apiError, download, queryClient, upload } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { useNavigationGuard } from '../components/navigation-guard.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  ConfirmDialog,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  text,
} from '../components/ui.js';
import {
  type FileClipboard,
  type FileOrder,
  fileBreadcrumbs,
  fileClipboardForScope,
  joinFilePath as join,
  normalizeFilePath,
  selectFileClick,
  selectFileRange,
  validMoveTarget,
  visibleFiles,
} from './file-manager-model.js';
import type { FileEditorControls } from './file-text-editor.js';
import { SftpPage } from './sftp.js';

const importEditor = () =>
  import('./viewer-engine/document-editor.js').then((module) => ({
    default: module.DocumentEditor,
  }));
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
import { clearFileListing, readFileListing, writeFileListing } from './file-listing-cache.js';
import { FilePathPicker } from './file-path-picker.js';
import { FileSelectionSummary, useFileTransfer } from './file-transfer-flow.js';
import { nextUpload, planUploadBatch, runUploadPool } from './file-upload-queue.js';
import { gameFilemanExtensions } from './fileman/extensions.js';
import { FilemanHost, FilemanSlot } from './fileman/host.js';
import {
  FilemanBreadcrumbs,
  FilemanContextMenu,
  FilemanListing,
  FilemanListSkeleton,
  FilemanParent,
  FilemanSearch,
  FilemanSelectionBar,
  FilemanToolbar,
  FilemanViewToggle,
  FilemanToolbarIcon as ToolbarIcon,
} from './fileman/presentation.js';
import { FolderUploadError, planFolderUpload, prepareFolderUpload } from './folder-upload.js';
import { InlineFileRename } from './inline-file-rename.js';
import { validFilename } from './inline-file-rename-model.js';
import { useDirectoryPrefetch } from './use-directory-prefetch.js';
import { useViewerEscape } from './use-viewer-escape.js';
import { isSingleCompressed } from './viewer-engine/core/compressed.js';
import {
  canUseDocumentView,
  documentViews,
  isDocumentView,
} from './viewer-engine/core/document-registry.js';
import {
  availableViewers,
  preferredViewer,
  savedViewer,
  selectableViewers,
  type ViewerId,
  type ViewerSource,
} from './viewer-engine/core/registry.js';
import { OpenWith, OpenWithIcon } from './viewer-engine/open-with.js';
import {
  useViewerCapabilities,
  useViewerPreferences,
  viewerCapabilitiesQuery,
  viewerPreferencesQuery,
} from './viewer-engine/preferences.js';
import { readViewerBookmark, writeViewerBookmark } from './viewer-engine/session.js';
import './viewer-engine/viewer.css';

const FileViewer = lazy(() =>
  import('./viewer-engine/engine.js').then((module) => ({ default: module.FileViewer })),
);

type Mode = 'mkdir' | 'new' | 'edit' | 'view' | 'rename' | 'delete' | 'extract';
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
const springOpenDelay = 1050;
const filePlaceholders = Array.from({ length: 12 }, (_, index) => ({
  id: `file-placeholder-${index}`,
  width: `${40 + (index % 4) * 12}%`,
}));

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
  const [sftpOpen, setSftpOpen] = useState(
    () => new URLSearchParams(location.search).get('sftp') === 'open',
  );
  const [sftpBusy, setSftpBusy] = useState(false);
  const recoveredSave = useRef<string | undefined>(undefined);
  const saveIdentity = useRef(saveScope?.join('\0'));
  saveIdentity.current = saveScope?.join('\0');
  const macKeyboard = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  const pathShortcut = `${macKeyboard ? '⌥' : 'ALT'} + G`;
  const searchInput = useRef<HTMLInputElement>(null);
  const server = useServer(serverId),
    transfers = useTransfers(serverId);
  const viewerIdentity = saveScope?.join('\0') ?? '';
  const viewerCapabilities = useViewerCapabilities(serverId, viewerIdentity);
  const viewerPreferences = useViewerPreferences(serverId, viewerIdentity);
  const directoryKey = saveScope
    ? JSON.stringify(['file-directory', ...saveScope, serverId])
    : undefined;
  const viewerKey = directoryKey ? `viewer:${directoryKey}` : undefined;
  const reloadViewer = useMemo(() => readViewerBookmark(viewerKey), [viewerKey]);
  const restoreAttempt = useRef<string | undefined>(undefined);
  const [restoredViewerKey, setRestoredViewerKey] = useState<string>();
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
  }
  useEffect(() => {
    if (!directoryKey) return;
    try {
      sessionStorage.setItem(directoryKey, directory);
    } catch {
      // Browsers may disable storage; folder navigation still works normally.
    }
    // A page reload retains storage; leaving Files unmounts the workspace.
    // Writing on setup also preserves the path through StrictMode effect replay.
    return () => {
      try {
        sessionStorage.removeItem(directoryKey);
      } catch {
        // Storage may be unavailable here as well.
      }
    };
  }, [directoryKey, directory]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string>();
  const [clipboard, setClipboard] = useState<FileClipboard>();
  const clipboardIdentity = saveIdentity.current;
  useEffect(() => {
    setClipboard((current) => fileClipboardForScope(current, clipboardIdentity, serverId));
  }, [clipboardIdentity, serverId]);
  const scopedClipboard = fileClipboardForScope(clipboard, clipboardIdentity, serverId);
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
  const [extractFromViewer, setExtractFromViewer] = useState(false);
  const [extractSelection, setExtractSelection] = useState<{
    entries?: string[];
    archives?: string[];
  }>();
  const [viewerBreadcrumb, setViewerBreadcrumb] = useState<HTMLOListElement | null>(null);
  const [viewerContext, setViewerContext] = useState<Partial<FilemanContext>>({});
  const [viewed, setViewed] = useState<{
    entry: ServerFile;
    source: ViewerSource;
    viewerId?: ViewerId;
    autoDecodeCompressed?: boolean;
  }>();
  const [viewerBeforeHome, setViewerBeforeHome] = useState<HTMLSpanElement | null>(null);
  const [viewerAfterHome, setViewerAfterHome] = useState<HTMLSpanElement | null>(null);
  const [viewerSearch, setViewerSearch] = useState<HTMLSpanElement | null>(null);
  const [viewerView, setViewerView] = useState<HTMLSpanElement | null>(null);
  const [viewerTools, setViewerTools] = useState<HTMLSpanElement | null>(null);
  const [openWith, setOpenWith] = useState<{ entry: ServerFile; source: ViewerSource }>();
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
  const [editorView, setEditorView] = useState<ViewerId>('text');
  const [editorFragment, setEditorFragment] = useState<string>();
  const [editorViewActions, setEditorViewActions] = useState<HTMLSpanElement | null>(null);
  const pendingViewChanges = Boolean(editorControls?.pendingChanges);
  const managerRef = useRef<HTMLElement>(null);
  const focusDirectory = useRef(false);
  useLayoutEffect(() => {
    if (!focusDirectory.current) return;
    const current = managerRef.current?.querySelector<HTMLButtonElement>(
      '.fm-breadcrumb button[aria-current="page"]',
    );
    if (current) {
      current.focus({ preventScroll: true });
      focusDirectory.current = false;
    }
  });
  const [inlineRename, setInlineRename] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const renamedFileFocus = useRef(false);
  const [editorAvailability, setEditorAvailability] =
    useState<ReturnType<typeof fileEditorAvailability>>('text');
  const editing = mode === 'edit' || mode === 'new';
  const viewing = mode === 'view' || (mode === 'extract' && extractFromViewer);
  const displaying = editing || viewing;

  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<{ entry: ServerFile; left: number; top: number }>();
  const [dropActive, setDropActive] = useState(false);
  const [hoverDestination, setHoverDestination] = useState<string>();
  const dragSession = useRef<
    { identity: string | undefined; serverId: string; source: string; names: string[] } | undefined
  >(undefined);
  const hoverTarget = useRef<string | undefined>(undefined);
  const springTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const finish = () => {
      window.clearTimeout(springTimer.current);
      springTimer.current = undefined;
      hoverTarget.current = undefined;
      dragSession.current = undefined;
      setHoverDestination(undefined);
    };
    window.addEventListener('dragend', finish, true);
    window.addEventListener('drop', finish);
    window.addEventListener('blur', finish);
    const leaveWindow = (event: globalThis.DragEvent) => {
      if (
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight
      )
        finish();
    };
    window.addEventListener('dragleave', leaveWindow);
    return () => {
      window.removeEventListener('dragend', finish, true);
      window.removeEventListener('drop', finish);
      window.removeEventListener('blur', finish);
      window.removeEventListener('dragleave', leaveWindow);
      finish();
    };
  }, []);
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
  const cachedListing = useMemo(
    () => readFileListing(saveScope, serverId, directory),
    [saveScope, serverId, directory],
  );
  const files = useQuery({
    ...directoryQuery,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    staleTime: 0,
    // A restored snapshot is display data, never evidence of a fresh listing.
    placeholderData: cachedListing,
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
    if (files.error instanceof ApiError && [401, 403, 404].includes(files.error.status)) {
      clearFileListing();
    } else if (files.data && files.dataUpdatedAt > 0 && !files.error) {
      writeFileListing(saveScope, serverId, directory, files.data);
    }
  }, [saveScope, serverId, directory, files.data, files.dataUpdatedAt, files.error]);
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
  useDirectoryPrefetch({
    serverId,
    directory,
    identity: JSON.stringify(directoryQuery.queryKey[3]),
    container: managerRef,
    rows,
    enabled: Boolean(saveScope && files.data && !files.error && !displaying),
  });
  const canManage = server.data?.permissionKeys.includes('files.write') === true;
  const canMutate = canManage && server.data?.availableActions.files === true;
  const canDelete =
    server.data?.permissionKeys.includes('files.delete') === true &&
    server.data?.availableActions.files === true;
  const canSftp = server.data?.permissionKeys.includes('files.sftp') === true;
  const canMutateRef = useRef(canMutate);
  canMutateRef.current = canMutate;
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
  const fileActionsBusy = mutating || transferFlow.active;
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
      const searchRequest = modifier && event.code === 'KeyK' && !displaying;
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
  }, [editPath, displaying]);
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
        pendingViewChanges ||
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
  }, [dirty, pendingViewChanges]);
  const navigationGuard = useRef<() => boolean>(() => false);
  navigationGuard.current = () => hasUnsubmittedChanges() || mutationRunning.current;
  const navigationBlocker = useNavigationGuard(() => navigationGuard.current(), true);
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
    if (pendingViewChanges) return true;
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
  function discardReloadViewer() {
    restoreAttempt.current = viewerKey;
    setRestoredViewerKey(viewerKey);
  }
  function navigate(path: string, preserveName = false, duringDrag = false) {
    if (mutationRunning.current || transferFlow.active) return;
    const normalized = normalizeFilePath(path);
    if (normalized === undefined) {
      setError({ messageKey: 'file.invalidPath' });
      return;
    }
    if (!confirmEditorExit()) return;
    discardReloadViewer();
    focusDirectory.current = !duringDrag;
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
    if (mode === 'extract' && extractFromViewer) {
      setMode('view');
      setExtractFromViewer(false);
      return;
    }
    if (!confirmEditorExit()) return;
    discardReloadViewer();
    cancelRead();
    setSaving(false);
    setInlineRename(false);
    setDirty(false);
    setMode(undefined);
    setReadError(undefined);
    requestAnimationFrame(() => {
      if (!mounted.current) return;
      // Native dialog restoration or a subsequent click may already have moved
      // focus somewhere useful. Never pull it back out of the user's input.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.isConnected &&
        !active.closest('dialog:not([open])')
      )
        return;
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
    if (mutationRunning.current || transferFlow.active) return;
    if (
      value === 'delete'
        ? !canDelete
        : value === 'move' || value === 'rename'
          ? !canMutate || !canDelete
          : value !== 'view' && !canMutate
    )
      return;
    if (!menu) menuTrigger.current = document.activeElement as HTMLElement;
    setError(undefined);
    setMenu(undefined);
    setTargets(names);
    setExtractSelection(undefined);
    setExtractFromViewer(false);
    if (value === 'move' || value === 'copy') {
      transferFlow.begin({ source: directory, destination: folder, names }, value);
      return;
    }
    discardReloadViewer();
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
  function viewerSource(entry: ServerFile, folder = directory): ViewerSource {
    return {
      path: join(folder, entry.name),
      name: entry.name,
      size: entry.size,
      gameId: server.data?.gameId,
    };
  }
  const menuCanOpen =
    menu &&
    (!menu.entry.is_file ||
      (viewerCapabilities.data?.available === true
        ? Boolean(preferredViewer(viewerSource(menu.entry), viewerPreferences.data?.preferences))
        : availableViewers(viewerSource(menu.entry)).some((choice) => choice.id === 'text')));
  async function open(
    entry: ServerFile,
    folder = directory,
    forcedViewer?: ViewerId,
    autoDecodeCompressed = forcedViewer !== 'archive',
    fragment?: string,
  ) {
    if (mutationRunning.current || transferFlow.active) return;
    if (!menu) menuTrigger.current = document.activeElement as HTMLElement;
    if (entry.is_symlink) return;
    if (!entry.is_file) {
      navigate(join(folder, entry.name), true);
      return;
    }
    if (!confirmEditorExit()) return;
    discardReloadViewer();
    const pending = getFileSave(saveScope, serverId, join(folder, entry.name));
    if (pending) {
      restoreSave(pending);
      return;
    }
    const source = viewerSource(entry, folder);
    let viewerId = forcedViewer;
    if (!viewerId) {
      const sequence = ++readSequence.current;
      const identity = saveIdentity.current;
      try {
        const capabilities = await queryClient.ensureQueryData(
          viewerCapabilitiesQuery(serverId, viewerIdentity),
        );
        // Local document/editor preferences do not require the optional remote
        // viewer service. Keep remote-only choices behind its availability gate.
        const preferences =
          viewerPreferences.data?.preferences ??
          (await queryClient.ensureQueryData(viewerPreferencesQuery(serverId, viewerIdentity)))
            .preferences;
        const preferred = preferredViewer(source, preferences);
        if (capabilities.available || canUseDocumentView(source, preferred)) {
          viewerId = preferred;
          if (isSingleCompressed(source) && savedViewer(source, preferences) === 'archive')
            autoDecodeCompressed = false;
        }
      } catch (failure) {
        setError(failure);
        // Optional viewer metadata must not disable the independent text editor.
        // Keep the failed lookup visible instead of claiming a default was applied.
        if (fileEditorAvailability(entry) !== 'text') return;
      }
      if (
        !mounted.current ||
        sequence !== readSequence.current ||
        identity !== saveIdentity.current
      )
        return;
    }
    viewerId ??= documentViews(source.name)[0]?.id;
    if (
      viewerId &&
      (!canUseDocumentView(source, viewerId) ||
        (autoDecodeCompressed && isSingleCompressed(source)))
    ) {
      cancelRead();
      setPathEditing(false);
      setDirectory(folder);
      setTargets([entry.name]);
      setDirty(false);
      setViewed({ entry, source, viewerId, autoDecodeCompressed });
      setMode('view');
      setMenu(undefined);
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
    setEditorView(viewerId ?? 'text');
    setEditorFragment(fragment);
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
  const reopenViewer = useEffectEvent(
    (entry: ServerFile, folder: string, choice?: ViewerId, autoDecodeCompressed?: boolean) =>
      open(entry, folder, choice, autoDecodeCompressed),
  );
  useEffect(() => {
    if (!viewerKey || restoreAttempt.current === viewerKey) return;
    // Explicit save recovery/navigation wins over a reload bookmark.
    if (!reloadViewer || mode || location.state?.fileSaveId) {
      restoreAttempt.current = viewerKey;
      setRestoredViewerKey(viewerKey);
      return;
    }
    const separator = reloadViewer.path.lastIndexOf('/');
    const folder = separator < 0 ? '' : reloadViewer.path.slice(0, separator);
    if (folder !== directory) {
      restoreAttempt.current = viewerKey;
      setRestoredViewerKey(viewerKey);
      return;
    }
    if (!server.data || (!files.data && !files.error) || files.isPlaceholderData) return;
    restoreAttempt.current = viewerKey;
    const entry = files.data?.find(
      (item) =>
        item.is_file && !item.is_symlink && join(directory, item.name) === reloadViewer.path,
    );
    if (!entry) {
      setRestoredViewerKey(viewerKey);
      return;
    }
    const source = {
      path: reloadViewer.path,
      name: entry.name,
      size: entry.size,
      gameId: server.data.gameId,
    };
    const choice = selectableViewers(source).some((item) => item.id === reloadViewer.viewerId)
      ? reloadViewer.viewerId
      : undefined;
    void reopenViewer(entry, directory, choice, reloadViewer.autoDecodeCompressed).finally(() => {
      if (mounted.current) setRestoredViewerKey(viewerKey);
    });
  }, [
    viewerKey,
    reloadViewer,
    directory,
    files.data,
    files.error,
    files.isPlaceholderData,
    server.data,
    mode,
    location.state?.fileSaveId,
  ]);
  useEffect(() => {
    if (restoredViewerKey !== viewerKey) return;
    writeViewerBookmark(
      viewerKey,
      viewing && viewed
        ? {
            path: viewed.source.path,
            viewerId: viewed.viewerId ?? 'text',
            autoDecodeCompressed: viewed.autoDecodeCompressed,
          }
        : mode === 'edit' && activeFile
          ? { path: join(directory, activeFile), viewerId: editorView }
          : undefined,
    );
  }, [viewerKey, restoredViewerKey, viewing, viewed, mode, directory, activeFile, editorView]);
  useEffect(() => () => writeViewerBookmark(viewerKey), [viewerKey]);

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
      setMode(mode === 'extract' && extractFromViewer ? 'view' : undefined);
      setExtractFromViewer(false);
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
    const scope = saveIdentity.current;
    if (editorControls?.flush && !(await editorControls.flush())) return;
    if (!mounted.current || sequence !== readSequence.current || scope !== saveIdentity.current)
      return;
    if (getFileSave(saveScope, serverId, join(directory, name))?.status === 'pending') return;
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
    if (
      !canMutate ||
      !canDelete ||
      dirty ||
      pendingViewChanges ||
      mutationRunning.current ||
      saving ||
      reading
    )
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
  const unfocusedPaste = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
  useViewerEscape(displaying && !pathEditing && !inlineRename && !transferFlow.active, closeEditor);
  unfocusedPaste.current = (event) => {
    // A browser can drop focus to its document when the previous folder's row
    // disappears. Paste still belongs to the mounted Files view in that case.
    // Never capture a shortcut directed at another control or application tab.
    if (
      (event.target === document.body || event.target === document.documentElement) &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'v'
    )
      keyboard(event);
  };
  useEffect(() => {
    const paste = (event: globalThis.KeyboardEvent) => unfocusedPaste.current(event);
    document.addEventListener('keydown', paste);
    return () => document.removeEventListener('keydown', paste);
  }, []);
  function keyboard(event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) {
    const target = event.target as HTMLElement;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (
      displaying ||
      event.defaultPrevented ||
      ('nativeEvent' in event ? event.nativeEvent.isComposing : event.isComposing) ||
      target.closest(
        'input:not([type="checkbox"]),textarea,select,[contenteditable]:not([contenteditable="false"]),dialog',
      )
    )
      return;
    if (event.key === 'Escape') {
      setSelected(new Set());
      setMenu(undefined);
      return;
    }
    if (
      event.repeat ||
      event.altKey ||
      mutationRunning.current ||
      transferFlow.active ||
      mode ||
      menu ||
      document.querySelector('dialog[open]') ||
      (window.getSelection()?.toString() && !(modifier && key === 'v'))
    )
      return;
    if (modifier && key === 'a') {
      event.preventDefault();
      setSelected(new Set(rows.filter((entry) => !entry.is_symlink).map((entry) => entry.name)));
    } else if (modifier && (key === 'c' || key === 'x')) {
      if (
        !clipboardIdentity ||
        !selectedNames.length ||
        !canMutate ||
        (key === 'x' && !canDelete) ||
        (key === 'c' && capabilities.data?.copy !== true)
      )
        return;
      event.preventDefault();
      setClipboard({
        identity: clipboardIdentity,
        serverId,
        source: directory,
        names: selectedNames,
        action: key === 'x' ? 'move' : 'copy',
      });
    } else if (modifier && key === 'v' && scopedClipboard) {
      if (
        !canMutate ||
        (scopedClipboard.action === 'move' && !canDelete) ||
        (scopedClipboard.action === 'copy' && capabilities.data?.copy !== true)
      )
        return;
      event.preventDefault();
      if (!validMoveTarget(scopedClipboard.source, scopedClipboard.names, directory)) {
        setError({ messageKey: 'file.invalidMove' });
        return;
      }
      menuTrigger.current = document.activeElement as HTMLElement;
      setError(undefined);
      transferFlow.begin(
        {
          source: scopedClipboard.source,
          destination: directory,
          names: scopedClipboard.names,
        },
        scopedClipboard.action,
        false,
        {
          quietChecking: true,
          onSubmitted:
            scopedClipboard.action === 'move'
              ? () => setClipboard((current) => (current === scopedClipboard ? undefined : current))
              : undefined,
        },
      );
    } else if (!modifier && event.key === 'Delete' && selectedNames.length && canDelete) {
      event.preventDefault();
      chooseMode('delete');
    }
  }
  function selectEntry(entry: ServerFile, event: MouseEvent<HTMLElement>) {
    if (entry.is_symlink || mutationRunning.current || transferFlow.active) return;
    const button = event.currentTarget.matches('.fm-filename')
      ? event.currentTarget
      : event.currentTarget.querySelector<HTMLButtonElement>('.fm-filename');
    button?.focus();
    setSelected((current) =>
      selectFileClick(rows, current, anchor, entry.name, {
        additive: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
      }),
    );
    if (!event.shiftKey || !anchor) setAnchor(entry.name);
  }
  function dropFolder(event: DragEvent, folder: string) {
    if (
      !event.dataTransfer.types.includes(dragType) ||
      !canMutate ||
      !canDelete ||
      mutationRunning.current
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const payload = dragSession.current;
    clearDragSession();
    if (!payload || payload.identity !== saveIdentity.current || payload.serverId !== serverId)
      return;
    // A drop onto the source or a selected folder cannot move anything.
    // Ignore it like a cancelled drag instead of showing a page-wide error.
    if (!validMoveTarget(payload.source, payload.names, folder)) return;
    setMenu(undefined);
    setError(undefined);
    menuTrigger.current = document.activeElement as HTMLElement;
    transferFlow.begin(
      { source: payload.source, destination: folder, names: payload.names },
      'move',
      false,
    );
  }
  function clearHover() {
    window.clearTimeout(springTimer.current);
    springTimer.current = undefined;
    hoverTarget.current = undefined;
    setHoverDestination(undefined);
  }
  function clearDragSession() {
    clearHover();
    dragSession.current = undefined;
  }
  function dragOverFolder(event: DragEvent, path: string) {
    const payload = dragSession.current;
    if (event.dataTransfer.types.includes(dragType)) event.stopPropagation();
    if (
      !canMutate ||
      !canDelete ||
      mutationRunning.current ||
      !event.dataTransfer.types.includes(dragType) ||
      !payload ||
      payload.identity !== saveIdentity.current ||
      payload.serverId !== serverId ||
      !validMoveTarget(payload.source, payload.names, path)
    ) {
      if (hoverTarget.current === path) clearHover();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (hoverTarget.current === path) return;
    clearHover();
    hoverTarget.current = path;
    setHoverDestination(path);
    if (path !== directory) {
      springTimer.current = window.setTimeout(() => {
        if (
          hoverTarget.current !== path ||
          !dragSession.current ||
          dragSession.current.identity !== saveIdentity.current ||
          !canMutateRef.current ||
          mutationRunning.current
        )
          return;
        clearHover();
        navigate(path, false, true);
      }, springOpenDelay);
    }
  }
  function dragLeaveFolder(event: DragEvent, path: string) {
    const target = event.currentTarget;
    const { clientX, clientY } = event;
    window.setTimeout(() => {
      if (
        hoverTarget.current === path &&
        !target.contains(document.elementFromPoint(clientX, clientY))
      )
        clearHover();
    }, 0);
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
    if (mutationRunning.current || transferFlow.active) return;
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
    if (mutationRunning.current || transferFlow.active) return;
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
    <FilemanHost
      context={{
        serverId,
        gameId: server.data?.gameId,
        path: editing ? join(directory, mode === 'new' ? newName : (targets[0] ?? '')) : directory,
        surface: displaying ? 'viewer' : 'directory',
        viewerId: displaying ? (viewing ? viewed?.viewerId : editorView) : undefined,
        readOnly: viewing || !canMutate,
        ...(viewing ? viewerContext : {}),
      }}
      extensions={gameFilemanExtensions}
    >
      <section
        className="file-manager"
        ref={managerRef}
        aria-label={t('web.files')}
        tabIndex={-1}
        onKeyDown={keyboard}
        onDragEnter={(event) => {
          if (!displaying && !fileActionsBusy && event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            setDropActive(true);
          }
        }}
        onDragOver={(event) => {
          if (
            !displaying &&
            event.dataTransfer.types.includes(dragType) &&
            (event.target as Element).closest('.fm-list')
          )
            dragOverFolder(event, directory);
          if (!displaying && event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = uploadAvailable && !fileActionsBusy ? 'copy' : 'none';
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false);
        }}
        onDrop={(event) => {
          if (
            !displaying &&
            event.dataTransfer.types.includes(dragType) &&
            (event.target as Element).closest('.fm-list')
          ) {
            dropFolder(event, directory);
            return;
          }
          if (!displaying && event.dataTransfer.types.includes('Files')) {
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
        <FilemanToolbar editing={displaying}>
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
            <FilemanBreadcrumbs
              parts={fileBreadcrumbs(directory)}
              listRef={setViewerBreadcrumb}
              current={!displaying}
              onNavigate={navigate}
              buttonProps={(part) => ({
                className: hoverDestination === part.path ? 'fm-drop-hover' : '',
                onDragOver: (event) => dragOverFolder(event, part.path),
                onDragLeave: (event) => dragLeaveFolder(event, part.path),
                onDrop: (event) => dropFolder(event, part.path),
              })}
              trailing={
                displaying &&
                !viewing && (
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
                        {(dirty || pendingViewChanges) && <span aria-hidden="true"> *</span>}
                      </span>
                    )}
                  </li>
                )
              }
              actions={
                !displaying ? (
                  <Tooltip
                    placement="cursor"
                    content={t('file.editPath', { shortcut: pathShortcut })}
                  >
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
                  canManage &&
                  canDelete && (
                    <Tooltip
                      placement="cursor"
                      content={t(dirty ? 'file.saveBeforeRename' : 'service.rename')}
                    >
                      <button
                        type="button"
                        className="fm-tool fm-path-edit"
                        aria-label={t('service.rename')}
                        disabled={
                          !canMutate ||
                          dirty ||
                          pendingViewChanges ||
                          reading ||
                          mutating ||
                          saving ||
                          inlineRename
                        }
                        onClick={() => setInlineRename(true)}
                      >
                        <ToolbarIcon kind="rename" />
                      </button>
                    </Tooltip>
                  )
                )
              }
            />
          )}
          {!displaying && (
            <>
              <FilemanSearch
                inputRef={searchInput}
                value={search}
                onChange={setSearch}
                onFocus={() => setPathEditing(false)}
                shortcut={macKeyboard ? '⌥ + K' : 'ALT + K'}
              />
              <div className="fm-tools">
                {canSftp && (
                  <button type="button" className="secondary" onClick={() => setSftpOpen(true)}>
                    {t('web.sftp')}
                  </button>
                )}
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
                        disabled={!canMutate || preparingFolder || fileActionsBusy}
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
                        disabled={!canMutate || preparingFolder || fileActionsBusy}
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
                        disabled={fileActionsBusy}
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
                        disabled={fileActionsBusy}
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
              <FilemanViewToggle view={view} onChange={setView} />
            </>
          )}
          {viewing && <span className="fm-viewer-chrome-slot" ref={setViewerSearch} />}
          {viewing && (
            <div className="fm-editor-toolbar">
              <span className="fm-viewer-chrome-slot" ref={setViewerTools} />
              <span className="fm-viewer-action-slot" ref={setViewerBeforeHome} />
              <Tooltip placement="cursor" content={t('file.backToFiles')}>
                <button
                  type="button"
                  className="fm-tool"
                  aria-label={t('file.backToFiles')}
                  onClick={closeEditor}
                >
                  <ToolbarIcon kind="home" />
                </button>
              </Tooltip>
              <span className="fm-viewer-action-slot" ref={setViewerAfterHome} />
            </div>
          )}
          {viewing && <span className="fm-viewer-chrome-slot" ref={setViewerView} />}
          {editing && (
            <div className="fm-editor-toolbar" role="toolbar" aria-label={t('file.editor')}>
              {(
                [
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
                      (!dirty && !pendingViewChanges && mode !== 'new'),
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
              <span className="fm-document-view-actions" ref={setEditorViewActions} />
              {mode === 'edit' && (
                <Tooltip placement="cursor" content={t('viewer.openWith')}>
                  <button
                    type="button"
                    className="fm-viewer-action fm-viewer-open-with"
                    aria-label={t('viewer.openWith')}
                    disabled={saving || reading || mutating}
                    onClick={() => {
                      const entry = files.data?.find((item) => item.name === targets[0]);
                      if (entry)
                        setOpenWith({
                          entry,
                          source: viewerSource(entry),
                        });
                    }}
                  >
                    <OpenWithIcon />
                    <span className="fm-viewer-action-label">{t('viewer.openWith')}</span>
                  </button>
                </Tooltip>
              )}
              <Tooltip placement="cursor" content={t('file.backToFiles')}>
                <button
                  type="button"
                  className="fm-tool"
                  aria-label={t('file.backToFiles')}
                  disabled={mutating}
                  onClick={closeEditor}
                >
                  <ToolbarIcon kind="home" />
                </button>
              </Tooltip>
              {mode === 'edit' && (
                <Tooltip placement="cursor" content={t('web.download')}>
                  <button
                    type="button"
                    className="fm-tool"
                    aria-label={t('web.download')}
                    disabled={!transfers.data?.download.available}
                    onClick={() =>
                      download(
                        `${serverPath(serverId)}/files/content?path=${encodeURIComponent(join(directory, targets[0] ?? ''))}`,
                      )
                    }
                  >
                    <ToolbarIcon kind="download" />
                  </button>
                </Tooltip>
              )}
            </div>
          )}
        </FilemanToolbar>
        {!displaying && totalSelected > 0 && (
          <FilemanSelectionBar
            count={totalSelected}
            onClear={() => {
              managerRef.current
                ?.querySelector<HTMLInputElement>('.fm-entry input[type="checkbox"]:checked')
                ?.focus({ preventScroll: true });
              setSelected(new Set());
            }}
          >
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
                    disabled={!canMutate || !canDelete || fileActionsBusy}
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
                    disabled={!canMutate || fileActionsBusy || capabilities.data?.copy !== true}
                    onClick={() => chooseMode('copy')}
                  >
                    <ToolbarIcon kind="copy" />
                  </button>
                </Tooltip>
              </>
            )}
            {canDelete && (
              <Tooltip placement="cursor" content={t('web.delete')}>
                <button
                  type="button"
                  className="fm-tool fm-selection-delete"
                  aria-label={t('web.delete')}
                  disabled={!canDelete || fileActionsBusy}
                  onClick={() => chooseMode('delete')}
                >
                  <ToolbarIcon kind="delete" />
                </button>
              </Tooltip>
            )}
          </FilemanSelectionBar>
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
        {viewing && viewed ? (
          <Suspense fallback={<FileEditorSkeleton />}>
            <FileViewer
              key={`${viewerIdentity}:${viewed.source.path}`}
              source={viewed.source}
              viewerId={viewed.viewerId}
              onContextChange={setViewerContext}
              serverId={serverId}
              identity={viewerIdentity}
              autoDecodeCompressed={viewed.autoDecodeCompressed}
              onViewerChange={(viewerId, options) =>
                setViewed((current) =>
                  current &&
                  (current.viewerId !== viewerId ||
                    current.autoDecodeCompressed !== options?.autoDecodeCompressed)
                    ? { ...current, viewerId, autoDecodeCompressed: options?.autoDecodeCompressed }
                    : current,
                )
              }
              actionTargets={{
                beforeHome: viewerBeforeHome,
                afterHome: viewerAfterHome,
                breadcrumb: viewerBreadcrumb,
                search: viewerSearch,
                view: viewerView,
                tools: viewerTools,
              }}
              onText={() => void open(viewed.entry, directory, 'text')}
              onClose={closeEditor}
              onExtract={
                canMutate &&
                /\.(?:zip|jar|tar|tgz|tar\.(?:gz|bz2|xz|zst)|gz|bz2|xz|zst|7z|rar)$/i.test(
                  viewed.entry.name,
                )
                  ? (selection) => {
                      chooseMode('extract', [viewed.entry.name]);
                      setExtractSelection(selection);
                      setExtractFromViewer(true);
                    }
                  : undefined
              }
            />
          </Suspense>
        ) : editing ? (
          <FilemanSlot name="viewer.content">
            <section
              className="fm-editor-view"
              ref={editorForm}
              aria-label={t('file.editor')}
              tabIndex={-1}
            >
              {!reading && editorAvailability === 'text' && !readError && (
                <span className="fm-editor-state sr-only" role="status">
                  {t(
                    mutating || saving
                      ? 'web.pending'
                      : dirty || pendingViewChanges
                        ? 'file.unsaved'
                        : 'file.saved',
                  )}
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
                      onKeyDown={(event) => {
                        if (
                          (event.ctrlKey || event.metaKey) &&
                          !event.altKey &&
                          event.key.toLowerCase() === 's'
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                          if (!event.nativeEvent.isComposing)
                            event.currentTarget.form?.requestSubmit();
                        }
                      }}
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
                      selectedView={editorView}
                      onViewChange={setEditorView}
                      actionTarget={editorViewActions}
                      initialFragment={editorFragment}
                      resourceContext={{
                        serverId,
                        identity: viewerIdentity,
                        source: {
                          path: join(
                            directory,
                            mode === 'edit' ? (targets[0] ?? '') : newName || 'new.txt',
                          ),
                          name: mode === 'edit' ? (targets[0] ?? '') : newName || 'new.txt',
                          size: 0,
                          gameId: server.data?.gameId,
                        },
                        onOpen: (source, fragment) => {
                          void open(
                            {
                              name: source.name,
                              size: source.size,
                              is_file: true,
                              is_symlink: false,
                              mode: '',
                              mimetype: '',
                              created_at: '',
                              modified_at: '',
                            },
                            source.path.split('/').slice(0, -1).join('/'),
                            undefined,
                            true,
                            fragment,
                          );
                        },
                      }}
                      path={join(
                        directory,
                        mode === 'edit' ? (targets[0] ?? '') : newName || 'new.txt',
                      )}
                      value={content}
                      onChange={(value) => {
                        contentRef.current = value;
                        setContent(value);
                        setDirty(
                          value !== baseline.current || (mode === 'new' && newName.length > 0),
                        );
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
          </FilemanSlot>
        ) : files.isPending ? (
          <FilemanListSkeleton view={view} />
        ) : files.error ? (
          <>
            <div className="fm-list fm-list-error">
              <ErrorNotice error={files.error} retry={() => void files.refetch()} />
            </div>
            <div className="fm-count" />
          </>
        ) : (
          <FilemanListing
            entries={rows}
            view={view}
            selected={selected}
            order={order}
            descending={descending}
            onSort={(field) => {
              if (order === field) setDescending((value) => !value);
              else {
                setOrder(field);
                setDescending(false);
              }
            }}
            onSelectAll={(checked) =>
              setSelected(
                checked
                  ? new Set(rows.filter((entry) => !entry.is_symlink).map((entry) => entry.name))
                  : new Set(),
              )
            }
            onSelect={(entry, event) => {
              const checked = event.currentTarget.checked;
              setSelected((current) =>
                selectFileRange(rows, current, anchor, entry.name, event.shiftKey, checked),
              );
              if (!event.shiftKey) setAnchor(entry.name);
            }}
            onOpen={(entry, event) => {
              if (event.ctrlKey || event.metaKey || event.shiftKey) selectEntry(entry, event);
              else {
                setAnchor(entry.name);
                void open(entry);
              }
            }}
            onMenu={showMenu}
            menuEntry={menu?.entry.name}
            busy={fileActionsBusy}
            gameId={server.data?.gameId}
            isArchive={isArchive}
            parent={
              directory ? (
                <FilemanParent
                  data-drag-hover={hoverDestination === parent || undefined}
                  onClick={() => navigate(parent)}
                  onDragOver={(event) => dragOverFolder(event, parent)}
                  onDragLeave={(event) => dragLeaveFolder(event, parent)}
                  onDrop={(event) => dropFolder(event, parent)}
                />
              ) : undefined
            }
            empty={<Empty text={t(search ? 'file.noMatches' : 'service.folderEmpty')} />}
            rowProps={(entry) => ({
              'data-directory-path':
                !entry.is_file && !entry.is_symlink ? join(directory, entry.name) : undefined,
              className: `${hoverDestination === join(directory, entry.name) && !entry.is_file && !entry.is_symlink ? 'fm-drop-hover' : ''} ${scopedClipboard?.action === 'move' && scopedClipboard.source === directory && scopedClipboard.names.includes(entry.name) ? 'fm-cut' : ''}`,
              onMouseDown: (event) => {
                if (
                  event.button === 0 &&
                  (event.ctrlKey || event.metaKey || event.shiftKey) &&
                  !(event.target as HTMLElement).closest('input,.fm-menu-trigger')
                )
                  event.preventDefault();
              },
              onClickCapture: (event) => {
                if ((event.target as HTMLElement).closest('button,input')) return;
                selectEntry(entry, event);
                event.currentTarget.querySelector<HTMLButtonElement>('.fm-filename')?.focus();
              },
              draggable: canMutate && canDelete && !entry.is_symlink && !fileActionsBusy,
              onDragStart: (event) => {
                const names = selected.has(entry.name) ? selectedNames : [entry.name];
                dragSession.current = {
                  identity: saveIdentity.current,
                  serverId,
                  source: directory,
                  names,
                };
                event.dataTransfer.setData(
                  dragType,
                  JSON.stringify({ serverId, directory, names }),
                );
                event.dataTransfer.effectAllowed = 'move';
              },
              onDragOver:
                !entry.is_file && !entry.is_symlink
                  ? (event) => dragOverFolder(event, join(directory, entry.name))
                  : undefined,
              onDragLeave:
                !entry.is_file && !entry.is_symlink
                  ? (event) => dragLeaveFolder(event, join(directory, entry.name))
                  : undefined,
              onDrop:
                !entry.is_file && !entry.is_symlink
                  ? (event) => dropFolder(event, join(directory, entry.name))
                  : undefined,
            })}
          />
        )}
        {dropActive && (
          <div className="fm-drop-overlay" aria-live="polite">
            <FileIcon folder />
            <strong>{t(uploadAvailable ? 'file.dropHere' : uploadReason)}</strong>
          </div>
        )}
        {menu && (
          <FilemanContextMenu
            ref={menuRef}
            label={t('file.actionsFor', { name: menu.entry.name })}
            left={menu.left}
            top={menu.top}
            onClose={() => {
              setMenu(undefined);
              menuTrigger.current?.focus();
            }}
          >
            {!menu.entry.is_symlink && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!menuCanOpen}
                  aria-describedby={!menuCanOpen ? 'file-edit-unavailable' : undefined}
                  onClick={() => {
                    void open(menu.entry);
                    setMenu(undefined);
                  }}
                >
                  {t(menu.entry.is_file ? 'viewer.open' : 'service.openFolder')}
                </button>
                {!menuCanOpen && (
                  <small id="file-edit-unavailable" className="fm-menu-reason">
                    {t(`file.editorUnavailable.${fileEditorAvailability(menu.entry)}`)}
                  </small>
                )}
                {menu.entry.is_file && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenWith({
                        entry: menu.entry,
                        source: viewerSource(menu.entry),
                      });
                      setMenu(undefined);
                    }}
                  >
                    {t('viewer.openWith')}
                  </button>
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
                  disabled={!canMutate || !canDelete}
                  onClick={() => chooseMode('rename', [menu.entry.name])}
                >
                  {t('service.rename')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canMutate || !canDelete}
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
            {canDelete && !menu.entry.is_symlink && (
              <button
                type="button"
                role="menuitem"
                className="danger"
                disabled={!canDelete}
                onClick={() => chooseMode('delete', [menu.entry.name])}
              >
                {t('web.delete')}
              </button>
            )}
          </FilemanContextMenu>
        )}
        {openWith && (
          <OpenWith
            serverId={serverId}
            source={openWith.source}
            available={viewerCapabilities.data?.available === true}
            onClose={() => setOpenWith(undefined)}
            onChoose={(id) => {
              const chosen = openWith;
              setOpenWith(undefined);
              if (
                editing &&
                chosen.source.path === join(directory, targets[0] ?? '') &&
                isDocumentView(chosen.entry.name, id)
              ) {
                void (async () => {
                  if (!editorControls?.flush || (await editorControls.flush())) setEditorView(id);
                })();
              } else void open(chosen.entry, directory, id);
            }}
          />
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
        {sftpOpen && canSftp && (
          <Dialog
            open
            title={t('web.sftp')}
            closeIcon
            className="sftp-dialog"
            closeDisabled={sftpBusy}
            onClose={() => {
              if (!sftpBusy) setSftpOpen(false);
            }}
          >
            <SftpPage serverId={serverId} embedded onBusyChange={setSftpBusy} />
          </Dialog>
        )}
        <ConfirmDialog
          key={`delete:${targets.join(',')}`}
          open={mode === 'delete'}
          title={t('web.delete')}
          confirmLabel={t('web.delete')}
          destructive
          busy={mutating}
          onClose={closeEditor}
          onConfirm={async () => {
            if (!canDelete) throw { messageKey: 'error.forbidden' };
            await mutation({
              action: 'delete',
              root: directory,
              files: targets,
              confirm: true,
            });
          }}
        >
          <FileSelectionSummary names={targets} />
          <p>{t('file.deleteWarning', { count: targets.length })}</p>
        </ConfirmDialog>
        <Dialog
          open={Boolean(mode) && mode !== 'delete' && (!displaying || mode === 'extract')}
          title={t(
            mode === 'mkdir'
              ? 'service.newFolder'
              : mode === 'rename'
                ? 'service.rename'
                : 'file.extract',
          )}
          onClose={() => {
            if (mode && !['view', 'edit', 'new'].includes(mode)) closeEditor();
          }}
          closeIcon
          closeDisabled={mutating}
        >
          <ActionForm
            key={`${mode}:${targets.join(',')}`}
            success={false}
            submitLabel={t(mode === 'extract' ? 'file.extract' : 'web.save')}
            onSubmit={async (data) => {
              if (!canMutate) throw { messageKey: 'error.forbidden' };
              if (mode === 'mkdir')
                await mutation({ action: 'mkdir', root: directory, name: text(data, 'name') });
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
                    ...extractSelection,
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
                      ? `${targets[0]?.replace(/\.(tar\.)?(gz|bz2|xz|zst|zip|jar|tar|tgz|tbz2|txz|7z|rar)$/i, '')}-extracted`
                      : ''
                }
              />
            )}
            {mode === 'extract' && (
              <>
                {extractSelection?.entries && (
                  <FileSelectionSummary names={extractSelection.entries} />
                )}
                <p>{t('file.extractWarning')}</p>
              </>
            )}
          </ActionForm>
        </Dialog>
      </section>
    </FilemanHost>
  );
}
