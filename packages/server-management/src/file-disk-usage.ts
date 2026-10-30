import type { ConsoleEvent, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';

/** Observations only, never reservations or authority. Wings remains responsible
 * for its quota enforcement; missing/stale samples fall back to its resource API. */
export function createFileDiskUsageCache(now: () => number = () => performance.now()) {
  const samples = new Map<string, { identifier: string; bytes: number; observedAt: number }>();
  const writing = new Map<string, number>();
  function invalidate(identifier: string) {
    for (const [key, sample] of samples) {
      if (sample.identifier === identifier) samples.delete(key);
    }
  }
  return {
    read(scope: string) {
      const sample = samples.get(scope);
      if (!sample) return undefined;
      if (now() - sample.observedAt >= 30_000 || writing.has(sample.identifier)) {
        samples.delete(scope);
        return undefined;
      }
      return sample.bytes;
    },
    observe(identifier: string, scope: string) {
      let status: Extract<ConsoleEvent, { type: 'status' }>['data'] | undefined;
      return (event: ConsoleEvent) => {
        if (event.type === 'status') {
          status = event.data;
          if (status === 'offline') samples.delete(scope);
        } else if (event.type === 'closed' || event.type === 'error') {
          // Retain the last valid observation until its original deadline, but
          // don't accept further data on a closed or failed relay.
          status = undefined;
        } else if (event.type === 'stats' && status && status !== 'offline') {
          const bytes = event.data.disk_bytes;
          if (!Number.isSafeInteger(bytes) || bytes < 0 || writing.has(identifier)) return;
          samples.delete(scope);
          if (samples.size >= 1024) samples.delete(samples.keys().next().value as string);
          samples.set(scope, { identifier, bytes, observedAt: now() });
        }
      };
    },
    async mutate<T>(identifier: string, work: () => Promise<T>): Promise<T> {
      writing.set(identifier, (writing.get(identifier) ?? 0) + 1);
      invalidate(identifier);
      try {
        return await work();
      } finally {
        // Includes rejected/uncertain effects. A sample received while a write
        // was in flight cannot establish post-write occupancy.
        invalidate(identifier);
        const remaining = (writing.get(identifier) ?? 1) - 1;
        if (remaining) writing.set(identifier, remaining);
        else writing.delete(identifier);
      }
    },
  };
}

/** Invalidate at the actual effect boundary, including prepared upload handles.
 * This wrapper also covers injected adapters used by integration tests. */
export function trackFileDiskMutations(
  adapter: PterodactylAdapter,
  cache: ReturnType<typeof createFileDiskUsageCache>,
): PterodactylAdapter {
  const methods: Partial<Record<keyof PterodactylAdapter, number>> = {
    writeFile: 0,
    deleteFiles: 0,
    guardedDeleteDirectory: 0,
    commitFileArchive: 0,
    extractArchive: 0,
    createDirectory: 0,
    renameFiles: 0,
    uploadFile: 0,
    restoreBackup: 0,
    reinstall: 0,
    reinstallWithConfirmation: 1,
  };
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === 'prepareUpload')
        return async (...args: Parameters<PterodactylAdapter['prepareUpload']>) => {
          const send = await target.prepareUpload(...args);
          return (input: Parameters<typeof send>[0]) => cache.mutate(args[0], () => send(input));
        };
      if (property === 'prepareUploadBatch')
        return async (...args: Parameters<PterodactylAdapter['prepareUploadBatch']>) => {
          const batch = await target.prepareUploadBatch(...args);
          return (
            batch && {
              ...batch,
              uploads: batch.uploads.map(
                (send) => (input: Parameters<typeof send>[0]) =>
                  cache.mutate(args[0], () => send(input)),
              ),
            }
          );
        };
      const index = methods[property as keyof PterodactylAdapter];
      if (index !== undefined)
        return (...args: unknown[]) =>
          cache.mutate(args[index] as string, async () =>
            Reflect.apply(Reflect.get(target, property), target, args),
          );
      return Reflect.get(target, property, receiver);
    },
  });
}
