import { AsyncLocalStorage } from 'node:async_hooks';
import type { createLogger } from '@nickhosting/core';
import type { CredentialScope } from './transport.js';

export type ProviderReadCaller =
  | 'api-other'
  | 'gateway'
  | 'worker'
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

const callerScope = new AsyncLocalStorage<ProviderReadCaller>();

export function withProviderReadCaller<T>(caller: ProviderReadCaller, operation: () => T): T {
  return callerScope.run(caller, operation);
}

function readKind(scope: CredentialScope, method: string, path: string, url: URL) {
  if (scope === 'client') {
    if (method === 'POST') {
      if (/^extensions\/nickhosting\/servers\/[^/?]+\/directory-list$/.test(path))
        return 'directoryList';
      if (/^extensions\/nickhosting\/servers\/[^/?]+\/download-urls$/.test(path))
        return 'downloadUrls';
    }
    if (method !== 'GET') return;
    if (/^servers\/[^/?]+\/resources(?:\?|$)/.test(path)) return 'resources';
    if (/^servers\/[^/?]+\/backups(?:\?|$)/.test(path)) return 'backupList';
    return 'otherClient';
  }
  if (method === 'POST') {
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
      const caller = callerScope.getStore() ?? fallback;
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
