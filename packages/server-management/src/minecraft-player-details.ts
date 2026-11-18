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
const sources = [
  ['usercache.json', 'usercache'],
  ['ops.json', 'operators'],
  ['whitelist.json', 'whitelist'],
  ['banned-players.json', 'banned'],
] as const;

function* identities(bytes: Uint8Array | undefined) {
  for (const raw of jsonArray(bytes)) {
    if (!raw || typeof raw !== 'object' || !('uuid' in raw) || typeof raw.uuid !== 'string')
      continue;
    let uuid: string;
    try {
      uuid = minecraftUuid(raw.uuid);
    } catch {
      continue;
    }
    const name =
      'name' in raw && typeof raw.name === 'string' && playerName.test(raw.name) ? raw.name : null;
    yield { uuid, name };
  }
}

// Only a unique name in the server's own cache can bind a console observation to a UUID.
function usercacheIdentities(bytes: Uint8Array | undefined) {
  const display = new Map<string, string | null>();
  const bindings = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const { uuid, name } of identities(bytes)) {
    display.set(uuid, name);
    if (bindings.has(uuid) && bindings.get(uuid) !== name) conflicts.add(uuid);
    else if (name) bindings.set(uuid, name);
  }
  for (const uuid of conflicts) {
    bindings.delete(uuid);
    display.set(uuid, null);
  }
  const byName = new Map<string, string>();
  for (const [uuid, name] of bindings) {
    const key = name.toLowerCase();
    const earlier = byName.get(key);
    if (earlier) {
      bindings.delete(uuid);
      bindings.delete(earlier);
    } else byName.set(key, uuid);
  }
  return { display, bindings };
}

function validRootFile(root: readonly FilemanEntry[], path: string) {
  const entry = root.find((candidate) => candidate.name === path);
  if (entry && (entry.kind !== 'file' || entry.size > 1048576))
    throw new DomainError('integration_unavailable');
  return !!entry;
}

export async function readMinecraftPlayerBinding(files: FilemanReadService, uuid: string) {
  const root = await files.list('');
  if (!validRootFile(root, 'usercache.json')) return;
  const bytes = await files.read({ path: 'usercache.json', maxBytes: 1048576 });
  return usercacheIdentities(bytes).bindings.get(uuid);
}

