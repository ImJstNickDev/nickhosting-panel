import type { GameViewerLogPage, GameViewerLogSession } from '@nickhosting/game-sdk/ui';
import { ApiError, api, queryClient } from '../../../api/client.js';
import { fileDirectoryQuery, serverPath } from '../../service-contracts.js';
import type { ViewerSource } from './registry.js';

/** One mounted viewer owns one backend lease. Heartbeats retain bytes; they never stat content. */
export function createLogSession(
  serverId: string,
  source: ViewerSource,
  lifetime: AbortSignal,
): GameViewerLogSession {
  const base = `${serverPath(serverId)}/files/viewer/log/session`;
  const directory = source.path.includes('/')
    ? source.path.slice(0, source.path.lastIndexOf('/'))
    : '';
  const context = JSON.stringify(fileDirectoryQuery(serverId, '').queryKey[3]);
  const listeners = new Set<() => void>();
  let sessionId: string | undefined;
  let opening: Promise<string> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewing = false;
  let closed = false;
  let denial: unknown;
  let lastListing = '';
  let notifying = false;
  const current = () => {
    lifetime.throwIfAborted();
    if (closed || context !== JSON.stringify(fileDirectoryQuery(serverId, '').queryKey[3]))
      throw new Error('viewer_identity_changed');
    if (denial) throw denial;
  };
  const notify = () => {
    if (notifying || closed) return;
    notifying = true;
    queueMicrotask(() => {
      notifying = false;
      if (!closed) for (const listener of listeners) listener();
    });
  };
  const release = (id: string) => {
    void fetch(`${base}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      redirect: 'error',
      keepalive: true,
    }).catch(() => {
      /* The bounded backend lease also expires after a lost close. */
    });
  };
  const forget = (id: string) => {
    if (sessionId !== id) return;
    sessionId = undefined;
    opening = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    release(id);
  };
  const open = () => {
    current();
    opening ??= api<{ sessionId: string; revision: string }>(base, {
      method: 'POST',
      body: { path: source.path },
      signal: lifetime,
    })
      .then((result) => {
        if (closed || lifetime.aborted) {
          release(result.sessionId);
          throw new Error('viewer_closed');
        }
        try {
          current();
        } catch (error) {
          release(result.sessionId);
          throw error;
        }
        sessionId = result.sessionId;
        heartbeat = setInterval(() => {
          if (renewing || closed || !sessionId) return;
          try {
            current();
          } catch {
            close();
            return;
          }
          renewing = true;
          const renewedId = sessionId;
          void api(`${base}/${encodeURIComponent(renewedId)}/renew`, {
            method: 'POST',
            signal: lifetime,
          })
            .catch((error) => {
              if (error instanceof ApiError && [401, 403].includes(error.status)) {
                denial = error;
                notify();
              } else if (
                error instanceof ApiError &&
                [404, 410].includes(error.status) &&
                sessionId === renewedId
              ) {
                forget(renewedId);
                notify();
              }
            })
            .finally(() => {
              renewing = false;
            });
        }, 30_000);
        return result.sessionId;
      })
      .catch((error) => {
        opening = undefined;
        throw error;
      });
    return opening;
  };
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (
      closed ||
      key[0] !== 'files' ||
      key[1] !== serverId ||
      key[2] !== directory ||
      JSON.stringify(key[3]) !== context
    )
      return;
    if (event.type !== 'updated') return;
    if (event.action.type === 'invalidate') notify();
    else if (event.action.type === 'success') {
      const entries = event.query.state.data;
      if (!Array.isArray(entries)) return;
      const entry = entries.find((item) => item?.name === source.name);
      const version = JSON.stringify(
        entry ? [entry.size, entry.modified_at, entry.is_file, entry.is_symlink] : null,
      );
      if (version !== lastListing) {
        lastListing = version;
        notify();
      }
    }
  });
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
    listeners.clear();
    if (sessionId) release(sessionId);
    globalThis.removeEventListener?.('pagehide', close);
    lifetime.removeEventListener('abort', close);
  };
  lifetime.addEventListener('abort', close, { once: true });
  globalThis.addEventListener?.('pagehide', close);
  const request = async <T>(operation: string, body: unknown, signal: AbortSignal): Promise<T> => {
    current();
    signal.throwIfAborted();
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = await open();
      current();
      signal.throwIfAborted();
      try {
        const result = await api<T>(`${base}/${encodeURIComponent(id)}/${operation}`, {
          method: 'POST',
          body,
          signal: AbortSignal.any([lifetime, signal]),
        });
        current();
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (attempt === 0 && error instanceof ApiError && [404, 410].includes(error.status)) {
          current();
          signal.throwIfAborted();
          forget(id);
          continue;
        }
        throw error;
      }
    }
    throw new Error('viewer_unavailable');
  };
  return {
    page: (options, signal) => request<GameViewerLogPage>('page', options, signal),
    refresh: (signal) =>
      request<{ revision: string; changed: boolean }>('refresh', undefined, signal),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
