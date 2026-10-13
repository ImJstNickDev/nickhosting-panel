import { fileEditorAvailability } from '../../../../../../packages/core/src/file-content.js';
import { gameViewerRegistry } from '../trusted-viewers.js';

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
  extensions: readonly string[];
}

/** Executable modules are compiled imports, never names or code supplied by an API. */
export const builtinViewers: readonly ViewerDefinition[] = [
  {
    id: 'image',
    label: 'viewer.image',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'svg', 'bmp', 'ico'],
  },
  {
    id: 'audio',
    label: 'viewer.audio',
    extensions: ['ogg', 'oga', 'mp3', 'wav', 'flac', 'opus', 'm4a', 'aac'],
  },
  {
    id: 'video',
    label: 'viewer.video',
    extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv'],
  },
  {
    id: 'archive',
    label: 'viewer.archive',
    extensions: ['zip', 'jar', 'tar', 'tgz', 'tar.gz', '7z', 'rar', 'tar.bz2', 'tar.xz', 'tar.zst'],
  },
  { id: 'sqlite', label: 'viewer.sqlite', extensions: ['db', 'sqlite', 'sqlite3'] },
  { id: 'json', label: 'viewer.json', extensions: ['json', 'jsonc', 'json5'] },
  { id: 'text', label: 'file.editor', extensions: [] },
];

export function viewerExtension(name: string) {
  const lower = name.toLowerCase();
  const compound = ['tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst'].find((extension) =>
    lower.endsWith(`.${extension}`),
  );
  return compound ?? (lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '');
}
export function availableViewers(source: ViewerSource): ViewerDefinition[] {
  const extension = viewerExtension(source.name);
  const gameViewers: ViewerDefinition[] = gameViewerRegistry
    .forFile(source.gameId, extension)
    .map(({ descriptor }) => ({
      id: descriptor.id as ViewerId,
      label: descriptor.labelKey,
      extensions: descriptor.extensions,
    }));
  return [...gameViewers, ...builtinViewers].filter((viewer) => {
    if (source.entry && ['archive', 'sqlite'].includes(viewer.id)) return false;
    if (viewer.id === 'text')
      return (
        fileEditorAvailability({ name: source.name, size: source.size, is_file: true }) === 'text'
      );
    return viewer.extensions.includes(extension);
  });
}
export function preferredViewer(
  source: ViewerSource,
  preferences: readonly ViewerPreference[] = [],
): ViewerId | undefined {
  const available = availableViewers(source);
  for (const scope of ['server', 'game', 'global'] as const) {
    const preference = preferences.find(
      (item) => item.scope === scope && item.extension === viewerExtension(source.name),
    );
    if (preference && available.some((item) => item.id === preference.viewerId))
      return preference.viewerId;
  }
  return available[0]?.id;
}
