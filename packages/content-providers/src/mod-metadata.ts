import type { ContentTarget } from './contracts.js';
import type {
  ContentCatalogProvider,
  ModAvailabilityHints,
  ModCatalogVersion,
  ModCompatibilityIssue,
  ModEnvironment,
  ModTag,
} from './mod-catalog.js';

/** Observed metadata only: bounded hints, never an exhaustive compatibility claim. */
export function modAvailabilityHints(versions: readonly ModCatalogVersion[]): ModAvailabilityHints {
  const bounded = (values: string[]) =>
    [...new Set(values.filter((value) => value.length > 0 && value.length <= 80))].slice(0, 20);
  return {
    availableMinecraftVersions: bounded(versions.flatMap((version) => version.gameVersions)),
    availableLoaders: bounded(versions.flatMap((version) => version.loaders)),
    availableChannels: [...new Set(versions.map((version) => version.channel))],
  };
}

export function modrinthEnvironment(input: {
  environment?: string | string[];
  client_side?: string;
  server_side?: string;
}): ModEnvironment {
  const raw =
    input.environment === undefined
      ? []
      : Array.isArray(input.environment)
        ? input.environment
        : [input.environment];
  const original = [...new Set(raw)];
  const known: Record<string, Pick<ModEnvironment, 'kind' | 'detail'>> = {
    client_only: { kind: 'client' },
    singleplayer_only: { kind: 'client', detail: 'singleplayer' },
    server_only: { kind: 'server' },
    dedicated_server_only: { kind: 'server', detail: 'dedicated-server' },
    client_and_server: { kind: 'both' },
    server_only_client_optional: { kind: 'both', detail: 'client-optional' },
    client_only_server_optional: { kind: 'both', detail: 'server-optional' },
    client_or_server: { kind: 'both', detail: 'either' },
    client_or_server_prefers_both: { kind: 'both', detail: 'prefers-both' },
  };
  if (original.length === 1)
    return { ...(known[original[0] ?? ''] ?? { kind: 'unknown' }), source: 'modrinth', original };
  if (original.length > 1) {
    const kinds = new Set(original.map((entry) => known[entry]?.kind ?? 'unknown'));
    return {
      kind: kinds.size === 1 ? (known[original[0] ?? '']?.kind ?? 'unknown') : 'unknown',
      source: 'modrinth',
      original,
    };
  }
  const supported = (side: string | undefined) => side === 'required' || side === 'optional';
  let kind: ModEnvironment['kind'] = 'unknown';
  if (supported(input.client_side) && supported(input.server_side)) kind = 'both';
  else if (supported(input.client_side) && input.server_side === 'unsupported') kind = 'client';
  else if (supported(input.server_side) && input.client_side === 'unsupported') kind = 'server';
  // A missing client declaration cannot distinguish server-only from client+server.
  return {
    kind,
    source: 'modrinth',
    original: [
      input.client_side && `client:${input.client_side}`,
      input.server_side && `server:${input.server_side}`,
    ].filter((v): v is string => Boolean(v)),
  };
}
/** CurseForge's Environment version type is carried alongside Minecraft/loader tags. */
export function curseforgeEnvironment(gameVersions: readonly string[]): ModEnvironment {
  const original = ['Client', 'Server'].filter((side) => gameVersions.includes(side));
  return {
    kind:
      original.length === 2
        ? 'both'
        : original[0] === 'Client'
          ? 'client'
          : original[0] === 'Server'
            ? 'server'
            : 'unknown',
    source: 'curseforge',
    original,
  };
}

/** Summarize declared sides only; distinct file declarations must not become "Both". */
export function curseforgeProjectEnvironment(
  files: readonly { gameVersions: readonly string[] }[],
): ModEnvironment {
  const declared = files
    .map((file) => curseforgeEnvironment(file.gameVersions))
    .filter((environment) => environment.kind !== 'unknown');
  const first = declared[0];
  return first && declared.every((environment) => environment.kind === first.kind)
    ? first
    : curseforgeEnvironment([]);
}

/** Only genuine synonyms are merged; unrelated provider topics retain distinct labels. */
export function normalizeModTags(
  provider: ContentCatalogProvider,
  values: { slug: string; name?: string }[],
): ModTag[] {
  const aliases: Record<string, [string, string]> = {
    'world-generation': ['worldgen', 'World Generation'],
    worldgen: ['worldgen', 'World Generation'],
    technology: ['technology', 'Technology'],
    tech: ['technology', 'Technology'],
    utility: ['utility', 'Utility'],
    'utility-qol': ['utility', 'Utility'],
    library: ['library', 'Library'],
    'library-api': ['library', 'Library'],
    optimization: ['optimization', 'Optimization'],
    performance: ['optimization', 'Optimization'],
    'adventure-rpg': ['adventure', 'Adventure'],
    adventure: ['adventure', 'Adventure'],
  };
  const byId = new Map<string, ModTag>();
  for (const entry of values) {
    if (!entry.slug || entry.slug.length > 128) continue;
    const slug = entry.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const [id, label] = aliases[slug] ?? [
      slug,
      (entry.name ?? slug.replaceAll('-', ' ')).slice(0, 128),
    ];
    if (!byId.has(id)) byId.set(id, { id, label, source: provider, original: entry.slug });
  }
  return [...byId.values()].slice(0, 100);
}
export function modCompatibility(
  gameVersions: string[],
  loaders: string[],
  environment: ModEnvironment,
  target: ContentTarget,
): ModCompatibilityIssue[] {
  const issues: ModCompatibilityIssue[] = [];
  if (!gameVersions.includes(target.minecraftVersion)) issues.push('minecraft-version');
  if (!loaders.includes(target.loader)) issues.push('loader');
  if (environment.detail === 'singleplayer') issues.push('singleplayer-only');
  else if (environment.kind === 'client') issues.push('client-only');
  return issues;
}
export function recommendedModVersion<
  T extends Pick<
    ModCatalogVersion,
    'available' | 'compatibility' | 'channel' | 'publishedAt' | 'id'
  >,
>(versions: readonly T[], preferBeta = false): T | undefined {
  const sorted = [...versions]
    .filter(
      (version) =>
        version.available && version.compatibility.length === 0 && version.channel !== 'alpha',
    )
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  return preferBeta
    ? sorted[0]
    : (sorted.find((version) => version.channel === 'release') ??
        sorted.find((version) => version.channel === 'beta'));
}
export function catalogImage(
  value: string | null | undefined,
  hosts: string[],
): string | undefined {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      hosts.includes(url.hostname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
