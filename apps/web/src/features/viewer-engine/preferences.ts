import { useQuery } from '@tanstack/react-query';
import { api, queryClient } from '../../api/client.js';
import { serverPath } from '../service-contracts.js';
import type { ViewerPreference } from './core/registry.js';

export function viewerCapabilitiesQuery(serverId: string, identity: string) {
  return {
    queryKey: ['viewer-capabilities', identity, serverId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<{ available: boolean; debugTiming?: boolean }>(
        `${serverPath(serverId)}/files/viewer/capabilities`,
        { signal },
      ),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  };
}
export function useViewerCapabilities(serverId: string, identity: string) {
  return useQuery({ ...viewerCapabilitiesQuery(serverId, identity), enabled: identity.length > 0 });
}
export function viewerPreferencesQuery(serverId: string, identity: string) {
  return {
    queryKey: ['viewer-preferences', identity, serverId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<{ preferences: ViewerPreference[] }>(`${serverPath(serverId)}/files/viewer/preferences`, {
        signal,
      }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  };
}
export function useViewerPreferences(serverId: string, identity: string) {
  const capabilities = useViewerCapabilities(serverId, identity);
  return useQuery({
    ...viewerPreferencesQuery(serverId, identity),
    enabled: identity.length > 0 && capabilities.data?.available === true,
  });
}
export async function setViewerPreference(
  serverId: string,
  preference: ViewerPreference | Omit<ViewerPreference, 'viewerId'>,
) {
  await api(`${serverPath(serverId)}/files/viewer/preferences`, {
    method: 'viewerId' in preference ? 'PUT' : 'DELETE',
    body: preference,
  });
  await queryClient.invalidateQueries({ queryKey: ['viewer-preferences'] });
}
