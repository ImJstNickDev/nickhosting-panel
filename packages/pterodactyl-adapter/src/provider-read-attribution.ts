import { AsyncLocalStorage } from 'node:async_hooks';
import type { createLogger } from '@nickhosting/core';
import type { CredentialScope } from './transport.js';

export type ProviderReadCaller =
  | 'api-other'
  | 'gateway'
  | 'worker'
  | 'worker-feed'
  | 'worker-minecraft-worlds'
  | 'worker-reconcile'
  | 'worker-openworld-captures'
  | 'openworld-telemetry'
  | 'openworld-players'
  | 'openworld-map'
  | 'openworld-space'
  | 'openworld-creatures'
  | 'openworld-factories'
  | 'openworld-screenshots'
  | 'openworld-rules'
  | 'openworld-inspector'
  | 'openworld-dashboard'
  | 'unknown';

const callerScope = new AsyncLocalStorage<{ caller: ProviderReadCaller; signal?: AbortSignal }>();

export function withProviderReadCaller<T>(
  caller: ProviderReadCaller,
  operation: () => T,
  signal = callerScope.getStore()?.signal,
): T {
  return callerScope.run({ caller, signal }, operation);
}

/** A retired observer may finish an already-dispatched read shared with another
 * caller, but cannot dispatch another request or publish the retired sample. */
export function assertProviderReadActive() {
  callerScope.getStore()?.signal?.throwIfAborted();
}

export function isBackgroundProviderRead() {
  const caller = callerScope.getStore()?.caller;
  return (
    caller === 'worker-reconcile' ||
    caller === 'worker-openworld-captures' ||
    caller === 'worker-feed' ||
    caller === 'worker-minecraft-worlds'
  );
}

function readKind(scope: CredentialScope, method: string, path: string, url: URL) {
  if (scope === 'client') {
    if (method === 'POST') {
      if (/^extensions\/nickhosting\/servers\/[^/?]+\/(?:world-)?directory-list$/.test(path))
        return 'directoryList';
      if (/^extensions\/nickhosting\/servers\/[^/?]+\/(?:world-)?download-urls$/.test(path))
        return 'downloadUrls';
    }
    if (method !== 'GET') return;
    if (/^servers\/[^/?]+\/resources(?:\?|$)/.test(path)) return 'resources';
    if (/^servers\/[^/?]+\/backups(?:\?|$)/.test(path)) return 'backupList';
    return 'otherClient';
  }
  if (method === 'POST') {
    if (path === 'extensions/nickhosting/gateway-topology/revision') return 'topologyRevision';
    if (path === 'extensions/nickhosting/gateway-topology/snapshot') return 'topologySnapshot';
    if (path === 'extensions/nickhosting/gateway-inventory') return 'bundle';
    if (/^extensions\/nickhosting\/instances\/[^/?]+\/server-snapshots$/.test(path))
      return 'serverSnapshots';
  }
  if (method !== 'GET') return;
  if (/^servers\/\d+(?:\?|$)/.test(path)) return 'detail';
  if (path.startsWith('servers/external/')) return 'externalDetail';
  if (path === 'servers' || path.startsWith('servers?'))
    return url.searchParams.has('filter[uuid]') ? 'batch' : 'list';
  return 'otherApplication';
}

type ReadCounts = Partial<Record<NonNullable<ReturnType<typeof readKind>>, number>>;

export function createProviderReadAttribution(runtime?: 'api' | 'worker') {
  const fallback = runtime === 'api' ? 'api-other' : (runtime ?? 'unknown');
  const callers = new Map<ProviderReadCaller, ReadCounts>();
  let since = Date.now();
  return {
    // Call immediately before fetch, after validation, local cooldown and in-flight joining.
    providerReadAgent(scope: CredentialScope, method: string, path: string, url: URL) {
      const kind = readKind(scope, method, path, url);
      if (!kind) return;
      const caller = callerScope.getStore()?.caller ?? fallback;
      const counts = callers.get(caller) ?? {};
      counts[kind] = (counts[kind] ?? 0) + 1;
      callers.set(caller, counts);
      return `NickPanel/${caller}`;
    },
    startReadReporting(logger: Pick<ReturnType<typeof createLogger>, 'log'>) {
      const flush = () => {
        const until = Date.now();
        if (callers.size) {
          const data = {
            runtime,
            from: new Date(since).toISOString(),
            until: new Date(until).toISOString(),
            callers: Object.fromEntries(callers),
          };
          callers.clear();
          try {
            logger.log('info', 'pterodactyl.server_reads', data);
          } catch {
            // An unavailable diagnostic sink cannot interrupt provider operations.
          }
        }
        since = until;
      };
      const timer = setInterval(flush, 60_000).unref();
      return () => {
        clearInterval(timer);
        flush();
      };
    },
  };
}
