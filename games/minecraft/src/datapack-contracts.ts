import { z } from 'zod';

export const minecraftDatapackNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (name) => !/[\\/\p{C}]/u.test(name) && name !== '.' && name !== '..' && !name.startsWith('.'),
  );
export const minecraftDatapackWorldSchema = minecraftDatapackNameSchema;
export const minecraftDatapackChangeSchema = z.strictObject({
  world: minecraftDatapackWorldSchema,
  action: z.enum(['install', 'enable', 'disable', 'delete']),
  path: z.string().max(512).optional(),
  sourceId: z.uuid().optional(),
  name: minecraftDatapackNameSchema.optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
export const minecraftDatapackApplySchema = z.strictObject({
  world: minecraftDatapackWorldSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
export type MinecraftDatapackChange = z.infer<typeof minecraftDatapackChangeSchema>;
export type { MinecraftDatapackMetadata } from './datapacks.js';

import type { MinecraftDatapackMetadata } from './datapacks.js';
export interface MinecraftDatapackSnapshot {
  world: string;
  selectedWorld: string | null;
  worlds: { name: string; selected: boolean }[];
  running: boolean;
  version: string;
  supported: boolean;
  installed: boolean;
  packs: {
    id: string;
    path: string;
    name: string;
    kind: 'zip' | 'directory';
    state: 'enabled' | 'disabled' | 'pending';
    /** Filesystem availability is not proof of Minecraft's loaded selection. */
    nativeState: 'enabled' | 'disabled' | 'unknown';
    metadata: MinecraftDatapackMetadata | null;
    compatibility: MinecraftDatapackMetadata['compatibility'];
  }[];
  changes: {
    id: string;
    action: MinecraftDatapackChange['action'];
    name: string;
    state: 'preparing' | 'ready' | 'failed' | 'uncertain';
    cancellable?: boolean;
    error?: string;
  }[];
  reload: { state: 'not_required' | 'required' | 'requested' | 'uncertain' };
}
