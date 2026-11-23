import { z } from 'zod';
import { openworldReleaseSchema } from '../../../games/openworld/src/catalog-source.js';

export const openworldUpdateSelection = z
  .strictObject({
    version: openworldReleaseSchema.shape.version,
    expectedVersion: openworldReleaseSchema.shape.version,
    mode: z.enum(['timed', 'immediate', 'when-empty']),
    noticeSeconds: z.number().int().min(1).max(86400).optional(),
  })
  .refine((v) => v.mode === 'timed' || v.noticeSeconds === undefined);

export const openworldUpdatePlanSchema = z.strictObject({
  source: openworldReleaseSchema,
  target: openworldReleaseSchema,
  waitForEmpty: z.boolean(),
  delaySeconds: z.number().int().min(0).max(86400),
  backupBefore: z.boolean(),
});
export type OpenworldUpdatePlan = z.infer<typeof openworldUpdatePlanSchema>;
