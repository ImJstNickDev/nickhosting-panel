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
export const openworldRuleActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('difficulty'), value: z.enum(openworldDifficulties) }),
  z.strictObject({ kind: z.literal('unban'), uuid: z.uuid() }),
]);
export type OpenworldRuleAction = z.infer<typeof openworldRuleActionSchema>;
export type OpenworldRulesSnapshot = {
  difficulty: OpenworldDifficulty | null;
  roles: {
    defaultRole: string;
    entries: {
      key: string;
      name: string;
      priority: number;
      parent: string | null;
      permissions: string[] | null;
    }[];
  } | null;
  zones:
    | {
        name: string;
        world: string | null;
        description: string;
        flags?: { key: string; value: 'allow' | 'deny' }[];
      }[]
    | null;
  borders: {
    spaceOpen: boolean;
    worlds: {
      world: string;
      description: string;
      border?: { radiusMeters: number; longitude: number; latitude: number };
    }[];
  } | null;
  bans: { uuid: string; name: string; reason: string | null }[] | null;
  capabilities: { difficulty: boolean; unban: boolean };
};

export function canUnbanOpenworldAccount(uuid: string) {
  return z.uuid().safeParse(uuid).success;
}
