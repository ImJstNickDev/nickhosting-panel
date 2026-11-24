import { z } from 'zod';
import { openworldMapWorldKey } from './world-map.js';

const count = z.int().min(0).max(0x7fffffff);
const terrain = z.strictObject({
  queued: count,
  pending: count,
  residentBytes: z
    .int()
    .min(0)
    .max(2 ** 40),
  residentMeshes: count,
  residentSurfaces: count,
  visibleMeshes: count,
  visibleSurfaces: count,
  middleWanted: count,
  middleReady: count,
  middlePresentColumns: count,
  behindWanted: count,
  behindReady: count,
  behindPresentColumns: count,
});
export type OpenworldMapDebugTerrain = z.infer<typeof terrain>;

const outcomes = z.strictObject({
  ok: count,
  empty: count,
  aborted: count,
  conflict: count,
  failed: count,
});
export type OpenworldMapDebugOutcomes = z.infer<typeof outcomes>;

const sample = z.strictObject({
  ms: count,
  mode: z.enum(['plan', 'iso', 'fly']),
  columnX: z.int(),
  columnZ: z.int(),
  spanMeters: z.int().nonnegative(),
  eyeHeightMeters: z.int().nullable(),
  yawDegrees: z.int().min(-180).max(180),
  pitchDegrees: z.int().min(-90).max(90).nullable(),
  turnDegrees: count,
  draws: count,
  terrain,
  terrainRequests: outcomes,
  meshRequests: outcomes,
});
export type OpenworldMapDebugSample = z.infer<typeof sample>;

export const openworldMapDebugBatch = z.strictObject({
  traceId: z.uuid(),
  batch: count,
  processRef: z.string().regex(/^[a-f0-9]{64}$/),
  world: openworldMapWorldKey,
  face: z.int().min(0).max(5),
  samples: z.array(sample).min(1).max(8),
});
