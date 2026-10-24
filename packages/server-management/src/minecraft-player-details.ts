import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { FilemanEntry, FilemanReadService } from '@nickhosting/game-sdk';
import {
  minecraftUuid,
  minecraftWorldName,
  parseMinecraftProperties,
} from '../../../games/minecraft/src/management.js';
import {
  inspectMinecraftPlayerData,
  inspectMinecraftPlayerStatistics,
} from '../../../games/minecraft/src/player-data.js';
import type {
  MinecraftKnownPlayer,
  MinecraftPlayerDetail,
} from '../../../games/minecraft/src/player-details-contracts.js';

type Source = MinecraftKnownPlayer['sources'][number];
type Ref = {
  path: string;
  scope: 'playerdata' | 'stats' | 'advancements';
  layout: 'legacy' | 'modern';
  entry: FilemanEntry;
};
const uuidFile = /^([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\.(dat(?:_old)?|json)$/;
const playerName = /^[A-Za-z0-9_]{3,16}$/;
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function jsonArray(bytes: Uint8Array | undefined) {
  if (!bytes) return [];
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!Array.isArray(value) || value.length > 10000) throw new Error();
    return value;
  } catch {
    throw new DomainError('integration_unavailable');
  }
}
/** Exact supported roots only; user-provided paths never enter the read contract. */
export async function discoverMinecraftPlayers(files: FilemanReadService) {
  const root = await files.list('');
  const properties = await files.read({ path: 'server.properties', maxBytes: 1048576 });
  if (!properties) throw new DomainError('integration_unavailable');
  const world = minecraftWorldName(
    parseMinecraftProperties(Buffer.from(properties).toString('utf8'))['level-name'] ?? 'world',
  );
  const worldEntry = root.find((entry) => entry.name === world);
  if (worldEntry && worldEntry.kind !== 'directory') throw new DomainError('conflict');
  const worldEntries = worldEntry ? await files.list(world) : [];
  const playersEntry = worldEntries.find((entry) => entry.name === 'players');
  if (playersEntry && playersEntry.kind !== 'directory') throw new DomainError('conflict');
  const modernEntries = playersEntry ? await files.list(`${world}/players`) : [];
  const references = new Map<string, Ref[]>();
  const known = new Map<string, MinecraftKnownPlayer>();
  const usercache = new Map<string, string>();
  const conflictingNames = new Set<string>();
  const add = (uuid: string, source: Source, name: string | null = null) => {
    let item = known.get(uuid);
    if (!item) {
      item = { uuid, name, sources: [] };
      known.set(uuid, item);
    }
    if (known.size > 10000) throw new DomainError('resources_unavailable');
    if (!item.sources.includes(source)) item.sources.push(source);
    if (source === 'usercache') {
      if (usercache.has(uuid) && usercache.get(uuid) !== name) conflictingNames.add(uuid);
      else if (name) usercache.set(uuid, name);
      item.name = name;
    } else if (!item.name && !item.sources.includes('usercache')) item.name = name;
  };
  for (const [path, source] of [
    ['usercache.json', 'usercache'],
    ['ops.json', 'operators'],
    ['whitelist.json', 'whitelist'],
    ['banned-players.json', 'banned'],
  ] as const) {
    const entry = root.find((entry) => entry.name === path);
    if (!entry) continue;
    if (entry.kind !== 'file' || entry.size > 1048576)
      throw new DomainError('integration_unavailable');
    for (const raw of jsonArray(await files.read({ path, maxBytes: 1048576 }))) {
      if (!raw || typeof raw !== 'object' || !('uuid' in raw) || typeof raw.uuid !== 'string')
        continue;
      let uuid: string;
      try {
        uuid = minecraftUuid(raw.uuid);
      } catch {
        continue;
      }
      const name =
        'name' in raw && typeof raw.name === 'string' && playerName.test(raw.name)
          ? raw.name
          : null;
      add(uuid, source, name);
    }
  }
  for (const uuid of conflictingNames) {
    usercache.delete(uuid);
    const item = known.get(uuid);
    if (item) item.name = null;
  }
  // Conflicting server name records cannot establish current player presence.
  const byName = new Map<string, string[]>();
  for (const [uuid, name] of usercache)
    byName.set(name.toLowerCase(), [...(byName.get(name.toLowerCase()) ?? []), uuid]);
  for (const ids of byName.values()) if (ids.length > 1) for (const id of ids) usercache.delete(id);
  const layouts = new Set<'legacy' | 'modern'>();
  for (const [layout, parents, prefix, directories] of [
    ['legacy', worldEntries, world, ['playerdata', 'stats', 'advancements']],
    ['modern', modernEntries, `${world}/players`, ['data', 'stats', 'advancements']],
  ] as const)
    for (const directory of directories) {
      const parent = parents.find((entry) => entry.name === directory);
      if (!parent) continue;
      if (parent.kind !== 'directory') throw new DomainError('conflict');
      layouts.add(layout);
      const scope = directory === 'data' ? 'playerdata' : directory;
      const entries = await files.list(`${prefix}/${directory}`);
      if (entries.length > 20000) throw new DomainError('resources_unavailable');
      for (const entry of entries) {
        const match = uuidFile.exec(entry.name);
        if (match && entry.kind === 'symlink') throw new DomainError('conflict');
        if (
          !match ||
          entry.kind !== 'file' ||
          (scope === 'playerdata' ? !match[2]?.startsWith('dat') : match[2] !== 'json')
        )
          continue;
        let uuid: string;
        try {
          uuid = minecraftUuid(match[1] ?? '');
        } catch {
          continue;
        }
        add(uuid, scope);
        const refs = references.get(uuid) ?? [];
        refs.push({ path: `${prefix}/${directory}/${entry.name}`, scope, layout, entry });
        references.set(uuid, refs);
      }
    }
  const layout =
    layouts.size === 2
      ? 'mixed'
      : layouts.has('modern')
        ? 'modern'
        : layouts.has('legacy')
          ? 'legacy'
          : 'missing';
  return {
    world,
    layout,
    knownPlayers: [...known.values()].sort((a, b) =>
      (a.name ?? a.uuid).localeCompare(b.name ?? b.uuid),
    ),
    usercache,
    references,
    propertiesDigest: digest(properties),
  } as const;
}

