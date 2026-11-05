import { api, queryClient } from '../../../api/client.js';
import { fileDirectoryQuery, serverPath } from '../../service-contracts.js';
import { readViewerBytes, viewerPath } from './access.js';
import type { ViewerSource } from './registry.js';

export const gamePrefixCacheLimits = {
  entries: 64,
  bytes: 4 * 1024 * 1024,
  ttlMs: 60_000,
} as const;
const namespace = ['viewer-game-prefix'] as const;
const identity = (serverId: string) => JSON.stringify(fileDirectoryQuery(serverId, '').queryKey[3]);
const unavailable = () =>
  Object.assign(new Error('viewer_unavailable'), { messageKey: 'viewer.unavailable' });

/** Abandon this consumer, never a concurrent consumer's shared authorized request. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function trim(currentKey: readonly unknown[]) {
  const queries = queryClient.getQueryCache().findAll({ queryKey: namespace });
  const current = JSON.stringify(currentKey);
  const pinned = queries.filter(
    (query) => query.state.fetchStatus === 'fetching' || JSON.stringify(query.queryKey) === current,
  );
  // Reserve the new reader before starting it, including its maximum pending
  // payload. Active readers cannot be evicted without cancelling other consumers.
  let count = pinned.length;
  let bytes = pinned.reduce((total, query) => total + Number(query.queryKey.at(-1)), 0);
  if (!pinned.some((query) => JSON.stringify(query.queryKey) === current)) {
    count++;
    bytes += Number(currentKey.at(-1));
  }
  if (count > gamePrefixCacheLimits.entries || bytes > gamePrefixCacheLimits.bytes)
    throw unavailable();
  for (const query of queries
    .filter((query) => !pinned.includes(query))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)) {
    const size = query.state.data instanceof Uint8Array ? query.state.data.byteLength : 0;
    if (
      count >= gamePrefixCacheLimits.entries ||
      bytes + size > gamePrefixCacheLimits.bytes ||
      Date.now() - query.state.dataUpdatedAt > gamePrefixCacheLimits.ttlMs
    ) {
      queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
    } else {
      bytes += size;
      count++;
    }
  }
}

/** Cache only a bounded metadata prefix, never full files. A fresh authorized stat
 * precedes every hit; If-Match binds new bytes to that existing source revision.
 * Returned bytes are shared between compiled trusted viewers and must not be mutated.
 * The backend revision is stat-based, not a full-content hash. */
export async function readGameViewerPrefix(options: {
  serverId: string;
  identity: string;
  source: ViewerSource;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<Uint8Array<ArrayBuffer>> {
  const { source, maxBytes, signal, serverId } = options;
  signal.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536)
    throw new TypeError('invalid_viewer_read_limit');
  const currentIdentity = identity(serverId);
  const check = () => {
    signal.throwIfAborted();
    if (currentIdentity !== identity(serverId)) throw unavailable();
  };
  const rootKey = [options.identity, currentIdentity, serverId, source.path];
  // This existing endpoint authorizes and stats the outer file, also when the
  // selected source is a nested member. Its revision pins the whole archive chain.
  const metadata = await waitFor(
    queryClient.fetchQuery({
      queryKey: ['viewer-game-source', ...rootKey],
      queryFn: ({ signal: sharedSignal }) =>
        api<{ revision: string; size: number; mtimeMs: number }>(
          `${serverPath(serverId)}/files/viewer?${new URLSearchParams({ path: source.path })}`,
          { signal: AbortSignal.any([sharedSignal, AbortSignal.timeout(15000)]) },
        ),
      staleTime: 0,
      gcTime: 0,
    }),
    signal,
  );
  check();
  if (
    typeof metadata.revision !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(metadata.revision) ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0
  )
    throw unavailable();
  // HTTP ranges have no satisfiable byte in an empty file. Only the freshly
  // authorized physical source stat can establish emptiness (not a listing).
  if (metadata.size === 0 && !source.entry && !source.archives?.length) return new Uint8Array(0);
  const key = [
    ...namespace,
    ...rootKey,
    source.archives ?? [],
    source.entry ?? '',
    metadata.revision,
    maxBytes,
  ];
  trim(key);
  const bytes = await waitFor(
    queryClient.fetchQuery({
      queryKey: key,
      queryFn: ({ signal: sharedSignal }) =>
        readViewerBytes(
          viewerPath(serverId, source),
          maxBytes,
          AbortSignal.any([sharedSignal, AbortSignal.timeout(15000)]),
          maxBytes,
          { 'If-Match': `"${metadata.revision}"` },
        ),
      staleTime: gamePrefixCacheLimits.ttlMs,
      gcTime: gamePrefixCacheLimits.ttlMs,
    }),
    signal,
  );
  check();
  trim(key);
  return bytes;
}
