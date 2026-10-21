import { parse as parseToml } from 'smol-toml';
import {
  type JarArchiveEntry,
  type JarArchiveReader,
  type JarMetadataIssue,
  readJarDescriptors,
} from './jar-descriptors.js';

export type ModLoader = 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'forge-neoforge';
export type ModEnvironment = 'client' | 'server' | 'both';
export type ModDependencyKind =
  | 'required'
  | 'optional'
  | 'recommended'
  | 'suggested'
  | 'incompatible'
  | 'discouraged';
export interface ModDependency {
  id: string;
  version: string;
  kind: ModDependencyKind;
  environment?: ModEnvironment;
  /** Quilt preserves compound / conditional rules instead of inventing mandatory dependencies. */
  alternatives?: ModDependency[];
  combination?: 'any' | 'all';
  unless?: ModDependency;
}
export interface ModMetadata {
  id: string;
  name: string;
  version?: string;
  description?: string;
  loader: ModLoader;
  source: string;
  authors: string[];
  licenses: string[];
  environment?: ModEnvironment;
  links: { label: string; url: string }[];
  dependencies: ModDependency[];
  iconPath?: string;
}
export type ModMetadataIssue = JarMetadataIssue;
export interface ModArchiveMetadata {
  mods: ModMetadata[];
  issues: ModMetadataIssue[];
  sources: string[];
}
export type ModArchiveReader = JarArchiveReader;
export type ModArchiveEntry = JarArchiveEntry;

const itemLimit = 256;
const rootDescriptors = ['fabric.mod.json', 'quilt.mod.json', 'quilt.mod.json5', 'mcmod.info'];
const metaDescriptors = ['mods.toml', 'neoforge.mods.toml'];
type ObjectValue = Record<string, unknown>;
type Issue = (source: string, code: ModMetadataIssue['code']) => void;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}
function text(value: unknown, limit = 4096): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, limit).trim() : undefined;
}
function limited<T>(values: T[], source?: string, issue?: Issue): T[] {
  if (values.length > itemLimit && source) issue?.(source, 'too_large');
  return values.slice(0, itemLimit);
}
function list(value: unknown, source?: string, issue?: Issue): unknown[] {
  return Array.isArray(value) ? limited(value, source, issue) : [];
}
function strings(value: unknown, source?: string, issue?: Issue): string[] {
  const values = Array.isArray(value) ? list(value, source, issue) : [value];
  return [...new Set(values.map((item) => text(item)).filter((item): item is string => !!item))];
}
function people(value: unknown, source: string, issue: Issue): string[] {
  return strings(
    list(value, source, issue).map((entry) =>
      typeof entry === 'string' ? entry : object(entry)?.name,
    ),
  );
}
function environment(value: unknown): ModEnvironment | undefined {
  if (value === 'client' || value === 'CLIENT') return 'client';
  if (value === 'server' || value === 'SERVER' || value === 'dedicated_server') return 'server';
  if (value === '*' || value === 'universal' || value === 'BOTH') return 'both';
  return undefined;
}
function versionRange(value: unknown, source: string, issue: Issue): string {
  if (value === undefined) return '*';
  if (
    typeof value === 'string' ||
    (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string'))
  )
    return strings(value, source, issue).join(' || ') || '*';
  issue(source, 'invalid_metadata');
  return '?';
}
function links(value: unknown): ModMetadata['links'] {
  const entries = Object.entries(object(value) ?? {}).slice(0, 32);
  return entries.flatMap(([label, raw]) => {
    const value = text(raw, 2048);
    if (!value) return [];
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? [{ label: label.slice(0, 64), url: url.href }]
        : [];
    } catch {
      return [];
    }
  });
}

