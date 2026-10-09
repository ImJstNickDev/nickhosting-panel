import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';

function invalid(reason: string): never {
  throw new DomainError('validation_failed', 400, { reason });
}
function unescapeProperty(input: string): string {
  return input.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_, escaped: string) => {
    if (escaped.startsWith('u')) return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
    return ({ t: '\t', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[escaped] ?? escaped;
  });
}
function escapeProperty(input: string): string {
  return input.replace(
    /[\\\n\r\t\f:=#! ]/g,
    (character) =>
      (({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f' }) as Record<string, string>)[
        character
      ] ?? `\\${character}`,
  );
}
interface PropertyLine {
  raw: string;
  key?: string;
  value?: string;
}
function propertyLines(source: string): PropertyLine[] {
  if (Buffer.byteLength(source) > 1024 * 1024 || source.includes('\0'))
    return invalid('minecraft_properties_invalid');
  // java.util.Properties treats CR, LF and CRLF as line endings, and only
  // space, tab and form feed as syntactic whitespace (not JS's broader \s).
  const lines = source.split(/\r\n|[\r\n]/);
  const result: PropertyLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i] ?? '';
    let raw = text;
    if (/^[ \t\f]*[#!]/.test(text)) {
      result.push({ raw });
      continue;
    }
    while ((text.match(/\\+$/)?.[0].length ?? 0) % 2 === 1) {
      if (++i >= lines.length) return invalid('minecraft_properties_continuation');
      const next = lines[i] ?? '';
      raw += `\n${next}`;
      text = text.slice(0, -1) + next.replace(/^[ \t\f]*/, '');
    }
    const trimmed = text.replace(/^[ \t\f]*/, '');
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      result.push({ raw });
      continue;
    }
    let split = 0;
    for (; split < trimmed.length; split++) {
      if (trimmed[split] === '\\') {
        split++;
        continue;
      }
      if (/[ \t\f=:]/.test(trimmed[split] ?? '')) break;
    }
    const key = unescapeProperty(trimmed.slice(0, split));
    const value = unescapeProperty(trimmed.slice(split).replace(/^[ \t\f]*[:=]?[ \t\f]*/, ''));
    if (seen.has(key) || /\\u(?![0-9a-fA-F]{4})/.test(trimmed))
      return invalid('minecraft_properties_ambiguous');
    seen.add(key);
    result.push({ raw, key, value });
  }
  return result;
}
export function parseMinecraftProperties(source: string): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      propertyLines(source)
        .filter((line) => line.key !== undefined)
        .map((line) => [line.key, line.value]),
    ),
  );
}
const booleans = new Set([
  'pvp',
  'white-list',
  'enforce-whitelist',
  'hardcore',
  'allow-flight',
  'spawn-monsters',
  'spawn-animals',
  'spawn-npcs',
  'generate-structures',
]);
const numeric: Record<string, [number, number]> = {
  'max-players': [1, 100_000],
  'view-distance': [2, 32],
  'simulation-distance': [2, 32],
  'spawn-protection': [0, 29_999_984],
  'player-idle-timeout': [0, 2_147_483_647],
};
/** Product fields exclude bind addresses, ports, RCON, online-mode and service credentials. */
export function editMinecraftProperties(
  source: string,
  changes: Readonly<Record<string, string | number | boolean>>,
  context: { release: string; supportedKeys: readonly string[] },
): { content: string; beforeSha256: string; afterSha256: string; requiresStoppedServer: true } {
  if (!context.release || new Set(context.supportedKeys).size !== context.supportedKeys.length)
    return invalid('minecraft_properties_version');
  const parsed = propertyLines(source);
  const replacement = new Map<string, string>();
  for (const [key, input] of Object.entries(changes)) {
    if (!context.supportedKeys.includes(key))
      return invalid('minecraft_property_unavailable_in_release');
    const value = String(input);
    if (booleans.has(key)) {
      if (value !== 'true' && value !== 'false') return invalid('minecraft_property_boolean');
    } else if (numeric[key]) {
      const [minimum, maximum] = numeric[key];
      if (
        !/^\d+$/.test(value) ||
        Number(value) < minimum ||
        Number(value) > maximum ||
        !Number.isSafeInteger(Number(value))
      )
        return invalid('minecraft_property_range');
    } else if (key === 'difficulty') {
      if (!['peaceful', 'easy', 'normal', 'hard'].includes(value))
        return invalid('minecraft_property_difficulty');
    } else if (key === 'gamemode') {
      if (!['survival', 'creative', 'adventure', 'spectator'].includes(value))
        return invalid('minecraft_property_gamemode');
    } else if (key === 'motd') {
      if (
        value.length > 256 ||
        [...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        return invalid('minecraft_property_motd');
    } else return invalid('minecraft_property_protected');
    // Release-specific support comes from a verified generated-property schema, not semver guesses.
    replacement.set(key, value);
  }
  const lines = parsed.map((line) => {
    if (!line.key || !replacement.has(line.key)) return line.raw;
    const value = replacement.get(line.key) ?? '';
    replacement.delete(line.key);
    return `${escapeProperty(line.key)}=${escapeProperty(value)}`;
  });
  if (lines.at(-1) === '') lines.pop();
  for (const [key, value] of replacement)
    lines.push(`${escapeProperty(key)}=${escapeProperty(value)}`);
  const content = `${lines.join('\n')}\n`;
  return {
    content,
    beforeSha256: createHash('sha256').update(source).digest('hex'),
    afterSha256: createHash('sha256').update(content).digest('hex'),
    requiresStoppedServer: true,
  };
}

export function minecraftUuid(value: string): string {
  if (
    !/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/.test(
      value,
    )
  )
    return invalid('minecraft_player_uuid');
  const hex = value.replaceAll('-', '').toLowerCase();
  if (/^0+$/.test(hex)) return invalid('minecraft_player_uuid');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function minecraftPlayerName(value: string): string {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(value)) return invalid('minecraft_player_name');
  return value;
}
export interface MinecraftVerifiedPlayer {
  readonly uuid: string;
  readonly name: string;
  readonly verifiedAt: string;
  readonly source: 'mojang';
}
/** Provider identities, never an avatar response, establish authority. Both directions must agree. */
export async function verifyMinecraftPlayer(
  name: string,
  provider: {
    lookupName(name: string): Promise<{ id: string; name: string }>;
    lookupUuid(uuid: string): Promise<{ id: string; name: string }>;
  },
  now = new Date(),
): Promise<MinecraftVerifiedPlayer> {
  const input = minecraftPlayerName(name);
  const byName = await provider.lookupName(input);
  const uuid = minecraftUuid(byName.id);
  const canonicalName = minecraftPlayerName(byName.name);
  const byUuid = await provider.lookupUuid(uuid.replaceAll('-', ''));
  if (
    canonicalName.toLowerCase() !== input.toLowerCase() ||
    minecraftUuid(byUuid.id) !== uuid ||
    minecraftPlayerName(byUuid.name).toLowerCase() !== canonicalName.toLowerCase()
  )
    throw new DomainError('conflict', 409, { reason: 'minecraft_player_identity_mismatch' });
  return Object.freeze({
    uuid,
    name: canonicalName,
    verifiedAt: now.toISOString(),
    source: 'mojang',
  });
}
export function minecraftAvatarUrl(
  player: Pick<MinecraftVerifiedPlayer, 'uuid'>,
  enabled: boolean,
  size = 64,
): string | undefined {
  if (!enabled) return undefined;
  if (!Number.isInteger(size) || size < 16 || size > 256) return invalid('minecraft_avatar_size');
  return `https://api.mcheads.org/head/${minecraftUuid(player.uuid)}/${size}`;
}
export interface MinecraftPlayerListEntry {
  uuid: string;
  name: string;
  level?: number;
  bypassesPlayerLimit?: boolean;
}
export function planMinecraftPlayerList(
  source: string,
  kind: 'whitelist' | 'operators',
  action: 'add' | 'remove',
  player: MinecraftVerifiedPlayer,
  options: { operatorLevel?: number; bypassesPlayerLimit?: boolean } = {},
): {
  path: 'whitelist.json' | 'ops.json';
  content: string;
  beforeSha256: string;
  afterSha256: string;
  requiresStoppedServer: true;
} {
  if (
    Buffer.byteLength(source) > 4 * 1024 * 1024 ||
    player.source !== 'mojang' ||
    !Number.isFinite(Date.parse(player.verifiedAt))
  )
    return invalid('minecraft_player_list');
  let list: unknown;
  try {
    list = JSON.parse(source);
  } catch {
    return invalid('minecraft_player_list');
  }
  if (!Array.isArray(list) || list.length > 100_000) return invalid('minecraft_player_list');
  const entries: MinecraftPlayerListEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.uuid !== 'string' ||
      typeof item.name !== 'string' ||
      Object.keys(item).some(
        (key) =>
          ![
            'uuid',
            'name',
            ...(kind === 'operators' ? ['level', 'bypassesPlayerLimit'] : []),
          ].includes(key),
      )
    )
      return invalid('minecraft_player_list');
    const entry: MinecraftPlayerListEntry = {
      uuid: minecraftUuid(item.uuid),
      name: minecraftPlayerName(item.name),
    };
    if (seen.has(entry.uuid)) return invalid('minecraft_player_list_duplicate');
    seen.add(entry.uuid);
    if (kind === 'operators') {
      if (
        !Number.isInteger(item.level) ||
        item.level < 1 ||
        item.level > 4 ||
        typeof item.bypassesPlayerLimit !== 'boolean'
      )
        return invalid('minecraft_operator_level');
      entry.level = item.level;
      entry.bypassesPlayerLimit = item.bypassesPlayerLimit;
    }
    entries.push(entry);
  }
  const uuid = minecraftUuid(player.uuid);
  const updated = entries.filter((entry) => entry.uuid !== uuid);
  if (action === 'add') {
    const entry: MinecraftPlayerListEntry = { uuid, name: minecraftPlayerName(player.name) };
    if (kind === 'operators') {
      const level = options.operatorLevel ?? 4;
      if (!Number.isInteger(level) || level < 1 || level > 4)
        return invalid('minecraft_operator_level');
      entry.level = level;
      entry.bypassesPlayerLimit = options.bypassesPlayerLimit ?? false;
    }
    updated.push(entry);
  }
  const content = `${JSON.stringify(updated, null, 2)}\n`;
  return {
    path: kind === 'operators' ? 'ops.json' : 'whitelist.json',
    content,
    beforeSha256: createHash('sha256').update(source).digest('hex'),
    afterSha256: createHash('sha256').update(content).digest('hex'),
    requiresStoppedServer: true,
  };
}

