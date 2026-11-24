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
const countByType = z
  .record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/i), z.int().nonnegative())
  .refine((counts) => Object.keys(counts).length <= 256)
  .nullish();
const itemType = z.object({ name: z.string().min(1).max(256), count: z.int().nonnegative() });
const historySample = z.object({
  t: z.number().nonnegative().max(8_640_000_000_000_000),
  hz: metric,
  stepMs: metric,
  cpuMs: metric,
  nodes: count,
});
const snapshot = z.object({
  enabled: z.boolean().nullish(),
  paused: z.boolean().nullish(),
  scope: z.enum(['loaded', 'world']).nullish().catch(null),
  hz: metric,
  targetHz: metric,
  cappedHz: metric,
  speed: metric,
  cpuMs: metric,
  lateMsP95: metric,
  debtMs: metric,
  droppedPerSecond: metric,
  duty: metric,
  priority: z.int().nullish(),
  qos: z.string().max(64).nullish(),
  steps: count,
  simSeconds: metric,
  uptimeSeconds: metric,
  loadedColumns: count,
  stepMs: z.object({ mean: metric, p95: metric, max: metric }).nullish(),
  phasesMs: z
    .object({
      commands: metric,
      topology: metric,
      signals: metric,
      rotation: metric,
      electric: metric,
      fluids: metric,
      items: metric,
      radio: metric,
      events: metric,
    })
    .nullish(),
  counts: z
    .object({
      nodes: count,
      nets: count,
      pieces: count,
      frozen: count,
      tooLong: count,
      tripped: count,
      byDevice: countByType,
      byMedium: countByType,
    })
    .nullish(),
  memory: z
    .object({
      totalBytes: count,
      nodes: count,
      links: count,
      transit: count,
      systems: count,
      index: count,
      other: count,
      topology: count,
    })
    .nullish(),
  power: z
    .object({
      producedW: metric,
      usedW: metric,
      storedJ: metric,
      capacityJ: metric,
      systems: count,
    })
    .nullish(),
  transit: z
    .object({
      items: count,
      fluidVoxels: count,
      itemTypes: z.array(itemType).max(1024).nullish(),
    })
    .nullish(),
  rotation: z.object({ systems: count, jammed: count, deliveredW: metric }).nullish(),
  radio: z.object({ emitters: count, receivers: count, channels: count }).nullish(),
  pumps: z.object({ count, pumpedVoxels: count, pendingTerrainVoxels: count }).nullish(),
  history: z
    .preprocess(
      (value) => (Array.isArray(value) ? value.slice(-600) : value),
      z.array(historySample),
    )
    .nullish(),
  topColumns: z.array(column).max(256).nullish(),
});
export type OpenworldFactoriesSnapshot = z.infer<typeof snapshot>;
export type OpenworldFactoryColumn = z.infer<typeof column>;

export function readOpenworldFactories(
  native: OpenworldNativeConnection,
): Promise<OpenworldFactoriesSnapshot> {
  return readNativeDiagnostic(native, 'ovm', snapshot);
}