/** A resource inside this JAR; never an external URL or an escape to a neighbouring file. */
export function modArchiveResourcePath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    /[\\:?#]/.test(value) ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return undefined;
  return value;
}
function icon(value: unknown, source: string, issue: Issue): string | undefined {
  let candidate = value;
  const sizes = object(value);
  if (sizes) {
    const entries = Object.entries(sizes)
      .map(([size, path]) => ({ size: Number(size), path }))
      .filter(({ size }) => Number.isFinite(size) && size > 0)
      .sort((a, b) => Math.abs(a.size - 128) - Math.abs(b.size - 128));
    candidate = entries[0]?.path;
  }
  if (candidate === undefined) return undefined;
  const path = modArchiveResourcePath(candidate);
  if (!path) issue(source, 'unsafe_path');
  return path;
}
function makeMod(
  id: unknown,
  source: string,
  loader: ModLoader,
  values: Partial<Omit<ModMetadata, 'id' | 'source' | 'loader'>>,
): ModMetadata | undefined {
  const identifier = text(id, 256);
  if (!identifier) return undefined;
  return {
    id: identifier,
    name: identifier,
    source,
    loader,
    authors: [],
    licenses: [],
    links: [],
    dependencies: [],
    ...values,
  };
}
function mapDependencies(
  value: unknown,
  kind: ModDependencyKind,
  source: string,
  issue: Issue,
): ModDependency[] {
  const entries = Object.entries(object(value) ?? {});
  if (entries.length > itemLimit) issue(source, 'too_large');
  return entries.slice(0, itemLimit).map(([id, range]) => ({
    id: id.slice(0, 256),
    version: versionRange(range, source, issue),
    kind,
  }));
}
function fabric(value: unknown, source: string, issue: Issue): ModMetadata[] {
  const data = object(value);
  if (!data) throw new TypeError('Invalid descriptor.');
  const schema = data.schemaVersion ?? 0;
  if (schema !== 0 && schema !== 1) {
    issue(source, 'unsupported_schema');
    return [];
  }
  const legacy = schema === 0;
  const contact = legacy ? data.links : data.contact;
  const legacyIcon = text(data.id) ? `assets/${text(data.id)}/icon.png` : undefined;
  const mod = makeMod(data.id, source, 'fabric', {
    name: text(data.name) ?? text(data.id),
    version: text(data.version),
    description: text(data.description, 16_384),
    authors: people(data.authors, source, issue),
    licenses: strings(data.license, source, issue),
    environment: environment((legacy ? data.side : data.environment) ?? '*'),
    links: links(typeof contact === 'string' ? { homepage: contact } : contact),
    iconPath: icon(legacy ? legacyIcon : data.icon, source, issue),
    dependencies: limited(
      [
        ...mapDependencies(legacy ? data.requires : data.depends, 'required', source, issue),
        ...mapDependencies(data.recommends, 'recommended', source, issue),
        ...mapDependencies(data.suggests, 'suggested', source, issue),
        ...mapDependencies(data.breaks, 'incompatible', source, issue),
        ...mapDependencies(data.conflicts, legacy ? 'incompatible' : 'discouraged', source, issue),
      ],
      source,
      issue,
    ),
  });
  if (!mod) issue(source, 'invalid_metadata');
  return mod ? [mod] : [];
}

function quiltVersionRange(value: unknown, source: string, issue: Issue, depth = 0): string {
  if (value === undefined) return '*';
  const plain = text(value);
  if (plain) return plain;
  if (depth > 8) {
    issue(source, 'too_large');
    return '?';
  }
  const data = object(value);
  const children = Array.isArray(value) ? value : (data?.any ?? data?.all);
  if (!Array.isArray(children) || children.length === 0 || (data?.any && data.all)) {
    issue(source, 'invalid_metadata');
    return '?';
  }
  if (children.length > itemLimit) issue(source, 'too_large');
  return list(children)
    .map((child) => {
      const expression = quiltVersionRange(child, source, issue, depth + 1);
      return expression.includes(' || ') || expression.includes(' && ')
        ? `(${expression})`
        : expression;
    })
    .join(data?.all ? ' && ' : ' || ');
}

function quiltDependency(
  value: unknown,
  kind: ModDependencyKind,
  source: string,
  issue: Issue,
  depth = 0,
): ModDependency | undefined {
  if (depth > 8) {
    issue(source, 'too_large');
    return undefined;
  }
  if (typeof value === 'string') return { id: value.slice(0, 256), version: '*', kind };
  if (Array.isArray(value)) {
    const alternatives = list(value, source, issue)
      .map((entry) => quiltDependency(entry, kind, source, issue, depth + 1))
      .filter((entry): entry is ModDependency => !!entry);
    return alternatives.length
      ? {
          id: '',
          version: '',
          kind,
          alternatives,
          combination: kind === 'incompatible' ? 'all' : 'any',
        }
      : undefined;
  }
  const data = object(value);
  const id = text(data?.id, 256);
  if (!data || !id) {
    issue(source, 'invalid_metadata');
    return undefined;
  }
  return {
    id,
    version: quiltVersionRange(data.versions, source, issue),
    kind: data.optional === true ? 'optional' : kind,
    ...(data.unless === undefined
      ? {}
      : { unless: quiltDependency(data.unless, 'required', source, issue, depth + 1) }),
  };
}
function quilt(value: unknown, source: string, issue: Issue): ModMetadata[] {
  const root = object(value);
  if (root?.schema_version !== 1) {
    issue(source, root ? 'unsupported_schema' : 'invalid_metadata');
    return [];
  }
  const data = object(root.quilt_loader);
  if (!data) throw new TypeError('Invalid descriptor.');
  const meta = object(data.metadata) ?? {};
  const licenses = (
    Array.isArray(meta.license) ? list(meta.license, source, issue) : [meta.license]
  ).flatMap((entry) =>
    strings(typeof entry === 'string' ? entry : (object(entry)?.id ?? object(entry)?.name)),
  );
  const mod = makeMod(data.id, source, 'quilt', {
    name: text(meta.name) ?? text(data.id),
    version: text(data.version),
    description: text(meta.description, 16_384),
    authors: Object.keys(object(meta.contributors) ?? {}).slice(0, itemLimit),
    licenses,
    environment: environment(object(root.minecraft)?.environment ?? '*'),
    links: links(meta.contact),
    iconPath: icon(meta.icon, source, issue),
    dependencies: limited(
      (
        [
          ['depends', 'required'],
          ['breaks', 'incompatible'],
        ] as const
      ).flatMap(([key, kind]) =>
        list(data[key], source, issue)
          .map((entry) => quiltDependency(entry, kind, source, issue))
          .filter((entry): entry is ModDependency => !!entry),
      ),
      source,
      issue,
    ),
  });
  if (!mod) issue(source, 'invalid_metadata');
  return mod ? [mod] : [];
}

