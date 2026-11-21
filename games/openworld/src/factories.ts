import { z } from 'zod';
import { type OpenworldNativeConnection, readNativeDiagnostic } from './native-diagnostics.js';
import { openworldMapWorldKey } from './world-map.js';

const metric = z.number().nonnegative().nullish();
const count = z.number().int().nonnegative().nullish();
const coordinate = z.number().min(0).max(0x7fffffff);
const columnIndex = coordinate.int().max(Math.floor((0x7fffffff - 8) / 16));
const column = z.object({
  world: openworldMapWorldKey.nullish().catch(null),
  face: z.number().int().min(0).max(5).nullish().catch(null),
  i: columnIndex.nullish().catch(null),
  j: columnIndex.nullish().catch(null),
  x: coordinate.nullish().catch(null),
  z: coordinate.nullish().catch(null),
  usPerS: metric,
  share: z.number().min(0).max(1).nullish(),
  nodes: count,
  nets: count,
});
const snapshot = z.object({
  enabled: z.boolean().nullish(),
  paused: z.boolean().nullish(),
  scope: z.enum(['loaded', 'world']).nullish().catch(null),
  hz: metric,
  targetHz: metric,
  steps: count,
  stepMs: z.object({ mean: metric, p95: metric, max: metric }).nullish(),
  counts: z.object({ nodes: count, nets: count, pieces: count }).nullish(),
  power: z
    .object({ producedW: metric, usedW: metric, storedJ: metric, capacityJ: metric })
    .nullish(),
  transit: z.object({ items: count, fluidVoxels: count }).nullish(),
  topColumns: z.array(column).max(256).nullish(),
});
export type OpenworldFactoriesSnapshot = z.infer<typeof snapshot>;
export type OpenworldFactoryColumn = z.infer<typeof column>;

export function readOpenworldFactories(
  native: OpenworldNativeConnection,
): Promise<OpenworldFactoriesSnapshot> {
  return readNativeDiagnostic(native, 'ovm', snapshot);
}
