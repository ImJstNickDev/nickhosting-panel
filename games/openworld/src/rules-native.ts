import { DomainError } from '@nickhosting/core';
import { OpenworldTokenExpired } from './dashboard-api.js';

import type { OpenworldNativeConnection } from './native-diagnostics.js';
import {
  type OpenworldDifficulty,
  type OpenworldRuleAction,
  type OpenworldRulesSnapshot,
  openworldDifficulties,
  openworldRuleActionSchema,
} from './rules.js';
import { type OpenworldRuleCommand, readNaturalSpawning, ruleReplies } from './rules-console.js';
import { fileContents, label, rolesFromFile, savedBorders } from './rules-documents.js';
import { planOpenworldEditorAction } from './rules-edit.js';
import { globalFlags, mergeZoneDetails, permissionNodes } from './rules-snapshot.js';

type Snapshot = OpenworldRulesSnapshot;
type ReadFile = () => Promise<Uint8Array | undefined>;
type Reply = { accepted: boolean; lines: string[] } | undefined;
// Each release in this set accepted the commands and persisted the resulting changes in isolated tests.
const verified = new Set([
  'a1.0.11',
  'a1.0.12',
  'a1.0.13',
  'a1.1.0',
  'a1.1.1',
  'a1.1.2',
  'a1.1.3',
  'pre-a1.2.0-1',
  'a1.2.0',
  'a1.2.1',
  'a1.2.2',
  'a1.2.3',
  'a1.2.4',
  'a1.2.5',
  'a1.2.6',
  'a1.2.7',
  'a1.2.8',
  'a1.2.9',
  'a1.2.10',
]);
export function canChangeOpenworldLegacyRules(version: string) {
  return verified.has(version);
}
export function canEditOpenworldTerritory(version: string) {
  return version === 'a1.2.10' || version === 'a1.2.9';
}
function parseRows<T>(lines: string[], parse: (line: string) => T | null): T[] | null {
  const rows: T[] = [];
  for (const line of lines) {
    const row = parse(line);
    if (row === null) return null;
    rows.push(row);
  }
  return rows;
}
function roles(reply: Reply): Snapshot['roles'] {
  if (!reply?.accepted) return null;
  const [title, ...lines] = reply.lines;
  const defaultRole = /^Roles \(the default one: ([a-z0-9_-]{1,32})\):$/.exec(title ?? '')?.[1];
  if (!defaultRole) return null;
  const entries = parseRows(lines, (l) => {
    const m =
      /^ {2}• ([a-z0-9_-]{1,32}) “(.{1,128})” — priority (-?\d{1,10}), parent (-|[a-z0-9_-]{1,32}), homes (?:∞|-?\d+), \d+ player\(s\)$/.exec(
        l,
      );
    return m?.[1] && m[2] && m[4] && label.safeParse(m[2]).success
      ? {
          key: m[1],
          name: m[2],
          priority: Number(m[3]),
          parent: m[4] === '-' ? null : m[4],
          permissions: null,
        }
      : null;
  });
  return entries?.length ? { defaultRole, entries } : null;
}
function zones(reply: Reply): Snapshot['zones'] {
  if (!reply?.accepted) return null;
  const [title, ...lines] = reply.lines;
  if (
    title?.startsWith('No zone yet (/zone create NAME [RADIUS]). Server rules: ') &&
    !lines.length
  )
    return [];
  const count = /^(\d+) zone\(s\)\. Server rules: /.exec(title ?? '');
  if (!count || Number(count[1]) !== lines.length) return null;
  return parseRows(lines, (l) => {
    const m = /^ {2}• (.{1,128}) — ([^,]{1,128}), (.+)$/.exec(l);
    if (
      !m?.[1] ||
      !m[2] ||
      !m[3] ||
      !label.safeParse(m[1]).success ||
      !label.safeParse(m[2]).success
    )
      return null;
    // The native console sometimes emits a nested untranslated format marker before the radius.
    const radius = /(\d+(?:\.\d+)?\s*(?:m|km))\b/.exec(m[3])?.[1];
    return { name: m[1], world: m[2], description: radius ?? '' };
  });
}
// The console rounds values for display (including converting metres to kilometres).
// Only use the file's extra precision when it agrees with that observation.
function matchesDisplay(exact: number, displayed: string, scale = 1) {
  const precision = displayed.split('.')[1]?.length ?? 0;
  return Math.abs(exact / scale - Number(displayed)) <= 0.5 * 10 ** -precision + 1e-10;
}
function borders(reply: Reply, document?: unknown, verifyWorld?: string): Snapshot['borders'] {
  const documents = savedBorders(document);
  if (!reply?.accepted) return null;
  const [title, ...lines] = reply.lines;
  const state = /^Travel rules: space is (open|closed)\.$/.exec(title ?? '')?.[1];
  if (!state) return null;
  const worlds = parseRows(lines, (l) => {
    const m = /^ {2}• ([^:]{1,128}): (.+)$/.exec(l);
    if (!m?.[1] || !m[2] || !label.safeParse(m[1]).success) return null;
    const world = m[1],
      stored = documents?.[world.toLowerCase()];
    const saved = stored?.border;
    const savedGeometry = saved && {
      enabled: saved.enabled,
      longitude: saved.centre[0],
      latitude: saved.centre[1],
      radiusMeters: saved.radius,
    };
    const verify = verifyWorld?.toLowerCase() === world.toLowerCase();
    if (m[2] === 'open, no border' || m[2] === 'closed') {
      const closed = m[2] === 'closed';
      const agrees = stored && stored.allowed === !closed && (closed || !stored.border.enabled);
      if (verify && stored && !agrees) throw new DomainError('conflict');
      return {
        world,
        description: closed ? 'closed' : 'open',
        ...(agrees && savedGeometry ? { border: savedGeometry } : {}),
      };
    }
    const geometry =
      /^a border of (\d+(?:\.\d+)?) (m|km) around lon (-?\d+(?:\.\d+)?), lat (-?\d+(?:\.\d+)?)$/.exec(
        m[2],
      );
    if (!geometry?.[1] || !geometry[3] || !geometry[4]) return null;
    const radiusMeters = Number(geometry[1]) * (geometry[2] === 'km' ? 1000 : 1);
    const longitude = Number(geometry[3]),
      latitude = Number(geometry[4]);
    if (
      !Number.isFinite(radiusMeters) ||
      radiusMeters <= 0 ||
      Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90
    )
      return null;
    const agrees =
      stored?.allowed &&
      saved?.enabled &&
      matchesDisplay(saved.radius, geometry[1], geometry[2] === 'km' ? 1000 : 1) &&
      matchesDisplay(saved.centre[0], geometry[3]) &&
      matchesDisplay(saved.centre[1], geometry[4]);
    if (verify && stored && !agrees) throw new DomainError('conflict');
    return {
      world,
      description: 'bounded',
      border: agrees && savedGeometry ? savedGeometry : { radiusMeters, longitude, latitude },
    };
  });
  return worlds ? { spaceOpen: state === 'open', worlds } : null;
}
export function parseOpenworldBanList(reply: Reply): Snapshot['bans'] {
  if (!reply?.accepted) return null;
  const [title, ...lines] = reply.lines;
  if (title === 'Nobody is banned.' && !lines.length) return [];
  const count = /^(\d+) banned player\(s\):$/.exec(title ?? '');
  if (!count || Number(count[1]) !== lines.length) return null;
  return parseRows(lines, (l) => {
    const m =
      /^ {2}(.{1,256}) \(((?:guest:)?[A-Za-z0-9_-]{1,128})\), banned by [^:]{1,256}(?:: (.{1,1024}))?$/.exec(
        l,
      );
    if (!m?.[1] || !m[2] || !label.safeParse(m[1]).success) return null;
    return { name: m[1], uuid: m[2], reason: m[3] ?? null };
  });
}
function difficulty(reply: Reply): OpenworldDifficulty | null {
  if (!reply?.accepted) return null;
  const label = /^Difficulty: (Easy|Moderate|Normal|Hard|Very hard|Terrible)\./.exec(
    reply.lines[0] ?? '',
  )?.[1];
  if (!label) return null;
  const value = label === 'Moderate' ? 'medium' : label.toLowerCase().replace(' ', '_');
  return openworldDifficulties.find((v) => v === value) ?? null;
}
export async function readOpenworldRules(
  native: OpenworldNativeConnection,
  version: string,
  readRoles?: ReadFile,
  readZones?: ReadFile,
  readBorders?: ReadFile,
  options?: { includeBans?: boolean },
): Promise<Snapshot> {
  const [roleDoc, zoneDoc, borderDoc] = await Promise.all([
    fileContents(readRoles),
    fileContents(readZones),
    fileContents(readBorders),
  ]);
  const fromFile = rolesFromFile(roleDoc);
  const commands: OpenworldRuleCommand[] = ['zone list', 'difficulty', 'border info'];
  if (!fromFile) commands.push('role list');
  if (options?.includeBans !== false) commands.push('banlist');
  const editing = canEditOpenworldTerritory(version);
  if (editing) commands.push('role nodes');
  const [replies, naturalSpawning] = await Promise.all([
    ruleReplies(native, commands),
    readNaturalSpawning(native),
  ]);
  const level = difficulty(replies.get('difficulty'));
  const banRows = parseOpenworldBanList(replies.get('banlist'));
  const global = globalFlags(replies.get('zone list'));
  const liveZones = mergeZoneDetails(zones(replies.get('zone list')), zoneDoc);
  const worldBorders = borders(replies.get('border info'), borderDoc);
  return {
    difficulty: level,
    naturalSpawning,
    globalFlags: global,
    permissionNodes: permissionNodes(replies.get('role nodes')),
    roles: fromFile ?? roles(replies.get('role list')),
    zones: liveZones,
    borders: worldBorders,
    bans: banRows,
    capabilities: {
      difficulty: verified.has(version) && level !== null,
      unban: verified.has(version) && banRows !== null,
      globals: editing && global !== null,
      zones: editing && !!liveZones?.some((z) => z.id !== undefined),
      borders: editing && worldBorders !== null,
      roles: editing && fromFile !== null,
      spawning: editing && naturalSpawning !== null,
    },
  };
}
export type OpenworldRuleDocuments = {
  roles?: Uint8Array;
  zones?: Uint8Array;
  borders?: Uint8Array;
};
type EditorState = Parameters<typeof planOpenworldEditorAction>[1];