/** JAR manifest attributes are case insensitive. Only the main section describes this archive. */
function manifestAttributes(value: string): Map<string, string> {
  const result = new Map<string, string>();
  let key: string | undefined;
  for (const line of value.split(/\r\n|\n|\r/)) {
    if (!line) break;
    if (line.startsWith(' ') && key) {
      result.set(key, (result.get(key) ?? '') + line.slice(1));
      continue;
    }
    const match = /^([^: ]+): (.*)$/.exec(line);
    key = match?.[1]?.toLowerCase();
    if (key) result.set(key, match?.[2] ?? '');
  }
  return result;
}
function forgeVersion(
  raw: unknown,
  properties: ObjectValue,
  attributes: Map<string, string>,
  source: string,
  issue: Issue,
): string | undefined {
  const value = text(raw);
  if (!value) return undefined;
  const replaced = value.replace(/\$\{file\.([^}]+)\}/g, (original, key: string) => {
    const resolved =
      key === 'jarVersion' ? attributes.get('implementation-version') : properties[key];
    return typeof resolved === 'string' || typeof resolved === 'number'
      ? String(resolved)
      : original;
  });
  if (/\$\{[^}]*\}/.test(replaced)) issue(source, 'unresolved_version');
  return replaced.slice(0, 4096);
}
function forge(
  value: unknown,
  source: string,
  attributes: Map<string, string>,
  issue: Issue,
): ModMetadata[] {
  const root = object(value);
  if (!root) throw new TypeError('Invalid descriptor.');
  const dependencies = object(root.dependencies) ?? {};
  const properties = object(root.properties) ?? {};
  const newNeo = source === 'META-INF/neoforge.mods.toml';
  const mods = list(root.mods);
  if (!Array.isArray(root.mods) || mods.length === 0) issue(source, 'invalid_metadata');
  if (Array.isArray(root.mods) && root.mods.length > itemLimit) issue(source, 'too_large');
  return mods.flatMap((entry) => {
    const data = object(entry);
    if (!data) {
      issue(source, 'invalid_metadata');
      return [];
    }
    const id = text(data.modId, 256);
    if (!id) {
      issue(source, 'invalid_metadata');
      return [];
    }
    const dependencyEntries = list(dependencies[id], source, issue).flatMap((value) => {
      const dep = object(value);
      const depId = text(dep?.modId, 256);
      if (!dep || !depId) return [];
      const neoKind = ['required', 'optional', 'incompatible', 'discouraged'].includes(
        String(dep.type),
      )
        ? (dep.type as ModDependencyKind)
        : undefined;
      return [
        {
          id: depId,
          version: versionRange(dep.versionRange, source, issue),
          kind: neoKind ?? (dep.mandatory === false ? 'optional' : 'required'),
          environment: environment(dep.side),
        },
      ];
    });
    const neo = newNeo || dependencyEntries.some((dep) => dep.id === 'neoforge');
    const loader: ModLoader = neo
      ? 'neoforge'
      : dependencyEntries.some((dep) => dep.id === 'forge')
        ? 'forge'
        : 'forge-neoforge';
    const mod = makeMod(id, source, loader, {
      name: text(data.displayName) ?? id,
      version: forgeVersion(data.version, properties, attributes, source, issue),
      description: text(data.description, 16_384),
      authors: strings(data.authors),
      licenses: strings(root.license, source, issue),
      environment: root.clientSideOnly === true ? 'client' : undefined,
      links: links({ homepage: data.displayURL, issues: root.issueTrackerURL }),
      iconPath: icon(data.logoFile, source, issue),
      dependencies: dependencyEntries,
    });
    return mod ? [mod] : [];
  });
}
function legacyDependency(value: string, kind: ModDependencyKind): ModDependency {
  const delimiter = value.indexOf('@');
  return delimiter >= 0
    ? { id: value.slice(0, delimiter), version: value.slice(delimiter + 1) || '*', kind }
    : { id: value, version: '*', kind };
}
function legacyForge(value: unknown, source: string, issue: Issue): ModMetadata[] {
  const collection = Array.isArray(value) ? value : object(value)?.modList;
  const entries = list(collection);
  if (!Array.isArray(collection) || entries.length === 0) issue(source, 'invalid_metadata');
  if (Array.isArray(collection) && collection.length > itemLimit) issue(source, 'too_large');
  return entries.flatMap((entry) => {
    const data = object(entry);
    if (!data) {
      issue(source, 'invalid_metadata');
      return [];
    }
    const mod = makeMod(data.modid, source, 'forge', {
      name: text(data.name) ?? text(data.modid),
      version: text(data.version),
      description: text(data.description, 16_384),
      authors: strings(data.authorList, source, issue),
      links: links({ homepage: data.url }),
      iconPath: icon(data.logoFile || undefined, source, issue),
      // Annotations can override this legacy descriptor; no runtime compatibility is inferred.
      dependencies:
        data.useDependencyInformation === true
          ? limited(
              [
                ...strings(data.requiredMods, source, issue).map((value) =>
                  legacyDependency(value, 'required'),
                ),
                ...strings(data.dependencies, source, issue).map((value) =>
                  legacyDependency(value, 'optional'),
                ),
              ],
              source,
              issue,
            )
          : [],
    });
    if (!mod) issue(source, 'invalid_metadata');
    return mod ? [mod] : [];
  });
}

