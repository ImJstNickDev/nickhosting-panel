import { useQuery } from '@tanstack/react-query';
import type { OpenworldSavedPlayersPage } from '../../../../../games/openworld/src/offline-players.js';
import { api } from '../../api/client.js';
import { playersBase } from './player-workspace.js';
import type { ServerView } from './telemetry.js';

export function useSavedDirectory(
  server: ServerView,
  enabled: boolean,
  q: string,
  page: number,
  excludeAccounts: string[],
) {
  const body = { q, page, excludeAccounts };
  return useQuery({
    queryKey: ['openworld-player-directory', ...server.viewerScope, server.serverId, body],
    queryFn: ({ signal }) =>
      api<OpenworldSavedPlayersPage>(`${playersBase(server.serverId)}/players/saved/search`, {
        body,
        signal,
      }),
    enabled,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => (query.state.data?.indexing && !query.state.error ? 3500 : false),
    refetchIntervalInBackground: false,
  });
}