/** Exact supported roots only; user-provided paths never enter the read contract. */
export async function discoverMinecraftPlayers(
  files: FilemanReadService,
  listSnapshot?: {
    root: readonly FilemanEntry[];
    rootFiles: ReadonlyMap<string, Uint8Array | undefined>;
  },
) {
  const [root, properties] = listSnapshot
    ? ([listSnapshot.root, listSnapshot.rootFiles.get('server.properties')] as const)
    : await Promise.all([
        files.list(''),
        files.read({ path: 'server.properties', maxBytes: 1048576 }),
      ]);
  if (!properties) throw new DomainError('integration_unavailable');
  const world = minecraftWorldName(
    parseMinecraftProperties(Buffer.from(properties).toString('utf8'))['level-name'] ?? 'world',
  );
  const worldEntry = root.find((entry) => entry.name === world);
  if (worldEntry && worldEntry.kind !== 'directory') throw new DomainError('conflict');
  const present = sources.filter(([path]) => validRootFile(root, path));
  const needed = present.filter(([path]) => !listSnapshot?.rootFiles.has(path));
  async function readRootFiles() {
    const requests = needed.map(([path]) => ({ path, maxBytes: 1048576 }));
    if (requests.length > 1) return files.readMany(requests);
    const values = new Map<string, Uint8Array | undefined>();
    if (requests[0]) values.set(requests[0].path, await files.read(requests[0]));
    return values;
  }
  const [worldEntries, rootBytes] = await Promise.all([
    worldEntry ? files.list(world) : [],
    readRootFiles(),
  ]);
  const playersEntry = worldEntries.find((entry) => entry.name === 'players');
  if (playersEntry && playersEntry.kind !== 'directory') throw new DomainError('conflict');
  const modernEntries = playersEntry ? await files.list(`${world}/players`) : [];
  const references = new Map<string, Ref[]>();
  const known = new Map<string, MinecraftKnownPlayer>();
  const add = (uuid: string, source: Source, name: string | null = null) => {
    let item = known.get(uuid);
    if (!item) {
      item = { uuid, name, sources: [] };
      known.set(uuid, item);
    }
    if (known.size > 10000) throw new DomainError('resources_unavailable');
    if (!item.sources.includes(source)) item.sources.push(source);
    if (!item.name && !item.sources.includes('usercache')) item.name = name;
  };
  let usercache = new Map<string, string>();
  for (const [path, source] of present) {
    const bytes = listSnapshot?.rootFiles.has(path)
      ? listSnapshot.rootFiles.get(path)
      : rootBytes.get(path);
    if (!bytes) throw new DomainError('integration_unavailable');
    if (source === 'usercache') {
      const { display, bindings } = usercacheIdentities(bytes);
      usercache = bindings;
      for (const [uuid, name] of display) add(uuid, source, name);
    } else {
      for (const { uuid, name } of identities(bytes)) add(uuid, source, name);
    }
  }
  const layouts = new Set<'legacy' | 'modern'>();
  const directoriesToRead: { path: string; scope: Ref['scope']; layout: Ref['layout'] }[] = [];
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
      directoriesToRead.push({ path: `${prefix}/${directory}`, scope, layout });
    }
  const batch = directoriesToRead.length
    ? await files.listMany(directoriesToRead.map(({ path }) => path))
    : [];
  for (const { path, scope, layout } of directoriesToRead) {
    const result = batch.find((entry) => entry.directory === path);
    if (!result || 'error' in result) {
      if (result && result.error === 'forbidden') throw new DomainError('forbidden');
      throw new DomainError('integration_unavailable');
    }
    const entries = result.files;
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
      refs.push({ path: `${path}/${entry.name}`, scope, layout, entry });
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

export async function findMinecraftPlayer(files: FilemanReadService, uuid: string) {
  const discovered = await discoverMinecraftPlayers(files);
  const player = discovered.knownPlayers.find((entry) => entry.uuid === uuid);
  if (!player) throw new DomainError('not_found');
  const refs = discovered.references.get(uuid) ?? [];
  return { discovered, player, refs };
}

export async function readMinecraftPlayerDetail(
  files: FilemanReadService,
  uuid: string,
  view: 'saved' | 'full' = 'full',
) {
  const { discovered, player, refs } = await findMinecraftPlayer(files, uuid);
  const dataRefs = refs.filter((ref) => ref.scope === 'playerdata' && ref.path.endsWith('.dat'));
  const statsRefs = refs.filter((ref) => ref.scope === 'stats');
  const required =
    view === 'full'
      ? refs
      : [...(dataRefs.length === 1 ? dataRefs : []), ...(statsRefs.length === 1 ? statsRefs : [])];
  const bytes = new Map<string, Uint8Array>();
  const content = (path: string) => {
    const value = bytes.get(path);
    if (!value) throw new DomainError('conflict');
    return value;
  };
  const fileLimit = 4 * 1024 ** 2;
  if (required.some((ref) => ref.entry.size > fileLimit))
    throw new DomainError('resources_unavailable');
  // readMany bounds parallel downloads and accepts at most 16 MiB per batch.
  for (let start = 0; start < required.length; start += 4) {
    const group = required.slice(start, start + 4);
    const values = await files.readMany(group.map(({ path }) => ({ path, maxBytes: fileLimit })));
    for (const { path } of group) {
      const value = values.get(path);
      if (!value) throw new DomainError('conflict');
      bytes.set(path, value);
    }
  }
  const revision = digest(
    JSON.stringify({
      ...(view === 'saved' ? { view } : {}),
      world: discovered.world,
      layout: discovered.layout,
      properties: discovered.propertiesDigest,
      files: required.map((ref) => ({
        path: ref.path,
        digest: digest(content(ref.path)),
        modifiedAt: ref.entry.modifiedAt,
      })),
    }),
  );
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
