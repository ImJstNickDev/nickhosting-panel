import type { GameViewerHost, GameViewerProps } from '@nickhosting/game-sdk/ui';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { queryClient } from '../../api/client.js';
import { useLocale, useT } from '../../app/i18n.js';
import { readViewerBytes, viewerPath } from './core/access.js';
import { trimArchivePages } from './core/archive-memory.js';
import { archiveQuery } from './core/archive-query.js';
import { readGameViewerPrefix } from './core/game-prefix-cache.js';
import { selectableViewers, type ViewerId, type ViewerSource } from './core/registry.js';
import { ViewerLoading } from './loading.js';

/** Integration metadata and embedded assets are bounded independently of archive size. */
export const gameViewerReadLimit = 8 * 1024 * 1024;

/** Selecting an archive member means inspecting that member's container, not its parent. */
export function gameViewerArchiveSource(source: ViewerSource): ViewerSource {
  return source.entry
    ? { ...source, archives: [...(source.archives ?? []), source.entry], entry: undefined }
    : { ...source, archives: source.archives ? [...source.archives] : undefined };
}

function memberPath(path: string, directory = false) {
  if (
    (directory && path === '') ||
    (path.length > 0 &&
      path.length <= 1024 &&
      !/[\\:\p{Cc}]/u.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'))
  )
    return path;
  throw new TypeError('invalid_viewer_member');
}

/** A consumer can leave without cancelling another viewer's shared metadata request. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createGameViewerHost(options: {
  source: ViewerSource;
  serverId: string;
  identity: string;
  t: GameViewerHost['t'];
  locale?: string;
  onViewerChange: (id: ViewerId) => void;
}): { host: GameViewerHost; dispose(): void } {
  const lifetime = new AbortController();
  const source = gameViewerArchiveSource(options.source);
  const signalFor = (signal: AbortSignal) => {
    const combined = AbortSignal.any([lifetime.signal, signal]);
    combined.throwIfAborted();
    return combined;
  };
  return {
    host: {
      t: options.t,
      locale: options.locale,
      async readPrefix(maxBytes, signal) {
        const combined = signalFor(signal);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536)
          throw new TypeError('invalid_viewer_read_limit');
        return readGameViewerPrefix({
          serverId: options.serverId,
          identity: options.identity,
          source: options.source,
          maxBytes,
          signal: combined,
        });
      },
      async readTail(maxBytes, signal) {
        let size = 0;
        const bytes = await readGameViewerPrefix({
          serverId: options.serverId,
          identity: options.identity,
          source: options.source,
          maxBytes,
          signal: signalFor(signal),
          tail: true,
          onSize: (value) => {
            size = value;
          },
        });
        return { bytes, truncated: size > bytes.length };
      },
      archive: {
        async list(directory, signal, query = '') {
          const combined = signalFor(signal);
          memberPath(directory, true);
          if (query.length > 256) throw new TypeError('invalid_viewer_query');
          const request = archiveQuery(
            options.serverId,
            options.identity,
            source,
            directory,
            0,
            query,
          );
          const page = await waitFor(queryClient.fetchQuery(request), combined);
          combined.throwIfAborted();
          trimArchivePages(request.queryKey);
          return { entries: page.entries, total: page.total };
        },
        async read(path, maxBytes, signal) {
          const combined = signalFor(signal);
          memberPath(path);
          if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > gameViewerReadLimit)
            throw new TypeError('invalid_viewer_read_limit');
          return readViewerBytes(
            viewerPath(options.serverId, { ...source, entry: path }),
            maxBytes,
            combined,
          );
        },
      },
      openViewer(id) {
        lifetime.signal.throwIfAborted();
        const viewer = selectableViewers(options.source).find((item) => item.id === id);
        if (!viewer) throw new TypeError('unavailable_viewer');
        options.onViewerChange(viewer.id);
      },
    },
    dispose: () => lifetime.abort(),
  };
}

/** The shell supplies authority and lifetime; game packages supply only their view. */
export function GameViewerMount({
  viewer: Viewer,
  source,
  serverId,
  identity,
  onViewerChange,
}: {
  viewer: ComponentType<GameViewerProps>;
  source: ViewerSource;
  serverId: string;
  identity: string;
  onViewerChange: (id: ViewerId) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const latest = useRef({ source, t, onViewerChange });
  latest.current = { source, t, onViewerChange };
  const key = JSON.stringify([serverId, identity, source]);
  const [state, setState] = useState<{ key: string; host: GameViewerHost }>();
  useEffect(() => {
    const scoped = createGameViewerHost({
      serverId,
      identity,
      locale,
      source: latest.current.source,
      t: (key, values) => latest.current.t(key, values),
      onViewerChange: (id) => latest.current.onViewerChange(id),
    });
    setState({ key, host: scoped.host });
    return () => scoped.dispose();
  }, [key, serverId, identity, locale]);
  return state?.key === key ? <Viewer source={source} host={state.host} /> : <ViewerLoading />;
}
