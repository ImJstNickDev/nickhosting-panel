import { fileEditorAvailability } from '../../../../../../packages/core/src/file-content.js';
import { gameViewerRegistry } from '../trusted-viewers.js';
import { documentViews } from './document-registry.js';

export type ViewerId =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'sqlite'
  | 'json'
  | `${string}:${string}`;
export interface ViewerSource {
  path: string;
  name: string;
  size: number;
  /** An entry of the archive at path; never interpreted as a real server path. */
  entry?: string;
  /** Ordered nested archive members, relative to their containing archive. */
  archives?: string[];
  gameId?: string;
}
export interface ViewerPreference {
  scope: 'server' | 'game' | 'global';
  extension: string;
  viewerId: ViewerId;
}
export interface ViewerDefinition {
  id: ViewerId;
  label: string;
  description?: string;
  extensions: readonly string[];
}

/** Executable modules are compiled imports, never names or code supplied by an API. */
export const builtinViewers: readonly ViewerDefinition[] = [
  {
    id: 'image',
    label: 'viewer.name.image',
    description: 'viewer.image',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'svg', 'bmp', 'ico'],
  },
  {
    id: 'audio',
    label: 'viewer.name.audio',
    description: 'viewer.audio',
    extensions: ['ogg', 'oga', 'mp3', 'wav', 'flac', 'opus', 'm4a', 'aac'],
  },
  {
    id: 'video',
    label: 'viewer.name.video',
    description: 'viewer.video',
    extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv'],
  },
  {
    id: 'archive',
    label: 'viewer.name.archive',
    description: 'viewer.archive',
    extensions: [
      'zip',
      'jar',
      'tar',
      'tgz',
      'tar.gz',
      '7z',
      'rar',
      'tar.bz2',
      'tar.xz',
      'tar.zst',
      'gz',
      'bz2',
      'xz',
      'zst',
    ],
  },
  {
    id: 'sqlite',
    label: 'viewer.name.sqlite',
    description: 'viewer.datagrid',
    extensions: ['db', 'sqlite', 'sqlite3', 'csv', 'tsv'],
  },
  {
    id: 'json',
    label: 'viewer.name.json',
    description: 'viewer.readOnly',
    extensions: ['json', 'jsonc', 'json5'],
  },
  { id: 'text', label: 'viewer.name.text', description: 'file.editor', extensions: [] },
];

export function viewerExtension(name: string) {
  const lower = name.toLowerCase();
  const compound = ['tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst'].find((extension) =>
    lower.endsWith(`.${extension}`),
  );
  return compound ?? (lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '');
}
/** Known runnable modules for this context; filename matches are only suggestions. */
export function selectableViewers(source: ViewerSource): ViewerDefinition[] {
  const gameViewers: ViewerDefinition[] = gameViewerRegistry
    .forGame(source.gameId)
    .map(({ descriptor }) => ({
      id: descriptor.id as ViewerId,
      label: descriptor.labelKey,
      extensions: descriptor.extensions,
    }));
  return [...gameViewers, ...builtinViewers].filter(
    (viewer) =>
      !(source.entry || source.archives?.length) ||
      viewer.id !== 'sqlite' ||
      documentViews(source.name).some((item) => item.id === viewer.id),
  );
}
export function availableViewers(source: ViewerSource): ViewerDefinition[] {
  const extension = viewerExtension(source.name);
  return selectableViewers(source).filter((viewer) => {
    if (viewer.id === 'text' || documentViews(source.name).some((item) => item.id === viewer.id))
      return (
        fileEditorAvailability({ name: source.name, size: source.size, is_file: true }) === 'text'
      );
    return viewer.extensions.includes(extension);
  });
}
export function savedViewer(
  source: ViewerSource,
  preferences: readonly ViewerPreference[] = [],
): ViewerId | undefined {
  const selectable = selectableViewers(source);
  for (const scope of ['server', 'game', 'global'] as const) {
    const preference = preferences.find(
      (item) => item.scope === scope && item.extension === viewerExtension(source.name),
    );
    if (preference && selectable.some((item) => item.id === preference.viewerId))
      return preference.viewerId;
  }
  return undefined;
}
export function preferredViewer(
  source: ViewerSource,
  preferences: readonly ViewerPreference[] = [],
): ViewerId | undefined {
  return savedViewer(source, preferences) ?? availableViewers(source)[0]?.id;
}
