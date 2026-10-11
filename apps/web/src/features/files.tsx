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
import { api, download, upload } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  Check,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Time,
  text,
} from '../components/ui.js';
import {
  type FileOrder,
  fileBreadcrumbs,
  joinFilePath as join,
  normalizeFilePath,
  selectFileRange,
  validMoveTarget,
  visibleFiles,
} from './file-manager-model.js';

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
import { FilePathPicker } from './file-path-picker.js';
import { FolderUploadError, planFolderUpload, prepareFolderUpload } from './folder-upload.js';

type Mode = 'mkdir' | 'new' | 'edit' | 'rename' | 'delete' | 'move' | 'copy' | 'extract';
type UploadItem = {
  id: number;
  file: File;
  directory: string;
  path: string;
  exclusive: boolean;
  sent: number;
  speed: number;
  status: 'queued' | 'uploading' | 'confirming' | 'complete' | 'cancelled' | 'failed';
  error?: unknown;
};
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

function FileIcon({ folder, archive = false }: { folder: boolean; archive?: boolean }) {
  return (
    <svg
      className={`fm-icon ${folder ? 'fm-icon-folder' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {folder ? (
        <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z" />
      ) : (
        <>
          <path d="M6 3h8l4 4v14H6Z M14 3v5h4" />
          {archive ? <path d="M11 10h2m-2 3h2m-2 3h2" /> : <path d="M9 12h6m-6 4h6" />}
        </>
      )}
    </svg>
  );
}
function ToolbarIcon({
  kind,
}: {
  kind: 'folder' | 'file' | 'upload' | 'uploadFolder' | 'refresh' | 'path';
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
      {kind === 'path' ? (
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
  const macKeyboard = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  const pathShortcut = `${macKeyboard ? '⌥' : 'ALT'} + G`;
  const searchInput = useRef<HTMLInputElement>(null);
  const server = useServer(serverId),
    transfers = useTransfers(serverId);
  const [directory, setDirectory] = useState('');
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
  const [destination, setDestination] = useState('');
  const [content, setContent] = useState('');
  const [newName, setNewName] = useState('');
  const [revision, setRevision] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<{ entry: ServerFile; left: number; top: number }>();
  const [dropActive, setDropActive] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [preparingFolder, setPreparingFolder] = useState(false);
  const folderPreparation = useRef<AbortController | undefined>(undefined);
  const [pendingUploads, setPendingUploads] = useState<File[]>([]);
  const uploadId = useRef(0),
    uploadRunning = useRef(false);
  const uploadAbort = useRef<AbortController | undefined>(undefined);
  const cancelledUploads = useRef(new Set<number>());
  const uploadQueue = useRef<UploadItem[]>([]);
  const mounted = useRef(true);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const editorForm = useRef<HTMLDivElement>(null);
  const mutationRunning = useRef(false);
  const readAbort = useRef<AbortController | undefined>(undefined),
    readSequence = useRef(0);
  const files = useQuery(fileDirectoryQuery(serverId, directory));
  const rows = useMemo(
    () => visibleFiles(files.data ?? [], search, order, descending),
    [files.data, search, order, descending],
  );
  const canManage = server.data?.permissions.manage === true;
  const canMutate = canManage && server.data?.availableActions.files === true;
  const uploadAvailable = transfers.data?.upload.available === true;
  const selectedNames = [...selected];
  const selectedEntries = files.data?.filter((entry) => selected.has(entry.name)) ?? [];
  const parent = directory.split('/').slice(0, -1).join('/');
  const uploadReason = transfers.error
    ? 'file.uploadReason.request'
    : transfers.isPending
      ? 'web.loading'
      : `file.uploadReason.${transfers.data?.upload.reason ?? 'configuration_invalid'}`;
  const capabilities = useQuery({
    queryKey: ['file-capabilities', serverId],
    refetchInterval: 10000,
    queryFn: () =>
      api<{ extractFormats: string[]; copy: boolean; extract: boolean }>(
        `${serverPath(serverId)}/files/capabilities`,
      ),
  });
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
    // Start fetching on tab entry, sharing the same promise with React.lazy.
    void loadEditor().catch(() => {});
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadAbort.current?.abort();
      folderPreparation.current?.abort();
      readAbort.current?.abort();
    };
  }, []);
  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      const modifier = event.altKey && !event.ctrlKey && !event.metaKey;
      const pathRequest = modifier && event.code === 'KeyG';
      const searchRequest = modifier && event.code === 'KeyK';
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
  }, [editPath]);
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
      if (dirty || uploadRunning.current || mutationRunning.current || folderPreparation.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
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
    if (dirty && !window.confirm(t('service.discardEdits'))) return;
    cancelRead();
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
    if (dirty && !window.confirm(t('service.discardEdits'))) return;
    cancelRead();
    setDirty(false);
    setMode(undefined);
    setReadError(undefined);
    queueMicrotask(() => menuTrigger.current?.isConnected && menuTrigger.current.focus());
  }
  function chooseMode(value: Mode, names = selectedNames, folder = directory) {
    if (!menu) menuTrigger.current = document.activeElement as HTMLElement;
    setError(undefined);
    setMenu(undefined);
    setTargets(names);
    setDestination(folder);
    setMode(value);
    setReadError(undefined);
    if (value === 'new') {
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
    if (dirty && !window.confirm(t('service.discardEdits'))) return;
    setPathEditing(false);
    if (folder !== directory) {
      setDirectory(folder);
      setSearch('');
      setSelected(new Set());
      setAnchor(undefined);
    }
    cancelRead();
    const sequence = ++readSequence.current,
      controller = new AbortController();
    readAbort.current = controller;
    setTargets([entry.name]);
    setMode('edit');
    setContent('');
    setRevision(null);
    setDirty(false);
    setReading(true);
    setReadError(undefined);
    try {
      const value = await api<{ content: string; revision: string }>(
        `${serverPath(serverId)}/files/editor?path=${encodeURIComponent(join(folder, entry.name))}`,
        { signal: controller.signal },
      );
      if (sequence === readSequence.current && !controller.signal.aborted) {
        setContent(value.content);
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
  function saveShortcut() {
    if (canMutate) editorForm.current?.querySelector('form')?.requestSubmit();
  }
  function downloadNames(names: string[]) {
    const entry = files.data?.find((item) => item.name === names[0]);
    const direct = names.length === 1 && entry?.is_file;
    download(
      direct
        ? `${serverPath(serverId)}/files/content?path=${encodeURIComponent(join(directory, names[0] ?? ''))}`
        : `${serverPath(serverId)}/files/archive?root=${encodeURIComponent(directory)}&files=${encodeURIComponent(JSON.stringify(names))}`,
    );
  }
  function downloadZip(names: string[]) {
    download(
      `${serverPath(serverId)}/files/archive?root=${encodeURIComponent(directory)}&files=${encodeURIComponent(JSON.stringify(names))}`,
    );
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
    if (!event.dataTransfer.types.includes(dragType) || !canMutate) return;
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
      chooseMode('move', payload.names, folder);
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
  async function runUploads() {
    if (uploadRunning.current) return;
    uploadRunning.current = true;
    while (uploadQueue.current.length && mounted.current) {
      const item = uploadQueue.current.shift();
      if (!item) break;
      if (cancelledUploads.current.has(item.id)) continue;
      const controller = new AbortController();
      uploadAbort.current = controller;
      const start = performance.now();
      updateUpload(item.id, { status: 'uploading' });
      try {
        if (item.exclusive) {
          const parent = item.path.split('/').slice(0, -1).join('/');
          const listing = await api<ServerFile[]>(
            `${serverPath(serverId)}/files?path=${encodeURIComponent(parent)}`,
            { signal: controller.signal },
          );
          if (
            listing.some(
              (entry) => entry.name.toLocaleLowerCase() === item.file.name.toLocaleLowerCase(),
            )
          )
            throw { messageKey: 'file.folderFileExists' };
        }
        await upload(
          `${serverPath(serverId)}/files/upload?path=${encodeURIComponent(item.path)}`,
          item.file,
          {
            signal: controller.signal,
            onProgress: (sent) =>
              updateUpload(item.id, {
                sent,
                speed: sent / Math.max(0.1, (performance.now() - start) / 1000),
                status: sent === item.file.size ? 'confirming' : 'uploading',
              }),
          },
        );
        updateUpload(item.id, { status: 'complete', sent: item.file.size });
        await files.refetch();
      } catch (failure) {
        updateUpload(item.id, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          error: controller.signal.aborted ? undefined : failure,
        });
      } finally {
        uploadAbort.current = undefined;
      }
    }
    uploadRunning.current = false;
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
    void runUploads();
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
    if (uploadRunning.current || folderPreparation.current) {
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
        void files.refetch();
      }
    }
  }
  function cancelUpload(item: UploadItem) {
    if (item.status === 'queued') {
      cancelledUploads.current.add(item.id);
      updateUpload(item.id, { status: 'cancelled' });
    } else uploadAbort.current?.abort();
  }
  const totalSelected = selected.size;
  const uploadsBusy = uploads.some((item) =>
    ['queued', 'uploading', 'confirming'].includes(item.status),
  );
  return (
    <section
      className="file-manager"
      aria-label={t('web.files')}
      onKeyDown={keyboard}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDropActive(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = uploadAvailable ? 'copy' : 'none';
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false);
      }}
      onDrop={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
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
      <div className="fm-toolbar">
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
                    aria-current={index === all.length - 1 ? 'page' : undefined}
                    onClick={() => navigate(part.path)}
                    onDragOver={dragOverFolder}
                    onDrop={(event) => dropFolder(event, part.path)}
                  >
                    {index === 0 ? t('file.root') : part.name}
                  </button>
                </li>
              ))}
            </ol>
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
          </nav>
        )}
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
                    if (uploadAvailable && !preparingFolder && !uploadRunning.current)
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
      </div>
      {totalSelected > 0 && (
        <section className="fm-selection" aria-label={t('file.selection')}>
          <span>{t('file.selected', { count: totalSelected })}</span>
          {totalSelected > 100 && <span role="status">{t('file.selectionLimit')}</span>}
          <button
            type="button"
            className="secondary"
            onClick={() => downloadZip(selectedNames)}
            disabled={
              totalSelected > 100 ||
              selectedEntries.some((entry) => entry.is_symlink) ||
              !transfers.data?.download.available
            }
          >
            {t('file.downloadZip')}
          </button>
          {canManage && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={!canMutate || totalSelected > 100}
                onClick={() => chooseMode('move')}
              >
                {t('file.move')}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!canMutate || totalSelected > 100 || capabilities.data?.copy !== true}
                onClick={() => chooseMode('copy')}
              >
                {t('file.copy')}
              </button>
              <button
                type="button"
                className="secondary danger"
                disabled={!canMutate || totalSelected > 100}
                onClick={() => chooseMode('delete')}
              >
                {t('web.delete')}
              </button>
            </>
          )}
          <button type="button" className="text-button" onClick={() => setSelected(new Set())}>
            {t('file.clearSelection')}
          </button>
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
      {files.isPending ? (
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
                    disabled={entry.is_symlink}
                    onClick={() => void open(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        showMenu(entry, event.currentTarget);
                      }
                    }}
                  >
                    <FileIcon folder={!entry.is_file} archive={isArchive(entry.name)} />
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
                onClick={() => {
                  void open(menu.entry);
                  setMenu(undefined);
                }}
              >
                {t(menu.entry.is_file ? 'web.edit' : 'service.openFolder')}
              </button>
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
      {uploads.length > 0 && (
        <section className="fm-uploads" aria-label={t('web.upload')}>
          <header>
            <strong>{t('web.upload')}</strong>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setUploads((items) =>
                  items.filter((item) =>
                    ['queued', 'uploading', 'confirming'].includes(item.status),
                  ),
                )
              }
            >
              {t('file.clearFinished')}
            </button>
          </header>
          <ul>
            {uploads.map((item) => (
              <li key={item.id}>
                <div className="fm-upload-name">
                  <span>{item.path.slice(item.directory ? item.directory.length + 1 : 0)}</span>
                  <span>{t(`file.upload.${item.status}`)}</span>
                  {['queued', 'uploading', 'confirming'].includes(item.status) && (
                    <button
                      type="button"
                      className="text-button"
                      aria-label={t('file.cancelUpload', { name: item.file.name })}
                      onClick={() => cancelUpload(item)}
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
      <Dialog
        open={Boolean(mode)}
        title={
          mode === 'edit'
            ? (targets[0] ?? t('web.edit'))
            : t(
                mode === 'mkdir'
                  ? 'service.newFolder'
                  : mode === 'new'
                    ? 'service.newFile'
                    : mode === 'rename'
                      ? 'service.rename'
                      : mode === 'delete'
                        ? 'web.delete'
                        : mode === 'move'
                          ? 'file.move'
                          : mode === 'copy'
                            ? 'file.copy'
                            : 'file.extract',
              )
        }
        onClose={closeEditor}
      >
        {mode === 'edit' && reading ? (
          <Loading />
        ) : mode === 'edit' && readError ? (
          <>
            <ErrorNotice error={readError} />
            <button type="button" className="secondary" onClick={() => downloadNames(targets)}>
              {t('web.download')}
            </button>
          </>
        ) : (
          <div
            ref={editorForm}
            className={
              mode === 'edit' || mode === 'new'
                ? `fm-editor-dialog ${!canMutate ? 'fm-readonly' : ''}`
                : undefined
            }
          >
            <ActionForm
              key={`${mode}:${targets.join(',')}`}
              success={false}
              submitLabel={t(
                mode === 'delete'
                  ? 'web.delete'
                  : mode === 'move'
                    ? 'file.move'
                    : mode === 'copy'
                      ? 'file.copy'
                      : mode === 'extract'
                        ? 'file.extract'
                        : 'web.save',
              )}
              onSubmit={async (data) => {
                if (!canMutate) throw { messageKey: 'error.forbidden' };
                if (mode === 'mkdir')
                  await mutation({ action: 'mkdir', root: directory, name: text(data, 'name') });
                else if (mode === 'delete')
                  await mutation({
                    action: 'delete',
                    root: directory,
                    files: targets,
                    confirm: true,
                  });
                else if (mode === 'rename')
                  await mutation({
                    action: 'rename',
                    root: directory,
                    files: [{ from: targets[0], to: text(data, 'name') }],
                  });
                else if (mode === 'move' || mode === 'copy') {
                  const folder = normalizeFilePath(text(data, 'destination'));
                  if (folder === undefined || !validMoveTarget(directory, targets, folder))
                    throw { messageKey: 'file.invalidMove' };
                  if (mode === 'move')
                    await mutation({
                      action: 'rename',
                      root: '',
                      files: targets.map((name) => ({
                        from: join(directory, name),
                        to: join(folder, name),
                      })),
                    });
                  else
                    await mutation(
                      { root: directory, files: targets, destination: folder },
                      '/files/copy',
                    );
                } else if (mode === 'extract')
                  await mutation(
                    {
                      root: directory,
                      file: targets[0],
                      destination: text(data, 'name'),
                      confirm: true,
                    },
                    '/files/extract',
                  );
                else
                  await mutation(
                    {
                      path: join(
                        directory,
                        mode === 'edit' ? (targets[0] ?? '') : text(data, 'name'),
                      ),
                      content,
                      expectedRevision: mode === 'edit' ? revision : null,
                    },
                    '/files/editor',
                    'PUT',
                  );
              }}
            >
              {(mode === 'mkdir' || mode === 'new' || mode === 'rename' || mode === 'extract') && (
                <Input
                  label={t(mode === 'extract' ? 'file.extractFolder' : 'web.name')}
                  name="name"
                  onChange={(event) => {
                    if (mode === 'new') setNewName(event.target.value);
                  }}
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
              {(mode === 'move' || mode === 'copy') && (
                <>
                  <p className="fm-targets">{targets.join(', ')}</p>
                  <Input
                    label={t('file.destination')}
                    name="destination"
                    defaultValue={`/${destination}`}
                    required
                  />
                  <p className="muted">{t('file.noOverwrite')}</p>
                </>
              )}
              {(mode === 'new' || mode === 'edit') && (
                <>
                  <div className="fm-editor-meta">
                    <span>{t(dirty ? 'file.unsaved' : 'file.saved')}</span>
                    <span>{t('file.saveShortcut')}</span>
                  </div>
                  <Suspense fallback={<Loading />}>
                    <FileTextEditor
                      path={join(
                        directory,
                        mode === 'edit' ? (targets[0] ?? '') : newName || 'new.txt',
                      )}
                      value={content}
                      onChange={(value) => {
                        setContent(value);
                        setDirty(true);
                      }}
                      onSave={saveShortcut}
                      readOnly={!canMutate || mutating}
                      label={t('service.content')}
                    />
                  </Suspense>
                </>
              )}
              {mode === 'new' && <Check required label={t('service.writeFileWarning')} />}
              {mode === 'delete' && (
                <>
                  <p>{t('file.deleteWarning', { count: targets.length })}</p>
                  <ul className="fm-targets">
                    {targets.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                  <Check label={t('web.confirm')} required />
                </>
              )}
              {mode === 'extract' && <p>{t('file.extractWarning')}</p>}
            </ActionForm>
          </div>
        )}
      </Dialog>
    </section>
  );
}
