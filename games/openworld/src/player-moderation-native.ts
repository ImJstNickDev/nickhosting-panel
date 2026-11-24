import { DomainError } from '@nickhosting/core';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import { z } from 'zod';
import { readOpenworldTelemetry } from './dashboard-api.js';
import type { OpenworldNativeConnection } from './native-diagnostics.js';
import { listSavedPlayerFiles, readSavedPlayerDocuments } from './offline-players.js';
import { moderationPlayerName, moderationRoleKey } from './player-moderation.js';
import { ruleReplies } from './rules-console.js';
import { parseOpenworldBanList } from './rules-native.js';

const roleDoc = z.object({
  defaultRole: moderationRoleKey,
  roles: z.record(z.string(), z.object({ name: z.string().max(256) })),
  players: z
    .record(
      z.string(),
      z.union([
        moderationRoleKey,
        z.object({ role: moderationRoleKey, pseudo: z.string().max(256).optional() }),
      ]),
    )
    .optional(),
});
const zoneDoc = z.object({
  zones: z
    .array(
      z.object({
        id: z.number().int().positive().safe(),
        name: z.string().min(1).max(128),
        world: z.string().min(1).max(128),
        members: z.array(z.string()).default([]),
      }),
    )
    .max(8192),
});

function parseFile<S extends z.ZodType>(bytes: Uint8Array | undefined, schema: S) {
  if (bytes) {
    try {
      const result = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      if (result.success) return result.data;
    } catch {}
  }
  throw new DomainError('integration_unavailable');
}

export function playerRoles(bytes: Uint8Array | undefined, account: string) {
  const doc = parseFile(bytes, roleDoc);
  const assignment = Object.entries(doc.players ?? {}).find(
    ([id]) => id.toLowerCase() === account,
  )?.[1];
  return {
    current: (typeof assignment === 'string' ? assignment : assignment?.role) ?? doc.defaultRole,
    roles: Object.entries(doc.roles)
      .filter(([key]) => moderationRoleKey.safeParse(key).success)
      .map(([key, r]) => ({ key, name: r.name })),
  };
}

export function playerMemberships(bytes: Uint8Array | undefined, account: string) {
  // A missing file is ambiguous (e.g. an oversized document) and cannot prove membership.
  const doc = parseFile(bytes, zoneDoc);
  return doc.zones.map((z) => ({
    id: z.id,
    name: z.name,
    world: z.world,
    member: z.members.some((id) => id.toLowerCase() === account),
  }));
}

export async function playerBans(native: OpenworldNativeConnection) {
  const observed = parseOpenworldBanList((await ruleReplies(native, ['banlist'])).get('banlist'));
  if (!observed) throw new DomainError('integration_unavailable');
  return observed;
}

export type IndexedIdentity = {
  file_stem: string;
  revision: string;
  account_id: string | null;
  display_name: string | null;
};

// Console verbs select by name. Compare live identities and the current save directory,
// including offline namesakes. Reuse only index entries whose file revision still matches.
export async function proveSavedModerationName(
  files: FilemanReadService,
  known: IndexedIdentity[],
  account: string,
  name: string,
) {
  if (!moderationPlayerName.safeParse(name).success) throw new DomainError('validation_failed');
  const target = name.toLowerCase();
  const indexed = new Map(known.map((row) => [row.file_stem, row]));
  const refs = await listSavedPlayerFiles(files);
  let saved = false;
  function checkSaved(id: string | null, display: string | null) {
    if (display?.toLowerCase() !== target) return;
    if (id?.toLowerCase() !== account) throw new DomainError('conflict');
    if (display === name) saved = true;
  }
  const roleDirectory = parseFile(
    await files.read({ path: 'roles.json', maxBytes: 512 * 1024 }),
    roleDoc,
  );
  for (const [id, entry] of Object.entries(roleDirectory.players ?? {})) {
    if (
      typeof entry !== 'string' &&
      entry.pseudo &&
      entry.pseudo.toLowerCase() === target &&
      id.toLowerCase() !== account
    )
      throw new DomainError('conflict');
  }
  const unmatched = [];
  for (const ref of refs.values()) {
    const old = indexed.get(ref.stem);
    if (
      !(ref.save && ref.stats) &&
      old?.account_id &&
      old.display_name &&
      old.revision === `v2:${ref.revision}` &&
      ref.save?.time !== null &&
      ref.stats?.time !== null
    ) {
      checkSaved(old.account_id, old.display_name);
    } else unmatched.push(ref);
  }
  for (let i = 0; i < unmatched.length; i += 24) {
    // A rename can leave the save and statistics documents with different aliases.
    // Either alias can collide with the native console's name-based selection.
    const records = unmatched
      .slice(i, i + 24)
      .flatMap((ref) => [
        ...(ref.save ? [{ ...ref, stats: null }] : []),
        ...(ref.stats ? [{ ...ref, save: null }] : []),
      ]);
    const docs = await readSavedPlayerDocuments(files, records);
    for (const doc of docs) {
      if (!doc) throw new DomainError('integration_unavailable');
      checkSaved(doc.uuid, doc.name);
    }
  }
  return saved;
}

// Resolve the final roster after reading the console cursor and immediately before sending the command.
export async function confirmModerationTarget(
  native: OpenworldNativeConnection,
  account: string,
  name: string,
  saved: boolean,
  requireOnline: boolean,
) {
  const target = name.toLowerCase();
  const read = <K extends 'players' | 'player'>(kind: K, id?: number) =>
    readOpenworldTelemetry(native.origin, native.token, kind, native.signal, id, native.fetcher);
  const { players } = await read('players');
  const matches = players.filter((p) => p.name.toLowerCase() === target);
  if (matches.length > 1) throw new DomainError('conflict');
  if (matches[0]) {
    const row = matches[0];
    const detail = row.accountVerified && row.account ? row : await read('player', row.id);
    if (
      row.name !== name ||
      detail.id !== row.id ||
      detail.name !== name ||
      !detail.accountVerified ||
      detail.account?.toLowerCase() !== account
    )
      throw new DomainError('conflict');
  } else if (requireOnline) throw new DomainError('game_request_unsupported');
  else if (!saved || players.some((p) => p.account?.toLowerCase() === account))
    throw new DomainError('conflict');
}
