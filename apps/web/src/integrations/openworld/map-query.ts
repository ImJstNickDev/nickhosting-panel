import { useQuery } from '@tanstack/react-query';
import { ApiError, readApi } from '../../api/client.js';
import type { ServerView } from './telemetry.js';

export const mapKey = (suffix: string) => `games.openworld.map.${suffix}`;
export const mapBase = (id: string) => `/v1/servers/${encodeURIComponent(id)}/openworld/map`;
export const mapScope = (s: ServerView) =>
  ['openworld-map', ...s.viewerScope, s.serverId, s.runtimeState] as const;
export const mapData = <T>(s: ServerView, path: string, signal: AbortSignal) =>
  readApi<T>(mapBase(s.serverId) + path, signal);
export function mapParams(params: Record<string, string | number>) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
}
export const scopeLost = (reason: unknown) =>
  reason instanceof ApiError &&
  (reason.status === 401 ||
    reason.status === 403 ||
    reason.status === 404 ||
    (reason.status === 409 && reason.code !== 'game_request_unsupported'));
export function useMapData<T>(
  s: ServerView,
  path: string,
  enabled = true,
  interval?: number,
  staleTime = 0,
) {
  return useQuery({
    queryKey: [...mapScope(s), path],
    queryFn: ({ signal }) => mapData<T>(s, path, signal),
    enabled,
    refetchInterval: (q) => (interval && !scopeLost(q.state.error) ? interval : false),
    refetchIntervalInBackground: false,
    gcTime: 0,
    staleTime,
    retry: false,
  });
}
