import { z } from 'zod';

// No service imports: source acquisition and browsing share these wire contracts
// without introducing a source-store/catalog-runtime initialization cycle.
const offset = z.coerce.number().int().min(0).max(9980).default(0);
export const minecraftWorldProjectId = z.string().regex(/^[1-9]\d{0,14}$/);
export const minecraftWorldSearchSchema = z.strictObject({
  provider: z.literal('curseforge'),
  query: z.string().trim().max(256).default(''),
  offset,
  gameVersion: z.string().trim().min(1).max(80).optional(),
});
export const minecraftWorldFilesSchema = z.strictObject({ offset });
