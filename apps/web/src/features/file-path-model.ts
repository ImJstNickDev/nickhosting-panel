import { normalizeFilePath } from './file-manager-model.js';
import type { ServerFile } from './service-contracts.js';

export interface FilePathInput {
  path: string;
  parent: string;
  prefix: string;
  directoryInput: boolean;
}

/** Keep meaningful filename spaces; normalizeFilePath is only the traversal guard. */
export function parseFilePathInput(value: string): FilePathInput | undefined {
  if (
    value.length > 4096 ||
    value.includes('//') ||
    /[%\\\p{Cc}]/u.test(value) ||
    /^[a-z]:/i.test(value) ||
    normalizeFilePath(value) === undefined
  )
    return undefined;
  const relative = value.startsWith('/') ? value.slice(1) : value;
  const directoryInput = relative === '' || relative.endsWith('/');
  const path = relative.endsWith('/') ? relative.slice(0, -1) : relative;
  if (
    path &&
    (path.split('/').length > 64 ||
      path.split('/').some((part) => !part || part === '.' || part === '..'))
  )
    return undefined;
  if (directoryInput) return { path, parent: path, prefix: '', directoryInput: true };
  const separator = path.lastIndexOf('/');
  return {
    path,
    parent: separator < 0 ? '' : path.slice(0, separator),
    prefix: path.slice(separator + 1),
    directoryInput: false,
  };
}

export function filePathCandidates(files: readonly ServerFile[], prefix: string): ServerFile[] {
  const query = prefix.toLowerCase();
  return files
    .filter((entry) => {
      const parsed = parseFilePathInput(entry.name);
      return (
        !entry.is_symlink &&
        !entry.name.includes('/') &&
        parsed?.path === entry.name &&
        !parsed.directoryInput &&
        entry.name.toLowerCase().startsWith(query)
      );
    })
    .sort(
      (a, b) =>
        Number(a.is_file) - Number(b.is_file) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
}
