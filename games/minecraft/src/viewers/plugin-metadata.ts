import { isScalar, parseDocument, visit } from 'yaml';
import {
  type JarArchiveReader,
  type JarMetadataIssue,
  readJarDescriptors,
} from './jar-descriptors.js';

export type PluginPlatform = 'bukkit' | 'paper' | 'bungeecord' | 'velocity';
export interface PluginDependency {
  id: string;
  kind: 'required' | 'optional' | 'loadbefore';
  stage?: 'bootstrap' | 'server';
  load?: 'BEFORE' | 'AFTER' | 'OMIT';
  joinClasspath?: boolean;
}
export interface PluginCommand {
  name: string;
  description?: string;
  usage?: string;
  aliases: string[];
  permission?: string;
  permissionMessage?: string;
}
export interface PluginPermission {
  name: string;
  description?: string;
  default?: string;
  children: { name: string; value: boolean }[];
}
export interface PluginMetadata {
  id: string;
  name: string;
  version?: string;
  description?: string;
  platform: PluginPlatform;
  source: string;
  authors: string[];
  contributors: string[];
  links: { label: string; url: string }[];
  apiVersion?: string;
  main?: string;
  load?: string;
  bootstrapper?: string;
  loader?: string;
  prefix?: string;
  /** A declaration from the descriptor, not verified Folia compatibility. */
  foliaSupported?: boolean;
  provides: string[];
  libraries: string[];
  defaultPermission?: string;
  dependencies: PluginDependency[];
  commands: PluginCommand[];
  permissions: PluginPermission[];
}
export interface PluginArchiveMetadata {
  plugins: PluginMetadata[];
  issues: JarMetadataIssue[];
  sources: string[];
}

// Paper selects its own descriptor first. Preserve other platform descriptors separately.
const descriptors = ['paper-plugin.yml', 'plugin.yml', 'bungee.yml', 'velocity-plugin.json'];
const itemLimit = 256;
type ObjectValue = Record<string, unknown>;
type Issue = (code: JarMetadataIssue['code']) => void;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}
function text(value: unknown, limit = 4096): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, limit).trim() : undefined;
}
function bounded<T>(values: T[], issue: Issue): T[] {
  if (values.length > itemLimit) issue('too_large');
  return values.slice(0, itemLimit);
}
function strings(value: unknown, issue: Issue, limit = 4096): string[] {
  return [
    ...new Set(
      bounded(Array.isArray(value) ? value : [value], issue)
        .map((entry) => text(entry, limit))
        .filter((entry): entry is string => !!entry),
    ),
  ];
}
function entries(value: unknown, issue: Issue): [string, unknown][] {
  return bounded(Object.entries(object(value) ?? {}), issue).map(([name, value]) => {
    if (name.length > 256) issue('too_large');
    return [name.slice(0, 256), value];
  });
}
function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function website(value: unknown): PluginMetadata['links'] {
  const raw = text(value, 2048);
  if (!raw) return [];
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? [{ label: 'homepage', url: url.href }]
      : [];
  } catch {
    return [];
  }
}
function permissionDefault(value: unknown): string | undefined {
  if (typeof value === 'boolean') return String(value);
  const name = text(value)?.toLowerCase();
  return name && ['op', 'not op', 'notop', '!op', 'true', 'false'].includes(name)
    ? name === 'not op' || name === '!op'
      ? 'notop'
      : name
    : undefined;
}

/** Parse data only. Bound aliases/AST size; preserve numeric-looking version spellings. */
function yaml(raw: string): ObjectValue {
  const document = parseDocument(raw, { uniqueKeys: true, merge: true, strict: true });
  if (document.errors.length || document.warnings.length) throw new TypeError('Invalid YAML.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 8192 || path.length > 48) throw new RangeError('Descriptor too complex.');
    const tag = object(node)?.tag;
    if (typeof tag === 'string' && !tag.startsWith('tag:yaml.org,2002:'))
      throw new TypeError('Unsupported YAML tag.');
  });
  const data = object(document.toJS({ maxAliasCount: 32 }));
  if (!data) throw new TypeError('Descriptor must be a mapping.');
  for (const key of ['version', 'api-version']) {
    const scalar = document.get(key, true);
    if (
      isScalar(scalar) &&
      (typeof scalar.value === 'number' || typeof scalar.value === 'bigint') &&
      scalar.source
    )
      data[key] = scalar.source;
  }
  return data;
}

