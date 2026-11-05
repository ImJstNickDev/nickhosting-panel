/** Read-only projections of SML descriptors and the existing SMM3/ficsit-cli formats.
 * Never imports backend resolver code or treats a manifest as installation authority. */
export const manifestReadLimit = 65_536;
export type ManifestField = { label: string; value: string | number | boolean };
export type ManifestItem = {
  reference: string;
  version?: string;
  enabled?: boolean;
  details?: string;
  flags?: ManifestField[];
  targets?: string;
};
export type ManifestSection = { title: string; fields: ManifestField[]; items: ManifestItem[] };
export type ManifestDocument = {
  kind: 'plugin' | 'profile' | 'profiles' | 'lock';
  sections: ManifestSection[];
};
export function matchesManifestName(name: string): boolean {
  return (
    /\.(uplugin|smmprofile)$/i.test(name) ||
    ['nick_hosting-lock.json', 'profiles.json'].includes(name.toLowerCase())
  );
}
const invalid = (): never => {
  throw new Error('invalid_manifest');
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const string = (value: unknown): string =>
  typeof value === 'string' && value.length <= 8192 ? value : invalid();
const boolean = (value: unknown): boolean => (typeof value === 'boolean' ? value : invalid());
const scalar = (value: unknown): string | number | boolean => {
  if (typeof value === 'string') return string(value);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value)))
    return value;
  return invalid();
};
const entries = (value: unknown): [string, unknown][] => {
  const result = Object.entries(record(value));
  if (result.length > 512) return invalid();
  return result;
};
function fields(value: Record<string, unknown>, names: Record<string, string>): ManifestField[] {
  return Object.entries(names).flatMap(([key, label]) =>
    value[key] === undefined ? [] : [{ label, value: scalar(value[key]) }],
  );
}
function targetField(value: unknown): ManifestField[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) return invalid();
  return [{ label: 'targets', value: value.map(string).join(', ') }];
}
function profile(value: unknown, key?: string): ManifestSection {
  const root = record(value);
  const name = string(root.name);
  return {
    title: key ?? name,
    fields: [{ label: 'profile', value: name }, ...targetField(root.required_targets)],
    items: entries(root.mods).map(([reference, item]) => {
      const mod = record(item);
      return { reference, version: string(mod.version), enabled: boolean(mod.enabled) };
    }),
  };
}
function lock(value: unknown): ManifestSection {
  const root = record(value);
  if (root.version !== 1) throw new Error('unsupported_manifest');
  return {
    title: '',
    fields: [{ label: 'format', value: 1 }],
    items: entries(root.mods).map(([reference, item]) => {
      const mod = record(item);
      const dependencies = mod.dependencies === null ? [] : entries(mod.dependencies);
      // Validate download metadata without turning arbitrary links into fetches or anchors.
      const targets = entries(mod.targets);
      for (const [, target] of targets) {
        const data = record(target);
        string(data.hash);
        string(data.link);
      }
      return {
        reference,
        version: string(mod.version),
        targets: targets.map(([name]) => name).join(', '),
        details: dependencies.map(([name, range]) => `${name}: ${string(range)}`).join('\n'),
      };
    }),
  };
}
export function parseManifest(bytes: Uint8Array, name: string): ManifestDocument {
  if (bytes.byteLength >= manifestReadLimit) throw new Error('manifest_too_large');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
  const root = record(value);
  const lower = name.toLowerCase();
  if (lower.endsWith('.uplugin')) {
    if (!Number.isSafeInteger(root.FileVersion) || Number(root.FileVersion) < 1) return invalid();
    if (Number(root.FileVersion) > 3) throw new Error('unsupported_manifest');
    for (const field of ['RequiredOnRemote', 'GameFeature'])
      if (root[field] !== undefined) boolean(root[field]);
    for (const field of [
      'FriendlyName',
      'VersionName',
      'SemVersion',
      'GameVersion',
      'CreatedBy',
      'Description',
      'RemoteVersionRange',
    ])
      if (root[field] !== undefined) string(root[field]);
    const plugins = root.Plugins ?? [];
    if (!Array.isArray(plugins) || plugins.length > 512) return invalid();
    const metadata = fields(root, {
      FriendlyName: 'modName',
      VersionName: 'versionName',
      SemVersion: 'version',
      GameVersion: 'gameVersion',
      CreatedBy: 'author',
      Description: 'description',
      RequiredOnRemote: 'requiredOnRemote',
      RemoteVersionRange: 'remoteVersion',
      GameFeature: 'gameFeature',
    });
    return {
      kind: 'plugin',
      sections: [
        {
          title: '',
          fields: metadata,
          items: plugins.map((entry) => {
            const plugin = record(entry);
            const reference = string(plugin.Name);
            // These flags are rendered explicitly, without resolving dependency defaults.
            const flags = fields(plugin, { Optional: 'optional', BasePlugin: 'basePlugin' });
            for (const flag of flags) if (typeof flag.value !== 'boolean') return invalid();
            return {
              reference,
              ...(plugin.SemVersion === undefined ? {} : { version: string(plugin.SemVersion) }),
              ...(plugin.Enabled === undefined ? {} : { enabled: boolean(plugin.Enabled) }),
              flags,
            };
          }),
        },
      ],
    };
  }
  if (lower.endsWith('.smmprofile')) {
    const section = profile(root.profile);
    const metadata = root.metadata == null ? {} : record(root.metadata);
    if (
      metadata.gameVersion !== undefined &&
      (!Number.isSafeInteger(metadata.gameVersion) || Number(metadata.gameVersion) < 0)
    )
      return invalid();
    section.fields.push(...fields(metadata, { gameVersion: 'gameBuild' }));
    if (root.lockfile != null) lock(root.lockfile);
    return { kind: 'profile', sections: [section] };
  }
  if (lower === 'profiles.json') {
    if (root.version !== 0) throw new Error('unsupported_manifest');
    const selected = string(root.selected_profile);
    const profiles = entries(root.profiles);
    if (profiles.length > 32) return invalid();
    const sections = profiles.map(([key, value]) => {
      const section = profile(value, key);
      section.fields.push({ label: 'selected', value: key === selected });
      return section;
    });
    if (sections.reduce((total, item) => total + item.items.length, 0) > 1024) return invalid();
    return { kind: 'profiles', sections };
  }
  if (lower === 'nick_hosting-lock.json') return { kind: 'lock', sections: [lock(root)] };
  throw new Error('unsupported_manifest');
}
