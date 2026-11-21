import { type UseQueryOptions, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { ServerView } from './telemetry.js';

export const playersBase = (id: string) => `/v1/servers/${encodeURIComponent(id)}/openworld`;

export function usePlayerResource<T>(
  server: ServerView,
  path: string,
  options: { enabled?: boolean; interval?: UseQueryOptions<T>['refetchInterval'] } = {},
) {
  return useQuery<T>({
    queryKey: [
      'openworld-players',
      ...server.viewerScope,
      server.serverId,
      server.runtimeState,
      path,
    ],
    queryFn: ({ signal }) => api<T>(`${playersBase(server.serverId)}/${path}`, { signal }),
    enabled: options.enabled ?? true,
    refetchInterval: options.interval ?? false,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