function permissions(value: unknown, fallback: string, issue: Issue): PluginPermission[] {
  const output: PluginPermission[] = [];
  // Bukkit permits nested declarations and a list shorthand for true-valued children.
  const active = new Set<ObjectValue>();
  function add(name: string, raw: unknown, inherited: string, depth: number) {
    if (output.length >= itemLimit || depth > 16) {
      issue('too_large');
      return;
    }
    const data = object(raw);
    if (!data || active.has(data)) {
      issue('invalid_metadata');
      return;
    }
    active.add(data);
    const defaultValue = permissionDefault(data.default) ?? inherited;
    if (data.default !== undefined && !permissionDefault(data.default)) issue('invalid_metadata');
    const permission: PluginPermission = {
      name: name.slice(0, 256),
      description: text(data.description),
      default: defaultValue,
      children: [],
    };
    output.push(permission);
    if (Array.isArray(data.children)) {
      permission.children = strings(data.children, issue, 256).map((name) => ({
        name,
        value: true,
      }));
    } else {
      for (const [child, rule] of entries(data.children, issue)) {
        if (typeof rule === 'boolean') permission.children.push({ name: child, value: rule });
        else if (object(rule)) {
          permission.children.push({ name: child, value: true });
          add(child, rule, defaultValue, depth + 1);
        } else issue('invalid_metadata');
      }
    }
    active.delete(data);
  }
  for (const [name, data] of entries(value, issue)) add(name, data, fallback, 0);
  return output;
}

function bukkitCommands(value: unknown, issue: Issue): PluginCommand[] {
  return entries(value, issue).flatMap(([name, value]) => {
    const data = value == null ? {} : object(value);
    if (!data) {
      issue('invalid_metadata');
      return [];
    }
    return [
      {
        name: name.slice(0, 256),
        description: text(data.description),
        usage: text(data.usage),
        aliases: strings(data.aliases, issue, 256),
        permission: text(data.permission),
        permissionMessage: text(data['permission-message']),
      },
    ];
  });
}
function paperDependencies(value: unknown, issue: Issue): PluginDependency[] {
  const data = object(value) ?? {};
  return bounded(
    (['bootstrap', 'server'] as const).flatMap((stage) =>
      entries(data[stage], issue).flatMap(([id, value]) => {
        const rule = value == null ? {} : object(value);
        if (!rule) {
          issue('invalid_metadata');
          return [];
        }
        const load = rule.load ?? 'OMIT';
        if (
          !['BEFORE', 'AFTER', 'OMIT'].includes(String(load)) ||
          (rule.required !== undefined && typeof rule.required !== 'boolean') ||
          (rule['join-classpath'] !== undefined && typeof rule['join-classpath'] !== 'boolean')
        ) {
          issue('invalid_metadata');
          return [];
        }
        return [
          {
            id: id.slice(0, 256),
            kind: rule.required === false ? ('optional' as const) : ('required' as const),
            stage,
            load: load as PluginDependency['load'],
            joinClasspath: boolean(rule['join-classpath']) ?? true,
          },
        ];
      }),
    ),
    issue,
  );
}

