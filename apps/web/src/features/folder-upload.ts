export type FolderUploadErrorCode =
  | 'empty_selection'
  | 'invalid_path'
  | 'multiple_roots'
  | 'collision'
  | 'unsafe_destination'
  | 'limit_exceeded'
  | 'preparation_failed'
  | 'cancelled';

export class FolderUploadError extends Error {
  readonly createdDirectories: string[] = [];
  uncertainDirectory?: string;

  constructor(
    readonly code: FolderUploadErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'FolderUploadError';
  }
}

export interface FolderUploadPlan {
  /** The selected folder name; retained below destination, never flattened. */
  root: string;
  destination: string;
  directories: string[];
  entries: { file: File; path: string }[];
}

export interface FolderUploadFilesystem {
  list(
    path: string,
    signal?: AbortSignal,
  ): Promise<readonly { name: string; is_file: boolean; is_symlink: boolean }[]>;
  mkdir(parent: string, name: string, signal?: AbortSignal): Promise<void>;
}

const maxEntries = 10000;
const maxDepth = 64;
const folded = (value: string) => value.normalize('NFC').toLowerCase();
const join = (left: string, right: string) => (left ? `${left}/${right}` : right);

function segments(path: string, allowRoot = false): string[] {
  if (allowRoot && path === '') return [];
  if (
    !path ||
    /[\\%\p{Cc}]/u.test(path) ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new FolderUploadError('invalid_path');
  const parts = path.split('/');
  if (path.length > 4096 || parts.length > maxDepth) throw new FolderUploadError('limit_exceeded');
  return parts;
}

/** webkitdirectory exposes files, not empty directories. Do not invent missing folders. */
export function planFolderUpload(files: Iterable<File>, destination: string): FolderUploadPlan {
  segments(destination, true);
  const entries: FolderUploadPlan['entries'] = [];
  const directories = new Set<string>();
  const seen = new Map<string, { path: string; file: boolean }>();
  let root: string | undefined;
  const remember = (path: string, file: boolean) => {
    const key = folded(path);
    const previous = seen.get(key);
    if (previous && (file || previous.file || previous.path !== path))
      throw new FolderUploadError('collision');
    seen.set(key, { path, file });
    if (seen.size > maxEntries) throw new FolderUploadError('limit_exceeded');
  };

  for (const file of files) {
    const parts = segments(file.webkitRelativePath);
    if (parts.length < 2 || parts.at(-1) !== file.name) throw new FolderUploadError('invalid_path');
    if (root !== undefined && root !== parts[0]) throw new FolderUploadError('multiple_roots');
    root = parts[0];
    const path = join(destination, file.webkitRelativePath);
    segments(path);
    for (let length = 1; length < parts.length; length++) {
      const directory = join(destination, parts.slice(0, length).join('/'));
      remember(directory, false);
      directories.add(directory);
    }
    remember(path, true);
    entries.push({ file, path });
  }
  if (root === undefined) throw new FolderUploadError('empty_selection');
  return {
    root,
    destination,
    // Every parent precedes its children even when the browser's FileList is unsorted.
    directories: [...directories].sort((a, b) => a.split('/').length - b.split('/').length),
    entries,
  };
}

const checkCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new FolderUploadError('cancelled');
};

async function verifyDirectory(
  path: string,
  filesystem: FolderUploadFilesystem,
  signal?: AbortSignal,
) {
  let parent = '';
  for (const name of segments(path, true)) {
    checkCancelled(signal);
    const listing = await filesystem.list(parent, signal);
    checkCancelled(signal);
    const matches = listing.filter((entry) => folded(entry.name) === folded(name));
    if (
      matches.length !== 1 ||
      matches[0]?.name !== name ||
      matches[0].is_file ||
      matches[0].is_symlink
    )
      throw new FolderUploadError('unsafe_destination');
    parent = join(parent, name);
  }
}

/**
 * Creates a fresh tree only. Nothing is uploaded until preparation succeeds.
 * Existing folders are never merged, and failed/cancelled preparation never deletes data.
 * Pterodactyl has no exclusive mkdir transaction: external writes can still race this check.
 */
export async function prepareFolderUpload(
  plan: FolderUploadPlan,
  filesystem: FolderUploadFilesystem,
  signal?: AbortSignal,
): Promise<FolderUploadPlan> {
  const created: string[] = [];
  let pendingDirectory: string | undefined;
  try {
    for (const directory of plan.directories) {
      checkCancelled(signal);
      const offset = directory.lastIndexOf('/');
      const parent = offset < 0 ? '' : directory.slice(0, offset);
      const name = directory.slice(offset + 1);
      await verifyDirectory(parent, filesystem, signal);
      checkCancelled(signal);
      const before = await filesystem.list(parent, signal);
      checkCancelled(signal);
      if (before.some((entry) => folded(entry.name) === folded(name)))
        throw new FolderUploadError('collision');
      pendingDirectory = directory;
      await filesystem.mkdir(parent, name, signal);
      created.push(directory);
      pendingDirectory = undefined;
      checkCancelled(signal);
      await verifyDirectory(directory, filesystem, signal);
    }
    return plan;
  } catch (cause) {
    const error =
      cause instanceof FolderUploadError
        ? cause
        : new FolderUploadError(signal?.aborted ? 'cancelled' : 'preparation_failed', {
            cause,
          });
    error.createdDirectories.push(...created);
    error.uncertainDirectory = pendingDirectory;
    throw error;
  }
}
