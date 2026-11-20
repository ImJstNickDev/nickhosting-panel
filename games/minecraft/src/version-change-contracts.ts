import { z } from 'zod';

export const minecraftVersionChoiceSchema = z.object({
  id: z.string().min(1).max(256),
  runtime: z.enum(['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'quilt', 'forge', 'neoforge']),
  version: z.string().min(1).max(128),
});
const loader = z.string().min(1).max(128);
const loaders = z.array(loader);
export const minecraftVersionCatalogSchema = z.object({
  current: z.object({
    combinationId: z.uuid(),
    version: minecraftVersionChoiceSchema.shape.version,
    runtime: minecraftVersionChoiceSchema.shape.runtime,
    loaderVersion: loader.nullable(),
  }),
  choices: z.array(minecraftVersionChoiceSchema),
  loaders: z.object({
    fabric: loaders,
    quilt: loaders,
    forge: z.record(z.string(), loaders),
    neoforge: z.record(z.string(), loaders),
  }),
});
export const minecraftVersionChangeRequestSchema = z
  .strictObject({
    sourceCombinationId: z.uuid(),
    choiceId: minecraftVersionChoiceSchema.shape.id,
    loaderVersion: loader.optional(),
    mode: z.enum(['fresh', 'keep']),
    confirm: z.literal(true),
    backupBefore: z.boolean().default(false),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  })
  .refine((request) => request.mode === 'keep' || !request.backupBefore);
export const minecraftVersionChangeAcceptedSchema = z.object({ jobId: z.uuid() });
export type MinecraftVersionChangeRequest = z.infer<typeof minecraftVersionChangeRequestSchema>;
