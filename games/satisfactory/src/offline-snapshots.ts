import { z } from 'zod';
import { satisfactoryGameStateSchema, satisfactorySessionsSchema } from './api.js';
import { satisfactoryHttpsCacheSchema } from './https-cache.js';

const dictionaries = z.record(z.string().max(256), z.string().max(4096));
const bodies = {
  QueryServerState: z.object({ serverGameState: satisfactoryGameStateSchema }),
  GetServerOptions: z.object({ serverOptions: dictionaries, pendingServerOptions: dictionaries }),
  GetAdvancedGameSettings: z.object({
    creativeModeEnabled: z.boolean(),
    advancedGameSettings: dictionaries,
  }),
  EnumerateSessions: satisfactorySessionsSchema,
};
const observation = z.strictObject({
  observedAt: z.number().finite(),
  body: z.record(z.string(), z.unknown()),
});
const observations = z.record(z.string(), observation);
export type OfflineSnapshots = z.infer<typeof observations>;
/** Strip unknown fields and accept only declared native read schemas.
 * These observations carry no authentication authority, even when retained. */
export function readOfflineSnapshots(input: unknown): OfflineSnapshots {
  const result: OfflineSnapshots = {};
  const parsed = observations.safeParse(input);
  if (!parsed.success) return result;
  for (const [operation, entry] of Object.entries(parsed.data)) {
    if (!Object.hasOwn(bodies, operation)) continue;
    try {
      if (Buffer.byteLength(JSON.stringify(entry.body)) > 64 * 1024) continue;
    } catch {
      continue;
    }
    const schema = bodies[operation as keyof typeof bodies];
    const envelope = z
      .object({ data: schema, errorCode: z.never().optional() })
      .safeParse(entry.body);
    if (envelope.success)
      result[operation] = { observedAt: entry.observedAt, body: { data: envelope.data.data } };
  }
  return result;
}
export function mergeOfflineSnapshots(previous: unknown, cache: unknown): OfflineSnapshots {
  const result = readOfflineSnapshots(previous);
  const parsed = satisfactoryHttpsCacheSchema.safeParse(cache);
  if (!parsed.success) return result;
  for (const entry of parsed.data) {
    for (const [operation, serialized] of Object.entries(entry.responses)) {
      try {
        const observedAt = entry.observedAt?.[operation] ?? entry.expiresAt - 5 * 60_000;
        if (observedAt > Date.now() + 5000 || observedAt < 0) continue;
        const candidate = readOfflineSnapshots({
          [operation]: { observedAt, body: JSON.parse(serialized) },
        })[operation];
        if (candidate && (result[operation]?.observedAt ?? 0) <= observedAt)
          result[operation] = candidate;
      } catch {
        /* Malformed observations never become offline responses. */
      }
    }
  }
  return result;
}
