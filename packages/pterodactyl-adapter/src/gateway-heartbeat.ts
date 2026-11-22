import { z } from 'zod';
import {
  linkedSnapshotsSchema,
  nickHostingExtensionSchema,
  PROVIDER_SNAPSHOT_BATCH_SIZE,
  scopedProofs,
} from './blueprint.js';

const ids = z
  .array(z.uuid())
  .min(1)
  .max(PROVIDER_SNAPSHOT_BATCH_SIZE)
  .refine((values) => new Set(values).size === values.length);
export const gatewayHeartbeatRequest = z
  .strictObject({
    instanceId: z.uuid().optional(),
    health: ids.optional(),
    snapshots: ids.optional(),
    capabilities: z.literal(true).optional(),
  })
  .refine(
    (request) =>
      Boolean(request.health || request.capabilities) &&
      (!request.health || request.instanceId) &&
      (!request.snapshots || request.snapshots.every((id) => request.health?.includes(id))),
  );
export type GatewayHeartbeatRequest = z.infer<typeof gatewayHeartbeatRequest>;
const checkedAt = z.iso.datetime({ offset: true });
const capabilitySchema = z.strictObject({ checkedAt, extension: nickHostingExtensionSchema });

function value<T>(section: unknown, schema: z.ZodType<T>) {
  const parsed = z.strictObject({ value: schema }).safeParse(section);
  return parsed.success ? parsed.data.value : undefined;
}

/** Only requested, independently validated results can reach feed consumers. */
export function heartbeatSections(request: GatewayHeartbeatRequest, raw: unknown) {
  const sections = z.record(z.string(), z.unknown()).safeParse(raw);
  const data = sections.success ? sections.data : {};
  const instance = request.instanceId;
  const failure =
    request.snapshots &&
    z.strictObject({ error: z.number().int().min(400).max(599) }).safeParse(data.snapshots);
  return {
    ...(failure?.success ? { snapshotError: failure.data.error } : {}),
    health:
      request.health && instance
        ? value(
            data.health,
            z.strictObject({
              schemaVersion: z.literal(1),
              instanceId: z.literal(instance),
              checkedAt,
              scopes: scopedProofs(new Set(request.health)),
            }),
          )
        : undefined,
    snapshots:
      request.snapshots && instance
        ? value(data.snapshots, linkedSnapshotsSchema(instance, new Set(request.snapshots)))
        : undefined,
    capabilities: request.capabilities ? value(data.capabilities, capabilitySchema) : undefined,
  };
}
export type GatewayHeartbeatSections = ReturnType<typeof heartbeatSections>;
