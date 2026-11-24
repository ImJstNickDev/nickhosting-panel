import { focusManager, type Query, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OpenworldFactoriesSnapshot,
  OpenworldFactoryColumn,
} from '../../../../../games/openworld/src/factories.js';
import { ApiError, readApi } from '../../api/client.js';
import type { TelemetryViewProps } from './telemetry.js';

export function factoryMapPoint(c: OpenworldFactoryColumn) {
  if (!c.world || c.world === 'ships' || c.face == null) return null;
  if (c.i != null && c.j != null)
    return { world: c.world, face: c.face, x: c.i * 16 + 8, z: c.j * 16 + 8 };
  return c.x != null && c.z != null ? { world: c.world, face: c.face, x: c.x, z: c.z } : null;
}

export function useFactoryData(props: TelemetryViewProps, enabled: boolean, interval = 1000) {
  const client = useQueryClient();
  const canRead = props.permissionKeys.includes('game.openworld.performance.read');
  const active = enabled && props.runtimeState === 'running' && canRead;
  const queryKey = [
    'openworld-factories',
    ...props.viewerScope,
    props.serverId,
    props.runtimeState,
    canRead,
  ];
  const cooldownKey = [...queryKey, 'retry-after'];
  const cooldownUntil = () => client.getQueryData<number>(cooldownKey) ?? 0;
  const retryAt = (q: Query<OpenworldFactoriesSnapshot>) => {
    const error = q.state.error;
    if (error instanceof ApiError) {
      if ([401, 403, 404].includes(error.status) || error.code === 'game_request_unsupported')
        return false;
      if (error.status === 429) return cooldownUntil();
    }
    return error ? q.state.errorUpdatedAt + Math.max(interval, 5000) : 0;
  };
  const canResume = (q: Query<OpenworldFactoriesSnapshot>) => {
    const next = retryAt(q);
    return focusManager.isFocused() && next !== false && Date.now() >= next;
  };
  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      // Manual retries and re-enabling a Map layer bypass observer interval options.
      const remaining = cooldownUntil() - Date.now();
      if (remaining > 0)
        throw new ApiError(
          'rate_limited',
          'errors.rate_limited',
          undefined,
          429,
          Math.ceil(remaining / 1000),
        );
      try {
        return await readApi<OpenworldFactoriesSnapshot>(
          `/v1/servers/${encodeURIComponent(props.serverId)}/openworld/factories`,
          signal,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 429) {
          const delay = Math.max(1, error.retryAfterSeconds ?? 60) * 1000;
          // Retain only the deadline across workspace unmounts, for the duration
          // advertised by this server. Normal snapshots can still be collected immediately.
          client.removeQueries({ queryKey: cooldownKey, exact: true });
          client.getQueryCache().build(client, {
            queryKey: cooldownKey,
            initialData: Date.now() + delay,
            gcTime: delay,
          });
        }
        throw error;
      }
    },
    // Suppress even the initial read in a background tab. After the first response
    // TanStack pauses interval requests on visibility and keeps their cooldown timer.
    enabled: (q) => active && (focusManager.isFocused() || q.state.status !== 'pending'),
    staleTime: Math.min(interval, 3000),
    gcTime: 0,
    retry: false,
    retryOnMount: canResume,
    refetchOnMount: canResume,
    refetchOnWindowFocus: canResume,
    refetchOnReconnect: canResume,
    refetchInterval: (q) => {
      const next = retryAt(q);
      if (next === false) return false;
      const remaining = next - Date.now();
      return remaining > 0 ? remaining : interval;
    },
    refetchIntervalInBackground: false,
  });
}