/** These are archive inventory checks; extraction and NBT/DataVersion validation happen before promotion. */
export interface MinecraftWorldArchiveEntry {
  readonly path: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly type: 'file' | 'directory' | 'symlink';
}
export function minecraftWorldName(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ||
    ['logs', 'libraries', 'plugins', 'mods', 'config', 'versions', 'crash-reports'].includes(
      value.toLowerCase(),
    )
  )
    return invalid('minecraft_world_name');
  return value;
}
export function planMinecraftWorldImport(
  entries: readonly MinecraftWorldArchiveEntry[],
  options: {
    targetWorld: string;
    maxBytes: number;
    maxEntries?: number;
    maxExpansionRatio?: number;
  },
): {
  targetWorld: string;
  sourceRoot: string;
  totalBytes: number;
  files: readonly { source: string; target: string; size: number }[];
  requiresStoppedServer: true;
  requiresNbtValidation: true;
} {
  const targetWorld = minecraftWorldName(options.targetWorld);
  const maxEntries = options.maxEntries ?? 100_000;
  const maxRatio = options.maxExpansionRatio ?? 200;
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isFinite(maxRatio) ||
    maxRatio < 1 ||
    entries.length < 1 ||
    entries.length > maxEntries
  )
    return invalid('minecraft_world_limits');
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = entry.type === 'directory' ? entry.path.replace(/\/$/, '') : entry.path;
    const segments = path.split('/');
    if (
      !path ||
      path.length > 1024 ||
      /[\\:]/.test(path) ||
      [...path].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      segments.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.startsWith('.') ||
          part.endsWith('.') ||
          part.endsWith(' '),
      ) ||
      entry.type === 'symlink'
    )
      return invalid('minecraft_world_unsafe_path');
    if (
      !Number.isSafeInteger(entry.size) ||
      !Number.isSafeInteger(entry.compressedSize) ||
      entry.size < 0 ||
      entry.compressedSize < 0 ||
      (entry.type === 'file' && entry.size > Math.max(entry.compressedSize, 1) * maxRatio)
    )
      return invalid('minecraft_world_expansion');
    const canonical = path.normalize('NFC').toLowerCase();
    if (paths.has(canonical)) return invalid('minecraft_world_duplicate_path');
    paths.add(canonical);
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > options.maxBytes)
      return invalid('minecraft_world_storage');
  }
  const filePaths = new Set(
    entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.path.normalize('NFC').toLowerCase()),
  );
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      if (filePaths.has(segments.slice(0, i).join('/')))
        return invalid('minecraft_world_file_directory_collision');
    }
  }
  const roots = entries
    .filter(
      (entry) =>
        entry.type === 'file' && (entry.path === 'level.dat' || entry.path.endsWith('/level.dat')),
    )
    .map((entry) => entry.path.slice(0, -'level.dat'.length));
  if (roots.length !== 1 || roots[0] === undefined) return invalid('minecraft_world_level_data');
  const sourceRoot = roots[0];
  const files = entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => {
      if (!entry.path.startsWith(sourceRoot)) return invalid('minecraft_world_multiple_roots');
      const relative = entry.path.slice(sourceRoot.length);
      // Never promote runnable code, properties, symlinks or files outside the isolated world root.
      if (
        /\.(?:jar|class|sh|bat|cmd|exe|dll|so)$/i.test(relative) ||
        ['server.properties', 'eula.txt', 'session.lock'].includes(relative)
      )
        return invalid('minecraft_world_protected_file');
      return { source: entry.path, target: `${targetWorld}/${relative}`, size: entry.size };
    });
  return {
    targetWorld,
    sourceRoot,
    totalBytes,
    files,
    requiresStoppedServer: true,
    requiresNbtValidation: true,
  };
}
export function planMinecraftWorldSelection(
  source: string,
  world: { name: string; verifiedDataVersion: number; sha256: string },
  compatibility: { allowedDataVersions: readonly number[] },
): { content: string; beforeSha256: string; requiresStoppedServer: true } {
  const name = minecraftWorldName(world.name);
  if (
    !/^[a-f0-9]{64}$/.test(world.sha256) ||
    !Number.isSafeInteger(world.verifiedDataVersion) ||
    !compatibility.allowedDataVersions.includes(world.verifiedDataVersion)
  )
    return invalid('minecraft_world_version');
  const lines = propertyLines(source);
  const existing = lines.find((line) => line.key === 'level-name');
  if (existing) existing.raw = `level-name=${name}`;
  else lines.push({ raw: `level-name=${name}` });
  return {
    content: `${lines
      .map((line) => line.raw)
      .join('\n')
      .replace(/\n+$/, '')}\n`,
    beforeSha256: createHash('sha256').update(source).digest('hex'),
    requiresStoppedServer: true,
  };
}

