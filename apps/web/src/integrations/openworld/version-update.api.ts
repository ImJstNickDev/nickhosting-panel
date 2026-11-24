import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { createOpenworldUpdates } from '../../../../../packages/server-management/src/openworld-updates.js';
import { api } from '../../api/client.js';
import type { Result } from '../../api/contracts.js';
import { serverPath } from '../../features/service-contracts.js';

export type UpdateCatalog = Result<ReturnType<typeof createOpenworldUpdates>['options']>;
export type OpenworldUpdate = NonNullable<UpdateCatalog['current']>;
export type UpdatePhase = OpenworldUpdate['phase'];
export interface UpdateRequest {
  expectedVersion: string;
  version: string;
  mode: 'immediate' | 'timed' | 'when-empty';
  noticeSeconds?: number;
  backupBefore: boolean;
  idempotencyKey: string;
}
export const updateKey = (name: string) => `games.openworld.update.${name}`;
export const updatePath = (id: string) => `${serverPath(id)}/openworld/update`;
const catalogKey = (id: string) => ['openworld', id, 'update-catalog'] as const;
const currentKey = (id: string) => ['openworld', id, 'current-update'] as const;
export function isActive(value: OpenworldUpdate | null | undefined): value is OpenworldUpdate & {
  phase: Exclude<UpdatePhase, 'completed' | 'failed' | 'cancelled'>;
} {
  return Boolean(value && !['completed', 'failed', 'cancelled'].includes(value.phase));
}
type Status = { current: OpenworldUpdate | null };
export async function rememberUpdate(
  cache: QueryClient,
  serverId: string,
  current: OpenworldUpdate,
) {
  await Promise.all([
    cache.cancelQueries({ queryKey: currentKey(serverId), exact: true }),
    cache.cancelQueries({ queryKey: catalogKey(serverId), exact: true }),
  ]);
  cache.setQueryData<Status>(currentKey(serverId), { current });
  cache.setQueryData<UpdateCatalog>(catalogKey(serverId), (old) => old && { ...old, current });
  void cache.invalidateQueries({ queryKey: ['server', serverId], exact: true });
}

export function useOpenworldUpdate(
  serverId: string,
  enabled: boolean,
  operationId?: string | null,
) {
  const cache = useQueryClient();
  const catalog = useQuery({
    queryKey: catalogKey(serverId),
    queryFn: ({ signal }) => api<UpdateCatalog>(updatePath(serverId), { signal }),
    enabled,
    staleTime: 300_000,
  });
  const status = useQuery({
    queryKey: currentKey(serverId),
    queryFn: ({ signal }) => api<Status>(`${updatePath(serverId)}/current`, { signal }),
    enabled:
      enabled &&
      (Boolean(operationId) ||
        isActive(catalog.data?.current) ||
        isActive(cache.getQueryData<Status>(currentKey(serverId))?.current)),
    refetchInterval: (query) =>
      isActive(query.state.data?.current ?? catalog.data?.current) ? 2000 : false,
    staleTime: 1000,
  });
  // The platform projection changes when another tab or manager enqueues a job.
  const previous = useRef(operationId);
  useEffect(() => {
    if (enabled && operationId && operationId !== previous.current)
      void cache.invalidateQueries({ queryKey: currentKey(serverId), exact: true });
    previous.current = operationId;
  }, [cache, enabled, operationId, serverId]);
  // A slow release catalog may carry an older snapshot than a status response
  // that arrived first. Compare the records rather than HTTP completion times.
  const listed = catalog.data?.current;
  const live = status.data?.current;
  const current =
    listed && live
      ? (
          listed.id === live.id
            ? listed.updatedAt > live.updatedAt
            : listed.startedAt > live.startedAt
        )
        ? listed
        : live
      : (live ?? listed ?? null);
  const activeId = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !current) return;
    if (isActive(current)) {
      activeId.current = current.id;
    } else if (activeId.current === current.id) {
      activeId.current = null;
      void cache.invalidateQueries({ queryKey: catalogKey(serverId), exact: true });
      void cache.invalidateQueries({ queryKey: ['server', serverId], exact: true });
    }
  }, [enabled, cache, current, serverId]);
  return {
    catalog,
    current: enabled ? current : null,
    error: catalog.error ?? status.error,
    statusError: status.error,
    retry: () => {
      void catalog.refetch();
      if (status.isEnabled) void status.refetch();
    },
  };
}
