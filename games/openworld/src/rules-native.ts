import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { OpenworldNativeConnection } from './native-diagnostics.js';
import {
  type OpenworldDifficulty,
  type OpenworldRuleAction,
  type OpenworldRulesSnapshot,
  openworldDifficulties,
  openworldRuleActionSchema,
} from './rules.js';
import { ruleReplies } from './rules-console.js';

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
]);
const key = z.string().regex(/^[a-z0-9_-]{1,32}$/);
const label = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
const roleFile = z.object({
  format: z.literal(2),
  defaultRole: key,
  roles: z.record(
    key,
    z.object({
      name: label,
      priority: z.int(),
      parent: key.nullish(),
      permissions: z.array(z.string().regex(/^[a-zA-Z0-9.*_!-]{1,128}$/)).max(1024),
    }),
  ),
});
const zonesFile = z.object({
  format: z.literal(1),
  zones: z
    .array(
      z.object({
        name: label,
        world: key,
        shape: z.enum(['circle', 'polygon']),
        radius: z.number().nonnegative().optional(),
        points: z
          .array(z.tuple([z.number(), z.number()]))
          .max(2000)
          .optional(),
        flags: z
          .record(z.string().regex(/^[a-z0-9_.-]{1,100}$/), z.enum(['allow', 'deny']))
          .optional(),
      }),
    )
    .max(4096),
});
async function fileContents(read?: ReadFile) {
  try {
    const bytes = await read?.();
    if (!bytes || bytes.byteLength > 1024 * 1024) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (
      error instanceof DomainError &&
      [
        'unauthenticated',
        'forbidden',
        'provenance_mismatch',
        'conflict',
        'game_not_ready',
      ].includes(error.code)
    )
      throw error;
    return null;
  }
}
function rolesFromFile(document: unknown): Snapshot['roles'] {
  const result = roleFile.safeParse(document);
  if (!result.success || Object.keys(result.data.roles).length > 512) return null;
  return {
    defaultRole: result.data.defaultRole,
    entries: Object.entries(result.data.roles)
      .map(([key, row]) => ({
        key,
        name: row.name,
        priority: row.priority,
        parent: row.parent ?? null,
        permissions: row.permissions,
      }))
      .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key)),
  };
}
function zonesFromFile(document: unknown): Snapshot['zones'] {
  const result = zonesFile.safeParse(document);
  if (!result.success) return null;
  return result.data.zones.map((z) => ({
    name: z.name,
    world: z.world,
    description: z.shape === 'circle' && z.radius != null ? `${z.radius} m` : '',
    flags: Object.entries(z.flags ?? {}).map(([key, value]) => ({ key, value })),
  }));
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
function borders(reply: Reply): Snapshot['borders'] {
  if (!reply?.accepted) return null;
  const [title, ...lines] = reply.lines;
  const state = /^Travel rules: space is (open|closed)\.$/.exec(title ?? '')?.[1];
  if (!state) return null;
  const worlds = parseRows(lines, (l) => {
    const m = /^ {2}• ([^:]{1,128}): (.+)$/.exec(l);
    if (!m?.[1] || !m[2] || !label.safeParse(m[1]).success) return null;
    if (m[2] === 'open, no border' || m[2] === 'closed')
      return { world: m[1], description: m[2] === 'closed' ? 'closed' : 'open' };
    const geometry =
      /^a border of (\d+(?:\.\d+)?) (m|km) around lon (-?\d+(?:\.\d+)?), lat (-?\d+(?:\.\d+)?)$/.exec(
        m[2],
      );
    if (!geometry) return null;
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
    return { world: m[1], description: 'bounded', border: { radiusMeters, longitude, latitude } };
  });
  return worlds ? { spaceOpen: state === 'open', worlds } : null;
}
function bans(reply: Reply): Snapshot['bans'] {
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
): Promise<Snapshot> {
  const [roleDoc, zoneDoc] = await Promise.all([fileContents(readRoles), fileContents(readZones)]);
  const fromFile = rolesFromFile(roleDoc);
  const replies = await ruleReplies(native, [
    ...(!fromFile ? ['role list' as const] : []),
    'zone list',
    'difficulty',
    'border info',
    'banlist',
  ]);
  const level = difficulty(replies.get('difficulty'));
  const banRows = bans(replies.get('banlist'));
  // Show live zones; enrich them only when their persisted world and name match.
  const zoneKey = (zone: { world: string | null; name: string }) =>
    JSON.stringify([zone.world?.toLowerCase(), zone.name]);
  const knownZones = new Map(zonesFromFile(zoneDoc)?.map((z) => [zoneKey(z), z]));
  const liveZones = zones(replies.get('zone list'));
  return {
    difficulty: level,
    roles: fromFile ?? roles(replies.get('role list')),
    zones: liveZones?.map((z) => knownZones.get(zoneKey(z)) ?? z) ?? null,
    borders: borders(replies.get('border info')),
    bans: banRows,
    capabilities: {
      difficulty: verified.has(version) && level !== null,
      unban: verified.has(version) && banRows !== null,
    },
  };
}
export async function performOpenworldRule(
  native: OpenworldNativeConnection,
  version: string,
  input: OpenworldRuleAction,
  beforeDispatch: () => Promise<void>,
) {
  const parsed = openworldRuleActionSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('validation_failed');
  const action = parsed.data;
  if (!verified.has(version)) throw new DomainError('game_request_unsupported');
  const observe = action.kind === 'difficulty' ? 'difficulty' : 'banlist';
  const prior = (await ruleReplies(native, [observe])).get(observe);
  if (action.kind === 'unban') {
    const old = bans(prior);
    if (!old) throw new DomainError('integration_unavailable');
    if (!old.some((row) => row.uuid === action.uuid)) throw new DomainError('not_found');
  } else if (!difficulty(prior)) throw new DomainError('integration_unavailable');
  const command =
    action.kind === 'unban'
      ? (`unban ${action.uuid}` as const)
      : (`difficulty ${action.value}` as const);
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
    const observed = (await ruleReplies(native, [observe])).get(observe);
    if (action.kind === 'difficulty') {
      if (difficulty(observed) === action.value) return;
    } else {
      const rows = bans(observed);
      if (rows && !rows.some((row) => row.uuid === action.uuid)) return;
    }
    throw new DomainError('operation_uncertain');
  } catch (error) {
    if (!dispatched || (error instanceof DomainError && error.code === 'game_request_rejected'))
      throw error;
    throw new DomainError('operation_uncertain');
  }
}
