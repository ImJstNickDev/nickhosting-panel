import { z } from 'zod';

export const openworldDifficulties = [
  'easy',
  'medium',
  'normal',
  'hard',
  'very_hard',
  'terrible',
] as const;
export type OpenworldDifficulty = (typeof openworldDifficulties)[number];
export const openworldRuleFlags = [
  'build',
  'explosions',
  'pvp',
  'pve',
  'mobs',
  'chests',
  'damage',
  'entry',
] as const;
export const openworldGlobalRuleFlags = [
  'build',
  'explosions',
  'pvp',
  'pve',
  'mobs',
  'chests',
  'damage',
] as const;
export type OpenworldRuleFlag = (typeof openworldRuleFlags)[number];
export type OpenworldRuleValue = 'allow' | 'deny' | 'default';
export type OpenworldFlags = Partial<Record<OpenworldRuleFlag, 'allow' | 'deny'>>;
export const openworldRoleKey = z.string().regex(/^[a-z0-9_-]{1,32}$/);
export const openworldZoneName = z.string().regex(/^[\p{L}\p{N}_-]{1,64}$/u);
const flag = z.enum(openworldRuleFlags);
const value = z.enum(['allow', 'deny', 'default']);
const zoneId = z.int().positive();
const role = openworldRoleKey;
const world = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const longitude = z.number().min(-180).max(180);
const latitude = z.number().min(-90).max(90);
const radius = z.number().positive().max(2147483647);
const text = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{M}\p{N} .,!?\x27’():_-]+$/u)
  .refine((s) => s === s.trim() && new TextEncoder().encode(s).length <= 200);
const permission = z
  .string()
  .max(128)
  .regex(/^-?(?:\*|[a-z0-9_]+(?:\.[a-z0-9_]+)*(?:\.\*)?)$/);
export const openworldRuleActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('difficulty'), value: z.enum(openworldDifficulties) }),
  z.strictObject({ kind: z.literal('unban'), uuid: z.uuid() }),
  z.strictObject({ kind: z.literal('spawning'), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('globalFlag'), flag: z.enum(openworldGlobalRuleFlags), value }),
  z.strictObject({ kind: z.literal('zoneFlag'), zoneId, flag, value }),
  z.strictObject({ kind: z.literal('zonePreset'), zoneId, value: z.enum(['safe', 'war']) }),
  z.strictObject({ kind: z.literal('zoneRadius'), zoneId, value: radius.min(1).max(100000) }),
  z.strictObject({ kind: z.literal('zonePriority'), zoneId, value: z.int().min(-1000).max(1000) }),
  z.strictObject({ kind: z.literal('zoneColor'), zoneId, value: color }),
  z.strictObject({
    kind: z.literal('zoneDescription'),
    zoneId,
    value: z.union([text, z.literal('')]),
  }),
  z.strictObject({ kind: z.literal('zoneRename'), zoneId, value: openworldZoneName }),
  z.strictObject({
    kind: z.literal('zoneAltitude'),
    zoneId,
    value: z
      .tuple([z.number(), z.number()])
      .refine(([min, max]) => min <= max)
      .nullable(),
  }),
  z.strictObject({ kind: z.literal('zoneDelete'), zoneId }),
  z.strictObject({ kind: z.literal('spaceTravel'), allowed: z.boolean() }),
  z.strictObject({ kind: z.literal('worldTravel'), world, allowed: z.boolean() }),
  z.strictObject({ kind: z.literal('borderRadius'), world, value: radius.min(16) }),
  z.strictObject({ kind: z.literal('borderCenter'), world, longitude, latitude }),
  z.strictObject({ kind: z.literal('borderEnabled'), world, enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('roleCreate'), role, parent: role.optional() }),
  z.strictObject({ kind: z.literal('roleDelete'), role }),
  z.strictObject({ kind: z.literal('roleDefault'), role }),
  z.strictObject({ kind: z.literal('roleParent'), role, value: role.nullable() }),
  z.strictObject({ kind: z.literal('roleName'), role, value: text.max(64) }),
  z.strictObject({ kind: z.literal('roleColor'), role, value: color }),
  z.strictObject({ kind: z.literal('rolePriority'), role, value: z.int().min(0).max(99) }),
  z.strictObject({ kind: z.literal('roleHomes'), role, value: z.int().min(-1).max(1000) }),
  z.strictObject({ kind: z.literal('rolePermission'), role, permission, add: z.boolean() }),
]);
export type OpenworldRuleAction = z.infer<typeof openworldRuleActionSchema>;
export function openworldRuleGrant(action: OpenworldRuleAction) {
  if (action.kind.startsWith('role')) return 'roles.manage';
  if (action.kind === 'difficulty') return 'rules.manage';
  return action.kind === 'unban' ? 'bans.manage' : 'territory.manage';
}
export type OpenworldRuleRole = {
  key: string;
  name: string;
  priority: number;
  parent: string | null;
  permissions: string[] | null;
  color?: string;
  maxHomes?: number;
};
export type OpenworldRuleZone = {
  name: string;
  world: string | null;
  description: string;
  flags?: { key: string; value: 'allow' | 'deny' }[];
  id?: number;
  shape?: 'circle' | 'polygon';
  radius?: number;
  centre?: [number, number];
  points?: [number, number][];
  priority?: number;
  color?: string;
  altitude?: [number, number] | null;
  memberCount?: number;
};
export type OpenworldRuleWorld = {
  world: string;
  description: string;
  border?: { radiusMeters: number; longitude: number; latitude: number; enabled?: boolean };
};
export type OpenworldRulesSnapshot = {
  difficulty: OpenworldDifficulty | null;
  naturalSpawning?: boolean | null;
  globalFlags?: OpenworldFlags | null;
  permissionNodes?: string[] | null;
  roles: { defaultRole: string; entries: OpenworldRuleRole[] } | null;
  zones: OpenworldRuleZone[] | null;
  borders: { spaceOpen: boolean; worlds: OpenworldRuleWorld[] } | null;
  bans: { uuid: string; name: string; reason: string | null }[] | null;
  capabilities: {
    difficulty: boolean;
    unban: boolean;
    globals?: boolean;
    zones?: boolean;
    borders?: boolean;
    roles?: boolean;
    spawning?: boolean;
  };
};
export function canUnbanOpenworldAccount(uuid: string) {
  return z.uuid().safeParse(uuid).success;
}