async function readEditorState(
  native: OpenworldNativeConnection,
  action: OpenworldRuleAction,
  readFiles?: () => Promise<OpenworldRuleDocuments>,
): Promise<EditorState> {
  const state: EditorState = {};
  if (action.kind === 'spawning') {
    state.naturalSpawning = await readNaturalSpawning(native);
    return state;
  }
  if (action.kind === 'globalFlag' || 'zoneId' in action) {
    const [doc, replies] = await Promise.all([
      'zoneId' in action
        ? fileContents(readFiles && (async () => (await readFiles()).zones))
        : null,
      ruleReplies(native, ['zone list']),
    ]);
    state.globalFlags = globalFlags(replies.get('zone list'));
    state.zones = mergeZoneDetails(zones(replies.get('zone list')), doc);
    return state;
  }
  if ('role' in action) {
    state.roles = rolesFromFile(
      await fileContents(readFiles && (async () => (await readFiles()).roles)),
    );
    return state;
  }
  const [doc, replies] = await Promise.all([
    fileContents(readFiles && (async () => (await readFiles()).borders)),
    ruleReplies(native, ['border info']),
  ]);
  state.borders = borders(
    replies.get('border info'),
    doc,
    'world' in action ? action.world : undefined,
  );
  return state;
}
export async function performOpenworldRule(
  native: OpenworldNativeConnection,
  version: string,
  input: OpenworldRuleAction,
  beforeDispatch: () => Promise<void>,
  readFiles?: () => Promise<OpenworldRuleDocuments>,
) {
  const parsed = openworldRuleActionSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('validation_failed');
  const action = parsed.data;
  if (!verified.has(version)) throw new DomainError('game_request_unsupported');
  if (action.kind !== 'difficulty' && action.kind !== 'unban') {
    if (!canEditOpenworldTerritory(version)) throw new DomainError('game_request_unsupported');
    const read = () => readEditorState(native, action, readFiles);
    const { command, matches } = planOpenworldEditorAction(action, await read());
    return performVerifiedChange(native, command, beforeDispatch, async () => {
      // Status is published on a separate tick. Never resubmit a write while waiting for it.
      for (let attempt = 0; ; attempt++) {
        if (matches(await read())) return true;
        if (action.kind !== 'spawning' || attempt >= 6 || native.signal.aborted) return false;
        await new Promise((resolve) => setTimeout(resolve, 230));
      }
    });
  }
  const observe = action.kind === 'difficulty' ? 'difficulty' : 'banlist';
  const prior = (await ruleReplies(native, [observe])).get(observe);
  if (action.kind === 'unban') {
    const old = parseOpenworldBanList(prior);
    if (!old) throw new DomainError('integration_unavailable');
    if (!old.some((row) => row.uuid === action.uuid)) throw new DomainError('not_found');
  } else if (!difficulty(prior)) throw new DomainError('integration_unavailable');
  const command =
    action.kind === 'unban'
      ? (`unban ${action.uuid}` as const)
      : (`difficulty ${action.value}` as const);
  return performVerifiedChange(native, command, beforeDispatch, async () => {
    const observed = (await ruleReplies(native, [observe])).get(observe);
    if (action.kind === 'difficulty') {
      if (difficulty(observed) === action.value) return true;
    } else {
      const rows = parseOpenworldBanList(observed);
      if (rows && !rows.some((row) => row.uuid === action.uuid)) return true;
    }
    return false;
  });
}

async function performVerifiedChange(
  native: OpenworldNativeConnection,
  command: OpenworldRuleCommand,
  beforeDispatch: () => Promise<void>,
  confirmed: () => Promise<boolean>,
) {
  let dispatched = false;
  try {
    const change = (
      await ruleReplies(native, [command], async () => {
        await beforeDispatch();
        dispatched = true;
      })
    ).get(command);
    if (change?.accepted === false) throw new DomainError('game_request_rejected');
    if (!change) throw new DomainError('operation_uncertain');
    if (await confirmed()) return;
    throw new DomainError('operation_uncertain');
  } catch (error) {
    if (!dispatched || (error instanceof DomainError && error.code === 'game_request_rejected'))
      throw error;
    if (error instanceof OpenworldTokenExpired)
      throw new OpenworldTokenExpired('operation_uncertain');
    throw new DomainError('operation_uncertain');
  }
}
