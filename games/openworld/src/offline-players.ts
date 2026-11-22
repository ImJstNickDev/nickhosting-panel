import { DomainError } from '@nickhosting/core';
import type { FilemanEntry, FilemanReadService } from '@nickhosting/game-sdk';
import { z } from 'zod';

const maxDocument = 128 * 1024;
const maxCandidates = 20000;
export const savedAccountId = /^(?:guest:)?[A-Za-z0-9_-]{1,128}$/;
const stamp = z.number().int().positive().max(8_640_000_000_000_000);
const label = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\p{C}]+$/u);
const counter = z.number().nonnegative();
const statsSchema = z.object({
  firstSeenMs: stamp.optional().catch(undefined),
  lastSeenMs: stamp.optional().catch(undefined),
  joins: counter.optional(),
  playSeconds: counter.optional(),
  blocksBroken: counter.optional(),
  blocksPlaced: counter.optional(),
  deaths: counter.optional(),
  playerKills: counter.optional(),
  creatureKills: counter.optional(),
  walkedMeters: counter.optional(),
});
const slot = z
  .tuple([z.number().int().min(0).max(0xffffffff), z.number().int().min(0).max(0xffffffff)])
  .transform(([code, count]) => (code && count ? { code, count } : null));
const inventorySchema = z.object({
  selected: z.number().int().min(0).max(11).nullable().catch(null),
  hotbar: z.array(slot).max(12),
  bag: z.array(slot).max(36),
});
const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  face: z.number().int().min(0).max(5).nullable().catch(null),
});
type Stats = z.output<typeof statsSchema>;
type Inventory = z.output<typeof inventorySchema>;
export type OpenworldSavedPlayerSummary = {
  uuid: string;
  name: string | null;
  lastSeenMs?: number | null;
  skinHash?: string | null;
  savedAt: string | null;
};
export type OpenworldSavedPlayersPage = {
  players: OpenworldSavedPlayerSummary[];
  page: number;
  total: number;
  indexedAt: string;
  stale: boolean;
  indexing: boolean;
};
export type OpenworldSavedPlayerDetail = OpenworldSavedPlayerSummary & {
  statsAt: string | null;
  world: string | null;
  mode: string | null;
  position: z.output<typeof positionSchema> | null;
  stats: Stats | null;
  inventory: Inventory | null;
};

type Ref = { path: string; size: number; time: string | null };
export type SavedPlayerFiles = {
  stem: string;
  save: Ref | null;
  stats: Ref | null;
  revision: string;
};
function json(bytes: Uint8Array | undefined): Record<string, unknown> {
  if (!bytes) throw new DomainError('integration_unavailable');
  try {
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      return raw as Record<string, unknown>;
  } catch {}
  throw new DomainError('integration_unavailable');
}
const iso = (value: unknown) => {
  const ms = stamp.safeParse(value);
  return ms.success ? new Date(ms.data).toISOString() : null;
};

function dirEntry(list: readonly FilemanEntry[], name: string, kind: 'directory' | 'file') {
  const entry = list.find((e) => e.name === name);
  if (entry && entry.kind !== kind) throw new DomainError('integration_unavailable');
  return entry;
}

export async function openworldDataRoot(files: FilemanReadService, root: readonly FilemanEntry[]) {
  let entries = root;
  const config = dirEntry(entries, 'server.json', 'file');
  let dataDir = 'owserver_data';
  if (config) {
    if (config.size > 1048576) throw new DomainError('integration_unavailable');
    const setting = json(await files.read({ path: 'server.json', maxBytes: 1048576 })).dataDir;
    if (setting !== undefined) {
      if (typeof setting !== 'string' || setting.length > 1024)
        throw new DomainError('integration_unavailable');
      if (setting.startsWith('/') || /[\\:\p{C}]/u.test(setting))
        throw new DomainError('integration_unavailable');
      const parts = setting.split('/').filter((p) => p && p !== '.');
      if (parts.length > 12 || parts.includes('..') || !setting.trim())
        throw new DomainError('integration_unavailable');
      dataDir = parts.join('/');
    }
  }
  let directory = '';
  for (const component of dataDir.split('/').filter(Boolean)) {
    if (!dirEntry(entries, component, 'directory')) return undefined;
    directory = directory ? `${directory}/${component}` : component;
    entries = await files.list(directory);
  }
  return { directory, entries };
}

