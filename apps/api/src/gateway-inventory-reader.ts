import { DomainError } from '@nickhosting/core';
import { type ApplicationServer, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import type { ManagementRuntime } from '@nickhosting/server-management';

async function stockInventory(management: ManagementRuntime, nodeIds: number[], uuids: string[]) {
  const [nodes, remotes, allocations] = await Promise.all([
    management.adapter.listNodes(),
    (async () => {
      // The snapshot permits 10,000 routes; the adapter accepts 1,000 distinct IDs per lookup.
      const found: ApplicationServer[] = [];
      for (let offset = 0; offset < uuids.length; offset += 1000)
        found.push(
          ...(await management.adapter.getApplicationServers(uuids.slice(offset, offset + 1000))),
        );
      return found;
    })(),
    (async () => {
      let next = 0;
      const results: {
        nodeId: number;
        allocations: { id: number; ip: string; port: number; assigned: boolean }[];
      }[] = [];
      await Promise.all(
        Array.from({ length: Math.min(4, nodeIds.length) }, async () => {
          for (;;) {
            const nodeId = nodeIds[next++];
            if (nodeId === undefined) return;
            results.push({
              nodeId,
              allocations: (await management.adapter.listAllocations(nodeId)).map(
                ({ id, ip, port, assigned }) => ({ id, ip, port, assigned }),
              ),
            });
          }
        }),
      );
      return results;
    })(),
  ]);
  return { nodes, servers: remotes, allocations };
}

type Topology = NonNullable<ManagementRuntime['adapter']['gatewayTopology']>;
type Snapshot = Awaited<ReturnType<Topology['snapshot']>>;
type Receipt = Snapshot['receipt'];
const matches = (a: Receipt, b: Receipt) =>
  a.epoch === b.epoch && a.revision === b.revision && a.digest === b.digest;

export function createGatewayInventoryReader(changed: () => Promise<void> = async () => {}) {
  let cache:
    | { binding: string; until: number; supported: Promise<boolean>; legacyUntil: number }
    | undefined;
  type Scope = {
    key: string;
    binding: string;
    value?: Snapshot;
    observedAt: number;
    demandAt: number;
    snapshotAt: number;
    watching?: Promise<void>;
    loading?: Promise<void>;
  };
  let rejection: { binding: string; error: PterodactylError; announced: boolean } | undefined;
  let current: Scope | undefined;
  let watcher: Promise<void> | undefined;
  const invalidate = (scope: Scope) => {
    if (scope !== current) return;
    scope.value = undefined;
    void changed().catch(() => {});
  };
  function watch(
    scope: Scope,
    topology: Topology,
    nodes: number[],
    servers: string[],
    interval: number,
  ) {
    if (watcher || !scope.value || current !== scope) return;
    const original = scope.value;
    const start = Date.now();
    const waitMs = Math.max(0, Math.min(interval, Math.floor(scope.observedAt + interval - start)));
    let renewed = false;
    const monotonicStart = performance.now();
    watcher = scope.watching = topology
      .revision(original.receipt, nodes, servers, waitMs)
      .then(
        (receipt) => {
          if (scope.value !== original || current !== scope) return;
          if ('changed' in receipt || !matches(receipt, original.receipt)) {
            invalidate(scope);
            return;
          }
          // The remote monotonic wait ends BEFORE the consistent transaction. Exclude
          // network/DB latency. Clamp to elapsed local monotonic and wall time.
          const observed =
            start + Math.min(receipt.waitedMs, Math.floor(performance.now() - monotonicStart));
          if (observed > Date.now() || receipt.waitedMs < waitMs) {
            invalidate(scope);
            return;
          }
          scope.observedAt = observed;
          renewed = true;
        },
        (error: unknown) => {
          if (scope.value !== original || current !== scope) return;
          if (
            error instanceof PterodactylError &&
            (error.reason === 'permission_denied' || error.upstreamStatus === 409)
          ) {
            rejection = { binding: scope.binding, error, announced: false };
          }
          invalidate(scope);
        },
      )
      .finally(() => {
        watcher = undefined;
        scope.watching = undefined;
        // Continue only for an active Gateway. Scope replacement and inactivity
        // release the upstream worker within one bounded wait.
        if (renewed && Date.now() - scope.demandAt < interval + 1000)
          watch(scope, topology, nodes, servers, interval);
      });
  }

  async function read(
    key: string,
    management: ManagementRuntime,
    nodeIds: number[],
    uuids: string[],
    confirmAfterMs: number,
  ) {
    const binding = management.consoleProviderBinding;
    const started = Date.now();
    const fresh = async <T>(read: () => Promise<T>) => {
      const providerObservedAt = Date.now();
      return {
        ...(await read()),
        providerObservedAt,
        providerReadFresh: true,
        checkCurrent: () => {},
      };
    };
    const stock = () => fresh(() => stockInventory(management, nodeIds, uuids));
    if (!uuids.length || nodeIds.length > 256) {
      current = undefined;
      if (!uuids.length)
        return {
          nodes: [],
          allocations: [],
          servers: [],
          providerObservedAt: started,
          providerReadFresh: false,
          checkCurrent: () => {},
        };
      return stock();
    }
    if (
      !cache ||
      cache.binding !== binding ||
      cache.until <= started ||
      cache.until > started + 60000
    ) {
      const supported = Promise.resolve().then(() =>
        management.adapter.supportsGatewayInventory((checkedAt) => {
          if (cache?.supported === supported)
            cache.until = Math.min(cache.until, checkedAt.getTime() + 60000);
        }),
      );
      cache = { binding, until: started + 60000, supported, legacyUntil: 0 };
      void supported.catch(() => {
        if (cache?.supported === supported) cache = undefined;
      });
    }
    const metadata = cache;
    const supported = await metadata.supported;
    if (metadata.until <= Date.now()) throw new DomainError('integration_unavailable');
    if (!supported) {
      current = undefined;
      return stock();
    }
    const topology = management.adapter.gatewayTopology;
    if (topology && metadata.legacyUntil <= started) {
      if (current?.key !== key)
        current = { key, binding, observedAt: 0, demandAt: started, snapshotAt: 0 };
      const scope = current;
      scope.demandAt = started;
      try {
        // One heartbeat both wakes on commits and certifies the current projection.
        // If a Gateway resumes after inactivity, ask for a zero-wait receipt now.
        if (
          scope.value &&
          (started - scope.observedAt >= confirmAfterMs || started < scope.observedAt)
        ) {
          if (!scope.watching) watch(scope, topology, nodeIds, uuids, confirmAfterMs);
          await scope.watching;
          if (Date.now() - scope.observedAt > confirmAfterMs || Date.now() < scope.observedAt)
            scope.value = undefined;
        }
        // A changed scope can briefly wait for the preceding scope's bounded PHP
        // worker. Full reads retain current-cycle authority until its own watch starts.
        if ((watcher && !scope.watching) || Date.now() - scope.snapshotAt >= 300000)
          scope.value = undefined;
        let providerReadFresh = false;
        if (!scope.value) {
          if (!scope.loading) {
            providerReadFresh = true;
            const readAt = Date.now();
            scope.loading = topology
              .snapshot(nodeIds, uuids)
              .then((value) => {
                scope.value = value;
                scope.snapshotAt = scope.observedAt = readAt;
              })
              .finally(() => {
                scope.loading = undefined;
              });
          }
          await scope.loading;
        }
        const value = scope.value;
        const checkCurrent = () => {
          if (!value || current !== scope || scope.value !== value)
            throw new DomainError('conflict', 412, {
              gatewayControlReason: 'snapshot_membership_changed',
            });
        };
        checkCurrent();
        if (!value) throw new DomainError('integration_unavailable');
        watch(scope, topology, nodeIds, uuids, confirmAfterMs);
        return { ...value, providerObservedAt: scope.observedAt, providerReadFresh, checkCurrent };
      } catch (error) {
        if (current === scope) current = undefined;
        if (!(error instanceof PterodactylError)) throw error;
        if (error.upstreamStatus === 413) return stock();
        if (error.upstreamStatus !== 404 && error.upstreamStatus !== 501) throw error;
        metadata.legacyUntil = Date.now() + 60000;
      }
    }
    current = undefined;
    try {
      return await fresh(() => management.adapter.readGatewayInventory(nodeIds, uuids));
    } catch (error) {
      if (!(error instanceof PterodactylError) || error.upstreamStatus !== 413) throw error;
      return stock();
    }
  }
  return async (
    management: ManagementRuntime,
    nodeIds: number[],
    uuids: string[],
    confirmAfterMs: number,
    admission: string,
  ) => {
    const key = JSON.stringify([
      management.consoleProviderBinding,
      admission,
      confirmAfterMs,
      [...nodeIds].sort((a, b) => a - b),
      [...uuids].sort(),
    ]);
    const refused = rejection;
    if (refused && !refused.announced) {
      refused.announced = true;
      throw refused.error;
    }
    const binding = management.consoleProviderBinding;
    if (rejection && rejection.binding !== binding) rejection = undefined;
    try {
      const result = await read(key, management, nodeIds, uuids, confirmAfterMs);
      if (rejection && rejection.binding === binding) {
        // All readers retain the refusal until a new authoritative read succeeds.
        if (rejection !== refused || (uuids.length && !result.providerReadFresh))
          throw rejection.error;
        rejection = undefined;
      }
      return result;
    } catch (error) {
      if (rejection && rejection.binding === binding) throw rejection.error;
      throw error;
    }
  };
}
