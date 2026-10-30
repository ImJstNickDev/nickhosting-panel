import { queryClient } from '../../../api/client.js';
import { fileDirectoryQuery } from '../../service-contracts.js';
import { readViewerBytes, viewerPath } from './access.js';
import { archiveQuery } from './archive-query.js';
import type { ViewerSource } from './registry.js';

export type DocumentResource =
  | { kind: 'local'; source: ViewerSource; fragment?: string; label?: string }
  | { kind: 'anchor'; fragment: string; label?: string }
  | { kind: 'external'; url: string; label?: string };
export interface DocumentResolveOptions {
  from?: ViewerSource;
  wiki?: boolean;
  signal?: AbortSignal;
}
export interface DocumentResources {
  readonly source: ViewerSource;
  resolve(reference: string, options?: DocumentResolveOptions): Promise<DocumentResource>;
  url(resource: DocumentResource): string;
  readText(resource: DocumentResource, signal?: AbortSignal): Promise<string>;
  open(resource: DocumentResource): void;
  dispose(): void;
}
export const documentResourceLimits = {
  textBytes: 1024 * 1024,
  cacheBytes: 4 * 1024 * 1024,
  cacheEntries: 32,
  concurrentReads: 8,
  pendingReads: 32,
  archivePages: 16,
} as const;

const fail = (code: string): never => {
  throw Object.assign(new Error(code), { messageKey: 'viewer.unavailable', code });
};
const namespace = (source: ViewerSource) =>
  source.entry ? JSON.stringify([source.path, source.archives ?? []]) : 'filesystem';
export const documentResourceKey = (source: ViewerSource) =>
  JSON.stringify([namespace(source), source.entry ?? source.path]);
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Relative references may ascend within their namespace, never out of an archive/server root. */
export function documentRelativePath(reference: string, current: string): string {
  if (
    reference.length > 4096 ||
    /[\\\p{Cc}]/u.test(reference) ||
    reference.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(reference)
  )
    return fail('document_invalid_path');
  const parts = reference.startsWith('/') ? [] : dirname(current).split('/').filter(Boolean);
  for (const part of reference.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return fail('document_path_escape');
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length || parts.length > 64) return fail('document_invalid_path');
  return parts.join('/');
}

