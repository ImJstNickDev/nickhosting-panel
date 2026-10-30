import { DomainError } from '@nickhosting/core';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';

type Prepared = NonNullable<Awaited<ReturnType<PterodactylAdapter['prepareUploadBatch']>>>;
type Upload = Prepared['uploads'][number];
type File = { id: string; path: string };
type Entry = { expiresAt: number; uploads: Map<string, { path: string; send: Upload }> } | null;

/** Private, disposable credentials. Durable file claims remain in PostgreSQL;
 * losing this bounded cache only requires issuing unused credentials again. */
export function createUploadUrlCache(now = Date.now, maxGroups = 32) {
  const groups = new Map<string, { pending: Promise<Entry>; value?: Entry }>();
  function current(key: string) {
    const group = groups.get(key);
    if (group?.value && group.value.expiresAt <= now() + 30_000) {
      groups.delete(key);
      return undefined;
    }
    return group;
  }
  async function warm(
    key: string,
    files: readonly File[],
    issue: (paths: string[]) => Promise<Prepared | null>,
    neededId?: string,
  ): Promise<Entry> {
    const existing = current(key);
    if (existing) {
      const value = await existing.pending;
      if (!neededId || value === null || value.uploads.has(neededId)) return value;
      if (groups.get(key) === existing) groups.delete(key);
      return warm(key, files, issue, neededId);
    }
    // An eviction never aborts an active transfer or releases a durable claim.
    while (groups.size >= maxGroups) {
      const first = groups.keys().next().value;
      if (first === undefined) break;
      groups.delete(first);
    }
    const group: { pending: Promise<Entry>; value?: Entry } = {
      pending: Promise.resolve().then(async () => {
        // Durable manifests are canonical '/path'; the adapter accepts relative paths.
        const result = await issue(files.map((file) => file.path.slice(1)));
        const value = result
          ? {
              expiresAt: result.expiresAt,
              uploads: new Map(
                files.map((file, index) => {
                  const send = result.uploads[index];
                  if (!send) throw new DomainError('integration_unavailable');
                  return [file.id, { path: file.path, send }];
                }),
              ),
            }
          : null;
        group.value = value;
        return value;
      }),
    };
    groups.set(key, group);
    try {
      return await group.pending;
    } catch (error) {
      if (groups.get(key) === group) groups.delete(key);
      throw error;
    }
  }
  return {
    warm,
    /** undefined is a cold/expired/missing entry; null selects the stock endpoint. */
    async take(key: string, file: File): Promise<Upload | null | undefined> {
      const group = current(key);
      if (!group) return undefined;
      const value = await group.pending;
      if (value === null) return null;
      const item = value.uploads.get(file.id);
      if (!item) return undefined;
      if (item.path !== file.path) throw new DomainError('conflict');
      // A rejected local admission must not consume an unused credential.
      // The adapter's handoff is itself single-use; durable admission fences replay.
      return (body) => {
        value.uploads.delete(file.id);
        return item.send(body);
      };
    },
    forget(key: string) {
      groups.delete(key);
    },
  };
}

export type UploadUrlCache = ReturnType<typeof createUploadUrlCache>;