/** Reads only known top-level descriptors. It never loads Java, embedded JARs or external URLs. */
export async function readModArchive(
  archive: ModArchiveReader,
  signal: AbortSignal,
): Promise<ModArchiveMetadata> {
  const { sources, texts, issues, remaining } = await readJarDescriptors(
    archive,
    signal,
    [...rootDescriptors, ...metaDescriptors.map((name) => `META-INF/${name}`)],
    { unsupported: ['quilt.mod.json5'] },
  );
  const result: ModArchiveMetadata = { mods: [], issues, sources };
  const issue: Issue = (source, code) => {
    if (!result.issues.some((entry) => entry.source === source && entry.code === code))
      result.issues.push({ source, code });
  };
  const parsed = new Map<string, unknown>();
  for (const source of sources) {
    const value = texts.get(source);
    if (value === undefined) continue;
    try {
      parsed.set(source, source.endsWith('.toml') ? parseToml(value) : JSON.parse(value));
    } catch {
      issue(source, 'invalid_metadata');
    }
  }
  let attributes = new Map<string, string>();
  const needsManifest = [...parsed.entries()].some(
    ([source, value]) =>
      source.endsWith('.toml') &&
      list(object(value)?.mods).some((mod) =>
        text(object(mod)?.version)?.includes(`\${file.jarVersion}`),
      ),
  );
  if (needsManifest) {
    const page = await archive.list('META-INF', signal, 'MANIFEST.MF');
    const entry = page.entries.find(
      (entry) => entry.path === 'META-INF/MANIFEST.MF' && !entry.directory,
    );
    if (
      entry &&
      Number.isSafeInteger(entry.size) &&
      entry.size >= 0 &&
      entry.size <= Math.min(64 * 1024, remaining)
    ) {
      const bytes = await archive.read(entry.path, 64 * 1024, signal);
      signal.throwIfAborted();
      if (bytes.byteLength <= 64 * 1024 && bytes.byteLength <= entry.size)
        attributes = manifestAttributes(new TextDecoder().decode(bytes));
      else issue(entry.path, 'too_large');
    } else if (entry) issue(entry.path, 'too_large');
  }
  for (const [source, value] of parsed) {
    try {
      const mods =
        source === 'fabric.mod.json'
          ? fabric(value, source, issue)
          : source === 'quilt.mod.json'
            ? quilt(value, source, issue)
            : source === 'mcmod.info'
              ? legacyForge(value, source, issue)
              : forge(value, source, attributes, issue);
      const remainingMods = itemLimit - result.mods.length;
      result.mods.push(...mods.slice(0, remainingMods));
      if (mods.length > remainingMods) issue(source, 'too_large');
    } catch {
      issue(source, 'invalid_metadata');
    }
  }
  return result;
}
