import { z } from 'zod';
import { satisfactoryModReferenceSchema } from './mods.js';

export async function satisfactoryModVersions(reference: string, signal?: AbortSignal) {
  satisfactoryModReferenceSchema.parse(reference);
  const response = await fetch(`https://api.ficsit.app/v1/mod/${reference}/versions/all`, {
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw new Error('satisfactory_catalog_unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8388608) throw new Error('satisfactory_catalog_response_limit');
    chunks.push(chunk);
  }
  const result = z
    .object({
      success: z.literal(true),
      data: z.array(
        z.object({
          version: z.string(),
          game_version: z.string(),
          dependencies: z.array(
            z.object({ mod_id: z.string(), condition: z.string(), optional: z.boolean() }),
          ),
          targets: z.array(z.object({ target_name: z.string() })),
        }),
      ),
    })
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  return result.data
    .filter((item) => item.targets.some((target) => target.target_name === 'LinuxServer'))
    .map((item) => ({
      version: item.version,
      gameVersion: item.game_version,
      dependencies: item.dependencies,
    }));
}

const project = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  mod_reference: satisfactoryModReferenceSchema,
});
const responseSchema = z.object({
  data: z.object({
    mods: z.object({
      count: z.number().int().nonnegative(),
      mods: z.array(project).max(50),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});
export const satisfactoryModSearchSchema = z
  .string()
  .trim()
  .max(256)
  .refine((query) => query.length === 0 || query.length >= 3);

/** SMR's public GraphQL catalog; project presence is not server compatibility evidence.
 * Target/version/dependency compatibility is resolved by ficsit-cli at preparation time.
 */
export async function searchSatisfactoryMods(input: {
  query: string;
  offset?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}) {
  const query = satisfactoryModSearchSchema.parse(input.query);
  const offset = z
    .number()
    .int()
    .min(0)
    .max(100000)
    .parse(input.offset ?? 0);
  const response = await (input.fetch ?? fetch)('https://api.ficsit.app/v2/query', {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query:
        'query Mods($filter: ModFilter) { mods: getMods(filter: $filter) { count mods { id name mod_reference } } }',
      variables: {
        filter: {
          ...(query ? { search: query } : {}),
          offset,
          limit: 30,
          order: 'desc',
          order_by: 'last_version_date',
        },
      },
    }),
    signal: input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw new Error('satisfactory_catalog_unavailable');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 1048576) throw new Error('satisfactory_catalog_response_limit');
    chunks.push(chunk);
  }
  const parsed = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (parsed.errors?.length) throw new Error('satisfactory_catalog_unavailable');
  return {
    total: parsed.data.mods.count,
    offset,
    items: parsed.data.mods.mods.map((item) => ({
      id: item.id,
      name: item.name,
      reference: item.mod_reference,
    })),
  };
}
