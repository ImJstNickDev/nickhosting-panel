/** Shared, bounded metadata access for Minecraft's JAR viewers. Fileman owns transport/cache. */
export interface JarArchiveEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
}
export interface JarArchiveReader {
  list(
    directory: string,
    signal: AbortSignal,
    query?: string,
  ): Promise<{
    entries: readonly JarArchiveEntry[];
    total: number;
  }>;
  read(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
}
export interface JarMetadataIssue {
  source: string;
  code:
    | 'invalid_metadata'
    | 'too_large'
    | 'unsupported_schema'
    | 'unsafe_path'
    | 'unresolved_version';
}

const descriptorLimit = 256 * 1024;
const totalLimit = 1024 * 1024;

/** Compiled root/first-level descriptor names only. No recursive scan or names inferred from contents. */
export async function readJarDescriptors(
  archive: JarArchiveReader,
  signal: AbortSignal,
  paths: readonly string[],
  options: { unsupported?: readonly string[] } = {},
) {
  signal.throwIfAborted();
  const descriptorPaths = [...new Set(paths)];
  const issues: JarMetadataIssue[] = [];
  const issue = (source: string, code: JarMetadataIssue['code']) => {
    if (!issues.some((entry) => entry.source === source && entry.code === code))
      issues.push({ source, code });
  };
  const known = new Map<string, JarArchiveEntry>();
  const groups = new Map<string, string[]>();
  for (const path of descriptorPaths) {
    const slash = path.lastIndexOf('/');
    const directory = slash === -1 ? '' : path.slice(0, slash);
    const names = groups.get(directory) ?? [];
    names.push(path.slice(slash + 1));
    groups.set(directory, names);
  }
  async function find(directory: string, names: readonly string[]) {
    const page = await archive.list(directory, signal);
    signal.throwIfAborted();
    const prefix = directory ? `${directory}/` : '';
    const exact = (entries: readonly JarArchiveEntry[], name: string) =>
      entries.find((entry) => entry.name === name && entry.path === `${prefix}${name}`);
    await Promise.all(
      names.map(async (name) => {
        let found = exact(page.entries, name);
        if (!found && page.total > page.entries.length) {
          const filtered = await archive.list(directory, signal, name);
          signal.throwIfAborted();
          found = exact(filtered.entries, name);
          if (!found && filtered.total > filtered.entries.length)
            issue(`${prefix}${name}`, 'too_large');
        }
        if (found) known.set(found.path, found);
      }),
    );
  }
  const directories = [...groups.keys()].filter(Boolean);
  await find('', [...new Set([...(groups.get('') ?? []), ...directories])]);
  await Promise.all(
    directories.map(async (directory) => {
      if (known.get(directory)?.directory) await find(directory, groups.get(directory) ?? []);
    }),
  );
  const descriptors = descriptorPaths
    .map((path) => known.get(path))
    .filter((entry): entry is JarArchiveEntry => !!entry && !entry.directory);
  let remaining = totalLimit;
  const texts = new Map<string, string>();
  const reads: Promise<void>[] = [];
  for (const entry of descriptors) {
    if (options.unsupported?.includes(entry.path)) {
      issue(entry.path, 'unsupported_schema');
      continue;
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > Math.min(descriptorLimit, remaining)
    ) {
      issue(entry.path, 'too_large');
      continue;
    }
    remaining -= entry.size;
    reads.push(
      (async () => {
        const bytes = await archive.read(entry.path, descriptorLimit, signal);
        signal.throwIfAborted();
        if (bytes.byteLength > descriptorLimit || bytes.byteLength > entry.size) {
          issue(entry.path, 'too_large');
          return;
        }
        try {
          texts.set(entry.path, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          issue(entry.path, 'invalid_metadata');
        }
      })(),
    );
  }
  await Promise.all(reads);
  signal.throwIfAborted();
  return { sources: descriptors.map((entry) => entry.path), texts, issues, remaining };
}