/** Cancelling a consumer never aborts another consumer's deduplicated read. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One mounted document owns this bounded text cache. No vault crawling or provider credentials. */
export function createDocumentResources(options: {
  serverId: string;
  source: ViewerSource;
  identity: string;
  onOpen(source: ViewerSource, fragment?: string): void;
  /** Optional metadata already indexed by the host. Never triggers recursive discovery. */
  knownSources?: readonly ViewerSource[] | (() => readonly ViewerSource[]);
}): DocumentResources {
  const lifetime = new AbortController();
  const session = JSON.stringify(fileDirectoryQuery(options.serverId, '').queryKey[3]);
  const cache = new Map<string, { text: string; bytes: number }>();
  const pending = new Map<string, Promise<string>>();
  const owned = new WeakSet<object>();
  let cacheBytes = 0;
  let activeReads = 0;
  const queue: (() => void)[] = [];
  function schedule<T>(load: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = queue.indexOf(start);
        if (index >= 0) queue.splice(index, 1);
        reject(lifetime.signal.reason);
      };
      const start = () => {
        lifetime.signal.removeEventListener('abort', abort);
        if (lifetime.signal.aborted) {
          reject(lifetime.signal.reason);
          return;
        }
        activeReads++;
        let work: Promise<T>;
        try {
          work = load();
        } catch (error) {
          work = Promise.reject(error);
        }
        void work.then(resolve, reject).finally(() => {
          activeReads--;
          queue.shift()?.();
        });
      };
      if (activeReads < documentResourceLimits.concurrentReads) start();
      else {
        queue.push(start);
        lifetime.signal.addEventListener('abort', abort, { once: true });
      }
    });
  }
  function check() {
    lifetime.signal.throwIfAborted();
    if (JSON.stringify(fileDirectoryQuery(options.serverId, '').queryKey[3]) !== session)
      fail('document_identity_changed');
  }
  function own<T extends DocumentResource>(resource: T): T {
    owned.add(resource);
    return resource;
  }
  function verify(resource: DocumentResource) {
    check();
    if (!owned.has(resource)) fail('document_foreign_resource');
  }
  async function candidates(
    from: ViewerSource,
    path: string,
    consumer?: AbortSignal,
  ): Promise<ViewerSource[]> {
    const signal = consumer ? AbortSignal.any([lifetime.signal, consumer]) : lifetime.signal;
    const folder = dirname(path);
    if (from.entry) {
      const found: ViewerSource[] = [];
      for (let page = 0; page < documentResourceLimits.archivePages; page++) {
        const query = archiveQuery(
          options.serverId,
          options.identity,
          from,
          folder,
          page * 200,
          basename(path),
        );
        const result = await waitFor(queryClient.fetchQuery(query), signal);
        check();
        found.push(
          ...result.entries
            .filter((entry) => !entry.directory)
            .map((entry) => ({ ...from, entry: entry.path, name: entry.name, size: entry.size })),
        );
        if ((page + 1) * 200 >= result.total) return found;
      }
      return fail('document_listing_limit');
    }
    const result = await waitFor(
      queryClient.fetchQuery(
        fileDirectoryQuery(options.serverId, folder, { prepareDownloads: false }),
      ),
      signal,
    );
    check();
    return result
      .filter((entry) => entry.is_file && !entry.is_symlink)
      .map((entry) => ({
        path: `${folder ? `${folder}/` : ''}${entry.name}`,
        name: entry.name,
        size: entry.size,
        gameId: from.gameId,
      }));
  }
  const resources: DocumentResources = {
    source: options.source,
    async resolve(reference, input = {}) {
      check();
      input.signal?.throwIfAborted();
      let target = reference.trim();
      if (target.length > 4096 || /[\p{Cc}\\]/u.test(target)) return fail('document_invalid_link');
      let label: string | undefined;
      if (input.wiki) {
        target = target.replace(/^!?\[\[/, '').replace(/\]\]$/, '');
        const separator = target.indexOf('|');
        if (separator >= 0) {
          label = target.slice(separator + 1);
          target = target.slice(0, separator);
        }
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        if (input.wiki) return fail('document_invalid_link');
        const url = new URL(target);
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password)
          return fail('document_invalid_link');
        return own({ kind: 'external', url: url.href, label });
      }
      const hash = target.indexOf('#');
      let fragment: string | undefined;
      try {
        if (hash >= 0) fragment = decodeURIComponent(target.slice(hash + 1));
        target = decodeURIComponent(hash >= 0 ? target.slice(0, hash) : target);
      } catch {
        return fail('document_invalid_link');
      }
      if (!target && fragment !== undefined) return own({ kind: 'anchor', fragment, label });
      const from = input.from ?? options.source;
      if (namespace(from) !== namespace(options.source)) return fail('document_foreign_namespace');
      const path = documentRelativePath(target, from.entry ?? from.path);
      const names = [path];
      if (input.wiki && !/\.(md|markdown)$/i.test(path))
        names.push(`${path}.md`, `${path}.markdown`);
      if (names.includes((from.entry ?? from.path).replace(/^\//, '')))
        return own({ kind: 'local', source: from, fragment, label });
      const list = await candidates(from, path, input.signal);
      for (const name of names) {
        const exact = list.filter((item) => (item.entry ?? item.path).replace(/^\//, '') === name);
        if (exact.length > 1) return fail('document_ambiguous_link');
        if (exact[0]) return own({ kind: 'local', source: exact[0], fragment, label });
      }
      if (input.wiki && !target.includes('/')) {
        const known =
          typeof options.knownSources === 'function'
            ? options.knownSources()
            : options.knownSources;
        const possible = (known ?? []).filter(
          (item) =>
            namespace(item) === namespace(from) &&
            names.some((name) => basename(name) === item.name),
        );
        const unique = [
          ...new Map(possible.map((item) => [documentResourceKey(item), item])).values(),
        ];
        if (unique.length > 1) return fail('document_ambiguous_link');
        if (unique[0]) return own({ kind: 'local', source: unique[0], fragment, label });
      }
      return fail('document_link_missing');
    },
    url(resource) {
      verify(resource);
      if (resource.kind === 'external') return resource.url;
      if (resource.kind === 'anchor') return `#${encodeURIComponent(resource.fragment)}`;
      return viewerPath(options.serverId, resource.source);
    },
    async readText(resource, signal) {
      verify(resource);
      signal?.throwIfAborted();
      if (resource.kind !== 'local') return fail('document_local_required');
      if (resource.source.size > documentResourceLimits.textBytes)
        return fail('document_text_limit');
      const key = documentResourceKey(resource.source);
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached.text;
      }
      let request = pending.get(key);
      if (!request) {
        if (pending.size >= documentResourceLimits.pendingReads) return fail('document_read_limit');
        request = schedule(() =>
          readViewerBytes(
            resources.url(resource),
            documentResourceLimits.textBytes,
            lifetime.signal,
          ),
        )
          .then((bytes) => {
            check();
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (text.includes('\0')) return fail('document_binary');
            // Strings use up to two bytes per UTF-16 unit; count retained bytes conservatively.
            const size = text.length * 2;
            while (
              cache.size &&
              (cacheBytes + size > documentResourceLimits.cacheBytes ||
                cache.size >= documentResourceLimits.cacheEntries)
            ) {
              const first = cache.entries().next().value;
              if (!first) break;
              cache.delete(first[0]);
              cacheBytes -= first[1].bytes;
            }
            cache.set(key, { text, bytes: size });
            cacheBytes += size;
            return text;
          })
          .finally(() => pending.delete(key));
        pending.set(key, request);
      }
      return waitFor(request, signal);
    },
    open(resource) {
      verify(resource);
      if (resource.kind !== 'local') return fail('document_local_required');
      options.onOpen(resource.source, resource.fragment);
    },
    dispose() {
      lifetime.abort();
      cache.clear();
      cacheBytes = 0;
      pending.clear();
    },
  };
  return resources;
}
