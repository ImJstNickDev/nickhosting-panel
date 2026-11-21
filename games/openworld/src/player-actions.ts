import { z } from 'zod';

const id = z.number().int().min(0).max(0xffffffff);
const name = z.string().min(1).max(256);
const world = z.string().min(1).max(128);
const target = z.strictObject({
  id,
  name,
  joinedAt: z.number().int().positive().max(8_640_000_000_000_000),
});
const destination = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('coordinates'),
    world,
    lon: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
    alt: z.number().nullish(),
  }),
  z.strictObject({ type: z.literal('player'), player: target }),
  z.strictObject({ type: z.literal('checkpoint'), id }),
]);
const action = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), text: z.string().trim().min(1).max(240) }),
  z.strictObject({ kind: z.literal('kick'), reason: z.string().trim().max(120).optional() }),
  z.strictObject({
    kind: z.literal('gamemode'),
    mode: z.enum(['survival', 'creative', 'spectator']),
  }),
  z.strictObject({ kind: z.literal('respawn') }),
  z.strictObject({ kind: z.literal('kill') }),
  z.strictObject({ kind: z.literal('screenshot') }),
  z.strictObject({ kind: z.literal('teleport'), destination }),
]);
export const openworldActionSchema = z.strictObject({
  requestId: z.uuid(),
  processRef: z.string().regex(/^[a-f0-9]{64}$/),
  player: target,
  action,
});
export type OpenworldActionPlayer = z.output<typeof target>;
export type OpenworldPlayerAction = z.output<typeof action>;
export type OpenworldActionRequest = z.output<typeof openworldActionSchema>;
export type OpenworldTeleportDestinations = {
  worlds: { key: string; name: string }[];
  checkpoints: { id: number; name: string; world: string }[];
};
