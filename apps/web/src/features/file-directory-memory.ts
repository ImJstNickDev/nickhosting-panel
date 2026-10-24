import { hashKey, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { ServerFile } from './service-contracts.js';

export const directoryMemoryLimits = { bytes: 8 * 1024 * 1024, directories: 192 } as const;

/** Only metadata lives here. Active listings remain usable even when one exceeds the cache budget. */
export class FileDirectoryMemory {
  private entries = new Map<string, { query: Query; data: unknown; bytes: number; used: number }>();
  private clock = 0;
  private invalidation = 0;
  private trimming = false;
  private unsubscribe: () => void;

  constructor(
    private client: QueryClient,
    private limits: { bytes: number; directories: number } = directoryMemoryLimits,
  ) {
    client.setQueryDefaults(['files'], { gcTime: 30 * 60 * 1000 });
    const cache = client.getQueryCache();
    for (const query of cache.getAll()) this.record(query);
    this.unsubscribe = cache.subscribe((event) => {
      if (event.query.queryKey[0] !== 'files') return;
      if (event.type === 'removed') this.entries.delete(event.query.queryHash);
      else {
        if (event.type === 'updated' && event.action.type === 'invalidate') this.invalidation++;
        this.record(event.query);
      }
      this.trim();
    });
  }

  dispose() {
    this.unsubscribe();
  }

  private record(query: Query) {
    if (query.queryKey[0] !== 'files' || query.state.data === undefined) return;
    const previous = this.entries.get(query.queryHash);
    this.entries.set(query.queryHash, {
      query,
      data: query.state.data,
      bytes:
        previous?.data === query.state.data
          ? previous.bytes
          : new TextEncoder().encode(JSON.stringify(query.state.data)).length,
      used: ++this.clock,
    });
  }

  private trim(extraBytes = 0, extraDirectories = 0) {
    if (this.trimming) return false;
    this.trimming = true;
    try {
      let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of [...this.entries.values()].sort((a, b) => a.used - b.used)) {
        if (
          bytes + extraBytes <= this.limits.bytes &&
          this.entries.size + extraDirectories <= this.limits.directories
        )
          return true;
        if (entry.query.getObserversCount() > 0 || entry.query.state.fetchStatus !== 'idle')
          continue;
        bytes -= entry.bytes;
        this.client.removeQueries({ queryKey: entry.query.queryKey, exact: true });
      }
      return (
        bytes + extraBytes <= this.limits.bytes &&
        this.entries.size + extraDirectories <= this.limits.directories
      );
    } finally {
      this.trimming = false;
    }
  }

  read(key: QueryKey) {
    const entry = this.entries.get(hashKey(key));
    if (entry) entry.used = ++this.clock;
    return this.client.getQueryData<ServerFile[]>(key);
  }

  capture(key: QueryKey) {
    return { state: this.client.getQueryState(key), invalidation: this.invalidation };
  }

  write(key: QueryKey, files: ServerFile[], before: ReturnType<FileDirectoryMemory['capture']>) {
    const current = this.client.getQueryState(key);
    // Never overwrite a foreground fetch, mutation invalidation or another completed listing.
    if (
      before.invalidation !== this.invalidation ||
      current !== before.state ||
      current?.fetchStatus === 'fetching' ||
      current?.data !== undefined
    )
      return false;
    const bytes = new TextEncoder().encode(JSON.stringify(files)).length;
    if (bytes > this.limits.bytes) return false;
    if (!this.trim(bytes, 1)) return false;
    this.client.setQueryData(key, files);
    return true;
  }
}

const clients = new WeakMap<QueryClient, FileDirectoryMemory>();
export function directoryMemory(client: QueryClient) {
  let memory = clients.get(client);
  if (!memory) {
    memory = new FileDirectoryMemory(client);
    clients.set(client, memory);
  }
  return memory;
}