export async function readMinecraftPlayerDetail(files: FilemanReadService, uuid: string) {
  const discovered = await discoverMinecraftPlayers(files);
  const player = discovered.knownPlayers.find((entry) => entry.uuid === uuid);
  if (!player) throw new DomainError('not_found');
  const refs = discovered.references.get(uuid) ?? [];
  const bytes = new Map<string, Uint8Array>();
  const content = (path: string) => {
    const value = bytes.get(path);
    if (!value) throw new DomainError('conflict');
    return value;
  };
  for (const ref of refs) {
    if (ref.entry.size > 4 * 1024 ** 2) throw new DomainError('resources_unavailable');
    const value = await files.read({ path: ref.path, maxBytes: 4 * 1024 ** 2 });
    if (!value) throw new DomainError('conflict');
    bytes.set(ref.path, value);
  }
  const revision = digest(
    JSON.stringify({
      world: discovered.world,
      layout: discovered.layout,
      properties: discovered.propertiesDigest,
      files: refs.map((ref) => ({
        path: ref.path,
        digest: digest(content(ref.path)),
        modifiedAt: ref.entry.modifiedAt,
      })),
    }),
  );
  const dataRefs = refs.filter((ref) => ref.scope === 'playerdata' && ref.path.endsWith('.dat'));
  const statsRefs = refs.filter((ref) => ref.scope === 'stats');
  let decoded: ReturnType<typeof inspectMinecraftPlayerData> | undefined;
  let state: MinecraftPlayerDetail['snapshot']['state'] = dataRefs.length ? 'available' : 'missing';
  if (dataRefs.length > 1) state = 'unsupported';
  else if (dataRefs[0])
    try {
      decoded = inspectMinecraftPlayerData(content(dataRefs[0].path));
    } catch {
      state = 'unsupported';
    }
  let statistics: MinecraftPlayerDetail['statistics'] = null;
  if (statsRefs.length === 1 && statsRefs[0])
    try {
      statistics = inspectMinecraftPlayerStatistics(content(statsRefs[0].path));
    } catch {
      /* Preserve unsupported statistics as unknown, not an empty list. */
    }
  const modifiedAt = dataRefs[0]?.entry.modifiedAt;
  const savedAt =
    modifiedAt && Number.isFinite(Date.parse(modifiedAt))
      ? new Date(modifiedAt).toISOString()
      : null;
  const detail: MinecraftPlayerDetail = {
    player,
    world: discovered.world,
    layout: discovered.layout,
    online: 'unknown',
    snapshot: {
      source: 'saved-files',
      observedAt: new Date().toISOString(),
      savedAt,
      revision,
      dataVersion: decoded?.dataVersion ?? null,
      state,
    },
    inventory: decoded?.inventory ?? null,
    enderChest: decoded?.enderChest ?? null,
    selectedSlot: decoded?.selectedSlot ?? null,
    vitals: decoded?.vitals ?? null,
    position: decoded?.position ?? null,
    statistics,
    capabilities: [],
  };
  return { detail, discovered, refs, bytes };
}
