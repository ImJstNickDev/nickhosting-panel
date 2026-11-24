import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { readNativeBytes } from './native-response.js';

const label = z.string().min(1).max(256);
const entry = z.object({
  key: label,
  name: label.optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional()
    .catch(undefined),
});
const entries = z.array(entry).max(8192);
const schema = z.object({
  seed: z.string().min(1).max(1024),
  seedText: z.string().max(1024).optional(),
  planet: label,
  planets: entries,
  version: z.uint32(),
  faceEdgeMeters: z.number().positive(),
  planetRadiusMeters: z.number().positive(),
  voxelSize: z.number().positive(),
  spawn: z.object({ face: z.int().min(0).max(5), x: z.number(), z: z.number() }),
  biomes: entries,
  materials: entries,
  featureKinds: entries,
  treeSpecies: entries,
});
export type OpenworldSeed = z.output<typeof schema>;
export type OpenworldSeedView = OpenworldSeed & {
  inspectorUrl: string | null;
  inspectorPublished: boolean;
};

export async function readOpenworldSeed(
  origin: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<OpenworldSeed> {
  try {
    // Use the current world's catalog. Initializing another planet can take seconds.
    const response = await fetcher(new URL('/api/info', origin), {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new DomainError('game_request_unsupported');
      if (response.status === 503) throw new DomainError('game_not_ready');
      throw new DomainError('integration_unavailable');
    }
    return schema.parse(
      JSON.parse(new TextDecoder().decode(await readNativeBytes(response, 2 * 1024 * 1024))),
    );
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('integration_unavailable');
  }
}

const inspectorAssets = new Set([
  '/inspector',
  '/inspector/',
  '/inspector/index.html',
  '/inspector/style.css',
  '/inspector/vendor/three.module.js',
  '/fonts/Nunito-Bold.ttf',
  '/fonts/Nunito-ExtraBold.ttf',
  '/fonts/IBMPlexMono-Regular.ttf',
]);
const generation = new Set([
  '/api/info',
  '/api/doc',
  '/api/tile',
  '/api/slice',
  '/api/chunk-mesh',
  '/api/column',
  '/api/features',
  '/api/feature-model',
  '/api/climate',
  '/api/trees',
  '/api/tree-model',
]);

/** The native inspector also probes the administrative API. Only generation and
 * the inspector's own static dependencies belong to a seed reader. */
export function isOpenworldSeedPath(path: string, method: string) {
  return (
    (method === 'GET' || method === 'HEAD') &&
    (inspectorAssets.has(path) ||
      generation.has(path) ||
      /^\/inspector\/js\/[a-z0-9_-]+\.js$/.test(path) ||
      /^\/pack\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.png$/.test(path))
  );
}
