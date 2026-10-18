import { FolderUploadError, planFolderUpload } from '../../features/folder-upload.js';

export type WorldFolderArchiveErrorCode =
  | 'invalid_folder'
  | 'limit_exceeded'
  | 'preparation_failed';
export class WorldFolderArchiveError extends Error {
  constructor(readonly code: WorldFolderArchiveErrorCode) {
    super(code);
    this.name = 'WorldFolderArchiveError';
  }
}
export interface WorldFolderArchiveInput {
  root: string;
  entries: { file: File; path: string }[];
}
export interface WorldFolderArchiveProgress {
  processedBytes: number;
  totalBytes: number;
}
/** Only metadata is inspected here. File bytes and checksums stay off the UI thread. */
export function planMinecraftWorldFolder(files: readonly File[]): WorldFolderArchiveInput {
  try {
    const plan = planFolderUpload(files, '');
    const entries = plan.entries.map(({ file, path }) => ({
      file,
      path: path.slice(plan.root.length + 1),
    }));
    if (!entries.some(({ path }) => path === 'level.dat'))
      throw new WorldFolderArchiveError('invalid_folder');
    return { root: plan.root, entries };
  } catch (error) {
    if (error instanceof WorldFolderArchiveError) throw error;
    throw new WorldFolderArchiveError(
      error instanceof FolderUploadError && error.code === 'limit_exceeded'
        ? 'limit_exceeded'
        : 'invalid_folder',
    );
  }
}
export function prepareMinecraftWorldFolder(
  files: readonly File[],
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: WorldFolderArchiveProgress) => void;
  } = {},
): Promise<File> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    let input: WorldFolderArchiveInput;
    try {
      input = planMinecraftWorldFolder(files);
    } catch (error) {
      reject(error);
      return;
    }
    const worker = new Worker(new URL('./world-folder-archive.worker.ts', import.meta.url), {
      type: 'module',
    });
    const cleanup = () => {
      worker.terminate();
      options.signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    worker.onmessage = (
      event: MessageEvent<{
        archive?: File;
        progress?: WorldFolderArchiveProgress;
        error?: WorldFolderArchiveErrorCode;
      }>,
    ) => {
      if (event.data.archive) {
        cleanup();
        resolve(event.data.archive);
      } else if (event.data.error) {
        cleanup();
        reject(new WorldFolderArchiveError(event.data.error));
      } else if (event.data.progress) options.onProgress?.(event.data.progress);
    };
    worker.onerror = () => {
      cleanup();
      reject(new WorldFolderArchiveError('preparation_failed'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    // webkitRelativePath is not guaranteed to survive structured cloning. The
    // validated relative paths are sent explicitly alongside immutable File refs.
    try {
      worker.postMessage(input);
    } catch {
      cleanup();
      reject(new WorldFolderArchiveError('preparation_failed'));
    }
  });
}
