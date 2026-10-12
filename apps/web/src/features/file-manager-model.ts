import type { ServerFile } from './service-contracts.js';

export type FileOrder = 'name' | 'size' | 'date';
export const joinFilePath = (directory: string, name: string) =>
  [directory, name].filter(Boolean).join('/');

/** Canonical server-relative paths. Never resolve traversal on the user's behalf. */
export function normalizeFilePath(value: string): string | undefined {
  const result = value.trim().replace(/^\/+|\/+$/g, '');
  if (result.includes('\\') || [...result].some((character) => character.charCodeAt(0) < 32))
    return undefined;
  if (result.split('/').some((part) => part === '..' || part === '.')) return undefined;
  return result.replace(/\/{2,}/g, '/');
}
export function fileBreadcrumbs(directory: string) {
  return [
    { name: 'root', path: '' },
    ...directory
      .split('/')
      .filter(Boolean)
      .map((name, index, segments) => ({
        name,
        path: segments.slice(0, index + 1).join('/'),
      })),
  ];
}
export function visibleFiles(
  files: ServerFile[],
  search: string,
  order: FileOrder,
  descending: boolean,
): ServerFile[] {
  const query = search.trim().toLocaleLowerCase();
  return files
    .filter((file) => file.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => {
      const folders = Number(a.is_file || a.is_symlink) - Number(b.is_file || b.is_symlink);
      if (folders) return folders;
      const value =
        order === 'size'
          ? a.size - b.size
          : order === 'date'
            ? Date.parse(a.modified_at) - Date.parse(b.modified_at)
            : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return (value || a.name.localeCompare(b.name)) * (descending ? -1 : 1);
    });
}
export function selectFileRange(
  visible: ServerFile[],
  selected: Set<string>,
  anchor: string | undefined,
  name: string,
  range: boolean,
  checked: boolean,
): Set<string> {
  const result = new Set(selected);
  const start = visible.findIndex((entry) => entry.name === anchor);
  const end = visible.findIndex((entry) => entry.name === name);
  const names =
    range && start >= 0 && end >= 0
      ? visible.slice(Math.min(start, end), Math.max(start, end) + 1).map((entry) => entry.name)
      : [name];
  for (const item of names.filter(
    (name) => !visible.find((entry) => entry.name === name)?.is_symlink,
  ))
    if (checked) result.add(item);
    else result.delete(item);
  return result;
}
/** Explorer name/row selection, separate from additive checkbox range selection. */
export function selectFileClick(
  visible: ServerFile[],
  selected: Set<string>,
  anchor: string | undefined,
  name: string,
  modifiers: { additive: boolean; range: boolean },
): Set<string> {
  if (modifiers.range)
    return selectFileRange(
      visible,
      modifiers.additive ? selected : new Set(),
      anchor,
      name,
      true,
      true,
    );
  return selectFileRange(
    visible,
    modifiers.additive ? selected : new Set(),
    anchor,
    name,
    false,
    !modifiers.additive || !selected.has(name),
  );
}

export interface FileClipboard {
  identity: string;
  serverId: string;
  source: string;
  names: string[];
  action: 'copy' | 'move';
}

/** Internal metadata clipboard: never accepts data from the system clipboard. */
export function fileClipboardForScope(
  clipboard: FileClipboard | undefined,
  identity: string | undefined,
  serverId: string,
): FileClipboard | undefined {
  return identity && clipboard?.identity === identity && clipboard.serverId === serverId
    ? clipboard
    : undefined;
}

export function validMoveTarget(directory: string, names: string[], destination: string) {
  return (
    destination !== directory &&
    !names.some((name) => {
      const path = joinFilePath(directory, name);
      return destination === path || destination.startsWith(`${path}/`);
    })
  );
}
