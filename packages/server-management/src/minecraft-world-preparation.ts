import { createHash } from 'node:crypto';
import { minecraftWorldName } from '@nickhosting/minecraft';
import type { PrivateTransferCache } from '@nickhosting/pterodactyl-adapter';
import { z } from 'zod';
import { directoryServerIdentity } from './directory-identity.js';

const ttlMs = 15 * 60_000;
const maxBytes = 1024 ** 2;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const world = z
  .object({
    name: z.string().refine((value) => {
      try {
        return minecraftWorldName(value) === value;
      } catch {
        return false;
      }
    }),
    dataVersion: z.number().int().positive().safe(),
    sha256: hash,
  })
  .strict();
const properties = z
  .object({
    content: z.string().refine((value) => Buffer.byteLength(value) <= maxBytes),
    hash,
  })
  .strict()
  .refine((value) => digest(value.content) === value.hash);
const prepared = z
  .object({
    observedAt: z.number().int().nonnegative().safe(),
    worlds: z
      .array(world)
      .max(100)
      .refine((values) => new Set(values.map((value) => value.name)).size === values.length),
    properties,
  })
  .strict();

export type MinecraftWorldPreparation = z.infer<typeof prepared>;
type Server = Parameters<typeof directoryServerIdentity>[0];
type Snapshot = {
  worlds: readonly {
    name: string;
    status: string;
    validation?: { dataVersion?: number; sha256: string };
  }[];
  properties: { content: string; hash: string };
};

/** Private, optional preparation only. Existing encrypted cache transport owns
 * storage; neither a browser payload nor an authorization grant is accepted here. */
export function createMinecraftWorldPreparation(
  cache: PrivateTransferCache,
  providerBinding: string,
) {
  const key = (server: Server, combinationId: string) =>
    `minecraft.world-preparation.v1:${digest(
      JSON.stringify([
        providerBinding,
        directoryServerIdentity(server),
        server.mapping_id,
        combinationId,
      ]),
    )}`;
  const validAge = (observedAt: number) => {
    const age = Date.now() - observedAt;
    return age >= 0 && age < ttlMs;
  };
  const write = async (storageKey: string, value: MinecraftWorldPreparation) => {
    const encoded = JSON.stringify(prepared.parse(value));
    if (Buffer.byteLength(encoded) > maxBytes || !validAge(value.observedAt)) return;
    await cache.put(storageKey, encoded, ttlMs - (Date.now() - value.observedAt));
  };
  async function read(
    server: Server,
    combinationId: string,
  ): Promise<MinecraftWorldPreparation | undefined> {
    try {
      const value = await cache.get(key(server, combinationId));
      if (!value || Buffer.byteLength(value) > maxBytes) return;
      const result = prepared.safeParse(JSON.parse(value));
      if (result.success && validAge(result.data.observedAt)) return result.data;
    } catch {
      // Cold, unavailable and corrupt preparation all use the regular read path.
    }
  }
  return {
    read,
    async invalidate(server: Server, combinationId: string): Promise<void> {
      try {
        await cache.delete(key(server, combinationId));
      } catch {
        // Cache availability never changes the result of the fresh inspection.
      }
    },
    async save(server: Server, combinationId: string, snapshot: Snapshot): Promise<void> {
      try {
        const worlds = snapshot.worlds
          .flatMap((value) => {
            if (value.status !== 'verified' || !value.validation) return [];
            const result = world.safeParse({
              name: value.name,
              dataVersion: value.validation.dataVersion,
              sha256: value.validation.sha256,
            });
            return result.success ? [result.data] : [];
          })
          .slice(0, 100);
        await write(key(server, combinationId), {
          observedAt: Date.now(),
          worlds,
          properties: snapshot.properties,
        });
      } catch {
        // Preparation never prevents listing worlds or queues a provider request.
      }
    },
    async updateProperties(
      server: Server,
      combinationId: string,
      beforeHash: string | null,
      content: string,
    ): Promise<void> {
      try {
        const current = await read(server, combinationId);
        if (!current) return;
        const afterHash = digest(content);
        if (current.properties.hash !== beforeHash && current.properties.hash !== afterHash) return;
        await write(key(server, combinationId), {
          ...current,
          properties: { content, hash: afterHash },
        });
      } catch {
        // A failed cache update cannot change the acknowledged file write.
      }
    },
  };
}
