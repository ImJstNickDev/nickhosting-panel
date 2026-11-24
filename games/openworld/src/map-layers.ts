import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { type OpenworldNativeConnection, readNativeDiagnostic } from './native-diagnostics.js';
import { openworldMapWorldKey } from './world-map.js';

const markerLimit = 256;
const label = z.string().min(1).max(256);
const coordinate = z.number().nonnegative().max(0x7fffffff);
const orbitalMetres = z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const vector = z.tuple([orbitalMetres, orbitalMetres, orbitalMetres]);
const species = z.object({
  id: z.uint32(),
  key: label,
  name: label,
  count: z.uint32(),
  hostile: z.boolean(),
});
const creatureMarker = z.object({
  species: z.uint32(),
  face: z.int().min(0).max(5),
  x: coordinate,
  z: coordinate,
});
const entities = z.object({
  total: z.uint32(),
  items: z.uint32(),
  bySpecies: z.array(species).max(1024),
  list: z.array(z.unknown()).max(markerLimit),
});

const body = z
  .object({
    index: z.uint32(),
    name: label,
    label: label.optional(),
    world: openworldMapWorldKey.nullish().transform((value) => value ?? null),
    parent: z.int().min(-1).max(0xffffffff),
    radiusMeters: z.number().positive().max(Number.MAX_SAFE_INTEGER),
    position: vector,
    atmosphere: z.boolean(),
    isLight: z.boolean(),
  })
  .transform(({ label, parent, ...entry }) => ({
    ...entry,
    name: label ?? entry.name,
    parent: parent === -1 ? null : parent,
  }));
const travelingPlayer = z
  .object({
    id: z.uint32(),
    name: label,
    world: openworldMapWorldKey.nullish().transform((value) => value ?? null),
    inSpace: z.literal(true),
    helio: vector,
  })
  .transform(({ id, name, world, helio }) => ({ id, name, world, position: helio }));
const orbitalCheckpoint = z
  .object({
    id: z.uint32(),
    name: label,
    world: openworldMapWorldKey,
    visibility: z.enum(['players', 'admins']),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    helio: vector,
  })
  .transform(({ helio, ...entry }) => ({ ...entry, position: helio }));
const space = z.object({
  t: z.number(),
  bodies: z.array(body).max(512),
  players: z.array(z.unknown()).max(8192),
  checkpoints: z.array(z.unknown()).max(8192),
});

export type OpenworldCreatureLayer = {
  world: string;
  total: number;
  items: number;
  species: z.output<typeof species>[];
  markers: z.output<typeof creatureMarker>[];
  markersTruncated: boolean;
};
export type OpenworldSpaceLayer = {
  t: number;
  bodies: z.output<typeof body>[];
  players: z.output<typeof travelingPlayer>[];
  checkpoints: z.output<typeof orbitalCheckpoint>[];
};

function validMarkers<S extends z.ZodType>(schema: S, rows: unknown[]): z.output<S>[] {
  const markers: z.output<S>[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) markers.push(parsed.data);
  }
  return markers;
}

export async function readOpenworldCreatures(
  native: OpenworldNativeConnection,
  world: string,
  markers = false,
): Promise<OpenworldCreatureLayer> {
  if (!openworldMapWorldKey.safeParse(world).success) throw new DomainError('validation_failed');
  const data = await readNativeDiagnostic(native, 'entities', entities, {
    world,
    limit: String(markers ? markerLimit : 1),
  });
  const positions = markers ? validMarkers(creatureMarker, data.list) : [];
  return {
    world,
    total: data.total,
    items: data.items,
    species: data.bySpecies,
    markers: positions,
    markersTruncated: markers && positions.length < data.total,
  };
}

export async function readOpenworldSpace(
  native: OpenworldNativeConnection,
): Promise<OpenworldSpaceLayer> {
  const data = await readNativeDiagnostic(native, 'space', space);
  return {
    t: data.t,
    bodies: data.bodies,
    players: validMarkers(travelingPlayer, data.players),
    checkpoints: validMarkers(orbitalCheckpoint, data.checkpoints),
  };
}