/** Traverse only real folders from the configured data root. Returned refs always come from these listings. */
export async function listSavedPlayerFiles(files: FilemanReadService) {
  const data = await openworldDataRoot(files, await files.list(''));
  if (!data || !dirEntry(data.entries, 'players', 'directory'))
    return new Map<string, SavedPlayerFiles>();
  const directory = data.directory ? `${data.directory}/players` : 'players';
  const entries = await files.list(directory);
  const refs = new Map<string, SavedPlayerFiles>();
  const add = (list: readonly FilemanEntry[], kind: 'save' | 'stats', root: string) => {
    for (const file of list) {
      if (file.kind !== 'file' || !file.name.endsWith('.json')) continue;
      const stem = file.name.slice(0, -5);
      if (!savedAccountId.test(stem)) continue;
      const ref = refs.get(stem) ?? { stem, save: null, stats: null, revision: '' };
      if (!refs.has(stem) && refs.size >= maxCandidates)
        throw new DomainError('validation_failed', 413);
      ref[kind] = {
        path: `${root}/${file.name}`,
        size: file.size,
        time:
          file.modifiedAt && Number.isFinite(Date.parse(file.modifiedAt))
            ? new Date(file.modifiedAt).toISOString()
            : null,
      };
      refs.set(stem, ref);
    }
  };
  add(entries, 'save', directory);
  if (dirEntry(entries, 'stats', 'directory'))
    add(await files.list(`${directory}/stats`), 'stats', `${directory}/stats`);
  for (const ref of refs.values()) ref.revision = JSON.stringify([ref.save, ref.stats]);
  return refs;
}

function document(bytes: Uint8Array | undefined, stem: string) {
  if (!bytes) return null;
  let doc: Record<string, unknown>;
  try {
    doc = json(bytes);
  } catch {
    return null;
  }
  const id = doc.uuid;
  if (typeof id !== 'string' || !savedAccountId.test(id)) return null;
  // Some offline records store the guest-prefixed identity in a file named for its suffix.
  if (id !== stem && !(id.startsWith('guest:') && id.slice(6) === stem)) return null;
  return { id, doc };
}
function maybeLabel(v: unknown) {
  const result = label.safeParse(v);
  return result.success ? result.data : null;
}
export function projectSavedPlayer(
  ref: SavedPlayerFiles,
  values: ReadonlyMap<string, Uint8Array | undefined>,
): OpenworldSavedPlayerDetail | null {
  const save = ref.save ? document(values.get(ref.save.path), ref.stem) : null;
  const stats = ref.stats ? document(values.get(ref.stats.path), ref.stem) : null;
  const identity = save ?? stats;
  if (!identity || (save && stats && save.id !== stats.id)) return null;
  const data = save?.doc,
    record = stats?.doc;
  const position = positionSchema.safeParse(data?.position);
  const statsResult = statsSchema.safeParse(record);
  const inventory = inventorySchema.safeParse(data?.inventory);
  return {
    uuid: identity.id,
    name: maybeLabel(data?.pseudo) ?? maybeLabel(record?.pseudo),
    savedAt: save ? (iso(data?.savedAtMs) ?? ref.save?.time ?? null) : null,
    lastSeenMs: statsResult.data?.lastSeenMs ?? null,
    statsAt: stats ? (ref.stats?.time ?? null) : null,
    mode: maybeLabel(data?.gameMode),
    world: maybeLabel(z.object({ world: z.unknown() }).safeParse(data?.position).data?.world),
    position: position.success ? position.data : null,
    stats: statsResult.success ? statsResult.data : null,
    inventory: inventory.success ? inventory.data : null,
  };
}
export async function readSavedPlayerDocuments(
  files: FilemanReadService,
  refs: SavedPlayerFiles[],
) {
  const requests = refs
    .flatMap((r) => [r.save, r.stats])
    .filter((r): r is Ref => !!r && r.size > 0 && r.size <= maxDocument)
    .map((r) => ({ path: r.path, maxBytes: maxDocument, missing: 'allow' as const }));
  const values = requests.length
    ? await files.readMany(requests)
    : new Map<string, Uint8Array | undefined>();
  return refs.map((r) => projectSavedPlayer(r, values));
}
