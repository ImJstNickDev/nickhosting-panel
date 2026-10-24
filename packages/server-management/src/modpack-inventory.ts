import { DomainError } from '@nickhosting/core';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import { parseMinecraftProperties } from '../../../games/minecraft/src/management.js';
import { minecraftModpackPathSchema } from '../../../games/minecraft/src/modpack-contracts.js';
import type {
  MinecraftModpackObservation,
  MinecraftModpackReceipt,
  PreparedMinecraftModpack,
} from './minecraft-modpacks-plan.js';

const contentRoots = new Set([
  'mods',
  'coremods',
  'plugins',
  'config',
  'defaultconfigs',
  'kubejs',
  'scripts',
  'resources',
  'resourcepacks',
  'datapacks',
  'patchouli_books',
  'openloader',
]);
/** Inventory candidate parents and existing content roots in bounded Fileman batches.
 * Only discovered directories are traversed; symlinks and world data are never followed. */
export async function inspectModpackFiles(
  files: FilemanReadService,
  prepared: PreparedMinecraftModpack,
  receipt: MinecraftModpackReceipt | null,
  binding: { combinationId: string; mappingId: string; protectedPaths: string[] },
): Promise<MinecraftModpackObservation> {
  const root = await files.list('');
  const entries = new Map<string, MinecraftModpackObservation['entries'][number]>();
  const put = (directory: string, values: Awaited<ReturnType<FilemanReadService['list']>>) => {
    const names = new Set<string>();
    for (const value of values) {
      if (
        !value.name ||
        /[/\\\0]/.test(value.name) ||
        ['.', '..'].includes(value.name) ||
        names.has(value.name)
      )
        throw new DomainError('integration_unavailable');
      names.add(value.name);
      const path = directory ? `${directory}/${value.name}` : value.name;
      entries.set(path, { path, kind: value.kind, size: value.size, modifiedAt: value.modifiedAt });
      if (entries.size > 40000) throw new DomainError('validation_failed');
    }
  };
  put('', root);
  let configuredWorld: string | undefined;
  const properties = root.find((entry) => entry.name === 'server.properties');
  if (properties) {
    if (properties.kind !== 'file' || properties.size > 1024 * 1024)
      throw new DomainError('conflict');
    const content = await files.read({ path: 'server.properties', maxBytes: 1024 * 1024 });
    if (!content || content.byteLength > 1024 * 1024) throw new DomainError('conflict');
    const name = parseMinecraftProperties(Buffer.from(content).toString('utf8'))['level-name'];
    configuredWorld = minecraftModpackPathSchema.parse(name || 'world');
  }
  const wanted = new Set<string>();
  for (const file of [
    ...prepared.files,
    ...(receipt?.files ?? []),
    ...(configuredWorld ? [{ path: `${configuredWorld}/level.dat` }] : []),
  ]) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      wanted.add(parts.slice(0, i).join('/'));
      if (wanted.size > 20000) throw new DomainError('validation_failed');
    }
  }
  const topDirectories = root
    .filter(
      (entry) =>
        entry.kind === 'directory' &&
        (!entry.name.startsWith('.') || configuredWorld?.split('/')[0] === entry.name),
    )
    .map((entry) => entry.name);
  if (topDirectories.length > 1000) throw new DomainError('validation_failed');
  const worldRoots: string[] = [];
  const pending = [...topDirectories];
  const queued = new Set(pending);
  let cursor = 0;
  while (cursor < pending.length) {
    const batch = pending.slice(cursor, cursor + 100);
    cursor += batch.length;
    const results = await files.listMany(batch);
    // A partial response is not evidence that the omitted directory was empty.
    if (
      results.length !== batch.length ||
      new Set(results.map((value) => value.directory)).size !== batch.length ||
      results.some((value) => !batch.includes(value.directory))
    )
      throw new DomainError('integration_unavailable');
    for (const result of results) {
      if ('error' in result) {
        if (result.error === 'not_found') continue;
        throw new DomainError('integration_unavailable');
      }
      put(result.directory, result.files);
      if (
        result.directory === configuredWorld ||
        result.files.some((file) => file.name === 'level.dat' && file.kind === 'file')
      ) {
        worldRoots.push(result.directory);
        continue;
      }
      const recursive = contentRoots.has(result.directory.split('/')[0] ?? '');
      for (const file of result.files) {
        if (file.kind !== 'directory') continue;
        const path = `${result.directory}/${file.name}`;
        if ((!recursive && !wanted.has(path)) || queued.has(path)) continue;
        queued.add(path);
        pending.push(path);
        if (queued.size > 20000) throw new DomainError('validation_failed');
      }
    }
  }
  return {
    ...binding,
    entries: [...entries.values()],
    worldRoots,
    replacePaths: root.filter((entry) => contentRoots.has(entry.name)).map((entry) => entry.name),
  };
}
