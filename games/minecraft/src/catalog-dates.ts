import { minecraftReleaseCatalog } from './catalog.js';
import { createRuntimeMetadataClient, type RuntimeMetadataClient } from './runtime.js';

export interface MinecraftReleaseDate {
  releaseTime: string | null;
  releaseTimeStatus: 'available' | 'unknown' | 'unavailable';
}

/** Presentation metadata only: never changes a stored runtime, identity or evidence.
 * One official, bounded manifest read supplies all rows, including snapshots. Failures
 * leave the existing catalog readable and never substitute database insertion dates. */
export function createMinecraftReleaseDateLookup(
  options: { client?: (userAgent: string) => RuntimeMetadataClient; now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const client =
    options.client ??
    ((userAgent: string) => createRuntimeMetadataClient({ userAgent, timeoutMs: 3000 }));
  let cache:
    | {
        userAgent: string;
        expires: number;
        pending: Promise<ReadonlyMap<string, string | null> | null>;
      }
    | undefined;

  return async (userAgent: string) => {
    if (!cache || cache.userAgent !== userAgent || cache.expires <= now()) {
      const entry = {
        userAgent,
        expires: Number.POSITIVE_INFINITY,
        pending: Promise.resolve(null) as Promise<ReadonlyMap<string, string | null> | null>,
      };
      entry.pending = (async () => {
        try {
          const releases = await minecraftReleaseCatalog(client(userAgent), true);
          return new Map(releases.map((release) => [release.id, release.releaseTime ?? null]));
        } catch {
          return null;
        } finally {
          entry.expires = now() + 5 * 60 * 1000;
        }
      })();
      cache = entry;
    }
    const dates = await cache.pending;
    return (version: string): MinecraftReleaseDate => {
      const releaseTime = dates?.get(version) ?? null;
      return {
        releaseTime,
        releaseTimeStatus: dates === null ? 'unavailable' : releaseTime ? 'available' : 'unknown',
      };
    };
  };
}
