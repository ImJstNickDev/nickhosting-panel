import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { OpenworldRulesSnapshot as Snapshot } from './rules.js';

const key = z.string().regex(/^[a-z0-9_-]{1,32}$/);
export const label = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const altitude = z.tuple([z.number(), z.number()]);
const roleFile = z.object({
  format: z.literal(2),
  defaultRole: key,
  roles: z.record(
    key,
    z.object({
      name: label,
      priority: z.int(),
      parent: key.nullish(),
      color: color.optional(),
      maxHomes: z.int().optional(),
      permissions: z.array(z.string().regex(/^[a-zA-Z0-9.*_!-]{1,128}$/)).max(1024),
    }),
  ),
});
const zonesFile = z.object({
  format: z.literal(1),
  zones: z
    .array(
      z.object({
        id: z.int().positive().optional(),
        name: label,
        world: key,
        centre: point.optional(),
        color: color.optional(),
        altitude: altitude.nullish(),
        description: z.string().max(1024).optional(),
        priority: z.int().optional(),
        members: z.array(z.string().max(256)).max(16384).optional(),
        shape: z.enum(['circle', 'polygon']),
        radius: z.number().nonnegative().optional(),
        points: z.array(point).max(2000).optional(),
        flags: z
          .record(z.string().regex(/^[a-z0-9_.-]{1,100}$/), z.enum(['allow', 'deny']))
          .optional(),
      }),
    )
    .max(4096),
});
export async function fileContents(read?: () => Promise<Uint8Array | undefined>) {
  try {
    const bytes = await read?.();
    if (!bytes || bytes.byteLength > 1024 * 1024) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (
      error instanceof DomainError &&
      [
        'unauthenticated',
        'forbidden',
        'provenance_mismatch',
        'conflict',
        'game_not_ready',
      ].includes(error.code)
    )
      throw error;
    return null;
  }
}
export function rolesFromFile(document: unknown): Snapshot['roles'] {
  const result = roleFile.safeParse(document);
  if (!result.success || Object.keys(result.data.roles).length > 512) return null;
  return {
    defaultRole: result.data.defaultRole,
    entries: Object.entries(result.data.roles)
      .map(([key, row]) => ({
        key,
        name: row.name,
        priority: row.priority,
        parent: row.parent ?? null,
        permissions: row.permissions,
        color: row.color,
        maxHomes: row.maxHomes ?? -1,
      }))
      .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key)),
  };
}
export function zonesFromFile(document: unknown): Snapshot['zones'] {
  const result = zonesFile.safeParse(document);
  if (!result.success) return null;
  return result.data.zones.map((z) => ({
    name: z.name,
    world: z.world,
    id: z.id,
    shape: z.shape,
    radius: z.radius,
    centre: z.centre,
    points: z.points,
    priority: z.priority,
    color: z.color,
    altitude: z.altitude ?? null,
    memberCount: z.members?.length,
    description: z.description ?? '',
    flags: Object.entries(z.flags ?? {}).map(([key, value]) => ({ key, value })),
  }));
}

const borderFile = z.object({
  format: z.literal(1),
  worlds: z.record(
    key,
    z.object({
      allowed: z.boolean(),
      border: z.object({ enabled: z.boolean(), centre: point, radius: z.number().nonnegative() }),
    }),
  ),
});
export function savedBorders(document: unknown) {
  return borderFile.safeParse(document).data?.worlds;
}
