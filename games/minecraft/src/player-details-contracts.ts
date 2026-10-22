import { z } from 'zod';

/** Browser-safe contracts. Saved files are observations, never live player state. */
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const name = z.string().regex(/^[A-Za-z0-9_]{3,16}$/);
export const minecraftKnownPlayerSchema = z.object({
  uuid,
  name: name.nullable(),
  sources: z.array(
    z.enum([
      'usercache',
      'operators',
      'whitelist',
      'banned',
      'playerdata',
      'stats',
      'advancements',
    ]),
  ),
});
export type MinecraftKnownPlayer = z.infer<typeof minecraftKnownPlayerSchema>;
export const minecraftPlayerItemSchema = z.object({
  slot: z.number().int(),
  id: z.string().max(256),
  count: z.number().int().nonnegative(),
  damage: z.number().int().nonnegative().nullable(),
  name: z.string().max(1024).nullable(),
  enchantments: z.array(z.object({ id: z.string().max(256), level: z.number().int() })).max(256),
  hasUnknownComponents: z.boolean(),
});
export const minecraftPlayerDetailActionNames = [
  'heal',
  'feed',
  'starve',
  'kill',
  'gamemode',
  'teleport',
  'reset',
] as const;
export const minecraftPlayerDetailActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['heal', 'feed', 'starve', 'kill']) }).strict(),
  z
    .object({
      action: z.literal('gamemode'),
      mode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
    })
    .strict(),
  z
    .object({
      action: z.literal('teleport'),
      x: z.number().finite().min(-29999984).max(29999984),
      y: z.number().finite().min(-2048).max(2048),
      z: z.number().finite().min(-29999984).max(29999984),
    })
    .strict(),
  z
    .object({
      action: z.literal('reset'),
      scopes: z
        .array(z.enum(['playerdata', 'stats', 'advancements']))
        .min(1)
        .max(3)
        .refine((value) => new Set(value).size === value.length),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      confirm: z.literal(true),
    })
    .strict(),
]);
export type MinecraftPlayerDetailAction = z.infer<typeof minecraftPlayerDetailActionSchema>;
export const minecraftPlayerDetailSchema = z.object({
  player: minecraftKnownPlayerSchema,
  world: z.string(),
  layout: z.enum(['legacy', 'modern', 'mixed', 'missing']),
  online: z.enum(['online', 'offline', 'unknown']),
  snapshot: z.object({
    source: z.literal('saved-files'),
    observedAt: z.iso.datetime({ offset: true }),
    savedAt: z.iso.datetime({ offset: true }).nullable(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    dataVersion: z.number().int().nullable(),
    state: z.enum(['available', 'missing', 'unsupported', 'unavailable']),
  }),
  inventory: z.array(minecraftPlayerItemSchema).max(256).nullable(),
  enderChest: z.array(minecraftPlayerItemSchema).max(256).nullable(),
  selectedSlot: z.number().int().nullable(),
  vitals: z
    .object({
      health: z.number().nullable(),
      maxHealth: z.number().nullable(),
      food: z.number().nullable(),
      saturation: z.number().nullable(),
      experienceLevel: z.number().nullable(),
      experienceProgress: z.number().nullable(),
      experienceTotal: z.number().nullable(),
      gameMode: z.number().nullable(),
    })
    .nullable(),
  position: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      dimension: z.union([z.string(), z.number()]).nullable(),
    })
    .nullable(),
  statistics: z
    .array(z.object({ category: z.string().max(256), id: z.string().max(256), value: z.number() }))
    .max(20000)
    .nullable(),
  capabilities: z.array(
    z.object({
      action: z.enum(minecraftPlayerDetailActionNames),
      available: z.boolean(),
      reason: z
        .enum([
          'permission',
          'offline',
          'online',
          'presence_unknown',
          'identity_unknown',
          'unsupported_version',
          'missing',
          'ambiguous_layout',
        ])
        .nullable(),
    }),
  ),
});
export type MinecraftPlayerDetail = z.infer<typeof minecraftPlayerDetailSchema>;
