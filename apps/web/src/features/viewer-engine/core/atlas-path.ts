import type { FilemanPathProvider } from '@nickhosting/game-sdk/ui';
import { parseFilePathInput } from '../../file-path-model.js';
import type { ArchiveEntry, ArchivePage } from './archive-query.js';
import { isSingleCompressed } from './compressed.js';
import { builtinViewers, type ViewerSource, viewerExtension } from './registry.js';

export interface AtlasAlias {
  original: ViewerSource;
  internal: ViewerSource;
}
export interface AtlasPathLocation {
  source: ViewerSource;
  directory: string;
}
const archiveExtensions = new Set(
  builtinViewers.find((viewer) => viewer.id === 'archive')?.extensions,
);
const archiveFile = (entry: ArchiveEntry) =>
  !entry.directory && archiveExtensions.has(viewerExtension(entry.name));
const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join('/');
const chainKey = (source: ViewerSource) => JSON.stringify(source.archives ?? []);

/** Virtual names stay entirely inside Atlas; only the original path reaches server filesystem APIs. */
export function createAtlasPathProvider(options: {
  key: readonly string[];
  root: ViewerSource;
  source: ViewerSource;
  directory: string;
  aliases: readonly AtlasAlias[];
  read(
    source: ViewerSource,
    directory: string,
    prefix: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<ArchivePage>;
  shouldDecode?(source: ViewerSource): boolean;
  rememberAliases?(aliases: readonly AtlasAlias[]): void;
  navigate(location: AtlasPathLocation): void;
  open(source: ViewerSource): void;
}): FilemanPathProvider {
  const { root, source, aliases } = options;
  const containers = new Map(aliases.map((alias) => [chainKey(alias.original), alias]));
  const hidden = new Set(aliases.map((alias) => chainKey(alias.internal)));
  const visibleArchives = (source.archives ?? []).filter(
    (_, index) => !hidden.has(JSON.stringify(source.archives?.slice(0, index + 1))),
  );
  const current = join(root.path, ...visibleArchives, source.entry ?? options.directory);
  const owns = (path: string) => path === root.path || path.startsWith(`${root.path}/`);
  const invalid = () => {
    throw { messageKey: 'file.pathNotFound' };
  };
  async function container(
    input: ViewerSource,
    signal?: AbortSignal,
    decode = false,
  ): Promise<ViewerSource> {
    const known = containers.get(chainKey(input));
    if (known) return known.internal;
    if (!decode || !isSingleCompressed(input) || options.shouldDecode?.(input) === false)
      return input;
    const page = await options.read(input, '', '', 0, signal);
    signal?.throwIfAborted();
    const member = page.entries[0];
    if (page.total !== 1 || !member || !archiveFile(member)) return input;
    const archives = [...(input.archives ?? []), member.path];
    if (archives.length > 4) return invalid();
    const internal = { ...input, name: member.name, size: member.size, archives, entry: undefined };
    containers.set(chainKey(input), { original: input, internal });
    return internal;
  }
  async function entries(
    input: ViewerSource,
    directory: string,
    prefix: string,
    signal?: AbortSignal,
    exact = false,
  ) {
    const found: ArchiveEntry[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    do {
      signal?.throwIfAborted();
      const page = await options.read(input, directory, prefix, offset, signal);
      signal?.throwIfAborted();
      for (const entry of page.entries) {
        if (
          exact ? entry.name === prefix : entry.name.toLowerCase().startsWith(prefix.toLowerCase())
        )
          found.push(entry);
        if (found.length >= (exact ? 1 : 200)) return found;
      }
      offset += page.entries.length;
      total = page.total;
      if (!page.entries.length) break;
    } while (offset < total);
    return found;
  }
  async function resolve(
    path: string,
    signal?: AbortSignal,
  ): Promise<AtlasPathLocation & { entry?: ArchiveEntry }> {
    if (!owns(path) || parseFilePathInput(`/${path}/`)?.path !== path) return invalid();
    let input = await container({ ...root, archives: [], entry: undefined }, signal);
    let directory = '';
    const segments = path.slice(root.path.length).split('/').filter(Boolean);
    for (let index = 0; index < segments.length; index++) {
      const name = segments[index] as string;
      const entry = (await entries(input, directory, name, signal, true))[0];
      if (!entry) return invalid();
      if (entry.directory) directory = entry.path;
      else if (archiveFile(entry)) {
        const archives = [...(input.archives ?? []), entry.path];
        if (archives.length > 4) return invalid();
        input = await container(
          {
            ...input,
            name: entry.name,
            size: entry.size,
            archives,
            entry: undefined,
          },
          signal,
          true,
        );
        directory = '';
      } else if (index === segments.length - 1) return { source: input, directory, entry };
      else return invalid();
    }
    return { source: input, directory };
  }
  return {
    key: options.key,
    currentPath: `/${current}${source.entry ? '' : '/'}`,
    owns,
    async list(path, prefix, signal) {
      const location = await resolve(path, signal);
      if (location.entry) return invalid();
      return (await entries(location.source, location.directory, prefix, signal)).map((entry) => ({
        name: entry.name,
        is_file: !entry.directory && !archiveFile(entry),
        is_symlink: false,
      }));
    },
    async navigate(path, signal) {
      const location = await resolve(path, signal);
      if (location.entry) return invalid();
      // Validate opening a nested container before committing the navigation.
      await options.read(location.source, location.directory, '', 0, signal);
      signal?.throwIfAborted();
      options.rememberAliases?.([...containers.values()]);
      options.navigate(location);
    },
    async open(path, signal) {
      const location = await resolve(path, signal);
      signal?.throwIfAborted();
      if (!location.entry) {
        await options.read(location.source, location.directory, '', 0, signal);
        signal?.throwIfAborted();
        options.rememberAliases?.([...containers.values()]);
        options.navigate(location);
      } else {
        options.rememberAliases?.([...containers.values()]);
        options.open({
          ...location.source,
          name: location.entry.name,
          size: location.entry.size,
          entry: location.entry.path,
        });
      }
    },
  };
}
