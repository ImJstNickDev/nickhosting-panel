import { z } from 'zod';
import { pluginProviderSchema } from '../../../packages/content-providers/src/mod-catalog.js';
import { minecraftModInstalledChangeSchema, minecraftModSelectionSchema } from './mod-contracts.js';

const catalogId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^/\\\p{C}]+$/u);
export const minecraftPluginSelectionSchema = minecraftModSelectionSchema.extend({
  roots: z
    .array(
      minecraftModSelectionSchema.shape.roots.element.extend({
        provider: pluginProviderSchema,
        projectId: catalogId,
        versionId: catalogId.optional(),
        optionalProjectIds: z.array(catalogId).max(512).default([]),
      }),
    )
    .max(512),
});
export const minecraftPluginInstalledChangeSchema = minecraftModInstalledChangeSchema.extend({
  path: z.string().regex(/^plugins\/[^/\\\p{C}]+\.jar(?:\.disabled)?$/u),
});
export const minecraftPluginToggleSchema = minecraftPluginInstalledChangeSchema
  .extend({ action: z.enum(['enable', 'disable']) })
  .refine((value) => value.path.endsWith('.disabled') === (value.action === 'enable'), {
    path: ['path'],
    message: 'The plugin state must match the requested action',
  });
export const minecraftPluginToggleResultSchema = z.object({
  state: z.enum(['published', 'dispatched', 'uncertain']),
  path: minecraftPluginInstalledChangeSchema.shape.path,
  restartRequired: z.boolean(),
});