function base(data: ObjectValue, source: string, platform: PluginPlatform): PluginMetadata {
  const id = text(platform === 'velocity' ? data.id : data.name, 256);
  const main = text(data.main, 1024);
  if (!id || !main) throw new TypeError('Missing plugin identity.');
  if (platform === 'velocity' && !/^[a-z][a-z0-9_-]{0,63}$/.test(id))
    throw new TypeError('Invalid Velocity ID.');
  return {
    id,
    name: text(data.name, 256) ?? id,
    main,
    source,
    platform,
    version: text(data.version, 256),
    description: text(data.description, 16_384),
    authors: [],
    contributors: [],
    links: [],
    provides: [],
    libraries: [],
    dependencies: [],
    commands: [],
    permissions: [],
  };
}
function serverPlugin(
  data: ObjectValue,
  source: string,
  paper: boolean,
  issue: Issue,
): PluginMetadata {
  const plugin = base(data, source, paper ? 'paper' : 'bukkit');
  if (!plugin.version) issue('invalid_metadata');
  plugin.authors = strings(
    paper
      ? [...strings(data.authors, issue), data.author]
      : [data.author, ...strings(data.authors, issue)],
    issue,
  );
  plugin.contributors = strings(data.contributors, issue);
  plugin.links = website(data.website);
  plugin.apiVersion = text(data['api-version'], 128);
  plugin.load = text(data.load, 64);
  plugin.prefix = text(data.prefix, 256);
  plugin.foliaSupported = boolean(data['folia-supported']);
  plugin.provides = strings(data.provides, issue, 256);
  plugin.defaultPermission =
    permissionDefault(data[paper ? 'defaultPerm' : 'default-permission']) ?? 'op';
  plugin.permissions = permissions(data.permissions, plugin.defaultPermission, issue);
  if (paper) {
    plugin.bootstrapper = text(data.bootstrapper, 1024);
    plugin.loader = text(data.loader, 1024);
    plugin.dependencies = paperDependencies(data.dependencies, issue);
    // paper-plugin.yml does not register commands or Bukkit-style Maven libraries.
  } else {
    plugin.loader = text(data['paper-plugin-loader'], 1024);
    plugin.libraries = strings(data.libraries, issue);
    plugin.commands = bukkitCommands(data.commands, issue);
    plugin.dependencies = bounded(
      [
        ...strings(data.depend, issue, 256).map((id) => ({ id, kind: 'required' as const })),
        ...strings(data.softdepend, issue, 256).map((id) => ({ id, kind: 'optional' as const })),
        ...strings(data.loadbefore, issue, 256).map((id) => ({ id, kind: 'loadbefore' as const })),
      ],
      issue,
    );
  }
  return plugin;
}
function proxyPlugin(
  data: ObjectValue,
  source: string,
  velocity: boolean,
  issue: Issue,
): PluginMetadata {
  const plugin = base(data, source, velocity ? 'velocity' : 'bungeecord');
  plugin.authors = strings(velocity ? data.authors : data.author, issue);
  if (velocity) {
    plugin.links = website(data.url);
    plugin.dependencies = bounded(
      Array.isArray(data.dependencies) ? data.dependencies : [],
      issue,
    ).flatMap((value) => {
      const dependency = object(value);
      const id = text(dependency?.id, 256);
      if (
        !id ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(id) ||
        (dependency?.optional !== undefined && typeof dependency.optional !== 'boolean')
      ) {
        issue('invalid_metadata');
        return [];
      }
      return [
        { id, kind: dependency?.optional === true ? ('optional' as const) : ('required' as const) },
      ];
    });
  } else {
    plugin.libraries = strings(data.libraries, issue);
    plugin.dependencies = bounded(
      [
        ...strings(data.depends, issue, 256).map((id) => ({ id, kind: 'required' as const })),
        ...strings(data.softDepends, issue, 256).map((id) => ({ id, kind: 'optional' as const })),
      ],
      issue,
    );
  }
  return plugin;
}

/** Root descriptors only; no class loading, archive extraction or provider lookup. */
export async function readPluginArchive(
  archive: JarArchiveReader,
  signal: AbortSignal,
): Promise<PluginArchiveMetadata> {
  const result = await readJarDescriptors(archive, signal, descriptors);
  const plugins: PluginMetadata[] = [];
  const issues = [...result.issues];
  for (const source of result.sources) {
    signal.throwIfAborted();
    const raw = result.texts.get(source);
    if (raw === undefined) continue;
    const issue: Issue = (code) => {
      if (!issues.some((entry) => entry.source === source && entry.code === code))
        issues.push({ source, code });
    };
    try {
      const data = source.endsWith('.json') ? object(JSON.parse(raw)) : yaml(raw);
      if (!data) throw new TypeError('Descriptor must be a mapping.');
      plugins.push(
        source === 'bungee.yml' || source === 'velocity-plugin.json'
          ? proxyPlugin(data, source, source === 'velocity-plugin.json', issue)
          : serverPlugin(data, source, source === 'paper-plugin.yml', issue),
      );
    } catch (error) {
      signal.throwIfAborted();
      issue(error instanceof RangeError ? 'too_large' : 'invalid_metadata');
    }
  }
  return { plugins, issues, sources: result.sources };
}
