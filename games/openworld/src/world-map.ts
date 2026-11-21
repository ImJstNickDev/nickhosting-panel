import { z } from 'zod';

const utf8 = new TextEncoder();
function nativeText(maxBytes: number) {
  return z
    .string()
    .trim()
    .max(maxBytes)
    .refine((value) => utf8.encode(value).length <= maxBytes);
}

const id = z.number().int().nonnegative().max(0xffffffff);
const face = z.number().int().min(0).max(5);
const metre = z.number().min(-0x7fffffff).max(0x7fffffff);
const coordinate = metre.nonnegative();
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const icon = z.enum(['flag', 'star', 'home', 'skull', 'gem', 'pin']);
const visibility = z.enum(['admins', 'players']);

export const openworldMapWorldKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

const fields = z.strictObject({
  name: nativeText(64).refine((value) => value.length > 0),
  note: nativeText(500),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  icon,
  visibility,
});

const position = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('geo'), lat, lon, alt: metre.nullable() }),
  z.strictObject({
    type: z.literal('face'),
    face,
    x: coordinate,
    z: coordinate,
    y: metre.nullable(),
  }),
]);

export const openworldCheckpointActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), fields, position }),
  z.strictObject({
    kind: z.literal('update'),
    id,
    revision,
    fields,
    position: position.optional(),
  }),
  z.strictObject({ kind: z.literal('delete'), id, revision }),
]);

export const openworldCheckpointSchema = z.object({
  id,
  world: openworldMapWorldKey,
  name: z.string().min(1).max(64),
  note: z.string().max(500),
  color: fields.shape.color,
  icon,
  visibility,
  createdAtMs: z.number().int().nonnegative().max(8_640_000_000_000_000),
  pos: z.object({ face, x: coordinate, y: metre, z: coordinate }),
  geo: z.object({ lat, lon, alt: metre }),
});

export type OpenworldMapWorld = { key: string; name: string; faceEdgeMeters: number | null };
export type OpenworldCheckpoint = z.output<typeof openworldCheckpointSchema>;
export type OpenworldCheckpointAction = z.output<typeof openworldCheckpointActionSchema>;