/** Fixed Mojang origins only; no avatar data, third-party mirrors or redirects establish identity. */
export function createMinecraftIdentityProvider(options: {
  userAgent: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  if (!/^[\x20-\x7e]{10,200}$/.test(options.userAgent))
    throw new DomainError('configuration_invalid');
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000)
    throw new DomainError('configuration_invalid');
  const request = async (url: string): Promise<{ id: string; name: string }> => {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, {
        redirect: 'error',
        credentials: 'omit',
        headers: { 'User-Agent': options.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new DomainError('integration_unavailable');
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new DomainError('integration_unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 64 * 1024) throw new DomainError('integration_unavailable');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let result: unknown;
    try {
      result = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    } catch {
      throw new DomainError('integration_unavailable');
    }
    if (
      !result ||
      typeof result !== 'object' ||
      !('id' in result) ||
      !('name' in result) ||
      typeof result.id !== 'string' ||
      typeof result.name !== 'string'
    )
      throw new DomainError('integration_unavailable');
    return { id: minecraftUuid(result.id), name: minecraftPlayerName(result.name) };
  };
  return {
    lookupName: (name: string) =>
      request(`https://api.mojang.com/users/profiles/minecraft/${minecraftPlayerName(name)}`),
    lookupUuid: (uuid: string) =>
      request(
        `https://sessionserver.mojang.com/session/minecraft/profile/${minecraftUuid(uuid).replaceAll('-', '')}`,
      ),
  };
}
