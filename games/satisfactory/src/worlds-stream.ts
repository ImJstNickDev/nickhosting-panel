import { z } from 'zod';
import { satisfactorySaveHeaderSchema } from './api-schemas.js';

export {
  satisfactoryEnumerationMaxBytes,
  satisfactoryResponseMaxBytes as satisfactoryReadMaxBytes,
} from './response-limits.js';

const source = z.enum(['cache', 'live']);
export const satisfactoryWorldsStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state'),
    phase: z.enum(['offline', 'starting', 'refreshing', 'ready', 'unavailable']),
    configured: z.boolean(),
    hasSnapshot: z.boolean(),
  }),
  z.object({ type: z.literal('begin'), source, observedAt: z.number().finite() }),
  z.object({
    type: z.literal('session'),
    source,
    index: z.number().int().min(0).max(1023),
    sessionName: z.string().max(4096),
  }),
  z.object({
    type: z.literal('save'),
    source,
    sessionIndex: z.number().int().min(0).max(1023),
    save: satisfactorySaveHeaderSchema,
    safety: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('classification'),
    source,
    saveNames: z.array(z.string().max(4096)).max(32768),
  }),
  z.object({
    type: z.literal('complete'),
    source,
    currentSessionIndex: z.number().int().min(-1),
    observedAt: z.number().finite(),
  }),
  z.object({ type: z.literal('error'), code: z.literal('integration_unavailable') }),
]);
export type SatisfactoryWorldsStreamEvent = z.infer<typeof satisfactoryWorldsStreamEventSchema>;
