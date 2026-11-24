import type { FilemanEntry, FilemanReadService } from '@nickhosting/game-sdk';
import { openworldDataRoot } from './offline-players.js';

export async function readOpenworldRuleFiles(files: FilemanReadService) {
  const root = await files.list('');
  const limit = 512 * 1024;
  const bounded = (entries: readonly FilemanEntry[], name: string) =>
    entries.some((e) => e.name === name && e.kind === 'file' && e.size <= limit);
  const data = await openworldDataRoot(files, root);
  const dataPath = (name: string) =>
    data && bounded(data.entries, name)
      ? data.directory
        ? `${data.directory}/${name}`
        : name
      : undefined;
  const zonesPath = dataPath('zones.json');
  const bordersPath = dataPath('borders.json');
  const paths = bounded(root, 'roles.json') ? ['roles.json'] : [];
  if (zonesPath) paths.push(zonesPath);
  if (bordersPath) paths.push(bordersPath);
  const contents = paths.length
    ? await files.readMany(paths.map((path) => ({ path, maxBytes: limit, missing: 'allow' })))
    : new Map<string, Uint8Array>();
  return {
    roles: contents.get('roles.json'),
    borders: bordersPath ? contents.get(bordersPath) : undefined,
    zones: zonesPath ? contents.get(zonesPath) : undefined,
  };
}
